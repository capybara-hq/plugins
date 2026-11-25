// The browser panel (browser use spec §8): the live view of the agent's browser in the
// conversation's right panel. It runs in the sandboxed embed iframe, so it talks to the host only
// through the embed bridge and to the plugin only through relative routes (`stream-ticket`,
// `network-hosts`, `handoff-answer`) plus the ticket's WebSocket. Every (re)connect rebuilds the
// whole UI from the daemon's first `state` message; nothing else survives an iframe remount (the
// opaque-origin sandbox has no usable storage). The host keeps the frame mounted across its full
// mode and tells the panel the mode it draws (`panel-mode` after `init` and on every change).
// Every viewer is the conversation owner's, so any non-compact panel is interactive while the
// person holds control, whichever panel took it; in the watch state (the agent drives) the panel
// is read-only, and the daemon drops input anyway. Takeover input (pointer, cursor, keys, IME,
// paste) lives in input.ts.
import type { ViewerFrame, ViewerIn, ViewerOut, ViewerTab } from "../../daemon/protocol.js";
import { decodeFrame, isIconDataUrl, VIEWPORT } from "../../daemon/protocol.js";
import { type Locale, type StringKey, t } from "./i18n.js";
import { mountInput } from "./input.js";
import { ICONS } from "./page.js";

const PROTOCOL = "capybara-embed/1";
const ASPECT = VIEWPORT.width / VIEWPORT.height;
/** The side view's frame budget; the expanded view (a takeover) may ask for the full viewport. */
const SIDE_MAX_WIDTH = 640;
/**
 * Frames are sized to the picture's CSS box times the device pixel ratio, capped here: a Retina
 * screen at 2x would ask four times the bytes of 1x for text that reads well at 1.25x.
 */
const MAX_DPR = 1.25;
/** The ground around the picture (CSS `#stage` padding). */
const STAGE_PAD = 12;
const HIDDEN_CLOSE_MS = 60_000;
const COMPACT_BELOW = 600;
/**
 * Backoff of the retries of a 4404 that follows a live view (the service restarting, e.g. after an
 * allow) before "not running". A 4404 before any live view is "not running" at once.
 */
const RESTART_RETRY_MS = [1000, 3000] as const;
/** The "not running" state looks for the browser this often while visible, for this long. */
const EMPTY_POLL_MS = 10_000;
const EMPTY_POLL_FOR_MS = 30 * 60_000;
/** How long a dialog or notice strip stays up. */
const STRIP_MS = 10_000;
/** How long an allowed page is opened again on a new connection (a restarted daemon). */
const PENDING_NAV_MS = 30_000;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The largest 16:10 rectangle centred in a panel of the given size. */
export function letterbox(width: number, height: number): Rect {
  let w = width;
  let h = Math.round(w / ASPECT);
  if (h > height) {
    h = height;
    w = Math.round(h * ASPECT);
  }
  return { x: Math.round((width - w) / 2), y: Math.round((height - h) / 2), w, h };
}

/** Maps a point inside the drawn picture (rect-relative CSS pixels) to viewport coordinates. */
export function mapPoint(px: number, py: number, rect: Rect): { x: number; y: number } {
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v));
  return {
    x: Math.round(clamp(px / rect.w, 1) * VIEWPORT.width),
    y: Math.round(clamp(py / rect.h, 1) * VIEWPORT.height),
  };
}

interface Socket {
  binaryType: string;
  onopen: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e: { code: number }) => void) | null;
  onerror: (() => void) | null;
  send(data: Uint8Array): void;
  close(): void;
}

export interface PanelOptions {
  window: Window & typeof globalThis;
  fetch?: typeof fetch;
  WebSocket?: new (url: string) => Socket;
  /** Sends a message to the host page (the embed bridge). */
  post?: (msg: unknown) => void;
  /** Decodes a JPEG into something drawable. */
  decode?: (jpeg: Uint8Array) => Promise<CanvasImageSource>;
}

interface Observer {
  observe(el: Element): void;
}

type View = "connecting" | "live" | "empty" | "offline" | "error";

