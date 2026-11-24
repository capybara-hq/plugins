// The browser session (spec §5, §9): the tabs of the one Chromium of the device, the agent's
// actions on them, and the events viewers follow (tab and navigation state, blocked hosts,
// dialogs). Takeover: main.ts refuses a request that arrives while the person holds control, and
// run() checks again when a queued request leaves the queue (`takenOver`).

import { lstatSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { basename, extname, join, sep } from "node:path";
import type {
  BrowserContext,
  CDPSession,
  Dialog,
  Download,
  Locator,
  Page,
  Request,
} from "playwright-core";
import {
  MAX_TABS,
  type ToolErrorCode,
  type ToolReply,
  type ToolRequest,
  VIEWPORT,
} from "./protocol.js";
import { takeSnapshot } from "./snapshot.js";
import { type Clock, systemClock } from "./state.js";

/** Something the viewers follow. */
export type SessionEvent =
  | { type: "state" }
  | { type: "active" }
  | { type: "blocked"; host: string; url: string }
  | { type: "dialog"; kind: "alert" | "confirm" | "prompt" | "file"; message: string };

/** A failure with the code the tool reply carries. */
export class ActionError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** What happened in the browser while one request ran. */
interface Collector {
  blocked: Set<string>;
  notes: string[];
  pending: Promise<unknown>[];
  /** Downloads that began during the request: waited for, at most `downloadWaitMs`. */
  downloads: { name: string; done: Promise<void>; finished: boolean }[];
}

/** How long a reply waits for the downloads its action started. */
export const DOWNLOAD_WAIT_MS = 10_000;
/** The default cap on the bytes of downloads in progress (BROWSER_DOWNLOAD_MAX_BYTES). */
export const DEFAULT_DOWNLOAD_MAX_BYTES = 200 * 1024 * 1024;
const DOWNLOAD_POLL_MS = 250;
const MAX_NAME_BYTES = 200;

const ACTION_TIMEOUT_MS = 10_000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const LOAD_GRACE_MS = 5_000;
const MAX_WAIT_MS = 60_000;
/**
 * The largest screenshot, decoded: its base64 plus the reply's JSON stays below the device service
 * message limit (8 MiB), with 64 KiB left for the rest of the reply.
 */
export const MAX_SCREENSHOT_BYTES = Math.floor(((8 * 1024 * 1024 - 64 * 1024) * 3) / 4);
/** Caps of page-controlled text in replies and viewer messages (a title can be megabytes). */
export const MAX_TITLE_CHARS = 2048;
export const MAX_URL_CHARS = 2048;
export const MAX_DIALOG_CHARS = 4096;
const DEFAULT_WAIT_MS = 10_000;
const MAX_UNREPORTED = 20;

export const TAKEN_OVER_MESSAGE = "The user is controlling the browser; call wait or handoff.";

/** `s` cut to `max` characters, with an ellipsis when cut. */
export function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

/** The longest prefix of `s` (whole code points) of at most `max` UTF-8 bytes. */
function utf8Prefix(s: string, max: number): string {
  let out = "";
  let bytes = 0;
  for (const ch of s) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > max) break;
    out += ch;
    bytes += n;
  }
  return out;
}

/**
 * A file name safe to create in the downloads directory: no path, control or reserved
 * characters, no leading dots, at most 200 UTF-8 bytes with the extension kept.
 */
