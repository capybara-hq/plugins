// The browser session (spec §5, §9): the tabs of the one Chromium of the device, the agents'
// actions on them, and the events viewers follow (tab and navigation state, blocked hosts,
// dialogs). Takeover: main.ts refuses a request that arrives while the person holds control, and
// run() checks again when a queued request leaves the queue (`takenOver`).
//
// Tabs are owned per conversation (tab ownership spec §4): every tab records its owner and the
// root of the owner's tree, or is unowned; each conversation has its own active tab and its own
// action queue. Notes, refused hosts, dialogs and clicks belong to the owner of their page.

import {
  closeSync,
  constants as fsc,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { basename, extname, join, sep } from "node:path";
import { sandboxProxyRefusalLayer } from "@capybara-hq/plugin-sdk";
import type {
  BrowserContext,
  CDPSession,
  Dialog,
  Download,
  Locator,
  Page,
  Request,
  Response,
} from "playwright-core";
import { fetchIcon, iconForPanel, iconUrlOf } from "./favicon.js";
import {
  type BlockedHost,
  EVICT_MIN_IDLE_MS,
  MAX_TABS,
  MAX_TABS_PER_CONVERSATION,
  type ToolErrorCode,
  type ToolOp,
  type ToolReply,
  type ToolRequest,
  VIEWPORT,
} from "./protocol.js";
import { takeSnapshot } from "./snapshot.js";
import { type Clock, systemClock } from "./state.js";
import { isVerificationPage, type TabBlocker, VERIFICATION_NOTE } from "./verification.js";

/**
 * Something the viewers follow. `active`: a conversation's active tab changed. `blocked` and
 * `dialog` carry the root of the page owner's tree (events of unowned pages are not sent).
 */
export type SessionEvent =
  | { type: "state" }
  | { type: "active"; conversationId: string }
  | { type: "blocked"; host: string; url: string; root: string }
  | {
      type: "dialog";
      kind: "alert" | "confirm" | "prompt" | "file";
      message: string;
      root: string;
    };

/** A failure with the code the tool reply carries. */
export class ActionError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** A collector's refused hosts as a reply carries them. */
function blockedHostsOf(c: Collector): BlockedHost[] {
  return [...c.blocked].map(([host, layer]) => ({ host, layer }));
}

/**
 * The message of a request that failed on refused hosts: the device's settings block the
 * `device` ones; the `address` ones resolve to private or local addresses, closed to the browser.
 */
export function blockedMessage(blocked: readonly BlockedHost[]): string {
  const device = blocked.filter((b) => b.layer === "device").map((b) => b.host);
  const address = blocked.filter((b) => b.layer === "address").map((b) => b.host);
  return [
    ...(device.length > 0 ? [`The device's network settings block ${device.join(", ")}.`] : []),
    ...(address.length > 0
      ? [
          `${address.join(", ")} ${address.length === 1 ? "resolves" : "resolve"} to a private or local address on the device, which the browser never reaches from the sandbox.`,
        ]
      : []),
  ].join(" ");
}

/** What happened in the browser while one request ran. */
interface Collector {
  /** The request's conversation: only events of its pages land here. */
  conv: string;
  /** The hosts the device's proxy refused for this request's pages, with the refusing layer. */
  blocked: Map<string, BlockedHost["layer"]>;
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
/**
 * The longest a reply waits on a query of a page besides the action (its title, the verification
 * check): a page whose navigation hangs keeps such queries waiting.
 */
const PAGE_QUERY_MS = 1_000;
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

/** Copies the file at `source` into the open descriptor `out`. */
function copyInto(source: string, out: number): void {
  const src = openSync(source, fsc.O_RDONLY | fsc.O_NOFOLLOW);
  try {
    const buf = Buffer.alloc(1024 * 1024);
    for (;;) {
      const n = readSync(src, buf, 0, buf.length, null);
      if (n === 0) break;
      let w = 0;
      while (w < n) w += writeSync(out, buf, w, n - w);
    }
  } finally {
    closeSync(src);
  }
}

const PROXY_PROBE_TIMEOUT_MS = 5_000;

/** The largest file an upload reads (Playwright takes uploads from memory). */
export const UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

/** Upload types by extension (the page may check it); anything else is octet-stream. */
const UPLOAD_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".zip": "application/zip",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** Whether `real` is `root` or lies beneath it. */
function within(real: string, root: string): boolean {
  return real === root || real.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Whether two stats are the same file. */
const sameFile = (a: { dev: number; ino: number }, b: { dev: number; ino: number }) =>
  a.dev === b.dev && a.ino === b.ino;

const REF_RE = /^(f\d+)?e\d+$/;
const PROXY_FAILURE_RE = /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED/;

/** Connection-level net errors (not the page's content): the device proxy is asked about them. */
const NETWORK_ERROR_RE =
  /^ERR_(TIMED_OUT|CONNECTION_[A-Z_]+|NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|ADDRESS_UNREACHABLE|EMPTY_RESPONSE|NETWORK_[A-Z_]+|SOCKET_NOT_CONNECTED)$/;

/** A wait for a page event in a conversation that has no tab (wait never opens one). */
export const NO_TAB_TO_WAIT_ON =
  "This conversation has no browser tab to wait on; call browser_navigate to open a page first.";

/** Playwright's error for a navigation that a network error page's late commit interrupted. */
const ERROR_PAGE_INTERRUPT_RE = /is interrupted by another navigation to "chrome-error:/;

/** How often a navigation runs while the device's network keeps changing under it. */
const NETWORK_CHANGED_ATTEMPTS = 4;

/** The longest a failed navigation waits for its error page to commit. */
const ERROR_PAGE_WAIT_MS = 2_000;

/** Whether `e` is Playwright's timeout. */
const isTimeout = (e: unknown) => e instanceof Error && e.name === "TimeoutError";

/** What Chromium's common net errors of a navigation mean (the rest are named only). */
// capybara:allow-module-state read-only constant (device service process, not the kernel)
const NET_ERROR_MEANINGS: Record<string, string> = {
  ERR_NAME_NOT_RESOLVED: "the host name does not resolve",
  ERR_CONNECTION_REFUSED: "the host refused the connection",
  ERR_CONNECTION_RESET: "the connection was reset",
  ERR_CONNECTION_CLOSED: "the host closed the connection without an answer",
  ERR_CONNECTION_TIMED_OUT: "the host did not answer the connection",
  ERR_ADDRESS_UNREACHABLE: "the host's address is unreachable",
  ERR_INTERNET_DISCONNECTED: "the device has no network connection",
  ERR_EMPTY_RESPONSE: "the server sent an empty answer",
  ERR_SSL_PROTOCOL_ERROR: "the secure connection failed",
  ERR_CERT_AUTHORITY_INVALID: "the site's certificate is not trusted",
  ERR_CERT_COMMON_NAME_INVALID: "the site's certificate is for another name",
  ERR_CERT_DATE_INVALID: "the site's certificate has expired or is not yet valid",
  ERR_TOO_MANY_REDIRECTS: "the page redirects in a loop",
};

/** A document address without its fragment (a request's URL has none; a frame's may). */
function docUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    return u.href;
  } catch {
    return raw;
  }
}

/** What became of the navigation in flight that took over an aborted `goto`. */
type TakenOver =
  | { kind: "loaded"; response: Response | null }
  | { kind: "failed"; url: string; error: string }
  | { kind: "none" };

/**
 * Watches a page's main-frame navigations while one `goto` runs, to tell an abort that still
 * shows the page asked for from a real failure: Chromium drops a navigation to an address whose
 * navigation is already in flight (a tab restored at start, the address bar), and that one then
 * redirects and loads (or fails).
 */
class NavWatch {
  private readonly target: string;
  /** The newest main-frame navigation request to the target address (redirects included). */
  private lastOurs: Request | undefined;
  /** The request of `lastOurs`'s chain whose document the main frame committed. */
  private committedOurs: Request | undefined;
  /** The request of `lastOurs`'s chain that failed. */
  private failedOurs: Request | undefined;
  private wake: (() => void) | undefined;
  private readonly onRequest = (r: Request) => {
    if (!r.isNavigationRequest() || r.frame() !== this.page.mainFrame()) return;
    this.lastOurs = this.isOurs(r) ? r : undefined;
    this.wake?.();
  };
  private readonly onNavigated = (f: unknown) => {
    if (f !== this.page.mainFrame()) return;
    const ours = this.lastOurs;
    if (ours !== undefined && docUrl(this.page.mainFrame().url()) === docUrl(ours.url()))
      this.committedOurs = ours;
    this.wake?.();
  };
  private readonly onFailed = (r: Request) => {
    if (r === this.lastOurs) this.failedOurs = r;
    this.wake?.();
  };
  /** After the session's own `requestfinished` handler (registered first) settled the request. */
  private readonly onFinished = (r: Request) => {
    if (!r.isNavigationRequest() || r.frame() !== this.page.mainFrame()) return;
    const wake = () => this.wake?.();
    void r.response().then(wake, wake);
  };

  constructor(
    private readonly page: Page,
    url: string,
    /** The main-frame navigation request in flight (not committed, failed or finished), if any. */
    private readonly pending: () => Request | undefined,
  ) {
    this.target = docUrl(url);
    // a navigation already in flight before this one (the one Chromium may keep)
    const before = pending();
    if (before !== undefined && this.isOurs(before)) this.lastOurs = before;
    page.on("request", this.onRequest);
    page.on("framenavigated", this.onNavigated);
    page.on("requestfailed", this.onFailed);
    page.on("requestfinished", this.onFinished);
  }

  private isOurs(r: Request): boolean {
    let root = r;
    for (let from = r.redirectedFrom(); from !== null; from = from.redirectedFrom()) root = from;
    return docUrl(root.url()) === this.target;
  }

  /** Resolves on the next navigation event or after `ms`. */
  private next(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      function done(): void {
        clearTimeout(timer);
        resolve();
      }
      this.wake = () => {
        this.wake = undefined;
        done();
      };
    });
  }

  /**
   * After an abort: waits (until `deadline`, the navigation's own) while a navigation to the
   * target address is in flight, then tells whether it loaded (its document committed; a script
   * may have moved the page on since), failed, or none of ours took over.
   */
  async follow(deadline: number): Promise<TakenOver> {
    for (let r = this.pending(); r !== undefined; r = this.pending()) {
      if (!this.isOurs(r)) return { kind: "none" };
      const left = deadline - Date.now();
      if (left <= 0) return { kind: "none" };
      await this.next(left);
    }
    const final = this.lastOurs;
    if (final === undefined) return { kind: "none" };
    if (this.failedOurs === final) {
      return { kind: "failed", url: final.url(), error: final.failure()?.errorText ?? "" };
    }
    if (this.committedOurs !== final) return { kind: "none" };
    const left = deadline - Date.now();
    if (left <= 0) return { kind: "none" };
    try {
      await this.page.waitForLoadState("domcontentloaded", { timeout: left });
    } catch {
      return { kind: "none" };
    }
    return { kind: "loaded", response: await final.response().catch(() => null) };
  }

  /**
   * The status the newest navigation to the target address was answered with, when it finished
   * without a document (a 204 or 205: Chromium keeps the page and aborts the navigation).
   */
  async emptyAnswer(): Promise<number | undefined> {
    const r = this.lastOurs;
    if (r === undefined || r === this.committedOurs) return undefined;
    const status = (await r.response().catch(() => null))?.status();
    return status === 204 || status === 205 ? status : undefined;
  }

  dispose(): void {
    this.page.off("request", this.onRequest);
    this.page.off("framenavigated", this.onNavigated);
    this.page.off("requestfailed", this.onFailed);
    this.page.off("requestfinished", this.onFinished);
    this.wake?.();
  }
}

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
 * What the device's proxy answers a CONNECT to a host: `refused` (403: the device's network rules
 * refuse it), `unreachable` (another refusal of the tunnel, such as 502: the proxy could not
 * connect), `connected` (the tunnel opened), `no_answer` (nothing within the probe's time),
 * `proxy_down` (the connection to the proxy itself could not be made: the device's network is not
 * up) or `unknown` (anything else).
 */
export type ProxyVerdict =
  | "refused"
  | "unreachable"
  | "connected"
  | "no_answer"
  | "proxy_down"
  | "unknown";

/** Socket errors that say the proxy itself cannot be reached (never the destination). */
const PROXY_DOWN_CODES = new Set([
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

/**
 * What the proxy answered a CONNECT probe: its {@link ProxyVerdict} and the status phrase of its
 * answer (for a refusal, the sandbox proxy puts its reason there: "resolved to a private address",
 * "host is not on the allow list").
 */
export interface ProxyAnswer {
  verdict: ProxyVerdict;
  reason: string;
}

/**
 * Asks the proxy whether it refuses `host` (a CONNECT that answers 403: Chromium reports every
 * failed tunnel alike, and an origin's own 403 looks like the proxy's), and for which layer:
 * `address` when the proxy's reason says the destination's address is closed
 * (`sandboxProxyRefusalLayer`), else `device`; null when it does not refuse it.
 */
export async function proxyRefusal(
  proxy: string,
  host: string,
  port: number,
): Promise<BlockedHost["layer"] | null> {
  const answer = await probeProxy(proxy, host, port);
  if (answer.verdict !== "refused") return null;
  return refusalLayer(answer.reason);
}

/** The layer of a proxy refusal from its reason: only a closed address is not the device's. */
export function refusalLayer(reason: string): BlockedHost["layer"] {
  return sandboxProxyRefusalLayer(reason) === "address" ? "address" : "device";
}

/** Opens (and at once closes) a tunnel to `host:port` through the proxy: its {@link ProxyAnswer}. */
export function probeProxy(proxy: string, host: string, port: number): Promise<ProxyAnswer> {
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(proxy.includes("://") ? proxy : `http://${proxy}`);
    } catch {
      resolve({ verdict: "unknown", reason: "" });
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
    const answer = (res: {
      statusCode?: number | undefined;
      statusMessage?: string | undefined;
    }): ProxyAnswer => ({
      verdict:
        res.statusCode === 403 ? "refused" : res.statusCode === 200 ? "connected" : "unreachable",
      reason: res.statusMessage ?? "",
    });
    req.on("connect", (res, socket) => {
      socket.destroy();
      resolve(answer(res));
    });
    req.on("response", (res) => {
      res.resume();
      resolve(answer(res));
    });
    req.on("timeout", () => {
      resolve({ verdict: "no_answer", reason: "" });
      req.destroy();
    });
    // down only when the connection to the proxy never came about: a reset after it connected
    // (a proxy dropping the client when its upstream fails) says nothing about the proxy itself
    let connected = false;
    req.on("socket", (sock) => {
      if (sock.connecting) sock.once("connect", () => (connected = true));
      else connected = true;
    });
    req.on("error", (e: NodeJS.ErrnoException) =>
      resolve({
        verdict: !connected && PROXY_DOWN_CODES.has(e.code ?? "") ? "proxy_down" : "unknown",
        reason: "",
      }),
    );
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

/** A tab's owner: the conversation that acts on it and the root of its tree. */
export interface TabOwner {
  owner: string;
  root: string;
}

/**
 * What the session asks about conversations (DaemonState answers it): whether one is in use, a
 * viewer pins it, how long it has been idle, and the tab parks.
 */
export interface TabUsage {
  /** A request in flight or a conversation park. */
  busy(conversationId: string): boolean;
  pinned(conversationId: string): boolean;
  idleFor(conversationId: string): number;
  lastActiveAt(conversationId: string): number;
  tabParked(tabId: string): boolean;
  tabClosed(tabId: string): void;
  /** The conversation gained a tab (adopt, a person's tab, a restore). */
  seen(conversationId: string, root: string): void;
  /** Whether the daemon keeps state for the conversation (it has not idle closed). */
  known(conversationId: string): boolean;
}

/** Usage for a session without a daemon state: nobody busy, everybody idle for good. */
const NO_USAGE: TabUsage = {
  busy: () => false,
  pinned: () => false,
  idleFor: () => Number.POSITIVE_INFINITY,
  lastActiveAt: () => Number.NEGATIVE_INFINITY,
  tabParked: () => false,
  tabClosed: () => undefined,
  seen: () => undefined,
  known: () => true,
};

/**
 * Whether a tab is the unowned blank tab Chromium starts with (or one a conversation left): it is
 * nobody's page, so neither tab lists nor viewers' other-conversation menus show it.
 */
export function isStartBlank(tab: { owner?: string | undefined; url: string }): boolean {
  return tab.owner === undefined && tab.url === "about:blank";
}

/** Titles of other conversations' tabs in a tab list are cut to this (outside text, kept short). */
export const OTHER_TITLE_CHARS = 120;

/** The refusal of a switch or close of another conversation's tab. */
export const notYourTab = (id: string) =>
  `Tab ${id} belongs to another conversation; call browser_tabs with action adopt and tabId ${id} first if the user asked you to use it.`;
/** The refusal of an adopt while the tab's owner is in use. */
export const tabInUse = (id: string) =>
  `Tab ${id} is in use by another conversation right now; retry shortly or open your own tab.`;
/** The note to a conversation whose tab another one adopted. */
export const tabMoved = (id: string, title: string) =>
  `Tab ${id} (${title}) was moved to another conversation.`;
/** The note to a conversation whose tab the device cap closed. */
export const tabEvicted = (id: string, title: string) =>
  `Tab ${id} (${title}) was closed to make room for another conversation.`;
/** The refusal at the per-conversation cap. */
export const CONVERSATION_CAP_MESSAGE = `This conversation has ${MAX_TABS_PER_CONVERSATION} tabs open, the most one conversation keeps; close one first.`;
/** The refusal at the device cap when nothing could be evicted. */
export const deviceCapMessage = (own: number) =>
  own > 0
    ? `The browser has ${MAX_TABS} tabs open, the most it keeps (${own} ${own === 1 ? "is" : "are"} this conversation's); close one of yours first.`
    : `Other conversations hold all ${MAX_TABS} tabs of the browser; retry later or ask the user to close one in the browser panel.`;

/** A URL without its query and fragment (other conversations' tabs in a list). */
export function bareUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.search = "";
    u.hash = "";
    return u.href;
  } catch {
    return raw.replace(/[?#].*$/s, "");
  }
}

/** The operations that act on the conversation's active tab (they get one when it has none). */
export function isActing(req: ToolOp): boolean {
  if (req.op === "handoff_notice" || req.op === "handoff_clear") return false;
  if (req.op === "tabs") return req.action !== "list" && req.action !== "adopt";
  return true;
}

export interface TabInfo {
  id: string;
  title: string;
  url: string;
  /** Set while the tab shows a verification page (bot check, CAPTCHA); cleared when it changes. */
  blocker?: TabBlocker;
  /** The tab's site icon as a `data:image/...` URL, once fetched (the panel shows a glyph). */
  favicon?: string;
  /** The tab is loading a document (the panel's icon slot spins). */
  loading?: true;
}

export class BrowserSession {
  private readonly ctx: BrowserContext;
  private readonly proxy: string | undefined;
  private readonly clock: Clock;
  private readonly navigationTimeoutMs: number;
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
  /**
   * Each tab's icon: the address it came from and its data URL (null: none or not usable). Kept
   * across navigations until the new page's icon is known, so the strip does not flicker.
   */
  private readonly favicons = new Map<string, { url: string; data: string | null }>();
  /** Tabs showing a verification page, by tab id (cleared on every main-frame navigation). */
  private readonly blockers = new Map<string, TabBlocker>();
  /** The status of each tab's current document (main-frame response), by tab id. */
  private readonly docStatus = new Map<string, number>();
  /** Each page's main-frame navigation request in flight (until it commits, fails or finishes). */
  private readonly pendingNavs = new WeakMap<Page, Request>();
  private readonly listeners = new Set<(e: SessionEvent) => void>();
  private readonly collectors = new Set<Collector>();
  private readonly probes = new Map<string, Promise<boolean>>();
  private readonly reservedDownloads = new Set<string>();
  /** Notes of a conversation's pages that arrived with none of its requests in flight. */
  private readonly unreported = new Map<string, string[]>();
  /** Device notes (no page: the browser build) for the next reply of any conversation. */
  private readonly unreportedAll: string[] = [];
  private nextId = 1;
  /** Each owned tab's owner (an unowned tab has no entry). */
  private readonly owners = new Map<string, TabOwner>();
  /** Each conversation's active tab. */
  private readonly activeOf = new Map<string, string>();
  /** The action queues, by {@link queueKey}. */
  private readonly queues = new Map<string, Promise<unknown>>();
  /** A conversation's first tab being claimed or opened (shared by its callers meanwhile). */
  private readonly claiming = new Map<string, Promise<Page>>();
  /** Tab allocations (claim, open, eviction) one at a time across conversations. */
  private allocChain: Promise<unknown> = Promise.resolve();
  /** Tabs being opened by the session (not yet tracked): they count toward the device cap. */
  private reserved = 0;
  /**
   * Tabs whose close is under way (an idle-closed conversation's, an evicted one): no
   * conversation owns, claims, adopts or lists them any more, and the device cap leaves them out.
   */
  private readonly closing = new Set<string>();
  /** When an agent request last acted on each tab (the eviction's least recently used tab). */
  private readonly tabUsedAt = new Map<string, number>();
  /** When each tab went to its owner (the next active tab after a loss is the newest). */
  private readonly gainedAt = new Map<string, number>();
  private gainSeq = 0;
  /** Order of the conversations' last acting requests (a viewer's default shown tab). */
  private readonly actedSeq = new Map<string, number>();
  private actSeq = 0;
  private readonly usage: TabUsage;
  /** Each tab's latest agent click; `seq` grows with every click (viewers flash only new ones). */
  private readonly clicks = new Map<string, { x: number; y: number; seq: number }>();
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
      /** How long a navigation may take before it is stopped (default 30 s; tests shorten it). */
      navigationTimeoutMs?: number;
      /** Who is in use, pinned or idle (DaemonState); default: nobody busy, everybody idle. */
      usage?: TabUsage;
    },
  ) {
    this.ctx = ctx;
    this.proxy = opts.proxy;
    this.workspace = opts.workspace;
    this.downloadsTmp = opts.downloadsTmp;
    this.downloadMaxBytes = opts.downloadMaxBytes ?? DEFAULT_DOWNLOAD_MAX_BYTES;
    this.downloadWaitMs = opts.downloadWaitMs ?? DOWNLOAD_WAIT_MS;
    this.clock = opts.clock ?? systemClock;
    this.navigationTimeoutMs = opts.navigationTimeoutMs ?? NAVIGATION_TIMEOUT_MS;
    this.usage = opts.usage ?? NO_USAGE;
    ctx.setDefaultTimeout(ACTION_TIMEOUT_MS);
    ctx.setDefaultNavigationTimeout(this.navigationTimeoutMs);
    ctx.on("page", (p) => {
      if (this.ids.has(p)) return;
      this.track(p);
      this.emit({ type: "state" });
      // A popup is attributed by its opener's `popup` event, emitted right after this one. A page
      // nobody opened (the browser's own) stays unowned; past the device cap it is closed.
      // Checked in the allocation chain: no tab of the session's own is half opened there.
      queueMicrotask(() => {
        void this.allocate(async () => {
          const id = this.ids.get(p);
          if (id === undefined || this.owners.has(id) || p.isClosed()) return;
          if (this.live().length > MAX_TABS) await p.close().catch(() => undefined);
        });
      });
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

  tabIdOf(page: Page): string {
    return this.ids.get(page) ?? "";
  }

  /** The live page of a tab, if it is open (and not closing). */
  pageById(tabId: string | undefined): Page | undefined {
    const page = tabId === undefined ? undefined : this.pages.get(tabId);
    return page === undefined || page.isClosed() || this.closing.has(tabId as string)
      ? undefined
      : page;
  }

  /** The open tabs that are not closing, in tab order. */
  private live(): [string, Page][] {
    return [...this.pages.entries()].filter(([id, p]) => !p.isClosed() && !this.closing.has(id));
  }

  /** A tab's owner, if it has one. */
  ownerOf(tabId: string): TabOwner | undefined {
    return this.owners.get(tabId);
  }

  /** The conversations owning a tab now. */
  owningConversations(): string[] {
    return [...new Set([...this.owners.values()].map((o) => o.owner))];
  }

  /** The conversation's tabs in tab order. */
  tabsOf(conversationId: string): string[] {
    return this.live()
      .map(([id]) => id)
      .filter((id) => this.owners.get(id)?.owner === conversationId);
  }

  /** How many tabs the conversation owns. */
  countOf(conversationId: string): number {
    return this.tabsOf(conversationId).length;
  }

  /** The conversation's active tab id, if it has a live one. */
  activeTabOf(conversationId: string): string | undefined {
    const id = this.activeOf.get(conversationId);
    return this.pageById(id) === undefined ? undefined : id;
  }

  /** The conversation's active page, if it has one (never opens a tab). */
  currentPage(conversationId: string): Page | undefined {
    return this.pageById(this.activeOf.get(conversationId));
  }

  /** The order of the conversation's last acting request (higher: later; 0: never). */
  actedOrder(conversationId: string): number {
    return this.actedSeq.get(conversationId) ?? 0;
  }

  /** The tab's latest agent click, if any. */
  lastClickOf(tabId: string | undefined): { x: number; y: number; seq: number } | undefined {
    return tabId === undefined ? undefined : this.clicks.get(tabId);
  }

  /** Whether the tab is loading a document. */
  isLoading(tabId: string | undefined): boolean {
    return tabId !== undefined && this.loadingTabs.has(tabId);
  }

  tabs(): (TabInfo & { owner?: string; root?: string; active: boolean })[] {
    return this.live().map(([id, p]) => {
      const blocker = this.blockers.get(id);
      const icon = this.favicons.get(id)?.data;
      const o = this.owners.get(id);
      return {
        id,
        title: clip(this.titles.get(id) ?? "", MAX_TITLE_CHARS),
        url: clip(p.url(), MAX_URL_CHARS),
        active: o !== undefined && this.activeOf.get(o.owner) === id,
        ...(o === undefined ? {} : { owner: o.owner, root: o.root }),
        ...(blocker === undefined ? {} : { blocker }),
        ...(icon === undefined || icon === null ? {} : { favicon: icon }),
        ...(this.loadingTabs.has(id) ? { loading: true as const } : {}),
      };
    });
  }

  /** Makes a tab the conversation's active tab (it must own it). */
  setActive(conversationId: string, tabId: string): void {
    if (this.owners.get(tabId)?.owner !== conversationId) return;
    if (this.activeOf.get(conversationId) === tabId) return;
    this.activeOf.set(conversationId, tabId);
    this.emit({ type: "active", conversationId });
    this.emit({ type: "state" });
  }

  /** Gives a tab to a conversation (owner and root); the previous owner's active moves on. */
  private assign(tabId: string, to: TabOwner): TabOwner | undefined {
    const before = this.owners.get(tabId);
    this.owners.set(tabId, to);
    this.gainedAt.set(tabId, ++this.gainSeq);
    if (before !== undefined && before.owner !== to.owner) this.activeMovedOff(before.owner, tabId);
    return before;
  }

  /**
   * A conversation lost its tab `tabId` (closed or moved): when it was its active tab, the active
   * tab becomes its most recently opened remaining tab, or none.
   */
  private activeMovedOff(conversationId: string, tabId: string): void {
    if (this.activeOf.get(conversationId) !== tabId) return;
    const next = this.newestTabOf(conversationId, tabId);
    if (next === undefined) this.activeOf.delete(conversationId);
    else this.activeOf.set(conversationId, next);
    this.emit({ type: "active", conversationId });
  }

  /**
   * The conversation's tab it gained last (opened, claimed, adopted or restored), besides
   * `except`.
   */
  private newestTabOf(conversationId: string, except?: string): string | undefined {
    let best: string | undefined;
    for (const id of this.tabsOf(conversationId)) {
      if (id === except) continue;
      if (best === undefined || (this.gainedAt.get(id) ?? 0) > (this.gainedAt.get(best) ?? 0))
        best = id;
    }
    return best;
  }

  /** Runs a tab allocation (claim, open, eviction) one at a time across conversations. */
  private allocate<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.allocChain.then(fn, fn);
    this.allocChain = run.catch(() => undefined);
    return run;
  }

  /**
   * The page an acting request of the conversation acts on: its active tab; with no live tab, an
   * unowned tab it claims, else a new tab (subject to the caps). Callers that find no tab at the
   * same time share one claim, so the conversation gets exactly one tab.
   */
  async pageFor(conversationId: string, root: string): Promise<Page> {
    const cur = this.currentPage(conversationId);
    if (cur !== undefined) return cur;
    const own = this.newestTabOf(conversationId);
    if (own !== undefined) {
      this.setActive(conversationId, own);
      const page = this.pageById(own);
      if (page !== undefined) return page;
    }
    let claim = this.claiming.get(conversationId);
    if (claim === undefined) {
      claim = this.allocate(async () => {
        // an adopt beside the queue may have given the conversation a tab meanwhile
        const now =
          this.currentPage(conversationId) ?? this.pageById(this.newestTabOf(conversationId));
        if (now !== undefined) {
          this.setActive(conversationId, this.tabIdOf(now));
          return now;
        }
        // only the start's blank tab: another unowned tab may show a former owner's page
        const unowned = this.live().find(
          ([id, p]) =>
            isStartBlank({ owner: this.owners.get(id)?.owner, url: p.url() }) &&
            !this.usage.tabParked(id),
        );
        if (unowned !== undefined) {
          const [id, page] = unowned;
          this.assign(id, { owner: conversationId, root });
          this.activeOf.set(conversationId, id);
          this.emit({ type: "active", conversationId });
          this.emit({ type: "state" });
          return page;
        }
        return this.openLocked(conversationId, root);
      }).finally(() => {
        this.claiming.delete(conversationId);
      });
      this.claiming.set(conversationId, claim);
    }
    return claim;
  }

  /** Opens a new tab for the conversation (the caps apply) and makes it its active tab. */
  openTab(conversationId: string, root: string): Promise<Page> {
    return this.allocate(() => this.openLocked(conversationId, root));
  }

  /** {@link openTab} inside the allocation chain. */
  private async openLocked(conversationId: string, root: string): Promise<Page> {
    const own = this.countOf(conversationId);
    if (own >= MAX_TABS_PER_CONVERSATION) throw new ActionError("failed", CONVERSATION_CAP_MESSAGE);
    if (this.live().length + this.reserved >= MAX_TABS && !(await this.evict(conversationId)))
      throw new ActionError("failed", deviceCapMessage(own));
    this.reserved++;
    let page: Page;
    try {
      page = await this.ctx.newPage();
    } finally {
      this.reserved--;
    }
    this.track(page);
    const id = this.tabIdOf(page);
    this.assign(id, { owner: conversationId, root });
    this.activeOf.set(conversationId, id);
    this.emit({ type: "active", conversationId });
    this.emit({ type: "state" });
    return page;
  }

  /**
   * Closes one tab to make room at the device cap: an unowned tab first, else a tab of the least
   * recently active conversation that is evictable (not in use, not pinned by a viewer, idle for
   * at least EVICT_MIN_IDLE_MS), its least recently used non-active tab before its active one; tabs
   * a park pins are skipped. Its owner is told. False when no tab qualifies.
   */
  private async evict(forConversation: string): Promise<boolean> {
    const live = this.live().filter(([id]) => !this.usage.tabParked(id));
    const unowned = live.find(([id]) => !this.owners.has(id));
    if (unowned !== undefined) {
      await this.closeEvicted(unowned[0], unowned[1]);
      return true;
    }
    const owners = new Set<string>();
    for (const [id] of live) {
      const o = this.owners.get(id)?.owner;
      if (
        o !== undefined &&
        o !== forConversation &&
        !this.usage.busy(o) &&
        !this.usage.pinned(o) &&
        this.usage.idleFor(o) >= EVICT_MIN_IDLE_MS
      )
        owners.add(o);
    }
    const victim = [...owners].sort(
      (a, b) => this.usage.lastActiveAt(a) - this.usage.lastActiveAt(b),
    )[0];
    if (victim === undefined) return false;
    const active = this.activeOf.get(victim);
    const used = (id: string) => this.tabUsedAt.get(id) ?? 0;
    const [tabId, page] =
      live
        .filter(([id]) => this.owners.get(id)?.owner === victim)
        .sort(
          ([a], [b]) => (a === active ? 1 : 0) - (b === active ? 1 : 0) || used(a) - used(b),
        )[0] ?? [];
    if (tabId === undefined || page === undefined) return false;
    const title = clip(this.titles.get(tabId) ?? "", OTHER_TITLE_CHARS) || "no title";
    await this.closeEvicted(tabId, page);
    this.noteTo(victim, tabEvicted(tabId, title));
    return true;
  }

  /**
   * Closes an evicted tab, closing from the start: no request or adopt reaches it while its close
   * runs (the close handler forgets it; a tab that would not close is kept as it was).
   */
  private async closeEvicted(tabId: string, page: Page): Promise<void> {
    this.closing.add(tabId);
    await page.close().catch(() => {
      this.closing.delete(tabId);
    });
  }

  /**
   * Moves a tab to the conversation and makes it its active tab (the tool's and a viewer's adopt).
   * `in_use`: its owner has a request in flight or a park (or a park pins the tab); `cap`: the
   * conversation already owns MAX_TABS_PER_CONVERSATION tabs. The previous owner is told.
   */
  adopt(conversationId: string, root: string, tabId: string): "ok" | "in_use" | "cap" {
    this.tabById(tabId);
    const before = this.owners.get(tabId);
    if (before?.owner === conversationId) {
      this.setActive(conversationId, tabId);
      return "ok";
    }
    if ((before !== undefined && this.usage.busy(before.owner)) || this.usage.tabParked(tabId))
      return "in_use";
    if (this.countOf(conversationId) >= MAX_TABS_PER_CONVERSATION) return "cap";
    this.assign(tabId, { owner: conversationId, root });
    this.activeOf.set(conversationId, tabId);
    this.usage.seen(conversationId, root);
    if (before !== undefined) {
      const title = clip(this.titles.get(tabId) ?? "", OTHER_TITLE_CHARS) || "no title";
      this.noteTo(before.owner, tabMoved(tabId, title));
    }
    this.emit({ type: "active", conversationId });
    this.emit({ type: "state" });
    return "ok";
  }

  /**
   * Opens a restored tab for its owner (the first claims the start's blank tab) and starts its
   * navigation without waiting for it.
   */
  async restoreTab(owner: TabOwner, url: string): Promise<string> {
    const page = await this.allocate(async () => {
      const blank = this.live().find(([id, p]) =>
        isStartBlank({ owner: this.owners.get(id)?.owner, url: p.url() }),
      );
      if (blank !== undefined) {
        this.assign(blank[0], owner);
        return blank[1];
      }
      this.reserved++;
      try {
        const p = await this.ctx.newPage();
        this.track(p);
        this.assign(this.tabIdOf(p), owner);
        return p;
      } finally {
        this.reserved--;
      }
    });
    const id = this.tabIdOf(page);
    if (!this.activeOf.has(owner.owner)) this.activeOf.set(owner.owner, id);
    this.usage.seen(owner.owner, owner.root);
    this.emit({ type: "active", conversationId: owner.owner });
    this.emit({ type: "state" });
    let target: string | undefined;
    try {
      target = normalizeUrl(url);
    } catch {
      // not a URL a tab opens: the tab stays blank
    }
    if (target !== undefined) void this.viewerNav(page, { url: target });
    return id;
  }

  /**
   * Closes an idle conversation's tabs (except those a park pins) and forgets what the session
   * keeps for it.
   */
  async closeConversation(conversationId: string): Promise<void> {
    const ids = this.tabsOf(conversationId).filter((id) => !this.usage.tabParked(id));
    // from now on these tabs are nobody's: a request arriving before they closed gets a new tab
    for (const id of ids) {
      this.closing.add(id);
      this.owners.delete(id);
    }
    this.activeOf.delete(conversationId);
    this.queues.delete(this.queueKey(conversationId));
    this.unreported.delete(conversationId);
    this.claiming.delete(conversationId);
    this.actedSeq.delete(conversationId);
    await Promise.all(
      ids.map((id) =>
        this.pages
          .get(id)
          ?.close()
          .catch(() => {
            // a tab that would not close stays, unowned
            this.closing.delete(id);
          }),
      ),
    );
    this.emit({ type: "state" });
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
        .then(() => this.checkVerification(page, id))
        .finally(() => this.emit({ type: "state" }));
    };
    const settle = (r: Request) => {
      if (this.pendingNavs.get(page) === r) this.pendingNavs.delete(page);
    };
    // a redirect hop finishes too: its navigation goes on (the next hop's request follows);
    // any other finish (a 204, a download, a 3xx without Location) ends it
    page.on("requestfinished", (r) => {
      if (this.pendingNavs.get(page) !== r) return;
      void r.response().then(
        (res) => {
          const status = res?.status() ?? 0;
          const redirects = status >= 300 && status < 400 && res?.headers().location;
          if (!redirects) settle(r);
        },
        () => settle(r),
      );
    });
    page.on("request", (r) => {
      if (r.isNavigationRequest() && r.frame() === page.mainFrame()) {
        this.pendingNavs.set(page, r);
        this.loadingTabs.add(id);
        this.emit({ type: "state" });
      }
    });
    page.on("framenavigated", (f) => {
      if (f !== page.mainFrame()) return;
      this.pendingNavs.delete(page);
      // a new document: a verification shown before is gone (refresh looks at the new one)
      this.blockers.delete(id);
      refresh();
    });
    page.on("domcontentloaded", refresh);
    page.on("load", () => {
      this.loadingTabs.delete(id);
      refresh();
      void this.resolveFavicon(page, id);
    });
    page.on("requestfailed", (r) => {
      settle(r);
      const err = r.failure()?.errorText ?? "";
      if (r.isNavigationRequest() && r.frame() === page.mainFrame()) {
        this.loadingTabs.delete(id);
        this.emit({ type: "state" });
      }
      // a request the device's network change dropped may have been a refused one: the proxy is
      // asked about its host too (a network change hides the tunnel's answer)
      if (
        this.proxy !== undefined &&
        (PROXY_FAILURE_RE.test(err) || err.includes("ERR_NETWORK_CHANGED"))
      )
        this.checkBlocked(page, r.url(), this.pageToOpen(page, r));
    });
    page.on("response", (r) => {
      if (r.request().isNavigationRequest() && r.frame() === page.mainFrame())
        this.docStatus.set(id, r.status());
      if (this.proxy !== undefined && r.status() === 403 && r.url().startsWith("http:")) {
        this.checkBlocked(page, r.url(), this.pageToOpen(page, r.request()));
      }
    });
    page.on("dialog", (d) => this.onDialog(page, d));
    page.on("download", (d) => this.onDownload(page, d));
    page.on("filechooser", () => {
      const o = this.owners.get(id);
      this.noteTo(
        o?.owner,
        "The page opened a file chooser; use the upload tool with the file input's ref.",
      );
      if (o !== undefined) this.emit({ type: "dialog", kind: "file", message: "", root: o.root });
    });
    // fires on the opener, `noopener` popups included: the popup is its opener's owner's
    page.on("popup", (p) => this.onPopup(page, p));
    page.on("close", () => {
      this.pendingNavs.delete(page);
      this.pages.delete(id);
      this.closing.delete(id);
      this.titles.delete(id);
      this.loadingTabs.delete(id);
      this.blockers.delete(id);
      this.favicons.delete(id);
      this.docStatus.delete(id);
      this.tabUsedAt.delete(id);
      this.gainedAt.delete(id);
      this.clicks.delete(id);
      const o = this.owners.get(id);
      this.owners.delete(id);
      if (o !== undefined) this.activeMovedOff(o.owner, id);
      this.usage.tabClosed(id);
      this.emit({ type: "state" });
    });
  }

  /**
   * A page opened a popup: it belongs to the opener's owner and becomes its active tab, as in a
   * desktop browser (an unowned opener leaves it unowned). Past the conversation's cap it is closed
   * at once; past the device cap a tab is evicted for it, else it is closed; the owner is told.
   */
  private onPopup(opener: Page, popup: Page): void {
    this.track(popup);
    const id = this.tabIdOf(popup);
    const o = this.owners.get(this.tabIdOf(opener));
    if (o === undefined || this.owners.has(id) || popup.isClosed()) return;
    const closeIt = (why: string) => {
      popup.close().catch(() => undefined);
      this.noteTo(
        o.owner,
        `The page opened a popup, but ${why}, so the popup was closed; close a tab and retry if it was needed.`,
      );
    };
    if (this.countOf(o.owner) >= MAX_TABS_PER_CONVERSATION) {
      closeIt(`this conversation keeps at most ${MAX_TABS_PER_CONVERSATION} tabs`);
      return;
    }
    this.assign(id, o);
    this.activeOf.set(o.owner, id);
    this.emit({ type: "active", conversationId: o.owner });
    this.emit({ type: "state" });
    // the device cap is checked in the allocation chain, where no tab of the session's own is
    // half opened (a page opening there is not yet in `pages`)
    void this.allocate(async () => {
      if (popup.isClosed() || this.live().length <= MAX_TABS) return;
      if (!(await this.evict(o.owner))) closeIt(`the browser keeps at most ${MAX_TABS} tabs`);
    });
  }

  private onDialog(page: Page, d: Dialog): void {
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
    const o = this.owners.get(this.tabIdOf(page));
    this.noteTo(
      o?.owner,
      `The page showed ${kind === "alert" ? "an alert" : `a ${kind}`} dialog: ${JSON.stringify(message)} (${kind === "alert" ? "closed" : "dismissed"}).`,
    );
    if (o !== undefined) this.emit({ type: "dialog", kind, message, root: o.root });
  }

  /**
   * A device note (not about a page: the browser build that runs): the replies of the requests in
   * flight carry it, else the next reply of any conversation.
   */
  note(text: string): void {
    const n = clip(text, MAX_DIALOG_CHARS + 200);
    if (this.collectors.size === 0) {
      this.unreportedAll.push(n);
      if (this.unreportedAll.length > MAX_UNREPORTED) this.unreportedAll.shift();
      return;
    }
    for (const c of this.collectors) c.notes.push(n);
  }

  /**
   * A note for a conversation (about one of its pages): its requests in flight carry it, else its
   * next reply. A note of an unowned page (`undefined`) reaches nobody.
   */
  noteTo(conversationId: string | undefined, text: string): void {
    if (conversationId === undefined) return;
    // a conversation that idle closed and owns nothing has no next reply to carry it
    if (this.countOf(conversationId) === 0 && !this.usage.known(conversationId)) return;
    const n = clip(text, MAX_DIALOG_CHARS + 200);
    let delivered = false;
    for (const c of this.collectors) {
      if (c.conv !== conversationId) continue;
      c.notes.push(n);
      delivered = true;
    }
    if (delivered) return;
    const list = this.unreported.get(conversationId) ?? [];
    list.push(n);
    if (list.length > MAX_UNREPORTED) list.shift();
    this.unreported.set(conversationId, list);
  }

  /** The owner of a page, if it has one. */
  private ownerOfPage(page: Page | null | undefined): TabOwner | undefined {
    return page === null || page === undefined ? undefined : this.owners.get(this.tabIdOf(page));
  }

  /**
   * Saves a download into `<workspace>/downloads` under its suggested name (sanitized, numbered
   * when taken). A request in flight waits for it at most `downloadWaitMs`, then says it is still
   * in progress; the result note then comes with a later reply. Downloads in progress are
   * cancelled when together they pass `downloadMaxBytes`, so a page cannot fill the disk.
   * Without a workspace the download is cancelled.
   */
  private onDownload(page: Page, d: Download): void {
    const shown = JSON.stringify(clip(d.suggestedFilename(), 300));
    const workspace = this.workspace;
    // read now: the page may move to another conversation later, its download's notes stay
    const owner = this.ownerOfPage(page)?.owner;
    const note = (text: string) => this.noteTo(owner, text);
    if (workspace === undefined) {
      d.cancel().catch(() => undefined);
      note(
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
          if (failure !== "canceled") note(`The download of ${shown} failed: ${failure}.`);
          return;
        }
        const tmp = await d.path();
        if (statSync(tmp).size > this.downloadMaxBytes) {
          note(
            `The download of ${shown} was not saved: it is larger than ${this.downloadMaxBytes} bytes.`,
          );
          return;
        }
        target = this.saveDownload(workspace, safeFileName(d.suggestedFilename()), tmp);
        note(`Downloaded ${shown} to ${target}.`);
      } catch (e) {
        note(
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
    for (const c of this.collectors) if (c.conv === owner) c.downloads.push(entry);
  }

  /**
   * Copies a finished download from Playwright's private file into `<workspace>/downloads` and
   * returns where. The agent owns that directory, so the target is never written through a path
   * it could have swapped: each candidate is created exclusively without following a link
   * (`O_CREAT | O_EXCL | O_NOFOLLOW`), then checked to be the file the resolved path inside the
   * downloads directory names before any byte is written; a mismatch (a directory swapped for a
   * link meanwhile) writes nothing, removes the empty file it made (only while that name still
   * is the file it opened) and fails.
   */
  private saveDownload(workspace: string, name: string, source: string): string {
    const dir = this.downloadsDir(workspace);
    const dirStat = lstatSync(dir);
    const ext = extname(name);
    const stem = name.slice(0, name.length - ext.length);
    for (let i = 0; i < 1000; i++) {
      const target = join(dir, i === 0 ? name : `${stem} (${i})${ext}`);
      if (this.reservedDownloads.has(target)) continue;
      let out: number;
      try {
        out = openSync(target, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o664);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw e;
      }
      this.reservedDownloads.add(target);
      try {
        let real: string;
        try {
          real = realpathSync(target);
        } catch {
          real = "";
        }
        const opened = fstatSync(out);
        const placed = real !== "" && within(real, dir) && sameFile(opened, statSync(real));
        if (!placed || !sameFile(dirStat, lstatSync(dir))) {
          // the file landed where a swapped link pointed: take back exactly that empty file
          try {
            if (real !== "" && sameFile(opened, lstatSync(real)) && opened.size === 0)
              unlinkSync(real);
          } catch {
            // gone or changed again: never remove anything else
          }
          throw new ActionError(
            "failed",
            `${dir} changed while the download was saved; nothing was written. Retry the download.`,
          );
        }
        copyInto(source, out);
        return target;
      } finally {
        closeSync(out);
        this.reservedDownloads.delete(target);
      }
    }
    throw new ActionError("failed", `No free name for ${name} in ${dir}; remove old downloads.`);
  }

  /** `<workspace>/downloads` resolved, refusing one that is a link or not a directory. */
  private downloadsDir(workspace: string): string {
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
    return dir;
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
          this.noteTo(
            this.ownerOfPage(d.page())?.owner,
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

  /**
   * An upload's bytes, read here and handed to Chromium from memory (never a path Chromium would
   * open later, after the agent could have swapped it for a link to the service's own files):
   * opened without following a final link, then accepted only when the resolved path lies in the
   * workspace and names the very file opened (an intermediate link swapped in either way shows as
   * another file), a regular file of at most {@link UPLOAD_MAX_BYTES}.
   */
  private readUpload(path: string): { name: string; mimeType: string; buffer: Buffer } {
    const root = this.uploadRoot();
    let fd: number;
    try {
      fd = openSync(path, fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      throw new ActionError(
        "failed",
        code === "ELOOP"
          ? `${path} is a symbolic link; upload the file it points to by its own path in the workspace.`
          : `No readable file at ${path}; give the absolute path of a file in the workspace (${root}).`,
      );
    }
    try {
      const opened = fstatSync(fd);
      let real = "";
      try {
        real = realpathSync(path);
      } catch {
        real = "";
      }
      if (!within(real, root) || !sameFile(opened, statSync(real)))
        throw new ActionError(
          "failed",
          `Upload paths must be inside the workspace (${root}); copy the file there first.`,
        );
      if (!opened.isFile())
        throw new ActionError("failed", `${path} is not a regular file; upload a file.`);
      if (opened.size > UPLOAD_MAX_BYTES)
        throw new ActionError(
          "failed",
          `${path} is larger than ${UPLOAD_MAX_BYTES} bytes, the most an upload takes.`,
        );
      const buffer = Buffer.alloc(opened.size);
      let off = 0;
      while (off < buffer.length) {
        const n = readSync(fd, buffer, off, buffer.length - off, off);
        if (n === 0) break;
        off += n;
      }
      const name = basename(real);
      return {
        name,
        mimeType: UPLOAD_TYPES[extname(name).toLowerCase()] ?? "application/octet-stream",
        buffer: buffer.subarray(0, off),
      };
    } finally {
      closeSync(fd);
    }
  }

  /** The resolved workspace uploads come from. */
  private uploadRoot(): string {
    const workspace = this.workspace;
    if (workspace === undefined) {
      throw new ActionError("failed", "Uploads are unavailable: the device has no workspace.");
    }
    return realpathSync(workspace);
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
  private checkBlocked(page: Page, rawUrl: string, pageUrl?: string): Promise<boolean> {
    const proxy = this.proxy;
    // the page's owner gets the refused host (its reply's blockedHosts, its tree's viewers)
    const owner = this.ownerOfPage(page);
    if (proxy === undefined) return Promise.resolve(false);
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return Promise.resolve(false);
    }
    const host = url.hostname;
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    const key = `${owner?.owner ?? ""}\u0000${host}`;
    let probe = this.probes.get(key);
    if (probe === undefined) {
      probe = proxyRefusal(proxy, host, port).then((layer) => {
        this.probes.delete(key);
        if (layer !== null && owner !== undefined) {
          for (const c of this.collectors) if (c.conv === owner.owner) c.blocked.set(host, layer);
          // the viewers offer to allow the host: only the device's settings can (a closed
          // address stays closed whatever the device's list says)
          if (layer === "device")
            this.emit({ type: "blocked", host, url: pageUrl ?? url.href, root: owner.root });
        }
        return layer !== null;
      });
      this.probes.set(key, probe);
    }
    for (const c of this.collectors) if (c.conv === owner?.owner) c.pending.push(probe);
    return probe;
  }

  /** `value`, or `fallback` when it takes longer than {@link PAGE_QUERY_MS} (never rejects). */
  private async bounded<T>(value: Promise<T>, fallback: T): Promise<T> {
    let timer: unknown;
    try {
      return await Promise.race([
        value.catch(() => fallback),
        new Promise<T>((r) => {
          timer = this.clock.schedule(() => r(fallback), PAGE_QUERY_MS);
        }),
      ]);
    } finally {
      this.clock.cancel(timer);
    }
  }

  /**
   * The action queue a conversation's requests run in: one per conversation, so one
   * conversation's slow navigation does not stall another (ruling 7). Falling back to one
   * device-wide queue is returning a constant here.
   */
  private queueKey(conversationId: string): string {
    return conversationId;
  }

  /**
   * Runs `fn` one at a time with the conversation's other actions (`wait`, the tab list and adopt
   * run beside them).
   */
  private serial<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
    const key = this.queueKey(conversationId);
    const run = (this.queues.get(key) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => undefined);
    this.queues.set(key, tail);
    // an idle queue is dropped (the map stays bounded by the conversations with work queued)
    void tail.then(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key);
    });
    return run;
  }

  /**
   * Runs a tool request of its conversation; never throws. `takenOver` is checked when a queued
   * request leaves the queue: a takeover that began while it waited refuses it. An action already
   * running is left to finish (stopping it halfway would leave the page in an unknown state).
   */
  async run(req: ToolRequest, opts: { takenOver?: () => boolean } = {}): Promise<ToolReply> {
    const conv = req.conversationId;
    // Notes that arrived with none of the conversation's requests in flight ride its next reply
    // (device notes ride the next reply of any conversation); a failed request puts them back.
    const lateOwn = this.unreported.get(conv) ?? [];
    this.unreported.delete(conv);
    const lateAll = this.unreportedAll.splice(0);
    const c: Collector = {
      conv,
      blocked: new Map(),
      notes: [...lateAll, ...lateOwn],
      pending: [],
      downloads: [],
    };
    this.collectors.add(c);
    let reply: ToolReply;
    try {
      // the tab list and adopt only read and move what the session tracks: they answer while an
      // action runs (wait runs beside the queue too)
      const beside =
        req.op === "wait" ||
        (req.op === "tabs" && (req.action === "list" || req.action === "adopt"));
      const out = await (beside
        ? this.exec(req)
        : this.serial(conv, () => {
            if (opts.takenOver?.() === true)
              throw new ActionError("taken_over", TAKEN_OVER_MESSAGE);
            return this.exec(req);
          }));
      await this.settleProbes(c);
      await this.settleDownloads(c);
      // from here on, notes go to later replies (none is lost between this one and the next)
      this.collectors.delete(c);
      const page = this.currentPage(conv);
      if (page !== undefined && isActing(req)) {
        this.tabUsedAt.set(this.tabIdOf(page), this.clock.now());
        this.actedSeq.set(conv, ++this.actSeq);
      }
      // a verification page goes to the person, said first so the agent hands off
      // (not for the tab list or adopt, which run beside a navigation and only read the tabs)
      const verifying =
        page === undefined ||
        (req.op === "tabs" && (req.action === "list" || req.action === "adopt"))
          ? false
          : await this.checkVerification(page, this.tabIdOf(page));
      const text = [
        ...(verifying ? [VERIFICATION_NOTE] : []),
        ...c.notes,
        ...(out.text === undefined ? [] : [out.text]),
      ].join("\n");
      reply = {
        ok: true,
        ...(page === undefined ? {} : { page: await this.pageInfo(page) }),
        blockedHosts: blockedHostsOf(c),
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
        // the plugin server adds the one next step (the network ask or note), so no advice here
        message = blockedMessage(blockedHostsOf(c));
      }
      reply = { ok: false, error: code, message, blockedHosts: blockedHostsOf(c) };
      if (lateOwn.length > 0)
        this.unreported.set(conv, [...lateOwn, ...(this.unreported.get(conv) ?? [])]);
      this.unreportedAll.unshift(...lateAll);
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

  /**
   * Finds the loaded page's icon and fetches it through the browser (the device's network rules
   * apply); a new address replaces the tab's icon, the same one is not fetched again. Any failure
   * leaves no icon (the panel's placeholder) and never affects the page.
   */
  private async resolveFavicon(page: Page, id: string): Promise<void> {
    try {
      const url = await iconUrlOf(page);
      if (this.pages.get(id) !== page) return;
      if (url === null) {
        if (this.favicons.delete(id)) this.emit({ type: "state" });
        return;
      }
      if (this.favicons.get(id)?.url === url) return;
      const cdp = await this.ctx.newCDPSession(page);
      let data: string | null = null;
      try {
        const bytes = await fetchIcon(cdp, url);
        data = bytes === null ? null : await iconForPanel(cdp, bytes);
      } finally {
        await cdp.detach().catch(() => undefined);
      }
      if (this.pages.get(id) !== page) return;
      this.favicons.set(id, { url, data });
      this.emit({ type: "state" });
    } catch {
      // a closed page or a refused fetch: no icon
    }
  }

  /**
   * Looks at the tab's page now and records or clears its verification blocker; true when it
   * shows a verification page.
   */
  private async checkVerification(page: Page, id: string): Promise<boolean> {
    if (id === "") return false;
    // bounded: a page whose navigation hangs keeps locator queries waiting (no timeout of their own)
    const blocked = await this.bounded(isVerificationPage(page, this.docStatus.get(id)), false);
    if (this.pages.get(id) !== page) return false;
    const before = this.blockers.get(id);
    if (blocked) {
      const url = clip(page.url(), MAX_URL_CHARS);
      if (before?.url !== url) {
        this.blockers.set(id, { kind: "verification", url });
        this.emit({ type: "state" });
      }
    } else if (before !== undefined) {
      this.blockers.delete(id);
      this.emit({ type: "state" });
    }
    return blocked;
  }

  async pageInfo(page: Page): Promise<{ url: string; title: string; tabId: string }> {
    const known = this.titles.get(this.tabIdOf(page)) ?? "";
    const title = await this.bounded(
      page.title().catch(() => known),
      known,
    );
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
          .waitForEvent("domcontentloaded", { timeout: this.navigationTimeoutMs })
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

  private markClick(page: Page, x: number, y: number): void {
    this.clicks.set(this.tabIdOf(page), { x, y, seq: ++this.clickSeq });
  }

  private async goto(page: Page, url: string): Promise<void> {
    let res: Awaited<ReturnType<Page["goto"]>>;
    // registered first: Playwright may reject the navigation just before it emits the download
    const download = page.waitForEvent("download", { timeout: ACTION_TIMEOUT_MS });
    download.catch(() => undefined);
    // The main frame's navigations while this one runs: another navigation to the same address
    // (a tab restored at start, the address bar) aborts this one but still lands on its page.
    // Following it shares the navigation's own deadline: an aborted navigate takes no longer.
    const deadline = Date.now() + this.navigationTimeoutMs;
    const watch = new NavWatch(page, url, () => this.pendingNavs.get(page));
    try {
      res = await this.gotoPastNetworkChange(page, url, watch, deadline);
    } catch (e) {
      const msg = firstLine(e);
      // a URL that is a file download: it is saved and reported (onDownload), not an error
      if (msg.includes("Download is starting")) {
        await download.catch(() => undefined);
        return;
      }
      if (isTimeout(e)) throw await this.navigationTimedOut(page, url);
      if (!msg.includes("net::ERR_ABORTED")) throw await this.navigationFailed(page, e, url, msg);
      const out = await watch.follow(deadline);
      if (out.kind !== "loaded") {
        const status = await watch.emptyAnswer();
        if (status !== undefined)
          throw new ActionError(
            "failed",
            `${url} answered ${status} with no page to show; the tab shows ${page.url()}.`,
          );
      }
      if (out.kind === "none") throw e;
      if (out.kind === "failed") {
        // the navigation that took over failed: that failure is this one's
        throw await this.navigationFailed(
          page,
          new Error(`${out.error} at ${out.url}`),
          out.url,
          out.error,
        );
      }
      res = out.response;
    } finally {
      watch.dispose();
    }
    // a plain-http request the proxy refuses loads its 403 page instead of failing
    if (res?.status() === 403 && (await this.checkBlocked(page, res.url()))) {
      throw new ActionError(
        "blocked",
        `The device's network settings block ${new URL(res.url()).hostname}.`,
      );
    }
    await page.waitForLoadState("load", { timeout: LOAD_GRACE_MS }).catch(() => undefined);
  }

  /**
   * `goto` past a change of the device's network (an interface came or went: Wi-Fi, a VPN, a
   * container network): Chromium answers net::ERR_NETWORK_CHANGED and may keep or restart the
   * navigation itself, so it is followed first (like one another navigation took over) and run
   * again only when none goes on, at most {@link NETWORK_CHANGED_ATTEMPTS} times, within the
   * navigation's deadline.
   */
  private async gotoPastNetworkChange(
    page: Page,
    url: string,
    watch: NavWatch,
    deadline: number,
  ): Promise<Awaited<ReturnType<Page["goto"]>>> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.gotoPastLateErrorPage(page, url, watch, deadline);
      } catch (e) {
        if (!firstLine(e).includes("net::ERR_NETWORK_CHANGED")) throw e;
        const out = await watch.follow(deadline);
        if (out.kind === "loaded") return out.response;
        // only a navigation the network change itself dropped runs again: an abort may be a
        // download or another navigation taking over, never fetched again
        if (out.kind === "failed" && !out.error.includes("ERR_NETWORK_CHANGED"))
          throw new Error(`${out.error} at ${out.url}`);
        if (attempt >= NETWORK_CHANGED_ATTEMPTS || Date.now() >= deadline) throw e;
      }
    }
  }

  /**
   * `page.goto`, past the late error page of the tab's previous failed or stopped navigation:
   * Chromium can commit that page after Playwright reported the failure (the Linux full build),
   * and its commit interrupts a navigation started meanwhile. Then this navigation is followed
   * when it went on in Chromium, and otherwise started once more (the error page is in now),
   * within the navigation's own deadline.
   */
  private async gotoPastLateErrorPage(
    page: Page,
    url: string,
    watch: NavWatch,
    deadline: number,
  ): Promise<Awaited<ReturnType<Page["goto"]>>> {
    try {
      return await page.goto(url, { waitUntil: "domcontentloaded" });
    } catch (e) {
      if (!ERROR_PAGE_INTERRUPT_RE.test(firstLine(e))) throw e;
      const out = await watch.follow(deadline);
      if (out.kind === "loaded") return out.response;
      // aborted: the error page took the frame from it, so it runs again; a real net error is its own
      if (out.kind === "failed" && !out.error.includes("net::ERR_ABORTED"))
        throw new Error(`${out.error} at ${out.url}`);
      return page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: Math.max(1, deadline - Date.now()),
      });
    }
  }

  /**
   * The error of a navigation that failed with Chromium's net error `error`: a host the proxy
   * refuses is reported as blocked (`run` turns `original` into the blocked reply); any other net
   * error is `unreachable`, saying what the device's network answered when it went through it.
   */
  private async navigationFailed(
    page: Page,
    original: unknown,
    url: string,
    error: string,
  ): Promise<unknown> {
    const net = /net::(ERR_[A-Z_]+)/.exec(error)?.[1];
    // an abort is not the site's failure: another navigation replaced this one
    if (net === undefined || net === "ERR_ABORTED") return original;
    await this.errorPageCommitted(page);
    const proxied = PROXY_FAILURE_RE.test(error);
    if (proxied && (await this.checkBlocked(page, url))) return original;
    // a connection-level failure through the device's proxy: what the proxy answers for the host
    // says whether the host, the network rules or the device's network itself is the cause
    if (proxied || NETWORK_ERROR_RE.test(net)) {
      const verdict = await this.networkVerdict(url);
      if (verdict?.kind === "proxy_down")
        return new ActionError(
          "network_unavailable",
          `${url} could not be loaded (net::${net}): ${verdict.text}`,
        );
      if (verdict !== undefined && verdict.text !== "")
        return new ActionError(
          "unreachable",
          `${url} could not be loaded (net::${net}): ${verdict.text}`,
        );
    }
    const meaning = NET_ERROR_MEANINGS[net];
    return new ActionError(
      "unreachable",
      `${url} could not be loaded (net::${net})${meaning === undefined ? "." : `: ${meaning}.`}`,
    );
  }

  /**
   * Waits (at most {@link ERROR_PAGE_WAIT_MS}) for the error page of the main frame's failed
   * navigation: Chromium commits it after Playwright reported the failure (the Linux full build
   * shows it), and a navigation started before that commit is interrupted by it.
   */
  private async errorPageCommitted(page: Page): Promise<void> {
    if (page.isClosed() || page.mainFrame().url().startsWith("chrome-error:")) return;
    await page
      .waitForEvent("framenavigated", {
        predicate: (f) => f === page.mainFrame() && f.url().startsWith("chrome-error:"),
        timeout: ERROR_PAGE_WAIT_MS,
      })
      .catch(() => undefined);
  }

  /**
   * The error of a navigation that took longer than its time limit. The navigation is stopped
   * first (a navigation left in flight keeps the page's scripts and snapshots waiting for a
   * document that never comes), so the tab goes back to the page it showed and the next request
   * works on it; the message says what the device's network answered for the host.
   */
  private async navigationTimedOut(page: Page, url: string): Promise<ActionError> {
    await this.stopNavigation(page);
    const seconds = Math.round(this.navigationTimeoutMs / 1000);
    const verdict = await this.networkVerdict(url, true);
    const detail =
      verdict === undefined || verdict.text === "" ? "no page came in that time." : verdict.text;
    const now = page.isClosed() ? "" : ` The navigation was stopped; the tab shows ${page.url()}.`;
    return new ActionError(
      verdict?.kind === "proxy_down" ? "network_unavailable" : "unreachable",
      `${url} did not load within ${seconds} s: ${detail}${now}`,
    );
  }

  /** Stops the page's navigation in flight (Chromium's stop button); never throws. */
  private async stopNavigation(page: Page): Promise<void> {
    if (page.isClosed()) return;
    try {
      const cdp = await this.ctx.newCDPSession(page);
      try {
        await cdp.send("Page.stopLoading");
      } finally {
        await cdp.detach().catch(() => undefined);
      }
    } catch {
      // a page closing meanwhile: nothing left to stop
    }
    this.pendingNavs.delete(page);
    const id = this.ids.get(page);
    if (id !== undefined && this.loadingTabs.delete(id)) this.emit({ type: "state" });
  }

  /**
   * What the device's proxy answers for the URL's host, and as a sentence (undefined without a
   * proxy). `timedOut`: the navigation got no page in time.
   */
  private async networkVerdict(
    rawUrl: string,
    timedOut = false,
  ): Promise<{ kind: ProxyVerdict; text: string } | undefined> {
    if (this.proxy === undefined) return undefined;
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return undefined;
    }
    const host = url.hostname;
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    const answer = await probeProxy(this.proxy, host, port);
    return { kind: answer.verdict, text: this.verdictText(answer, host, port, timedOut) };
  }

  /** The sentence for a proxy's {@link ProxyAnswer} ("" when it says nothing). */
  private verdictText(answer: ProxyAnswer, host: string, port: number, timedOut: boolean): string {
    switch (answer.verdict) {
      case "proxy_down":
        // the device's own network, not the address: nothing loads until it is back
        return "the device's network proxy is not reachable, so no page loads on the device right now; this is not a problem of the address.";
      case "unreachable":
        return `the device's network could not connect to ${host}:${port} (the name did not resolve, or the host refused or did not answer the connection).`;
      case "no_answer":
        return `the device's network got no answer from ${host}:${port}.`;
      case "connected":
        return timedOut
          ? `${host} accepted the connection through the device's network but sent no page in that time.`
          : `the device's network connects to ${host}:${port}, but the connection failed.`;
      case "refused":
        // checkBlocked reports it (a navigation that timed out is refused only if the rules changed)
        return refusalLayer(answer.reason) === "address"
          ? `${host} resolves to a private or local address on the device, which the browser never reaches from the sandbox.`
          : `the device's network settings block ${host}.`;
      default:
        return "";
    }
  }

  private async exec(req: ToolRequest): Promise<{ text?: string; image?: string }> {
    const conv = req.conversationId;
    const root = req.rootConversationId;
    const activePage = () => this.pageFor(conv, root);
    switch (req.op) {
      case "navigate": {
        const page = await activePage();
        if (req.url !== undefined) {
          await this.goto(page, normalizeUrl(req.url));
        } else if (req.action === "back" || req.action === "forward") {
          const r = await (req.action === "back" ? page.goBack() : page.goForward()).catch(
            async (e: unknown) => {
              if (isTimeout(e)) throw await this.navigationTimedOut(page, page.url());
              throw e;
            },
          );
          if (r === null && page.url() === "about:blank") {
            return { text: `No ${req.action === "back" ? "earlier" : "later"} page in this tab.` };
          }
        } else if (req.action === "reload") {
          await page.reload({ waitUntil: "domcontentloaded" }).catch(async (e: unknown) => {
            if (isTimeout(e)) throw await this.navigationTimedOut(page, page.url());
            throw e;
          });
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
        return { text: await takeSnapshot(await activePage()) };
      case "click":
      case "hover": {
        const page = await activePage();
        const loc = await this.locate(page, req.ref);
        if (req.op === "hover") {
          await loc.hover();
          return {};
        }
        const at = await this.centerOf(loc);
        if (at !== undefined) this.markClick(page, at.x, at.y);
        await this.settled(page, () => loc.click());
        return {};
      }
      case "type": {
        const page = await activePage();
        const loc = await this.locate(page, req.ref);
        await loc.fill(req.text);
        if (req.submit === true) await this.settled(page, () => loc.press("Enter"));
        return {};
      }
      case "select": {
        const page = await activePage();
        const loc = await this.locate(page, req.ref);
        const chosen = await this.settled(page, () => loc.selectOption(req.values));
        return { text: `Selected ${JSON.stringify(chosen)}.` };
      }
      case "press": {
        const page = await activePage();
        await this.settled(page, () => page.keyboard.press(req.key));
        return {};
      }
      case "scroll": {
        const page = await activePage();
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
        const page = await activePage();
        const file = this.readUpload(req.path);
        const loc = await this.locate(page, req.ref);
        await loc.setInputFiles(file);
        return {};
      }
      case "click_at":
      case "type_at": {
        const page = await activePage();
        this.checkPoint(req.x, req.y);
        this.markClick(page, Math.round(req.x), Math.round(req.y));
        await this.settled(page, () => page.mouse.click(req.x, req.y));
        if (req.op === "type_at") await page.keyboard.type(req.text);
        return {};
      }
      case "wait":
        // never claims or opens a tab (it also runs while the person holds control)
        return this.waitOp(req, this.currentPage(conv));
      case "screenshot": {
        const page = await activePage();
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
    const conv = req.conversationId;
    const root = req.rootConversationId;
    switch (req.action) {
      case "list":
        // never opens a tab (it runs beside the actions; a navigation may be opening one)
        return { text: await this.listText(conv, root) };
      case "open": {
        // a conversation's first tab may be the unowned blank one: that is a new tab too
        const page =
          this.countOf(conv) === 0
            ? await this.pageFor(conv, root)
            : await this.openTab(conv, root);
        if (req.url !== undefined) await this.goto(page, normalizeUrl(req.url));
        return {};
      }
      case "switch": {
        this.ownTab(conv, req.tabId);
        this.setActive(conv, req.tabId as string);
        return {};
      }
      case "close": {
        const page = this.ownTab(conv, req.tabId);
        await page.close();
        return {};
      }
      case "adopt": {
        const id = req.tabId;
        const result = this.adopt(conv, root, this.tabIdOf(this.tabById(id)));
        if (result === "in_use") throw new ActionError("failed", tabInUse(id ?? ""));
        if (result === "cap") throw new ActionError("failed", CONVERSATION_CAP_MESSAGE);
        return {};
      }
    }
    throw new ActionError("failed", "tabs needs an action: list, open, switch, close or adopt.");
  }

  /** The conversation's own tab `tabId`; another conversation's is refused with what to do. */
  private ownTab(conversationId: string, tabId: string | undefined): Page {
    const page = this.tabById(tabId);
    if (this.owners.get(tabId as string)?.owner !== conversationId)
      throw new ActionError("failed", notYourTab(tabId as string));
    return page;
  }

  /**
   * The tab list of a conversation: its own tabs, then its tree's other tabs, then other trees'
   * tabs (unowned ones too, but not a blank start tab), with ids, titles clipped to
   * OTHER_TITLE_CHARS and URLs without query or fragment outside its own; no conversation ids.
   */
  private async listText(conversationId: string, root: string): Promise<string> {
    const own: string[] = [];
    const tree: string[] = [];
    const device: string[] = [];
    for (const [id, p] of this.live()) {
      const o = this.owners.get(id);
      if (o?.owner === conversationId) {
        const info = await this.pageInfo(p);
        const active = this.activeOf.get(conversationId) === id ? " (active)" : "";
        own.push(`${id}${active}: ${info.title || "(no title)"} ${info.url}`);
        continue;
      }
      if (isStartBlank({ owner: o?.owner, url: p.url() })) continue;
      const title = clip(this.titles.get(id) ?? "", OTHER_TITLE_CHARS) || "(no title)";
      const line = `${id}: ${title} ${bareUrl(clip(p.url(), MAX_URL_CHARS))}`;
      if (o !== undefined && o.root === root) tree.push(line);
      else device.push(line);
    }
    const lines = [...own];
    if (tree.length > 0) lines.push("Tabs of other conversations in this task:", ...tree);
    if (device.length > 0) lines.push("Tabs of other conversations on this device:", ...device);
    if (tree.length + device.length > 0)
      lines.push(
        "To use another conversation's tab, call browser_tabs with action adopt and its tabId.",
      );
    if (lines.length === 0) return "No browser tabs are open.";
    return lines.join("\n");
  }

  tabById(tabId: string | undefined): Page {
    const page = this.pageById(tabId);
    if (page === undefined) {
      throw new ActionError(
        "failed",
        `No tab ${JSON.stringify(tabId ?? "")}; list the tabs to see their ids.`,
      );
    }
    return page;
  }

  /** Brings a tab to the front of the window (only a viewer in control decides what is front). */
  async bringToFront(tabId: string): Promise<void> {
    await this.pageById(tabId)
      ?.bringToFront()
      .catch(() => undefined);
  }

  /** Navigates a tab for a viewer (address bar, back, forward, reload); never throws. */
  async viewerNav(
    page: Page,
    nav: { url?: string; action?: "back" | "forward" | "reload" },
  ): Promise<void> {
    try {
      if (nav.url !== undefined) await this.goto(page, normalizeUrl(nav.url));
      else if (nav.action === "back") await page.goBack();
      else if (nav.action === "forward") await page.goForward();
      else if (nav.action === "reload") await page.reload();
    } catch {
      // the page shows the failure; a refused host arrives as a blocked message
    }
  }

  private async waitOp(
    req: Extract<ToolRequest, { op: "wait" }>,
    page: Page | undefined,
  ): Promise<{ text?: string }> {
    const asked = Number(req.timeoutMs);
    const timeout = Number.isFinite(asked)
      ? Math.max(0, Math.min(MAX_WAIT_MS, Math.floor(asked)))
      : DEFAULT_WAIT_MS;
    if (page === undefined) {
      if (req.text !== undefined || req.ref !== undefined || req.navigation === true)
        throw new ActionError("failed", NO_TAB_TO_WAIT_ON);
      await new Promise<void>((r) => this.clock.schedule(r, timeout));
      return {};
    }
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
