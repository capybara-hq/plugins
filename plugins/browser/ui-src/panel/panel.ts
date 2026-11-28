// The browser panel (browser use spec §8): the live view of the agent's browser in the
// conversation's right panel. It runs in the sandboxed embed iframe, so it talks to the host only
// through the embed bridge and to the plugin only through relative routes (`stream-ticket`,
// `network-hosts`, `handoff-answer`) plus the ticket's WebSocket. Every (re)connect rebuilds the
// whole UI from the daemon's first `state` message; nothing else survives an iframe remount (the
// opaque-origin sandbox has no usable storage). The host keeps the frame mounted across its full
// mode and tells the panel the mode it draws (`panel-mode` after `init` and on every change).
// Every viewer is the conversation owner's, so any panel is interactive while the person holds
// control, whichever panel took it (a compact one takes over inside its drawer, with a takeover
// bar for the phone viewport, the soft keyboard and hand back: dialogs spec §7.2); in the watch
// state (the agent drives) the panel is read-only, and the daemon drops input anyway. Takeover
// input (pointer, touch, cursor, keys, IME, paste) lives in input.ts. A page dialog the daemon
// holds shows as a box over the picture until it is answered (dialogs spec §8).
//
// Tabs are owned per conversation (tab ownership spec §5): the strip shows the tabs of this
// conversation's tree (its own first, then one "Sub-task" group per sub-agent conversation), and
// the shown tab is this viewer's own choice, which a click changes also in the watch state. Other
// trees' tabs are listed under "Other conversations", each movable here ("Move here", an adopt).
import type {
  PendingDialogView,
  ViewerFrame,
  ViewerHandoff,
  ViewerIn,
  ViewerOtherTab,
  ViewerOut,
  ViewerTab,
  ViewerViewport,
} from "../../daemon/protocol.js";
import { decodeFrame, isIconDataUrl, VIEWPORT } from "../../daemon/protocol.js";
import { type Locale, type StringKey, t } from "./i18n.js";
import { mountInput } from "./input.js";
import { ICONS, withSystemFaces } from "./page.js";

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

/** The largest rectangle of the page's aspect (16:10 by default) centred in a panel. */
export function letterbox(width: number, height: number, aspect = ASPECT): Rect {
  let w = width;
  let h = Math.round(w / aspect);
  if (h > height) {
    h = height;
    w = Math.round(h * aspect);
  }
  return { x: Math.round((width - w) / 2), y: Math.round((height - h) / 2), w, h };
}

/**
 * Maps a point inside the drawn picture (rect-relative CSS pixels) to coordinates of the page's
 * viewport (the desktop one unless the person chose the phone profile).
 */