export function safeFileName(raw: string): string {
  const visible = [...raw]
    .map((ch) => {
      const code = ch.charCodeAt(0);
      return code < 0x20 || code === 0x7f ? "_" : ch;
    })
    .join("");
  const name = basename(visible.replace(/\\/g, "/"))
    .replace(/[/:*?"<>|]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  if (name === "") return "download";
  if (Buffer.byteLength(name) <= MAX_NAME_BYTES) return name;
  let ext = extname(name);
  if (Buffer.byteLength(ext) > 32) ext = "";
  return (
    utf8Prefix(name.slice(0, name.length - ext.length), MAX_NAME_BYTES - Buffer.byteLength(ext)) +
    ext
  );
}

/** Whether `path` names nothing at all (a dangling link is something). */
function absent(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch {
    return true;
  }
}

const PROXY_PROBE_TIMEOUT_MS = 5_000;

const REF_RE = /^(f\d+)?e\d+$/;
const PROXY_FAILURE_RE = /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED/;

export interface JpegCapture {
  data: string;
  width: number;
  height: number;
}

/** The pixel size of a JPEG (its first SOF marker); zero when none is found. */
export function jpegSize(jpeg: Buffer): { width: number; height: number } {
  let i = 2;
  while (i + 9 < jpeg.length) {
    if (jpeg[i] !== 0xff) break;
    const marker = jpeg[i + 1] ?? 0;
    const len = jpeg.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: jpeg.readUInt16BE(i + 5), width: jpeg.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return { width: 0, height: 0 };
}

// capybara:allow-module-state read-only constant (device service process, not the kernel)
const QUALITIES = [80, 60, 40, 25];
// capybara:allow-module-state read-only constant (device service process, not the kernel)
const SCALES = [1, 0.75, 0.5, 0.35, 0.25, 0.15];

/**
 * A JPEG of the page whose decoded size is at most `maxBytes`: quality, then scale, go down
 * until it fits; null when even the smallest does not. `maxScale` caps the scale (a viewer's
 * maximum size); `fullPage` captures beyond the viewport.
 */
export async function captureFitting(
  cdp: CDPSession,
  opts: { maxBytes: number; maxScale?: number; fullPage?: boolean },
): Promise<JpegCapture | null> {
  const metrics = await cdp.send("Page.getLayoutMetrics");
  const vv = metrics.cssVisualViewport;
  const content = metrics.cssContentSize;
  const area = opts.fullPage
    ? { x: 0, y: 0, width: content.width, height: Math.min(content.height, 16_384) }
    : { x: vv.pageX, y: vv.pageY, width: vv.clientWidth, height: vv.clientHeight };
  const maxScale = Math.min(1, opts.maxScale ?? 1);
  for (const s of SCALES) {
    const scale = s * maxScale;
    if (scale * area.width < 16) break;
    for (const quality of QUALITIES) {
      const shot = await cdp.send("Page.captureScreenshot", {
        format: "jpeg",
        quality,
        clip: { ...area, scale },
        captureBeyondViewport: opts.fullPage === true,
      });
      const bytes = Buffer.from(shot.data, "base64");
      if (bytes.length <= opts.maxBytes) return { data: shot.data, ...jpegSize(bytes) };
    }
  }
  return null;
}

/**
 * Asks the proxy whether it refuses `host` (a CONNECT that answers 403): Chromium reports every
 * failed tunnel alike, and an origin's own 403 looks like the proxy's.
 */
export function proxyRefuses(proxy: string, host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(proxy.includes("://") ? proxy : `http://${proxy}`);
    } catch {
      resolve(false);
      return;
    }
    const headers: Record<string, string> = { host: `${host}:${port}` };
    if (url.username !== "") {
      const cred = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
      headers["proxy-authorization"] = `Basic ${Buffer.from(cred).toString("base64")}`;
    }
    const req = httpRequest({
      host: url.hostname,
      port: Number(url.port || 80),
      method: "CONNECT",
      path: `${host}:${port}`,
      headers,
      timeout: PROXY_PROBE_TIMEOUT_MS,
    });
    req.on("connect", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode === 403);
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode === 403);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
    req.end();
  });
}

/** An http(s) URL from what a person or agent typed: a bare host gets https://. */
export function normalizeUrl(raw: string): string {
  const s = raw.trim();
  if (s === "about:blank") return s;
  const withScheme =
    /^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^/]+:\d+(\/|$)/.test(s) ? s : `https://${s}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new ActionError("failed", `${JSON.stringify(raw)} is not a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ActionError("failed", `Only http and https URLs can be opened, not ${url.protocol}`);
  }
  return url.href;
}

const firstLine = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).split("\n")[0]?.replace(/^[a-zA-Z.]+: /, "") ?? "";

export interface TabInfo {
  id: string;
  title: string;
  url: string;
}

export class BrowserSession {
  private readonly ctx: BrowserContext;
  private readonly proxy: string | undefined;
  private readonly clock: Clock;
  /** The device's workspace root (CAPYBARA_SERVICE_WORKSPACE): uploads and downloads stay in it. */
  private readonly workspace: string | undefined;
  private readonly downloadsTmp: string | undefined;
  private readonly downloadMaxBytes: number;
  private readonly downloadWaitMs: number;
  /** Downloads in progress, cancelled together when their bytes pass the cap. */
  private readonly activeDownloads = new Set<Download>();
  private downloadPoll: unknown;
  /**
   * Files of downloads cancelled at the cap: Playwright removes them later, and until then they
   * do not count toward the cap of the downloads that follow.
   */
  private readonly cancelledTmp = new Set<string>();
  private readonly pages = new Map<string, Page>();
  private readonly ids = new WeakMap<Page, string>();
  private readonly titles = new Map<string, string>();
  private readonly loadingTabs = new Set<string>();
  private readonly listeners = new Set<(e: SessionEvent) => void>();
  private readonly collectors = new Set<Collector>();
  private readonly probes = new Map<string, Promise<boolean>>();
  private readonly reservedDownloads = new Set<string>();
  private readonly unreported: string[] = [];
  private nextId = 1;
  private active: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  /** The agent's latest click; `seq` grows with every click (viewers flash only new ones). */
  lastClick: { x: number; y: number; seq: number } | undefined;
  private clickSeq = 0;