export function mountPanel(opts: PanelOptions): void {
  const win = opts.window;
  const doc = win.document;
  const doFetch = opts.fetch ?? win.fetch.bind(win);
  const SocketCtor = opts.WebSocket ?? (win.WebSocket as unknown as new (url: string) => Socket);
  const post = opts.post ?? ((m: unknown) => win.parent.postMessage(m, "*"));
  const decode =
    opts.decode ??
    ((jpeg: Uint8Array) =>
      win.createImageBitmap(new Blob([jpeg as BlobPart], { type: "image/jpeg" })));

  const $ = <T extends HTMLElement>(id: string) => doc.getElementById(id) as T;
  const view = $<HTMLCanvasElement>("view");
  const stage = $("stage");
  const url = $<HTMLInputElement>("url");

  let locale: Locale = "en";
  let token = "";
  let started = false;
  let gen = 0;
  let sock: Socket | null = null;
  let mode: View = "connecting";
  let tabs: ViewerTab[] = [];
  let control: "agent" | "user" = "agent";
  let lastState: Extract<ViewerOut, { t: "state" }> | null = null;
  let retried401 = false;
  let attempts = 0;
  let restartRetries = 0;
  /** The last connection showed the browser: a 4404 now may be a restart, retried before "not running". */
  let wasLive = false;
  /** This connection is a quiet look for the browser from "not running": it stays there until a state. */
  let quiet = false;
  /**
   * The host shows this panel full: the frame fills the box, no resize. Only the host's
   * `panel-mode` sets it (after `init` and on every change, whoever made it: this panel's ask on
   * take over, the host's close control or Esc, the host refusing full mode on a phone).
   */
  let full = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let emptyTimer: ReturnType<typeof setTimeout> | undefined;
  let emptySince: number | undefined;
  let dialogTimer: ReturnType<typeof setTimeout> | undefined;
  let dialogUrl: string | undefined;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  /** The page an allow opens, sent again on the first state of a new connection. */
  let pendingNav: { url: string; sentOn: Socket | null; until: number } | null = null;
  /** The newest agent click this panel has seen (flash only newer ones). */
  let seenClick: number | undefined;
  let hiddenTimer: ReturnType<typeof setTimeout> | undefined;
  let pausedForHidden = false;
  let blockedHost = "";
  let blockedUrl = "";
  let pendingHandoff: { callId: string; message: string } | null = null;
  let sentSize = "";
  let image: CanvasImageSource | null = null;
  /** The layer the panel shows now (see `renderLoading`). */
  let shown: "idle" | "skeleton" | "app" = "skeleton";

  /**
   * Watch only on a phone (the host's compact size class, a pushed page): the device's screen,
   * never the panel's width, so a narrow side panel on a desktop still offers take over.
   */
  const compact = (): boolean => {
    const sw = win.screen?.width ?? 0;
    return sw > 0 && sw < COMPACT_BELOW;
  };
  const text = (key: StringKey) => t(locale, key);
  /** The person drives the page from this panel: any non-compact panel while they hold control. */
  const interactive = (): boolean => !compact() && control === "user";

  function send(msg: ViewerIn): void {
    if (sock === null) return;
    sock.send(new TextEncoder().encode(JSON.stringify(msg)));
  }
  const input = mountInput({
    window: win,
    view,
    stage,
    send,
    interactive: () => interactive(),
    toPage: (clientX, clientY) => {
      const r = view.getBoundingClientRect();
      return mapPoint(clientX - r.left, clientY - r.top, { x: 0, y: 0, w: r.width, h: r.height });
    },
    label: t(locale, "view"),
  });
  /** Asks the host to enter or leave full mode; the host's own `panel-mode` says what it did. */
  function askMode(next: boolean): void {
    post({ protocol: PROTOCOL, type: "panel-mode", full: next });
  }
  /** The host's `panel-mode`: the mode it draws this panel in. */
  function hostMode(next: boolean): void {
    if (next === full) return;
    full = next;
    onBoxChange();
  }

  // ---- rendering ----

  function setLabels(): void {
    const set = (id: string, key: StringKey) => {
      $(id).textContent = text(key);
    };
    set("takeover", "takeover");
    set("handback", "handback");
    set("verify-title", "verifyTitle");
    set("verify-body", "verifyBody");
    set("verify-go", "verifyGo");
    set("skeleton-status", "statusConnecting");
    set("allow", "allow");
    set("reconnect", "reconnect");
    set("blocked-label", "blocked");
    set("dialog-label", "dialog");
    set("handoff-label", "handoff");
    set("handoff-done", "handoffDone");
    set("handoff-cancel", "handoffCancel");
    input.sink.setAttribute("aria-label", text("view"));
    $("lock").setAttribute("aria-label", text("secure"));
    $("lock").setAttribute("title", text("secure"));
    for (const [id, key] of [
      ["back", "back"],
      ["forward", "forward"],
      ["reload", "reload"],
      ["more", "more"],
    ] as const) {
      $(id).setAttribute("aria-label", text(key));
      $(id).setAttribute("title", text(key));
    }
    url.setAttribute("aria-label", text("address"));
    view.setAttribute("aria-label", text("view"));
    doc.title = text("title");
    doc.documentElement.lang = locale;
  }

  /** The status line: an icon, a lead and a detail, in one fixed-height line. */
  function renderStatus(): void {
    const el = $("status");
    el.setAttribute("data-control", control);
    let tone: "agent" | "user" | "quiet" = "quiet";
    let icon = "";
    let lead: StringKey | null = null;
    let detail: StringKey | null = null;
    if (mode === "connecting") lead = "statusConnecting";
    else if (mode === "live" && control === "user") {
      if (interactive()) {
        tone = "user";
        icon = ICONS.hand;
        lead = "statusUser";
        detail = "statusUserDetail";
      } else lead = "statusUserElsewhere";
    } else if (mode === "live") {
      tone = "agent";
      const loading = lastState?.loading === true;
      icon = loading ? ICONS.spin : ICONS.dot;
      lead = "statusAgent";
      if (loading) detail = "statusLoading";
    }
    el.setAttribute("data-tone", tone);
    $("status-icon").innerHTML = icon;
    $("status-lead").textContent = lead === null ? "" : text(lead);
    $("status-detail").textContent = detail === null ? "" : ` · ${text(detail)}`;
  }

  function renderChrome(): void {
    const watchOnly = compact();
    // the watch state is read-only: navigation and tabs only while the person drives
    const readOnly = !interactive();
    const isLive = mode === "live";
    $("takeover").hidden = watchOnly || !isLive || control === "user";
    $("handback").hidden = watchOnly || !isLive || control !== "user";
    // the takeover slot stays reserved unless hand back takes it or the device only watches
    $("takeover").toggleAttribute("data-gone", watchOnly || (isLive && control === "user"));
    // the active tab shows a verification page (the daemon's tab blocker, cleared on its next
    // navigation)
    const verifying =
      isLive &&
      control === "agent" &&
      tabs.find((x) => x.active)?.blocker?.kind === "verification" &&
      !watchOnly;
    $("verify").hidden = !verifying;
    // one primary action: while a verification waits, take over steps back
    $("takeover").className = verifying ? "secondary" : "primary";
    $("handoff").hidden = pendingHandoff === null || verifying;
    $("status").hidden = verifying || pendingHandoff !== null;
    $("stage").setAttribute("data-control", isLive ? control : "agent");
    $("field").toggleAttribute("data-edit", interactive());
    for (const id of ["back", "forward", "reload"])
      ($(id) as HTMLButtonElement).disabled = readOnly;
    ($("more") as HTMLButtonElement).disabled = readOnly;
    ($("tabsbtn") as HTMLButtonElement).disabled = readOnly;
    url.readOnly = readOnly;
    input.sync();
    $("lock").hidden = !isLive || lastState?.secure !== true;
    const showEmpty = mode === "empty" || mode === "offline" || mode === "error";
    $("reconnect").hidden = !showEmpty;
    const keys: Record<string, [StringKey, StringKey]> = {
      empty: ["emptyTitle", "emptyBody"],
      offline: ["offlineTitle", "offlineBody"],
      error: ["errorTitle", "errorBody"],
    };
    const k = keys[mode];
    if (k !== undefined) {
      $("empty-title").textContent = text(k[0]);
      $("empty-body").textContent = text(k[1]);
    }
    $("blocked").hidden = blockedHost === "";
    $("blocked-host").textContent = blockedHost;
    renderStatus();
    renderLoading();
  }

  /**
   * Which of the three layers shows; each is the whole panel and only one is visible:
   * - `idle`: no browser to show (not running, offline, error): the centred idle state alone,
   *   with no tabs, toolbar or status line (nothing to navigate);
   * - `skeleton`: a connection on its way (or live without its first frame yet);
   * - `app`: the live panel, once the browser's state and its first frame are there.
   * A browser that comes up from the idle state (a quiet look found it) keeps the idle state until
   * its first frame and then switches once to the live panel, as from the skeleton.
   */
  function renderLoading(): void {
    const idleMode = mode === "empty" || mode === "offline" || mode === "error";
    let next: "idle" | "skeleton" | "app";
    if (idleMode) next = "idle";
    else if (mode === "live" && image !== null) next = "app";
    else if (mode === "live" && shown === "idle") next = "idle";
    else next = "skeleton";
    shown = next;
    $("app").toggleAttribute("data-loading", next === "skeleton");
    $("app").toggleAttribute("data-idle", next === "idle");
    $("skeleton").hidden = next !== "skeleton";
    $("empty").hidden = next !== "idle";
    if (next === "app") onBoxChange();
  }

  function renderTabs(): void {
    const box = $("tabs");
    box.textContent = "";
    const watchOnly = !interactive();
    for (const tab of tabs) {
      const el = doc.createElement("div");
      el.className = "tab";
      el.setAttribute("role", "tab");
      el.setAttribute("data-active", String(tab.active));
      el.setAttribute("aria-selected", String(tab.active));
      el.appendChild(favOf(tab));
      const label = doc.createElement("button");
      label.type = "button";
      label.className = "label";
      label.textContent = tabName(tab);
      label.title = tabName(tab);
      label.disabled = watchOnly;
      label.addEventListener("click", () => send({ t: "tab", action: "switch", tabId: tab.id }));
      el.appendChild(label);
      // close only while the person is in control (the design's take over state)
      if (!watchOnly && tab.active && control === "user") {
        const close = doc.createElement("button");
        close.type = "button";
        close.className = "x";
        close.innerHTML = ICONS.close;
        close.setAttribute("aria-label", text("closeTab"));
        close.addEventListener("click", () => send({ t: "tab", action: "close", tabId: tab.id }));
        el.appendChild(close);
      }
      box.appendChild(el);
    }
    if (!watchOnly) {
      const add = doc.createElement("button");
      add.type = "button";
      add.className = "add";
      add.innerHTML = ICONS.plus;
      add.setAttribute("aria-label", text("newTab"));
      add.addEventListener("click", () => send({ t: "tab", action: "open" }));
      box.appendChild(add);
    }
    // narrow panels: one button for the tabs and the address
    const active = tabs.find((x) => x.active);
    $("tabsbtn").querySelector(".fav")?.replaceWith(favOf(active));
    $("tabsbtn-name").textContent =
      active === undefined ? "" : hostOf(active.url) || tabName(active);
    $("tabsbtn-count").textContent = String(tabs.length);
    $("tabsbtn").setAttribute("aria-label", `${text("tabs")}: ${tabs.length}`);
  }

  // a blank tab (about:blank, the tab left after the last one closed) reads as a new tab
  const tabName = (tab: ViewerTab): string =>
    tab.title !== "" ? tab.title : tab.url === "about:blank" ? text("newTab") : tab.url;
  /** The tab's site icon (the daemon's data URL), or the placeholder square. */
  function favOf(tab: ViewerTab | undefined): HTMLElement {
    if (tab !== undefined && isIconDataUrl(tab.favicon)) {
      const img = doc.createElement("img");
      img.className = "fav";
      img.alt = "";
      img.src = tab.favicon;
      // an icon the browser cannot draw falls back to the placeholder
      img.addEventListener("error", () => img.replaceWith(favOf(undefined)), { once: true });
      return img;
    }
    const fav = doc.createElement("span");
    fav.className = "fav";
    return fav;
  }
  function hostOf(u: string): string {
    try {
      return new URL(u).host;
    } catch {
      return "";
    }
  }

  /** The address as host (ink) and the rest (muted) while the field is not being edited. */
  function renderUrl(u: string): void {
    let host = u;
    let rest = "";
    try {
      const p = new URL(u);
      if (p.protocol === "http:" || p.protocol === "https:") {
        host = p.host;
        rest = `${p.pathname === "/" ? "" : p.pathname}${p.search}${p.hash}`;
      }
    } catch {
      // not a URL (about:blank and the like): shown as it is
    }
    $("urltext-host").textContent = host;
    $("urltext-path").textContent = rest;
  }

  // ---- menus (narrow panels) ----

  function openMenu(
    anchor: HTMLElement,
    items: { label: string; current?: boolean; run(): void }[],
  ): void {
    const menu = $("menu");
    menu.textContent = "";
    for (const it of items) {
      const b = doc.createElement("button");
      b.type = "button";
      b.setAttribute("role", "menuitem");
      b.textContent = it.label;
      if (it.current) b.setAttribute("aria-current", "true");
      b.addEventListener("click", () => {
        closeMenu();
        it.run();
      });
      menu.appendChild(b);
    }
    const r = anchor.getBoundingClientRect();
    menu.style.top = `${Math.round(r.bottom + 4)}px`;
    menu.style.right = `${Math.max(12, Math.round(win.innerWidth - r.right))}px`;
    menu.hidden = false;
    anchor.setAttribute("aria-expanded", "true");
    (menu.firstElementChild as HTMLElement | null)?.focus();
  }
  function closeMenu(): void {
    $("menu").hidden = true;
    $("tabsbtn").removeAttribute("aria-expanded");
    $("more").removeAttribute("aria-expanded");
  }

  function applyState(s: Extract<ViewerOut, { t: "state" }>): void {
    lastState = s;
    pendingHandoff = s.handoffs.at(-1) ?? null;
    $("handoff").hidden = pendingHandoff === null;
    $("handoff-message").textContent = pendingHandoff?.message ?? "";
    tabs = s.tabs;
    const was = control;
    control = s.control;
    // the take over ended elsewhere (another panel handed back, the agent resumed): leave full
    if (full && was === "user" && control === "agent") askMode(false);
    // and an allow's pending reopen no longer takes over again on this connection's successors
    if (was === "user" && control === "agent" && pendingNav?.sentOn === sock) pendingNav = null;
    const active = tabs.find((x) => x.active);
    if (doc.activeElement !== url) url.value = active?.url ?? "";
    renderUrl(active?.url ?? "");
    renderTabs();
    renderChrome();
    // the frame budget follows control (the full viewport while the person drives): the hello
    // was sized before this connection's first state, so compare with what was sent
    if (sock !== null) {
      const { w, h } = layout();
      if (`${w}x${h}` !== sentSize) sizeMessage("resize");
    }
    // a dialog strip goes with the page that showed it
    if (dialogUrl !== undefined && active?.url !== dialogUrl) hideDialog();
    reopenAllowed(active?.url);
    const click = s.lastClick;
    if (click !== undefined) {
      const fresh = seenClick !== undefined && click.seq > seenClick;
      seenClick = Math.max(seenClick ?? 0, click.seq);
      if (fresh) flashAt(click.x, click.y);
    } else seenClick ??= 0;
  }

  function flashAt(x: number, y: number): void {
    const flash = $("flash");
    const r = view.getBoundingClientRect();
    const st = stage.getBoundingClientRect();
    flash.style.left = `${r.left - st.left + (x / VIEWPORT.width) * r.width}px`;
    flash.style.top = `${r.top - st.top + (y / VIEWPORT.height) * r.height}px`;
    flash.hidden = false;
    win.setTimeout(() => {
      flash.hidden = true;
    }, 600);
  }

  /**
   * The page an allow opens: sent once per connection (a daemon restarted by the allow comes back
   * on a new one with a blank tab), until the tab shows it or PENDING_NAV_MS pass.
   */
  function reopenAllowed(activeUrl: string | undefined): void {
    const p = pendingNav;
    if (p === null) return;
    if (activeUrl === p.url || Date.now() > p.until) {
      pendingNav = null;
      return;
    }
    if (p.sentOn !== sock && sock !== null) {
      p.sentOn = sock;
      // the person allowed it while driving: a daemon restarted by the allow starts with the
      // agent in control, so take it over again (input is dropped in the watch state)
      if (control !== "user" && !compact()) takeover();
      send({ t: "nav", url: p.url });
    }
  }

  function showDialog(m: Extract<ViewerOut, { t: "dialog" }>): void {
    $("dialog-text").textContent = m.kind === "file" ? text("fileDialog") : m.message;
    $("dialog").hidden = false;
    dialogUrl = tabs.find((x) => x.active)?.url ?? "";
    if (dialogTimer !== undefined) clearTimeout(dialogTimer);
    dialogTimer = setTimeout(hideDialog, STRIP_MS);
  }

  function hideDialog(): void {
    if (dialogTimer !== undefined) clearTimeout(dialogTimer);
    dialogTimer = undefined;
    dialogUrl = undefined;
    $("dialog").hidden = true;
  }

  /** A refusal the person should see (an allow or an answer the kernel refused). */
  function notice(key: StringKey, detail: string): void {
    $("notice-text").textContent = detail === "" ? text(key) : `${text(key)} ${detail}`;
    $("notice").hidden = false;
    if (noticeTimer !== undefined) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      $("notice").hidden = true;
    }, STRIP_MS);
  }

  /** The kernel's refusal message from an error body, if any. */
  async function refusalOf(res: Response): Promise<string> {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: unknown } };
    const m = body.error?.message;
    return typeof m === "string" ? m.slice(0, 300) : "";
  }

  // ---- canvas ----

  function layout(): { w: number; h: number } {
    const st = stage.getBoundingClientRect();
    const box = letterbox(
      Math.max(0, Math.floor(st.width) - 2 * STAGE_PAD),
      Math.max(0, Math.floor(st.height) - 2 * STAGE_PAD),
    );
    view.style.width = `${box.w}px`;
    view.style.height = `${box.h}px`;
    const dpr = win.devicePixelRatio || 1;
    const cap = control === "user" || full ? VIEWPORT.width : SIDE_MAX_WIDTH;
    const w = Math.max(1, Math.min(cap, Math.round(box.w * Math.min(dpr, MAX_DPR))));
    return { w, h: Math.max(1, Math.round(w / ASPECT)) };
  }

  /** The box changed (width, the host's new height, a strip shown or hidden). */
  function onBoxChange(): void {
    if (sock === null || mode !== "live") return;
    const { w, h } = layout();
    if (sentSize !== `${w}x${h}`) sizeMessage("resize");
    draw();
  }

  function sizeMessage(kind: "hello" | "resize"): void {
    const { w, h } = layout();
    sentSize = `${w}x${h}`;
    send({ t: kind, maxWidth: w, maxHeight: h });
  }

  function draw(): void {
    if (image === null) return;
    const { w, h } = layout();
    if (view.width !== w || view.height !== h) {
      view.width = w;
      view.height = h;
    }
    const ctx = view.getContext("2d");
    ctx?.drawImage(image, 0, 0, w, h);
  }

  async function onFrame(m: ViewerFrame): Promise<void> {
    try {
      const first = image === null;
      image = await decode(m.jpeg);
      if (first) renderLoading();
      draw();
      input.frame();
    } catch {
      // A frame that fails to decode is skipped; the ack below keeps the stream moving.
    }
    send({ t: "frame-ack", seq: m.seq });
  }

  // ---- connection ----

  function show(next: View): void {
    mode = next;
    // a later browser is a new one: the idle state holds until its own first frame
    if (next === "empty" || next === "offline" || next === "error") image = null;
    if (next === "empty") {
      wasLive = false;
      armEmptyPoll();
    }
    renderChrome();
  }

  /**
   * "Not running" looks again every EMPTY_POLL_MS while the panel is visible, for EMPTY_POLL_FOR_MS
   * at most: a ticket never starts the service, so this only notices one an agent started.
   */
  function armEmptyPoll(): void {
    emptySince ??= Date.now();
    if (emptyTimer !== undefined) clearTimeout(emptyTimer);
    emptyTimer = setTimeout(() => {
      emptyTimer = undefined;
      if (mode !== "empty" || emptySince === undefined) return;
      if (Date.now() - emptySince >= EMPTY_POLL_FOR_MS) return;
      if (doc.visibilityState === "hidden") armEmptyPoll();
      else void connect(true);
    }, EMPTY_POLL_MS);
  }

  function stop(): void {
    gen++;
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    if (emptyTimer !== undefined) clearTimeout(emptyTimer);
    emptyTimer = undefined;
    const s = sock;
    sock = null;
    if (s !== null) {
      s.onclose = null;
      s.onmessage = null;
      s.close();
    }
  }

  /** `lookOnly`: a look from "not running" that keeps showing it until the browser answers. */
  async function connect(lookOnly = false): Promise<void> {
    stop();
    const mine = gen;
    quiet = lookOnly && mode === "empty";
    // a quiet look keeps the next one armed: a handshake that hangs does not end the looking
    if (quiet) armEmptyPoll();
    else {
      // a new connection shows the skeleton until its own first frame
      image = null;
      show("connecting");
    }
    let ticketUrl: string;
    try {
      const res = await doFetch("stream-ticket", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: "{}",
        credentials: "omit",
      });
      const body = (await res.json().catch(() => ({}))) as {
        url?: unknown;
        code?: unknown;
        error?: { code?: unknown };
      };
      if (mine !== gen) return;
      const code = body.code ?? body.error?.code;
      if (code === "service_not_running") return show("empty");
      if (!res.ok || typeof body.url !== "string") return show(quiet ? "empty" : "offline");
      ticketUrl = body.url;
    } catch {
      if (mine === gen) show(quiet ? "empty" : "offline");
      return;
    }
    const ws = new SocketCtor(ticketUrl);
    sock = ws;
    ws.binaryType = "arraybuffer";
    ws.onopen = () => sizeMessage("hello");
    ws.onmessage = (e) => {
      if (mine !== gen) return;
      void onMessage(e.data);
    };
    ws.onclose = (e) => {
      if (mine === gen) onClose(e.code);
    };
  }

  async function onMessage(data: unknown): Promise<void> {
    let bytes: Uint8Array;
    if (typeof data === "string") bytes = new TextEncoder().encode(data);
    else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else if (ArrayBuffer.isView(data))
      bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else if (typeof (data as Blob).arrayBuffer === "function")
      bytes = new Uint8Array(await (data as Blob).arrayBuffer());
    else return;
    retried401 = false;
    attempts = 0;
    restartRetries = 0;
    const frame = decodeFrame(bytes);
    if (frame !== null) {
      void onFrame(frame);
      return;
    }
    let msg: ViewerOut;
    try {
      msg = JSON.parse(new TextDecoder().decode(bytes)) as ViewerOut;
    } catch {
      return;
    }
    switch (msg.t) {
      case "ping":
        send({ t: "pong", id: msg.id });
        break;
      case "cursor":
        input.cursor(msg.cursor);
        break;
      case "state":
        mode = "live";
        wasLive = true;
        quiet = false;
        emptySince = undefined;
        applyState(msg);
        break;
      case "blocked":
        blockedHost = msg.host;
        blockedUrl = msg.url;
        renderChrome();
        break;
      case "dialog":
        showDialog(msg);
        break;
    }
  }

  function onClose(code: number): void {
    sock = null;
    lastState = null;
    if (quiet && code !== 4401 && code !== 4409 && code !== 1009) {
      // a quiet look that found no browser: still "not running", look again later
      show("empty");
      return;
    }
    if (code === 4401 && !retried401) {
      retried401 = true;
      void connect(quiet);
    } else if (code === 4404) {
      // The service is not running, or (after a live view) restarting: an allow restarts it on
      // some devices, so two tries with backoff before "not running".
      const wait = wasLive ? RESTART_RETRY_MS[restartRetries] : undefined;
      if (wait === undefined) show("empty");
      else {
        restartRetries++;
        show("connecting");
        retryTimer = setTimeout(() => void connect(), wait);
      }
    } else if (code === 4409 || code === 4401) show("offline");
    else if (code === 1009) show("error");
    else if (code === 1012 || code === 1013) void connect();
    else {
      // 1001 (server shutdown) and abnormal closes: back off, then offer a manual reconnect.
      attempts++;
      if (attempts > 6) {
        show("offline");
        return;
      }
      show("connecting");
      retryTimer = setTimeout(() => void connect(), Math.min(15_000, 1000 * 2 ** (attempts - 1)));
    }
  }

  // ---- user actions ----

  function takeover(): void {
    send({ t: "takeover" });
    askMode(true);
    input.focus();
    renderChrome();
  }

  /** Hands the browser back; a pending handoff question is answered Done with it. */
  function handback(): void {
    // the person's latest choice wins over an allow's pending reopen (which would take over again)
    pendingNav = null;
    send({ t: "handback" });
    askMode(false);
    renderChrome();
    if (pendingHandoff !== null) void answerHandoff(true);
  }

  function normalizeUrl(raw: string): string {
    const v = raw.trim();
    return /^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`;
  }

  /**
   * Allows the blocked host, then opens the blocked page (not a reload: a device that restarts the
   * browser for the new network comes back with a blank tab, so the page is opened again on the
   * new connection too).
   */
  async function allowHost(): Promise<void> {
    const host = blockedHost;
    const target = blockedUrl;
    if (host === "") return;
    try {
      const res = await doFetch("network-hosts", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ hosts: [host] }),
        credentials: "omit",
      });
      if (!res.ok) {
        notice("allowFailed", await refusalOf(res));
        return;
      }
    } catch {
      notice("allowFailed", "");
      return;
    }
    blockedHost = "";
    blockedUrl = "";
    renderChrome();
    // the watch state is read-only: the agent opens the page again itself
    if (!interactive()) return;
    if (target === "") {
      send({ t: "nav", action: "reload" });
      return;
    }
    pendingNav = { url: target, sentOn: sock, until: Date.now() + PENDING_NAV_MS };
    send({ t: "nav", url: target });
  }

  async function answerHandoff(done: boolean): Promise<void> {
    const h = pendingHandoff;
    if (h === null) return;
    try {
      const res = await doFetch("handoff-answer", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ callId: h.callId, done }),
        credentials: "omit",
      });
      if (res.status === 404) {
        // The question is gone (the run was cancelled or already answered): only the banner was
        // stale. Hide it here; the daemon drops its notice on the next agent request.
        if (pendingHandoff?.callId === h.callId) {
          pendingHandoff = null;
          $("handoff").hidden = true;
        }
        return;
      }
      if (!res.ok) {
        notice("answerFailed", await refusalOf(res));
        return;
      }
    } catch {
      notice("answerFailed", "");
      return;
    }
    // The daemon clears state.handoff once the answer lands; the next state hides the banner.
  }

  // ---- wiring ----

  $("takeover").addEventListener("click", takeover);
  $("verify-go").addEventListener("click", takeover);
  $("tabsbtn").addEventListener("click", (e) => {
    if (!interactive()) return;
    openMenu(e.currentTarget as HTMLElement, [
      ...tabs.map((tab) => ({
        label: tabName(tab),
        current: tab.active,
        run: () => send({ t: "tab", action: "switch", tabId: tab.id }),
      })),
      { label: text("newTab"), run: () => send({ t: "tab", action: "open" }) },
    ]);
  });
  $("more").addEventListener("click", (e) => {
    openMenu(e.currentTarget as HTMLElement, [
      { label: text("forward"), run: () => send({ t: "nav", action: "forward" }) },
      { label: text("reload"), run: () => send({ t: "nav", action: "reload" }) },
    ]);
  });
  doc.addEventListener("mousedown", (e) => {
    const m = $("menu");
    if (m.hidden || m.contains(e.target as Node)) return;
    if ((e.target as Element | null)?.closest?.("#tabsbtn, #more")) return;
    closeMenu();
  });
  $("handback").addEventListener("click", handback);
  $("handoff-done").addEventListener("click", () => void answerHandoff(true));
  $("handoff-cancel").addEventListener("click", () => void answerHandoff(false));
  $("allow").addEventListener("click", () => void allowHost());
  $("reconnect").addEventListener("click", () => {
    retried401 = false;
    attempts = 0;
    void connect();
  });
  $("back").addEventListener("click", () => send({ t: "nav", action: "back" }));
  $("forward").addEventListener("click", () => send({ t: "nav", action: "forward" }));
  $("reload").addEventListener("click", () => send({ t: "nav", action: "reload" }));
  url.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !interactive() || url.value.trim() === "") return;
    send({ t: "nav", url: normalizeUrl(url.value) });
    input.focus();
  });
  doc.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("menu").hidden) {
      closeMenu();
      return;
    }
    if (interactive()) handback();
  });
  win.addEventListener("resize", () => {
    onBoxChange();
    if (sock === null || mode !== "live") return;
    renderChrome();
    renderTabs();
  });
  const Ro = (win as unknown as { ResizeObserver?: new (cb: () => void) => Observer })
    .ResizeObserver;
  if (Ro !== undefined) new Ro(onBoxChange).observe(stage);
  doc.addEventListener("visibilitychange", () => {
    if (doc.visibilityState === "hidden") {
      if (hiddenTimer === undefined) {
        hiddenTimer = setTimeout(() => {
          hiddenTimer = undefined;
          if (started) {
            pausedForHidden = true;
            stop();
          }
        }, HIDDEN_CLOSE_MS);
      }
    } else {
      if (hiddenTimer !== undefined) clearTimeout(hiddenTimer);
      hiddenTimer = undefined;
      if (pausedForHidden) {
        pausedForHidden = false;
        // from "not running" this is a quiet look, not a "Connecting…" flash
        void connect(true);
      }
    }
  });

  function applyTheme(tokens: unknown, theme: unknown): void {
    const root = doc.documentElement;
    if (theme === "dark" || theme === "light") root.setAttribute("data-theme", theme);
    if (tokens === null || typeof tokens !== "object") return;
    for (const [name, value] of Object.entries(tokens)) {
      if (name.startsWith("--cb-") && typeof value === "string" && value.length <= 200) {
        root.style.setProperty(name, value);
      }
    }
  }

  setLabels();
  renderChrome();

  win.addEventListener("message", (ev: MessageEvent) => {
    // only the host page speaks the embed protocol (not a page this frame may embed)
    if (ev.source !== win.parent) return;
    const m = ev.data as Record<string, unknown> | null;
    if (m === null || typeof m !== "object" || m.protocol !== PROTOCOL) return;
    if (m.type === "init") {
      if (typeof m.token === "string") token = m.token;
      locale = m.locale === "zh" ? "zh" : "en";
      applyTheme(m.tokens, m.theme);
      setLabels();
      renderChrome();
      doc.body.setAttribute("data-ready", "");
      if (!started) {
        started = true;
        void connect();
      }
    } else if (m.type === "token" && typeof m.token === "string") {
      token = m.token;
    } else if (m.type === "theme") {
      applyTheme(m.tokens, m.theme);
    } else if (m.type === "panel-mode" && typeof m.full === "boolean") {
      hostMode(m.full);
    }
  });
}