export function mapPoint(
  px: number,
  py: number,
  rect: Rect,
  vp: { width: number; height: number } = VIEWPORT,
): { x: number; y: number } {
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v));
  return {
    x: Math.round(clamp(px / rect.w, 1) * vp.width),
    y: Math.round(clamp(py / rect.h, 1) * vp.height),
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

/** A menu entry: a button (`run`), or a heading that groups the buttons after it. */
interface MenuItem {
  label: string;
  /** A short action word after the label (the other conversations' "Move here"). */
  hint?: string;
  current?: boolean;
  heading?: boolean;
  /** The entry's icon slot (a tab's icon or glyph); none for actions. */
  fav?(): HTMLElement;
  run?(): void;
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
  let otherTabs: ViewerOtherTab[] = [];
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
  /** The newest pending handoff of the tree (the banner's; its answer echoes its conversation). */
  let pendingHandoff: ViewerHandoff | null = null;
  let sentSize = "";
  let image: CanvasImageSource | null = null;
  /** The layer the panel shows now (see `renderLoading`). */
  let layer: "idle" | "skeleton" | "app" = "skeleton";
  /** The page's viewport (the daemon's `state.viewport`): input and the picture follow it. */
  let viewport: ViewerViewport = { width: VIEWPORT.width, height: VIEWPORT.height, mobile: false };
  /** The held dialog the box shows (its fields keep what the person typed across states). */
  let boxDialog: PendingDialogView | null = null;
  /** The newest permission request of the tree (the strip's). */
  let permission: { origin: string; permission: string; grantable: boolean } | null = null;
  let permissionTimer: ReturnType<typeof setTimeout> | undefined;
  /** The phone width was suggested in this takeover already (once per takeover). */
  let phoneHinted = false;

  /**
   * A phone (the host's compact size class, a pushed page): the device's screen, never the
   * panel's width. It takes over inside its drawer (no full mode) with the takeover bar.
   */
  const compact = (): boolean => {
    const sw = win.screen?.width ?? 0;
    return sw > 0 && sw < COMPACT_BELOW;
  };
  /** A touch screen (the takeover bar and its 44 px targets show there too). */
  const coarse = (): boolean => win.matchMedia?.("(pointer: coarse)").matches === true;
  const text = (key: StringKey) => t(locale, key);
  /** The person drives the page from this panel: any panel while they hold control. */
  const interactive = (): boolean => control === "user";
  const aspect = (): number => viewport.width / viewport.height;
  /** The browser runs but this conversation's tree owns no tab: the tree's empty state. */
  const treeEmpty = (): boolean => mode === "live" && lastState !== null && tabs.length === 0;

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
      return mapPoint(
        clientX - r.left,
        clientY - r.top,
        { x: 0, y: 0, w: r.width, h: r.height },
        viewport,
      );
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
    set("permission-label", "permAsk");
    set("permission-allow", "permAllow");
    set("phonehint-text", "phoneHint");
    set("phonehint-go", "phoneWidth");
    set("keyboard", "keyboard");
    set("touch-handback", "handback");
    $("pdialog-user").setAttribute("aria-label", text("dlgUsername"));
    $("pdialog-user").setAttribute("placeholder", text("dlgUsername"));
    $("pdialog-pass").setAttribute("aria-label", text("dlgPassword"));
    $("pdialog-pass").setAttribute("placeholder", text("dlgPassword"));
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
    // a parked long wait of the tree: what the agent waits for and until when
    let waitingDetail: string | null = null;
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
      const waiting = lastState?.waiting;
      if (waiting !== undefined && !loading) {
        lead = "statusWaiting";
        const until = new Date(waiting.until);
        const time = Number.isNaN(until.getTime())
          ? ""
          : ` (${text("statusWaitingUntil")} ${until.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })})`;
        waitingDetail = `${waiting.label}${time}`;
      }
    }
    el.setAttribute("data-tone", tone);
    $("status-icon").innerHTML = icon;
    $("status-lead").textContent = lead === null ? "" : text(lead);
    $("status-detail").textContent =
      waitingDetail !== null ? ` · ${waitingDetail}` : detail === null ? "" : ` · ${text(detail)}`;
  }

  function renderChrome(): void {
    // the watch state is read-only: navigation and tabs only while the person drives
    const readOnly = !interactive();
    const isLive = mode === "live";
    // a compact or touch screen hands back from the takeover bar
    const bar = isLive && control === "user" && (compact() || coarse());
    $("touchbar").hidden = !bar;
    $("viewport-toggle").textContent = text(viewport.mobile ? "desktopWidth" : "phoneWidth");
    $("takeover").hidden = !isLive || control === "user";
    $("handback").hidden = !isLive || control !== "user" || bar;
    // the takeover slot stays reserved unless hand back takes it
    $("takeover").toggleAttribute("data-gone", isLive && control === "user");
    // the active tab shows a verification page (the daemon's tab blocker, cleared on its next
    // navigation)
    const verifying =
      isLive && control === "agent" && tabs.find((x) => x.active)?.blocker?.kind === "verification";
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
    url.readOnly = readOnly;
    input.sync();
    $("lock").hidden = !isLive || lastState?.secure !== true;
    const showEmpty = mode === "empty" || mode === "offline" || mode === "error";
    $("reconnect").hidden = !showEmpty;
    const keys: Record<string, [StringKey, StringKey]> = {
      empty: ["emptyTitle", "emptyBody"],
      offline: ["offlineTitle", "offlineBody"],
      error: ["errorTitle", "errorBody"],
      tree: ["treeEmptyTitle", "treeEmptyBody"],
    };
    const k = keys[treeEmpty() ? "tree" : mode];
    // the tree's empty state lists other conversations' pages (to move one here), never shows one
    const emptyOthers = $("empty-others");
    emptyOthers.hidden = !treeEmpty() || otherTabs.length === 0;
    emptyOthers.textContent = othersLabel();
    if (k !== undefined) {
      $("empty-title").textContent = text(k[0]);
      $("empty-body").textContent = text(k[1]);
    }
    $("blocked").hidden = blockedHost === "";
    $("blocked-host").textContent = blockedHost;
    if (!isLive || control !== "user" || viewport.mobile) $("phonehint").hidden = true;
    renderDialogBox();
    renderPermission();
    renderStatus();
    renderLoading();
  }

  /**
   * The held dialog of the shown tab as a box over the picture: the page's text as text, and for
   * the person in control the answer controls (confirm, prompt, leave-page, sign-in); watching,
   * the same box read-only. Fields keep what the person typed while the same dialog stays.
   */
  function renderDialogBox(): void {
    const d =
      mode === "live" && lastState !== null
        ? ((lastState.dialogs ?? []).find((x) => x.tabId === lastState?.shown) ?? null)
        : null;
    const box = $("pdialog");
    box.hidden = d === null;
    if (d === null) {
      boxDialog = null;
      return;
    }
    const fresh = boxDialog?.id !== d.id;
    boxDialog = d;
    const kinds: Record<PendingDialogView["kind"], StringKey> = {
      confirm: "dlgConfirm",
      prompt: "dlgPrompt",
      beforeunload: "dlgLeave",
      auth: "dlgAuth",
    };
    $("pdialog-kind").textContent = text(kinds[d.kind]);
    $("pdialog-msg").textContent = d.kind === "auth" ? (d.origin ?? "") : d.message;
    const realm = $("pdialog-realm");
    realm.hidden = d.kind !== "auth" || (d.realm ?? "") === "";
    realm.textContent = `${text("dlgRealm")} ${d.realm ?? ""}`;
    const answering = interactive();
    const field = $<HTMLInputElement>("pdialog-text");
    field.hidden = d.kind !== "prompt" || !answering;
    if (fresh) field.value = d.defaultValue ?? "";
    for (const id of ["pdialog-user", "pdialog-pass"]) {
      const input = $<HTMLInputElement>(id);
      input.hidden = d.kind !== "auth" || !answering;
      if (fresh) input.value = "";
    }
    const labels: Record<PendingDialogView["kind"], [StringKey, StringKey]> = {
      confirm: ["dlgOk", "dlgCancel"],
      prompt: ["dlgOk", "dlgCancel"],
      beforeunload: ["dlgLeaveGo", "dlgLeaveStay"],
      auth: ["dlgSignIn", "dlgCancel"],
    };
    const [yes, no] = labels[d.kind];
    $("pdialog-yes").textContent = text(yes);
    $("pdialog-no").textContent = text(no);
    $("pdialog-yes").hidden = !answering;
    $("pdialog-no").hidden = !answering;
    const hint = $("pdialog-hint");
    hint.hidden = answering;
    hint.textContent = text("dlgReadOnly");
  }

  /** Answers the box's dialog; the password goes only into this message and is cleared at once. */
  function answerDialog(action: "accept" | "dismiss"): void {
    const d = boxDialog;
    if (d === null || !interactive()) return;
    const pass = $<HTMLInputElement>("pdialog-pass");
    const msg: ViewerIn = { t: "dialog", id: d.id, action };
    if (action === "accept" && d.kind === "prompt")
      msg.text = $<HTMLInputElement>("pdialog-text").value;
    if (action === "accept" && d.kind === "auth") {
      msg.username = $<HTMLInputElement>("pdialog-user").value;
      msg.password = pass.value;
    }
    pass.value = "";
    send(msg);
  }

  /** The permission strip: the origin and the permission, 允许 for a grantable one in control. */
  function renderPermission(): void {
    const p = permission;
    $("permission").hidden = p === null || mode !== "live";
    if (p === null) return;
    const names: Record<string, StringKey> = {
      notifications: "permNotifications",
      "clipboard-read": "permClipboard",
      geolocation: "permGeolocation",
      camera: "permCamera",
      microphone: "permMicrophone",
    };
    $("permission-origin").textContent = p.origin;
    const key = names[p.permission];
    $("permission-name").textContent = key === undefined ? p.permission : text(key);
    $("permission-allow").hidden = !p.grantable || !interactive();
  }

  function showPermission(m: Extract<ViewerOut, { t: "permission" }>): void {
    permission = { origin: m.origin, permission: m.permission, grantable: m.grantable };
    renderPermission();
    if (permissionTimer !== undefined) clearTimeout(permissionTimer);
    permissionTimer = setTimeout(() => {
      permission = null;
      renderPermission();
    }, STRIP_MS);
  }

  /**
   * Which of the three layers shows; each is the whole panel and only one is visible:
   * - `idle`: no browser to show (not running, offline, error): the centred idle state alone,
   *   with no tabs, toolbar or status line (nothing to navigate);
   * - `skeleton`: a connection on its way (or live without its first frame yet);
   * - `app`: the live panel, once the browser's state and its first frame are there.
   * A browser that comes up from the idle state (a quiet look found it) keeps the idle state until
   * its first frame and then switches once to the live panel, as from the skeleton; so does a tree
   * that gets its first tab while its empty state shows (an idle layer too).
   */
  function renderLoading(): void {
    const idleMode = mode === "empty" || mode === "offline" || mode === "error" || treeEmpty();
    let next: "idle" | "skeleton" | "app";
    if (idleMode) next = "idle";
    else if (mode === "live" && image !== null) next = "app";
    else if (mode === "live" && layer === "idle") next = "idle";
    else next = "skeleton";
    layer = next;
    $("app").toggleAttribute("data-loading", next === "skeleton");
    $("app").toggleAttribute("data-idle", next === "idle");
    $("skeleton").hidden = next !== "skeleton";
    $("empty").hidden = next !== "idle";
    if (next === "app") onBoxChange();
  }

  function renderTabs(): void {
    const box = $("tablist");
    box.textContent = "";
    const watchOnly = !interactive();
    const subs = subGroups();
    let group = "own";
    for (const tab of tabs) {
      if (tab.group !== group) {
        group = tab.group;
        if (group !== "own") {
          const label = doc.createElement("span");
          label.className = "group";
          label.setAttribute("role", "presentation");
          label.textContent = groupLabel(group, subs);
          box.appendChild(label);
        }
      }
      const el = doc.createElement("div");
      el.className = "tab";
      el.setAttribute("role", "tab");
      el.setAttribute("data-active", String(tab.active));
      el.setAttribute("data-group", tab.group);
      el.setAttribute("aria-selected", String(tab.active));
      el.appendChild(favOf(tab));
      const label = doc.createElement("button");
      label.type = "button";
      label.className = "label";
      label.textContent = tabName(tab);
      label.title = tabName(tab);
      // like browser tabs: a click shows the tab, also while only watching
      label.addEventListener("click", () => pickTab(tab));
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
    const others = $("others");
    others.hidden = otherTabs.length === 0;
    others.textContent = othersLabel();
    // narrow panels: one button for the tabs and the address
    const active = tabs.find((x) => x.active);
    $("tabsbtn").querySelector(".fav")?.replaceWith(favOf(active));
    $("tabsbtn-name").textContent =
      active === undefined ? "" : hostOf(active.url) || tabName(active);
    $("tabsbtn-count").textContent = String(tabs.length);
    $("tabsbtn").setAttribute("aria-label", `${text("tabs")}: ${tabs.length}`);
  }

  /**
   * A tab of the tree chosen in the strip or the tabs menu. In control it is a `switch` (for a
   * tab of this conversation it also becomes its active tab); while watching it changes only this
   * viewer's shown tab (`show`, allowed in the watch state). The daemon's next state marks it.
   */
  function pickTab(tab: ViewerTab): void {
    if (interactive()) send({ t: "tab", action: "switch", tabId: tab.id });
    else if (!tab.active) send({ t: "show", tabId: tab.id });
  }

  /** The tree's other groups in strip order. */
  const subGroups = (): string[] => [
    ...new Set(tabs.map((x) => x.group).filter((g) => g !== "own")),
  ];
  /**
   * "Sub-task", numbered only while the tree has more than one (no conversation names). The number
   * comes from the daemon's group key (`sub<n>`, stable for the viewer's lifetime), so a group keeps
   * its number when an earlier one closes.
   */
  const groupLabel = (group: string, subs: string[]): string => {
    if (subs.length <= 1) return text("subTask");
    const n = /^sub(\d+)$/.exec(group)?.[1];
    return n === undefined ? text("subTask") : `${text("subTask")} ${n}`;
  };
  const othersLabel = (): string => `${text("otherConversations")} (${otherTabs.length})`;

  /** The other conversations' tabs as menu entries, each moved here on a click (an adopt). */
  function otherItems(): MenuItem[] {
    return otherTabs.map((tab) => ({
      label: tab.title !== "" ? tab.title : tab.url === "about:blank" ? text("newTab") : tab.url,
      hint: text("moveHere"),
      // another conversation's tab carries no icon (by design): the neutral globe
      fav: () => glyph("site"),
      run: () => send({ t: "tab", action: "adopt", tabId: tab.id }),
    }));
  }
  function openOthers(anchor: HTMLElement): void {
    openMenu(anchor, [{ label: othersLabel(), heading: true }, ...otherItems()]);
  }

  // a blank tab (about:blank, the tab left after the last one closed) reads as a new tab
  const tabName = (tab: ViewerTab): string =>
    tab.title !== "" ? tab.title : tab.url === "about:blank" ? text("newTab") : tab.url;
  /**
   * The tab's icon slot, never an empty square: the site's icon (the daemon's data URL), else a
   * small spinner while the tab loads, else a neutral globe. Every state is the same 14 px box.
   */
  function favOf(tab: ViewerTab | undefined): HTMLElement {
    if (tab !== undefined && isIconDataUrl(tab.favicon)) {
      const img = doc.createElement("img");
      img.className = "fav";
      img.alt = "";
      img.src = tab.favicon;
      // an icon the browser cannot draw falls back to the globe
      img.addEventListener("error", () => img.replaceWith(glyph("site")), { once: true });
      return img;
    }
    return glyph(tab?.loading === true ? "loading" : "site");
  }
  function glyph(kind: "loading" | "site"): HTMLElement {
    const fav = doc.createElement("span");
    fav.className = "fav";
    fav.setAttribute("data-glyph", kind);
    fav.innerHTML = kind === "loading" ? ICONS.spin : ICONS.globe;
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

  function openMenu(anchor: HTMLElement, items: MenuItem[]): void {
    const menu = $("menu");
    menu.textContent = "";
    for (const it of items) {
      if (it.heading === true || it.run === undefined) {
        const h = doc.createElement("p");
        h.className = "heading";
        h.setAttribute("role", "presentation");
        h.textContent = it.label;
        menu.appendChild(h);
        continue;
      }
      const run = it.run;
      const b = doc.createElement("button");
      b.type = "button";
      b.setAttribute("role", "menuitem");
      if (it.fav !== undefined) b.appendChild(it.fav());
      const name = doc.createElement("span");
      name.className = "name";
      name.textContent = it.label;
      b.appendChild(name);
      if (it.hint !== undefined) {
        const hint = doc.createElement("span");
        hint.className = "hint";
        hint.textContent = it.hint;
        b.appendChild(hint);
      }
      if (it.current) b.setAttribute("aria-current", "true");
      b.addEventListener("click", () => {
        closeMenu();
        run();
      });
      menu.appendChild(b);
    }
    const r = anchor.getBoundingClientRect();
    menu.style.top = `${Math.round(r.bottom + 4)}px`;
    // right-aligned with its anchor, moved right only as far as its width needs to stay inside
    // the panel (a narrow panel's anchor, or the centred button of the empty state)
    menu.style.maxWidth = `${Math.max(0, win.innerWidth - 24)}px`;
    menu.style.right = "12px";
    menu.hidden = false;
    const width = menu.getBoundingClientRect().width;
    const right = Math.max(12, Math.round(win.innerWidth - r.right));
    menu.style.right = `${Math.max(12, Math.min(right, Math.round(win.innerWidth - 12 - width)))}px`;
    anchor.setAttribute("aria-expanded", "true");
    (menu.querySelector("button") as HTMLElement | null)?.focus();
  }
  function closeMenu(): void {
    $("menu").hidden = true;
    for (const id of ["tabsbtn", "more", "others", "empty-others"])
      $(id).removeAttribute("aria-expanded");
  }

  function applyState(s: Extract<ViewerOut, { t: "state" }>): void {
    lastState = s;
    // the banner shows the tree's newest handoff (a sub-agent's too)
    pendingHandoff = s.handoffs.at(-1) ?? null;
    $("handoff").hidden = pendingHandoff === null;
    $("handoff-message").textContent = pendingHandoff?.message ?? "";
    tabs = s.tabs;
    otherTabs = s.otherTabs;
    if (s.viewport !== undefined) viewport = s.viewport;
    // the tree lost its last tab: its next first tab starts from the idle layer, not a stale frame
    if (tabs.length === 0) image = null;
    const was = control;
    control = s.control;
    // the take over ended elsewhere (another panel handed back, the agent resumed): leave full
    if (full && was === "user" && control === "agent") askMode(false);
    if (control === "agent") phoneHinted = false;
    // a phone screen that just took over: suggest the phone width once (never switched for the
    // person: a switch reflows the page)
    if (was === "agent" && control === "user" && compact() && !viewport.mobile && !phoneHinted) {
      phoneHinted = true;
      $("phonehint").hidden = false;
    }
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
    flash.style.left = `${r.left - st.left + (x / viewport.width) * r.width}px`;
    flash.style.top = `${r.top - st.top + (y / viewport.height) * r.height}px`;
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
      if (control !== "user") takeover();
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
      aspect(),
    );
    view.style.width = `${box.w}px`;
    view.style.height = `${box.h}px`;
    const dpr = win.devicePixelRatio || 1;
    const cap = control === "user" || full ? viewport.width : SIDE_MAX_WIDTH;
    const w = Math.max(1, Math.min(cap, Math.round(box.w * Math.min(dpr, MAX_DPR))));
    return { w, h: Math.max(1, Math.round(w / aspect())) };
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
    // the tree's empty state shows no page (a frame of a tab shown before is stale)
    if (!treeEmpty()) {
      try {
        const first = image === null;
        image = await decode(m.jpeg);
        if (first) renderLoading();
        draw();
        input.frame();
      } catch {
        // A frame that fails to decode is skipped; the ack below keeps the stream moving.
      }
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
      case "permission":
        showPermission(msg);
        break;
      case "notice":
        // a refused "Move here": the tab's conversation is using it right now, or this
        // conversation keeps the most tabs it may
        if (msg.code === "tab_in_use") notice("tabInUse", "");
        else if (msg.code === "tab_cap") notice("tabCap", "");
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
    // a phone takes over inside its drawer (the host keeps no full mode there)
    if (!compact()) askMode(true);
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
        // the handoff's own conversation (a sub-agent's when it asked): the kernel looks the
        // question up by it and the callId, which is unique only within its run
        body: JSON.stringify({ callId: h.callId, done, handoffConversationId: h.conversationId }),
        credentials: "omit",
      });
      if (res.status === 404) {
        // The question is gone (the run was cancelled or already answered): only the banner was
        // stale. Hide it here; the daemon drops its notice on the next agent request.
        if (
          pendingHandoff?.callId === h.callId &&
          pendingHandoff.conversationId === h.conversationId
        ) {
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
    // the tree's tabs by group (a pick shows the tab, also while watching), a new tab while in
    // control, then the other conversations' tabs to move here
    const items: MenuItem[] = [];
    const subs = subGroups();
    let group = "own";
    for (const tab of tabs) {
      if (tab.group !== group) {
        group = tab.group;
        if (group !== "own") items.push({ label: groupLabel(group, subs), heading: true });
      }
      items.push({
        label: tabName(tab),
        current: tab.active,
        fav: () => favOf(tab),
        run: () => pickTab(tab),
      });
    }
    if (interactive())
      items.push({ label: text("newTab"), run: () => send({ t: "tab", action: "open" }) });
    if (otherTabs.length > 0) items.push({ label: othersLabel(), heading: true }, ...otherItems());
    if (items.length > 0) openMenu(e.currentTarget as HTMLElement, items);
  });
  $("others").addEventListener("click", (e) => openOthers(e.currentTarget as HTMLElement));
  $("empty-others").addEventListener("click", (e) => openOthers(e.currentTarget as HTMLElement));
  $("more").addEventListener("click", (e) => {
    openMenu(e.currentTarget as HTMLElement, [
      { label: text("forward"), run: () => send({ t: "nav", action: "forward" }) },
      { label: text("reload"), run: () => send({ t: "nav", action: "reload" }) },
    ]);
  });
  doc.addEventListener("mousedown", (e) => {
    const m = $("menu");
    if (m.hidden || m.contains(e.target as Node)) return;
    if ((e.target as Element | null)?.closest?.("#tabsbtn, #more, #others, #empty-others")) return;
    closeMenu();
  });
  $("handback").addEventListener("click", handback);
  $("touch-handback").addEventListener("click", handback);
  $("viewport-toggle").addEventListener("click", () => {
    if (!interactive()) return;
    $("phonehint").hidden = true;
    send({ t: "viewport", profile: viewport.mobile ? "desktop" : "phone" });
  });
  $("phonehint-go").addEventListener("click", () => {
    $("phonehint").hidden = true;
    if (interactive()) send({ t: "viewport", profile: "phone" });
  });
  $("keyboard").addEventListener("click", () => input.keyboard());
  $("pdialog-yes").addEventListener("click", () => answerDialog("accept"));
  $("pdialog-no").addEventListener("click", () => answerDialog("dismiss"));
  for (const id of ["pdialog-text", "pdialog-pass"])
    $(id).addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") answerDialog("accept");
    });
  $("permission-allow").addEventListener("click", () => {
    const p = permission;
    if (p === null || !p.grantable || !interactive()) return;
    send({ t: "permission", origin: p.origin, permission: p.permission, allow: true });
    permission = null;
    renderPermission();
  });
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

  /** The host's font stacks (see {@link withSystemFaces}). */
  const FONT_TOKENS = new Set(["--cb-font", "--cb-font-prose", "--cb-font-code"]);

  function applyTheme(tokens: unknown, theme: unknown): void {
    const root = doc.documentElement;
    if (theme === "dark" || theme === "light") root.setAttribute("data-theme", theme);
    if (tokens === null || typeof tokens !== "object") return;
    for (const [name, value] of Object.entries(tokens)) {
      if (name.startsWith("--cb-") && typeof value === "string" && value.length <= 200) {
        // the host's web fonts do not reach this frame: its stacks get the system faces
        root.style.setProperty(name, FONT_TOKENS.has(name) ? withSystemFaces(value) : value);
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