  constructor(
    ctx: BrowserContext,
    opts: {
      proxy?: string | undefined;
      clock?: Clock;
      workspace?: string | undefined;
      /** Playwright's directory for downloads in progress (launch option `downloadsPath`). */
      downloadsTmp?: string | undefined;
      downloadMaxBytes?: number;
      downloadWaitMs?: number;
    },
  ) {
    this.ctx = ctx;
    this.proxy = opts.proxy;
    this.workspace = opts.workspace;
    this.downloadsTmp = opts.downloadsTmp;
    this.downloadMaxBytes = opts.downloadMaxBytes ?? DEFAULT_DOWNLOAD_MAX_BYTES;
    this.downloadWaitMs = opts.downloadWaitMs ?? DOWNLOAD_WAIT_MS;
    this.clock = opts.clock ?? systemClock;
    ctx.setDefaultTimeout(ACTION_TIMEOUT_MS);
    ctx.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    ctx.on("page", (p) => {
      // A popup counts toward MAX_TABS like any tab (openTab refuses before it opens one): one
      // past the limit is closed at once and the agent told.
      if (!this.ids.has(p) && this.pages.size >= MAX_TABS) {
        p.close().catch(() => undefined);
        this.note(
          `The page opened a popup, but the browser keeps at most ${MAX_TABS} tabs, so the popup was closed; close a tab and retry if it was needed.`,
        );
        return;
      }
      this.track(p);
      // a popup the page opened comes to the front, as in a desktop browser
      this.active = this.ids.get(p);
      this.emit({ type: "active" });
      this.emit({ type: "state" });
    });
    for (const p of ctx.pages()) this.track(p);
  }

  get context(): BrowserContext {
    return this.ctx;
  }

