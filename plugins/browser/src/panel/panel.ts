// The browser panel (browser use spec §8): the live view of the agent's browser in the
// conversation's right panel. It runs in the sandboxed embed iframe, so it talks to the host only
// through the embed bridge and to the plugin only through relative routes (`stream-ticket`,
// `network-hosts`) plus the ticket's WebSocket. Every (re)connect rebuilds the whole UI from the
// daemon's first `state` message; nothing else is trusted to survive an iframe remount.
import type { ViewerIn, ViewerOut, ViewerTab } from "../../daemon/protocol.js";
import { VIEWPORT } from "../../daemon/protocol.js";
import { type Locale, type StringKey, t } from "./i18n.js";

const PROTOCOL = "capybara-embed/1";
const ASPECT = VIEWPORT.width / VIEWPORT.height;
/** The side view's frame budget; the expanded view (a takeover) may ask for the full viewport. */
const SIDE_MAX_WIDTH = 640;
const HIDDEN_CLOSE_MS = 60_000;
const COMPACT_BELOW = 600;
const MOVE_INTERVAL_MS = 50;

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
  let conversationId = "";
  let started = false;
  let gen = 0;
  let sock: Socket | null = null;
  let mode: View = "connecting";
  let tabs: ViewerTab[] = [];
  let control: "agent" | "user" = "agent";
  let lastState: Extract<ViewerOut, { t: "state" }> | null = null;
  let retried401 = false;
  let attempts = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let hiddenTimer: ReturnType<typeof setTimeout> | undefined;
  let pausedForHidden = false;
  let blockedHost = "";
  let pendingHandoff: { callId: string; message: string } | null = null;
  let sentSize = "";
  let lastMove = Number.NEGATIVE_INFINITY;
  let image: CanvasImageSource | null = null;

  const compact = () => win.innerWidth < COMPACT_BELOW;
  const text = (key: StringKey) => t(locale, key);
  const storageKey = () => `capybara-browser-takeover:${conversationId}`;
  const initiated = (): boolean => {
    try {
      return win.sessionStorage.getItem(storageKey()) === "1";
    } catch {
      return false;
    }
  };
  const setInitiated = (on: boolean): void => {
    try {
      if (on) win.sessionStorage.setItem(storageKey(), "1");
      else win.sessionStorage.removeItem(storageKey());
    } catch {
      // Storage may be blocked; takeover then simply is not restored after a remount.
    }
  };

  function send(msg: ViewerIn): void {
    if (sock === null) return;
    sock.send(new TextEncoder().encode(JSON.stringify(msg)));
  }
  const bridge = (full: boolean) => post({ protocol: PROTOCOL, type: "panel-mode", full });

  // ---- rendering ----

  function setLabels(): void {
    const set = (id: string, key: StringKey) => {
      $(id).textContent = text(key);
    };
    set("takeover", "takeover");
    set("handback", "handback");
    set("allow", "allow");
    set("reconnect", "reconnect");
    set("blocked-label", "blocked");
    set("dialog-label", "dialog");
    set("handoff-label", "handoff");
    set("handoff-done", "handoffDone");
    set("handoff-cancel", "handoffCancel");
    for (const [id, key] of [
      ["back", "back"],
      ["forward", "forward"],
      ["reload", "reload"],
    ] as const) {
      $(id).setAttribute("aria-label", text(key));
      $(id).setAttribute("title", text(key));
      $(id).textContent = id === "back" ? "<" : id === "forward" ? ">" : "↻";
    }
    url.setAttribute("aria-label", text("address"));
    view.setAttribute("aria-label", text("view"));
    doc.title = text("title");
    doc.documentElement.lang = locale;
  }

  function takeoverHere(): boolean {
    return control === "user" && initiated();
  }

  function renderStatus(): void {
    const el = $("status");
    el.setAttribute("data-control", control);
    let key: StringKey;
    if (mode === "connecting") key = "statusConnecting";
    else if (control === "user") key = takeoverHere() ? "takeoverHint" : "statusUserElsewhere";
    else if (lastState?.loading === true) key = "statusLoading";
    else key = "statusAgent";
    el.textContent = text(key);
  }

  function renderChrome(): void {
    const watchOnly = compact();
    const here = takeoverHere();
    $("takeover").hidden = watchOnly || control === "user";
    $("handback").hidden = watchOnly || control !== "user";
    for (const id of ["back", "forward", "reload"])
      ($(id) as HTMLButtonElement).disabled = watchOnly;
    url.readOnly = watchOnly;
    view.style.cursor = here ? "default" : "pointer";
    const showEmpty = mode === "empty" || mode === "offline" || mode === "error";
    $("empty").hidden = !showEmpty;
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
  }

  function renderTabs(): void {
    const box = $("tabs");
    box.textContent = "";
    const watchOnly = compact();
    for (const tab of tabs) {
      const el = doc.createElement("div");
      el.className = "tab";
      el.setAttribute("role", "tab");
      el.setAttribute("data-active", String(tab.active));
      const label = doc.createElement("button");
      label.type = "button";
      label.className = "label";
      label.textContent = tab.title === "" ? tab.url : tab.title;
      label.disabled = watchOnly;
      label.addEventListener("click", () => send({ t: "tab", action: "switch", tabId: tab.id }));
      el.appendChild(label);
      if (!watchOnly) {
        const close = doc.createElement("button");
        close.type = "button";
        close.textContent = "×";
        close.setAttribute("aria-label", text("closeTab"));
        close.addEventListener("click", () => send({ t: "tab", action: "close", tabId: tab.id }));
        el.appendChild(close);
      }
      box.appendChild(el);
    }
    if (!watchOnly) {
      const add = doc.createElement("button");
      add.type = "button";
      add.textContent = "+";
      add.setAttribute("aria-label", text("newTab"));
      add.addEventListener("click", () => send({ t: "tab", action: "open" }));
      box.appendChild(add);
    }
  }

  function applyState(s: Extract<ViewerOut, { t: "state" }>): void {
    lastState = s;
    pendingHandoff = s.handoff ?? null;
    $("handoff").hidden = pendingHandoff === null;
    $("handoff-message").textContent = pendingHandoff?.message ?? "";
    tabs = s.tabs;
    control = s.control;
    // Control went back to the agent (any viewer): this panel no longer holds a takeover.
    if (control === "agent" && initiated()) setInitiated(false);
    const active = tabs.find((x) => x.active);
    if (doc.activeElement !== url) url.value = active?.url ?? "";
    renderTabs();
    renderChrome();
    const flash = $("flash");
    if (s.lastClick !== undefined) {
      const r = view.getBoundingClientRect();
      const st = stage.getBoundingClientRect();
      flash.style.left = `${r.left - st.left + (s.lastClick.x / VIEWPORT.width) * r.width}px`;
      flash.style.top = `${r.top - st.top + (s.lastClick.y / VIEWPORT.height) * r.height}px`;
      flash.hidden = false;
      win.setTimeout(() => {
        flash.hidden = true;
      }, 600);
    }
  }

  // ---- canvas ----

  function layout(): { w: number; h: number } {
    const st = stage.getBoundingClientRect();
    const box = letterbox(Math.max(0, Math.floor(st.width)), Math.max(0, Math.floor(st.height)));
    view.style.width = `${box.w}px`;
    view.style.height = `${box.h}px`;
    const dpr = win.devicePixelRatio || 1;
    const cap = initiated() ? VIEWPORT.width : SIDE_MAX_WIDTH;
    const w = Math.max(1, Math.min(cap, Math.round(box.w * dpr)));
    return { w, h: Math.max(1, Math.round(w / ASPECT)) };
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

  async function onFrame(m: Extract<ViewerOut, { t: "frame" }>): Promise<void> {
    try {
      const bin = win.atob(m.jpeg);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      image = await decode(bytes);
      draw();
    } catch {
      // A frame that fails to decode is skipped; the ack below keeps the stream moving.
    }
    send({ t: "frame-ack", seq: m.seq });
  }

  // ---- connection ----

  function show(next: View): void {
    mode = next;
    renderChrome();
  }

  function stop(): void {
    gen++;
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    const s = sock;
    sock = null;
    if (s !== null) {
      s.onclose = null;
      s.onmessage = null;
      s.close();
    }
  }

  async function connect(): Promise<void> {
    stop();
    const mine = gen;
    show("connecting");
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
      if (!res.ok || typeof body.url !== "string") return show("offline");
      ticketUrl = body.url;
    } catch {
      if (mine === gen) show("offline");
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
    let raw: string;
    if (typeof data === "string") raw = data;
    else if (data instanceof ArrayBuffer) raw = new TextDecoder().decode(data);
    else if (ArrayBuffer.isView(data)) raw = new TextDecoder().decode(data);
    else if (typeof (data as Blob).arrayBuffer === "function")
      raw = new TextDecoder().decode(await (data as Blob).arrayBuffer());
    else return;
    let msg: ViewerOut;
    try {
      msg = JSON.parse(raw) as ViewerOut;
    } catch {
      return;
    }
    retried401 = false;
    attempts = 0;
    switch (msg.t) {
      case "state":
        mode = "live";
        applyState(msg);
        break;
      case "frame":
        void onFrame(msg);
        break;
      case "blocked":
        blockedHost = msg.host;
        renderChrome();
        break;
      case "dialog":
        $("dialog-text").textContent = msg.message;
        $("dialog").hidden = false;
        break;
    }
  }

  function onClose(code: number): void {
    sock = null;
    if (code === 4401 && !retried401) {
      retried401 = true;
      void connect();
    } else if (code === 4404) show("empty");
    else if (code === 4409 || code === 4401) show("offline");
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
    setInitiated(true);
    send({ t: "takeover" });
    bridge(true);
    view.focus();
    renderChrome();
  }

  function handback(): void {
    send({ t: "handback" });
    setInitiated(false);
    bridge(false);
    renderChrome();
  }

  function normalizeUrl(raw: string): string {
    const v = raw.trim();
    return /^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`;
  }

  async function allowHost(): Promise<void> {
    const host = blockedHost;
    if (host === "") return;
    try {
      const res = await doFetch("network-hosts", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ hosts: [host] }),
        credentials: "omit",
      });
      if (!res.ok) return;
    } catch {
      return;
    }
    blockedHost = "";
    renderChrome();
    send({ t: "nav", action: "reload" });
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
      if (!res.ok) return;
    } catch {
      return;
    }
    // The daemon clears state.handoff once the answer lands; the next state hides the banner.
  }

  function onPointer(kind: "down" | "up" | "move", e: MouseEvent): void {
    if (compact()) return;
    if (kind === "move") {
      if (!takeoverHere() || e.timeStamp - lastMove < MOVE_INTERVAL_MS) return;
      lastMove = e.timeStamp;
    }
    const r = view.getBoundingClientRect();
    const p = mapPoint(e.clientX - r.left, e.clientY - r.top, {
      x: 0,
      y: 0,
      w: r.width,
      h: r.height,
    });
    send({
      t: "mouse",
      kind,
      ...p,
      ...(kind === "move" ? {} : { button: e.button === 2 ? "right" : "left" }),
    });
  }

  // ---- wiring ----

  $("takeover").addEventListener("click", takeover);
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
    if (e.key !== "Enter" || compact() || url.value.trim() === "") return;
    send({ t: "nav", url: normalizeUrl(url.value) });
    view.focus();
  });
  view.addEventListener("mousedown", (e) => onPointer("down", e));
  view.addEventListener("mouseup", (e) => onPointer("up", e));
  view.addEventListener("mousemove", (e) => onPointer("move", e));
  view.addEventListener("contextmenu", (e) => e.preventDefault());
  view.addEventListener(
    "wheel",
    (e) => {
      if (compact()) return;
      e.preventDefault();
      const r = view.getBoundingClientRect();
      const p = mapPoint(e.clientX - r.left, e.clientY - r.top, {
        x: 0,
        y: 0,
        w: r.width,
        h: r.height,
      });
      send({ t: "mouse", kind: "wheel", ...p, dx: e.deltaX, dy: e.deltaY });
    },
    { passive: false },
  );
  view.addEventListener("keydown", (e) => {
    if (!takeoverHere() || e.key === "Escape" || e.isComposing) return;
    e.preventDefault();
    send({ t: "key", kind: "down", key: e.key, code: e.code });
  });
  view.addEventListener("keyup", (e) => {
    if (!takeoverHere() || e.key === "Escape" || e.isComposing) return;
    e.preventDefault();
    send({ t: "key", kind: "up", key: e.key, code: e.code });
  });
  view.addEventListener("compositionend", (e) => {
    if (takeoverHere() && e.data !== "")
      send({ t: "key", kind: "char", key: e.data, text: e.data });
  });
  doc.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && takeoverHere()) handback();
  });
  win.addEventListener("resize", () => {
    if (sock === null || mode !== "live") return;
    const { w, h } = layout();
    if (sentSize !== `${w}x${h}`) sizeMessage("resize");
    renderChrome();
    renderTabs();
    draw();
  });
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
        void connect();
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
    const m = ev.data as Record<string, unknown> | null;
    if (m === null || typeof m !== "object" || m.protocol !== PROTOCOL) return;
    if (m.type === "init") {
      if (typeof m.token === "string") token = m.token;
      locale = m.locale === "zh" ? "zh" : "en";
      const ctxt = m.context as { conversationId?: unknown } | undefined;
      conversationId = typeof ctxt?.conversationId === "string" ? ctxt.conversationId : "";
      applyTheme(m.tokens, m.theme);
      setLabels();
      renderChrome();
      if (!started) {
        started = true;
        void connect();
      }
    } else if (m.type === "token" && typeof m.token === "string") {
      token = m.token;
    } else if (m.type === "theme") {
      applyTheme(m.tokens, m.theme);
    }
  });
}