  on(fn: (e: SessionEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The active tab, opening a blank one when none is left. */
  async activePage(): Promise<Page> {
    const cur = this.active === undefined ? undefined : this.pages.get(this.active);
    if (cur !== undefined && !cur.isClosed()) return cur;
    const first = [...this.pages.values()].find((p) => !p.isClosed());
    if (first !== undefined) {
      this.active = this.ids.get(first);
      return first;
    }
    const p = await this.ctx.newPage();
    this.track(p);
    this.active = this.ids.get(p);
    return p;
  }

  tabIdOf(page: Page): string {
    return this.ids.get(page) ?? "";
  }

  tabs(): (TabInfo & { active: boolean })[] {
    return [...this.pages.entries()].map(([id, p]) => ({
      id,
      title: clip(this.titles.get(id) ?? "", MAX_TITLE_CHARS),
      url: clip(p.url(), MAX_URL_CHARS),
      active: id === this.active,
    }));
  }

  /** Whether the active tab is loading a document. */
  get loading(): boolean {
    return this.active !== undefined && this.loadingTabs.has(this.active);
  }

  private emit(e: SessionEvent): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(e);
      } catch {
        // a viewer's failure never stops the others
      }
    }
  }

  private track(page: Page): void {
    if (this.ids.has(page)) return;
    const id = `t${this.nextId++}`;
    this.ids.set(page, id);
    this.pages.set(id, page);
    const refresh = () => {
      page
        .title()
        .then((t) => this.titles.set(id, t))
        .catch(() => undefined)
        .finally(() => this.emit({ type: "state" }));
    };
    page.on("request", (r) => {
      if (r.isNavigationRequest() && r.frame() === page.mainFrame()) {
        this.loadingTabs.add(id);
        this.emit({ type: "state" });
      }
    });
    page.on("framenavigated", (f) => {
      if (f === page.mainFrame()) refresh();
    });
    page.on("domcontentloaded", refresh);
    page.on("load", () => {
      this.loadingTabs.delete(id);
      refresh();
    });
    page.on("requestfailed", (r) => {
      const err = r.failure()?.errorText ?? "";
      if (r.isNavigationRequest() && r.frame() === page.mainFrame()) {
        this.loadingTabs.delete(id);
        this.emit({ type: "state" });
      }
      if (this.proxy !== undefined && PROXY_FAILURE_RE.test(err))
        this.checkBlocked(r.url(), this.pageToOpen(page, r));
    });
    page.on("response", (r) => {
      if (this.proxy !== undefined && r.status() === 403 && r.url().startsWith("http:")) {
        this.checkBlocked(r.url(), this.pageToOpen(page, r.request()));
      }
    });
    page.on("dialog", (d) => this.onDialog(d));
    page.on("download", (d) => this.onDownload(d));
    page.on("filechooser", () => {
      this.note("The page opened a file chooser; use the upload tool with the file input's ref.");
      this.emit({ type: "dialog", kind: "file", message: "" });
    });
    page.on("close", () => {
      this.pages.delete(id);
      this.titles.delete(id);
      this.loadingTabs.delete(id);
      if (this.active === id) {
        const next = [...this.pages.keys()].at(-1);
        this.active = next;
        this.emit({ type: "active" });
      }
      this.emit({ type: "state" });
    });
  }

  private onDialog(d: Dialog): void {
    const type = d.type();
    if (type === "beforeunload") {
      d.accept().catch(() => undefined);
      return;
    }
    const kind = type === "confirm" || type === "prompt" ? type : "alert";
    const message = clip(d.message(), MAX_DIALOG_CHARS);
    // An alert only informs; a confirm or prompt is dismissed, the safe answer, and the agent
    // learns it so it can act differently.
    const settle = kind === "alert" ? d.accept() : d.dismiss();
    settle.catch(() => undefined);
    this.note(
      `The page showed ${kind === "alert" ? "an alert" : `a ${kind}`} dialog: ${JSON.stringify(message)} (${kind === "alert" ? "closed" : "dismissed"}).`,
    );
    this.emit({ type: "dialog", kind, message });
  }

  /**
   * Adds a note to the replies of the requests in flight; with none in flight (a download that
   * finished after its click replied, a dialog the person caused) the next reply carries it.
   */
  private note(text: string): void {
    const n = clip(text, MAX_DIALOG_CHARS + 200);
    if (this.collectors.size === 0) {
      this.unreported.push(n);
      if (this.unreported.length > MAX_UNREPORTED) this.unreported.shift();
      return;
    }
    for (const c of this.collectors) c.notes.push(n);
  }

  /**
   * Saves a download into `<workspace>/downloads` under its suggested name (sanitized, numbered
   * when taken). A request in flight waits for it at most `downloadWaitMs`, then says it is still
   * in progress; the result note then comes with a later reply. Downloads in progress are
   * cancelled when together they pass `downloadMaxBytes`, so a page cannot fill the disk.
   * Without a workspace the download is cancelled.
   */
  private onDownload(d: Download): void {
    const shown = JSON.stringify(clip(d.suggestedFilename(), 300));
    const workspace = this.workspace;
    if (workspace === undefined) {
      d.cancel().catch(() => undefined);
      this.note(
        `The page started a download (${shown}), which was cancelled: the device has no workspace.`,
      );
      return;
    }
    this.activeDownloads.add(d);
    this.pollDownloads();
    const entry = { name: shown, done: Promise.resolve(), finished: false };
    entry.done = (async () => {
      let target: string | undefined;
      try {
        const failure = await d.failure();
        if (failure !== null) {
          if (failure !== "canceled") this.note(`The download of ${shown} failed: ${failure}.`);
          return;
        }
        const tmp = await d.path();
        if (statSync(tmp).size > this.downloadMaxBytes) {
          this.note(
            `The download of ${shown} was not saved: it is larger than ${this.downloadMaxBytes} bytes.`,
          );
          return;
        }
        target = this.downloadTarget(workspace, safeFileName(d.suggestedFilename()));
        await d.saveAs(target);
        this.note(`Downloaded ${shown} to ${target}.`);
      } catch (e) {
        this.note(
          `The download of ${shown} was not saved: ${e instanceof ActionError ? e.message : firstLine(e)}`,
        );
      } finally {
        if (target !== undefined) this.reservedDownloads.delete(target);
        // Playwright keeps the artifact in downloadsPath until deleted: saved, too large, failed
        // or cancelled, it goes now (else saved downloads double disk use and count to the cap)
        await d.delete().catch(() => undefined);
        this.activeDownloads.delete(d);
        entry.finished = true;
      }
    })();
    for (const c of this.collectors) c.downloads.push(entry);
  }

  /** A free path in `<workspace>/downloads`, refusing a downloads directory that is a link. */
  private downloadTarget(workspace: string, name: string): string {
    const root = realpathSync(workspace);
    const dir = join(root, "downloads");
    mkdirSync(dir, { recursive: true });
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink() || realpathSync(dir) !== dir) {
      throw new ActionError(
        "failed",
        `${dir} is not a plain directory in the workspace; remove it so downloads can be saved.`,
      );
    }
    const ext = extname(name);
    const stem = name.slice(0, name.length - ext.length);
    let target = join(dir, name);
    for (let i = 1; !absent(target) || this.reservedDownloads.has(target); i++) {
      target = join(dir, `${stem} (${i})${ext}`);
    }
    this.reservedDownloads.add(target);
    return target;
  }

  /**
   * While downloads run, sums the bytes of Playwright's in-progress files and cancels every
   * running download once the sum passes the cap.
   */
  private pollDownloads(): void {
    if (this.downloadPoll !== undefined || this.activeDownloads.size === 0) return;
    this.downloadPoll = this.clock.schedule(() => {
      this.downloadPoll = undefined;
      if (this.activeDownloads.size === 0) return;
      let bytes = 0;
      let names: string[] = [];
      const dir = this.downloadsTmp;
      if (dir !== undefined) {
        try {
          names = readdirSync(dir);
        } catch {
          // not created yet
        }
        for (const f of this.cancelledTmp) if (!names.includes(f)) this.cancelledTmp.delete(f);
        for (const f of names) {
          if (this.cancelledTmp.has(f)) continue;
          try {
            bytes += statSync(join(dir, f)).size;
          } catch {
            // finished and moved meanwhile
          }
        }
      }
      if (bytes > this.downloadMaxBytes) {
        for (const f of names) this.cancelledTmp.add(f);
        for (const d of this.activeDownloads) {
          this.note(
            `The download of ${JSON.stringify(clip(d.suggestedFilename(), 300))} was cancelled: downloads in progress passed ${this.downloadMaxBytes} bytes.`,
          );
          d.cancel().catch(() => undefined);
        }
        this.activeDownloads.clear();
        return;
      }
      this.pollDownloads();
    }, DOWNLOAD_POLL_MS);
  }

  /** The real path of an upload, refused unless it is inside the workspace. */
  private uploadPath(path: string): string {
    const workspace = this.workspace;
    if (workspace === undefined) {
      throw new ActionError("failed", "Uploads are unavailable: the device has no workspace.");
    }
    const root = realpathSync(workspace);
    let real: string;
    try {
      real = realpathSync(path);
    } catch {
      throw new ActionError(
        "failed",
        `No file at ${path}; give the absolute path of a file in the workspace (${root}).`,
      );
    }
    if (real !== root && !real.startsWith(root.endsWith(sep) ? root : root + sep)) {
      throw new ActionError(
        "failed",
        `Upload paths must be inside the workspace (${root}); copy the file there first.`,
      );
    }
    return real;
  }

  /**
   * The page a viewer opens once the refused host is allowed: the navigation's target for a
   * main-frame navigation, else the page that loaded the refused resource.
   */
  private pageToOpen(page: Page, r: Request): string {
    return r.isNavigationRequest() && r.frame() === page.mainFrame() ? r.url() : page.url();
  }

  /**
   * Probes the proxy for the URL's host and reports it when refused; the viewers' `blocked`
   * message carries `pageUrl` (default: the URL itself), the page to open once allowed.
   */
  private checkBlocked(rawUrl: string, pageUrl?: string): Promise<boolean> {
    const proxy = this.proxy;
    if (proxy === undefined) return Promise.resolve(false);
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return Promise.resolve(false);
    }
    const host = url.hostname;
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    let probe = this.probes.get(host);
    if (probe === undefined) {
      probe = proxyRefuses(proxy, host, port).then((refused) => {
        this.probes.delete(host);
        if (refused) {
          for (const c of this.collectors) c.blocked.add(host);
          this.emit({ type: "blocked", host, url: pageUrl ?? url.href });
        }
        return refused;
      });
      this.probes.set(host, probe);
    }
    for (const c of this.collectors) c.pending.push(probe);
    return probe;
  }

  /** Runs `fn` one at a time with the other actions (`wait` runs beside them). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Runs a tool request; never throws. `takenOver` is checked when a queued request leaves the
   * queue: a takeover that began while it waited refuses it. An action already running is left to
   * finish (stopping it halfway would leave the page in an unknown state).
   */
  async run(req: ToolRequest, opts: { takenOver?: () => boolean } = {}): Promise<ToolReply> {
    // Notes that arrived with no request in flight ride the next reply, whichever conversation of
    // the device sends it (they are all the owner's); a failed request puts them back.
    const late = this.unreported.splice(0);
    const c: Collector = { blocked: new Set(), notes: [...late], pending: [], downloads: [] };
    this.collectors.add(c);
    let reply: ToolReply;
    try {
      const out = await (req.op === "wait"
        ? this.exec(req)
        : this.serial(() => {
            if (opts.takenOver?.() === true)
              throw new ActionError("taken_over", TAKEN_OVER_MESSAGE);
            return this.exec(req);
          }));
      await this.settleProbes(c);
      await this.settleDownloads(c);
      // from here on, notes go to later replies (none is lost between this one and the next)
      this.collectors.delete(c);
      const page = await this.activePage();
      const text = [...c.notes, ...(out.text === undefined ? [] : [out.text])].join("\n");
      reply = {
        ok: true,
        page: await this.pageInfo(page),
        blockedHosts: [...c.blocked],
        ...(text === "" ? {} : { text }),
        ...(out.image === undefined ? {} : { image: out.image }),
      };
    } catch (e) {
      await this.settleProbes(c);
      let code: ToolErrorCode = e instanceof ActionError ? e.code : "failed";
      let message = e instanceof ActionError ? e.message : firstLine(e);
      if (!(e instanceof ActionError) && e instanceof Error && e.name === "TimeoutError") {
        code = "timeout";
      }
      if (c.blocked.size > 0 && code !== "no_such_ref" && code !== "taken_over") {
        code = "blocked";
        // the plugin server adds the one next step (the network ask), so no advice here
        message = `The device's network settings block ${[...c.blocked].join(", ")}.`;
      }
      reply = { ok: false, error: code, message, blockedHosts: [...c.blocked] };
      this.unreported.unshift(...late);
    } finally {
      this.collectors.delete(c);
    }
    this.emit({ type: "state" });
    return reply;
  }

  /**
   * Waits for the request's downloads at most `downloadWaitMs`; those still running are noted as
   * in progress (their result note comes later).
   */
  private async settleDownloads(c: Collector): Promise<void> {
    if (c.downloads.length === 0) return;
    let timer: unknown;
    await Promise.race([
      Promise.allSettled(c.downloads.map((x) => x.done)),
      new Promise<void>((r) => {
        timer = this.clock.schedule(r, this.downloadWaitMs);
      }),
    ]);
    this.clock.cancel(timer);
    for (const x of c.downloads) {
      if (!x.finished)
        c.notes.push(
          `Download still in progress: ${x.name}; a later reply says where it was saved.`,
        );
    }
  }

  private async settleProbes(c: Collector): Promise<void> {
    while (c.pending.length > 0) {
      const all = c.pending.splice(0);
      await Promise.allSettled(all);
    }
  }

  async pageInfo(page: Page): Promise<{ url: string; title: string; tabId: string }> {
    let title = "";
    try {
      title = await page.title();
    } catch {
      title = this.titles.get(this.tabIdOf(page)) ?? "";
    }
    return {
      url: clip(page.url(), MAX_URL_CHARS),
      title: clip(title, MAX_TITLE_CHARS),
      tabId: this.tabIdOf(page),
    };
  }

  private async locate(page: Page, ref: string): Promise<Locator> {
    if (!REF_RE.test(ref)) {
      throw new ActionError(
        "no_such_ref",
        `${JSON.stringify(ref)} is not an element ref; refs look like e12. Take a snapshot first.`,
      );
    }
    const loc = page.getByRef(ref);
    let n = 0;
    try {
      n = await loc.count();
    } catch {
      n = 0;
    }
    if (n === 0) {
      throw new ActionError(
        "no_such_ref",
        `No element has ref ${ref} on this page; take a new snapshot and use a ref from it.`,
      );
    }
    return loc.first();
  }

  /** Runs `fn`; when it started a main-frame navigation, waits until that document has loaded. */
  private async settled<T>(page: Page, fn: () => Promise<T>): Promise<T> {
    let navigating = false;
    let loaded = false;
    const onReq = (r: { isNavigationRequest(): boolean; frame(): unknown }) => {
      if (r.isNavigationRequest() && r.frame() === page.mainFrame()) {
        navigating = true;
        loaded = false;
      }
    };
    const onLoad = () => {
      loaded = true;
    };
    page.on("request", onReq);
    page.on("domcontentloaded", onLoad);
    try {
      const out = await fn();
      if (navigating && !loaded) {
        await page
          .waitForEvent("domcontentloaded", { timeout: NAVIGATION_TIMEOUT_MS })
          .catch(() => undefined);
      }
      return out;
    } finally {
      page.off("request", onReq);
      page.off("domcontentloaded", onLoad);
    }
  }

  private async centerOf(loc: Locator): Promise<{ x: number; y: number } | undefined> {
    const box = await loc.boundingBox().catch(() => null);
    if (box === null) return undefined;
    return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  }

  private checkPoint(x: number, y: number): void {
    if (!(x >= 0 && y >= 0 && x < VIEWPORT.width && y < VIEWPORT.height)) {
      throw new ActionError(
        "failed",
        `(${x}, ${y}) is outside the ${VIEWPORT.width}x${VIEWPORT.height} viewport; use viewport pixel coordinates from a screenshot.`,
      );
    }
  }

  private markClick(x: number, y: number): void {
    this.lastClick = { x, y, seq: ++this.clickSeq };
  }

  private async goto(page: Page, url: string): Promise<void> {
    let res: Awaited<ReturnType<Page["goto"]>>;
    // registered first: Playwright may reject the navigation just before it emits the download
    const download = page.waitForEvent("download", { timeout: ACTION_TIMEOUT_MS });
    download.catch(() => undefined);
    try {
      res = await page.goto(url, { waitUntil: "domcontentloaded" });
    } catch (e) {
      const msg = firstLine(e);
      // a URL that is a file download: it is saved and reported (onDownload), not an error
      if (msg.includes("Download is starting")) {
        await download.catch(() => undefined);
        return;
      }
      if (PROXY_FAILURE_RE.test(msg)) await this.checkBlocked(url);
      throw e;
    }
    // a plain-http request the proxy refuses loads its 403 page instead of failing
    if (res?.status() === 403 && (await this.checkBlocked(res.url()))) {
      throw new ActionError(
        "blocked",
        `The device's network settings block ${new URL(res.url()).hostname}.`,
      );
    }
    await page.waitForLoadState("load", { timeout: LOAD_GRACE_MS }).catch(() => undefined);
  }

  private async exec(req: ToolRequest): Promise<{ text?: string; image?: string }> {
    switch (req.op) {
      case "navigate": {
        const page = await this.activePage();
        if (req.url !== undefined) {
          await this.goto(page, normalizeUrl(req.url));
        } else if (req.action === "back" || req.action === "forward") {
          const r = await (req.action === "back" ? page.goBack() : page.goForward());
          if (r === null && page.url() === "about:blank") {
            return { text: `No ${req.action === "back" ? "earlier" : "later"} page in this tab.` };
          }
        } else if (req.action === "reload") {
          await page.reload({ waitUntil: "domcontentloaded" });
        } else {
          throw new ActionError(
            "failed",
            "navigate needs a url or an action (back, forward, reload).",
          );
        }
        return {};
      }
      case "tabs":
        return this.tabsOp(req);
      case "snapshot":
        return { text: await takeSnapshot(await this.activePage()) };
      case "click":
      case "hover": {
        const page = await this.activePage();
        const loc = await this.locate(page, req.ref);
        if (req.op === "hover") {
          await loc.hover();
          return {};
        }
        const at = await this.centerOf(loc);
        if (at !== undefined) this.markClick(at.x, at.y);
        await this.settled(page, () => loc.click());
        return {};
      }
      case "type": {
        const page = await this.activePage();
        const loc = await this.locate(page, req.ref);
        await loc.fill(req.text);
        if (req.submit === true) await this.settled(page, () => loc.press("Enter"));
        return {};
      }
      case "select": {
        const page = await this.activePage();
        const loc = await this.locate(page, req.ref);
        const chosen = await this.settled(page, () => loc.selectOption(req.values));
        return { text: `Selected ${JSON.stringify(chosen)}.` };
      }
      case "press": {
        const page = await this.activePage();
        await this.settled(page, () => page.keyboard.press(req.key));
        return {};
      }
      case "scroll": {
        const page = await this.activePage();
        if (req.ref !== undefined) {
          const loc = await this.locate(page, req.ref);
          await loc.scrollIntoViewIfNeeded();
          if (req.dy !== 0) {
            await loc.hover();
            await page.mouse.wheel(0, req.dy);
          }
        } else {
          await page.evaluate(`window.scrollBy(0, ${Number(req.dy) || 0})`);
        }
        return {};
      }
      case "upload": {
        const page = await this.activePage();
        const path = this.uploadPath(req.path);
        const loc = await this.locate(page, req.ref);
        await loc.setInputFiles(path);
        return {};
      }
      case "click_at":
      case "type_at": {
        const page = await this.activePage();
        this.checkPoint(req.x, req.y);
        this.markClick(Math.round(req.x), Math.round(req.y));
        await this.settled(page, () => page.mouse.click(req.x, req.y));
        if (req.op === "type_at") await page.keyboard.type(req.text);
        return {};
      }
      case "wait":
        return this.waitOp(req);
      case "screenshot": {
        const page = await this.activePage();
        const maxBytes = Math.min(MAX_SCREENSHOT_BYTES, Math.floor(req.maxBytes));
        if (!(maxBytes > 0))
          throw new ActionError("failed", "screenshot needs a positive maxBytes.");
        const cdp = await this.ctx.newCDPSession(page);
        try {
          const shot = await captureFitting(cdp, {
            maxBytes,
            ...(req.fullPage === true ? { fullPage: true } : {}),
          });
          if (shot === null) {
            throw new ActionError(
              "failed",
              `The page does not fit in a ${maxBytes}-byte screenshot even at the smallest size; use snapshot instead.`,
            );
          }
          return {
            image: shot.data,
            text: `Screenshot ${shot.width}x${shot.height} (viewport ${VIEWPORT.width}x${VIEWPORT.height}).`,
          };
        } finally {
          await cdp.detach().catch(() => undefined);
        }
      }
    }
    throw new ActionError(
      "failed",
      `Unknown browser operation ${JSON.stringify((req as { op: unknown }).op)}.`,
    );
  }

  private async tabsOp(req: Extract<ToolRequest, { op: "tabs" }>): Promise<{ text?: string }> {
    switch (req.action) {
      case "list": {
        await this.activePage();
        const lines = await Promise.all(
          [...this.pages.entries()].map(async ([id, p]) => {
            const info = await this.pageInfo(p);
            return `${id}${id === this.active ? " (active)" : ""}: ${info.title || "(no title)"} ${info.url}`;
          }),
        );
        return { text: lines.join("\n") };
      }
      case "open": {
        const page = await this.openTab();
        if (req.url !== undefined) await this.goto(page, normalizeUrl(req.url));
        return {};
      }
      case "switch": {
        const page = this.tabById(req.tabId);
        this.active = req.tabId;
        await page.bringToFront().catch(() => undefined);
        this.emit({ type: "active" });
        return {};
      }
      case "close": {
        const page = this.tabById(req.tabId);
        await page.close();
        await this.activePage();
        return {};
      }
    }
    throw new ActionError("failed", "tabs needs an action: list, open, switch or close.");
  }

  /** Opens a blank tab and makes it active. */
  async openTab(): Promise<Page> {
    if (this.pages.size >= MAX_TABS) {
      throw new ActionError(
        "failed",
        `The browser has ${MAX_TABS} tabs open, the most it keeps; close one first.`,
      );
    }
    const page = await this.ctx.newPage();
    this.track(page);
    this.active = this.ids.get(page);
    this.emit({ type: "active" });
    this.emit({ type: "state" });
    return page;
  }

  tabById(tabId: string | undefined): Page {
    const page = tabId === undefined ? undefined : this.pages.get(tabId);
    if (page === undefined || page.isClosed()) {
      throw new ActionError(
        "failed",
        `No tab ${JSON.stringify(tabId ?? "")}; list the tabs to see their ids.`,
      );
    }
    return page;
  }

  /** Makes a tab active (a viewer's tab switch). */
  async switchTo(tabId: string): Promise<void> {
    const page = this.tabById(tabId);
    this.active = tabId;
    await page.bringToFront().catch(() => undefined);
    this.emit({ type: "active" });
    this.emit({ type: "state" });
  }

  /** Navigates the active tab for a viewer (address bar, back, forward, reload); never throws. */
  async viewerNav(nav: { url?: string; action?: "back" | "forward" | "reload" }): Promise<void> {
    try {
      const page = await this.activePage();
      if (nav.url !== undefined) await this.goto(page, normalizeUrl(nav.url));
      else if (nav.action === "back") await page.goBack();
      else if (nav.action === "forward") await page.goForward();
      else if (nav.action === "reload") await page.reload();
    } catch {
      // the page shows the failure; a refused host arrives as a blocked message
    }
  }

  private async waitOp(req: Extract<ToolRequest, { op: "wait" }>): Promise<{ text?: string }> {
    const asked = Number(req.timeoutMs);
    const timeout = Number.isFinite(asked)
      ? Math.max(0, Math.min(MAX_WAIT_MS, Math.floor(asked)))
      : DEFAULT_WAIT_MS;
    const page = await this.activePage();
    if (req.text !== undefined) {
      await page
        .getByText(req.text)
        .first()
        .waitFor({ state: "visible", timeout })
        .catch((e) => {
          throw e instanceof Error && e.name === "TimeoutError"
            ? new ActionError(
                "timeout",
                `${JSON.stringify(req.text)} did not appear within ${timeout} ms.`,
              )
            : e;
        });
      await page.waitForLoadState("load", { timeout: LOAD_GRACE_MS }).catch(() => undefined);
      return {};
    }
    if (req.ref !== undefined) {
      if (!REF_RE.test(req.ref))
        throw new ActionError(
          "no_such_ref",
          `${JSON.stringify(req.ref)} is not an element ref; refs look like e12.`,
        );
      await page
        .getByRef(req.ref)
        .first()
        .waitFor({ state: "visible", timeout })
        .catch((e) => {
          throw e instanceof Error && e.name === "TimeoutError"
            ? new ActionError("timeout", `Element ${req.ref} did not appear within ${timeout} ms.`)
            : e;
        });
      return {};
    }
    if (req.navigation === true) {
      await page
        .waitForEvent("framenavigated", { predicate: (f) => f === page.mainFrame(), timeout })
        .catch((e) => {
          throw e instanceof Error && e.name === "TimeoutError"
            ? new ActionError("timeout", `No navigation within ${timeout} ms.`)
            : e;
        });
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
      return {};
    }
    await new Promise<void>((r) => this.clock.schedule(r, timeout));
    return {};
  }

  /** Closes the browser (flushes the profile). */
  async close(): Promise<void> {
    this.listeners.clear();
    if (this.downloadPoll !== undefined) this.clock.cancel(this.downloadPoll);
    await this.ctx.close().catch(() => undefined);
  }
}
