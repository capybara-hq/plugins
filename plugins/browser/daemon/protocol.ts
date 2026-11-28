// The browser daemon's message contract (browser use spec §5, §8–§10), shared by the daemon, the
// plugin server (tool requests) and the panel (viewer streams). Pure types and constants: no
// imports, so every side can load it (Node and the browser).
//
// Transport: the device service socket protocol of @capybara-hq/plugin-sdk (`device-service.ts`).
// Every message is one UTF-8 JSON value.
// - A request connection (`{"kind":"request"}`) carries one ToolRequest and gets one ToolReply.
//   Every request names its conversation and the root of its conversation tree (written by the
//   plugin server from the tool call context, never from tool input); one that does not is refused
//   with NO_CONVERSATION_MESSAGE. Tabs are owned per conversation (tab ownership spec §4): a
//   conversation acts only on its own tabs and has its own active tab.
// - A stream connection (`{"kind":"stream"}`) is one viewer. Its first stream message is the
//   kernel's viewer context (`parseViewerContext` of @capybara-hq/plugin-sdk: the ticket's
//   conversation and its root); a stream whose first message is not is closed, and a later
//   message of that shape (the panel's) is never read as context. The viewer sees its tree: the
//   tabs its conversation and the tree's other conversations own. The viewer's next message is
//   `hello`; the daemon answers at once with a full `state` message and a first frame, then
//   sends `state` on every change. A frame is a binary message ({@link encodeFrame}: a zero tag
//   byte, then seq, width, height and the raw JPEG); every other message is JSON (its first byte
//   is `{`). Frames are paced by the viewer's `frame-ack`: at most VIEWER_UNACKED_FRAMES
//   unacknowledged, fewer while the measured link is slow, never more often than VIEWER_MAX_FPS,
//   and only the newest frame waits (a stale one is replaced, never queued). JSON messages
//   (state, cursor, dialogs) never wait behind a held frame. A quiet stream is not a dead one:
//   Chromium sends frames only when the page changes, so the viewer keeps the last one.
// - Viewer input (mouse, key, nav, tab) acts on the viewer's shown tab and is applied only while
//   the person holds control (`state.control === "user"`, after a `takeover` from any viewer): a
//   viewer in the watch state is read-only, and the daemon drops its input, also input still
//   queued when control returns to the agent. Two messages pass in the watch state too: `show`
//   (the viewer-local shown tab) and `tab` with `action: "adopt"` (an ownership change). Input already running then (a navigation, a long paste) finishes; keys and
//   buttons the person still holds are released for the agent. Mouse moves are coalesced (the
//   newest wins). After a move the daemon answers the page's cursor at the pointer (`cursor`)
//   when it changed, resolved off the input queue.
// - Viewer coordinates are viewport CSS pixels (the panel maps them back through its scale).
// - Viewer key input: `down` / `up` carry a key name (KeyboardEvent.key); a printable key's `down`
//   types its character. `char` inserts text (IME composition, paste); never send both for one key.

/**
 * The kernel's roll check (the SDK's `DEVICE_SERVICE_ROLL_CHECK`): asked before the service is
 * restarted on an upgraded plugin's files. The daemon answers `{ busy, reason? }`, busy while the
 * person holds control or a handoff waits, so the restart waits for a later call.
 */
export const ROLL_CHECK_REQUEST = '{"capybara":"roll-check"}';

/**
 * The reply of a request that was running when Chromium crashed: the daemon stays up and launches
 * it again on the next use, with the tabs that closed in the crash reopened.
 */
export const BROWSER_CRASHED_MESSAGE =
  "The browser in the device stopped unexpectedly while this ran (it crashed). It starts again on the next browser call, with this conversation's tabs reopened; call browser_snapshot to see the page, and retry if the action did not happen.";

/** The note to each conversation whose tabs a relaunch after a crash reopened. */
export const BROWSER_RESTARTED_NOTE =
  "The browser in the device stopped unexpectedly (it crashed) and was started again: this conversation's tabs were reopened at their last addresses, and anything typed into them but not submitted is gone.";

/** A request of a conversation the kernel's notice deleted (or of its tree). */
export const CONVERSATION_DELETED_MESSAGE =
  "This conversation was deleted; its browser tabs are closed.";

/**
 * The agent's viewport: every tool request runs on it (coordinates, screenshots). Only the person
 * may switch to the `phone` profile while holding control, and hand back restores this one before
 * any agent request runs (dialogs spec §7.1).
 */
export const VIEWPORT = { width: 1280, height: 800 } as const;

/** The viewport profiles a person in control may choose (dialogs spec §7.1). */
export type ViewportProfile = "desktop" | "phone";

// capybara:allow-module-state read-only constant (a profile table, never written)
export const VIEWPORT_PROFILES = {
  desktop: { width: VIEWPORT.width, height: VIEWPORT.height, mobile: false, scale: 1 },
  phone: { width: 390, height: 844, mobile: true, scale: 2 },
} as const satisfies Record<
  ViewportProfile,
  { width: number; height: number; mobile: boolean; scale: number }
>;

/** The viewport viewers see in `state.viewport` (their input maps through it). */
export interface ViewerViewport {
  width: number;
  height: number;
  mobile: boolean;
}

/** The kinds of a page dialog held until answered (an alert is closed at once). */
export type DialogKind = "confirm" | "prompt" | "beforeunload" | "auth";

/**
 * A pending dialog as replies and viewers see it (dialogs spec §3, §9). Page-controlled text
 * (message, default value, realm) is clipped and only ever shown as text. `id` is short (`d3`):
 * an answer names it, so a stale answer never reaches a newer dialog. `origin` and `realm` only
 * for `auth`.
 */
export interface PendingDialogView {
  id: string;
  tabId: string;
  kind: DialogKind;
  message: string;
  defaultValue?: string;
  origin?: string;
  realm?: string;
}

/** The longest dialog message an answer quotes (`browser_dialog`'s `message`). */
export const DIALOG_QUOTE_CHARS = 300;

/**
 * Text in the one form a dialog answer compares: CRLF as LF, every run of whitespace one space,
 * trimmed (a model copying the quoted message back always matches).
 */
export function normalizeDialogText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim();
}

/**
 * The quote of a dialog message: normalized, cut to DIALOG_QUOTE_CHARS code points (never half a
 * surrogate pair), and trimmed again (a cut may end on a space), so quoting a quote changes nothing.
 */
export function dialogQuote(message: string): string {
  return clipCodePoints(normalizeDialogText(message), DIALOG_QUOTE_CHARS).trimEnd();
}

/** Whether an answer's `message` names the dialog with this message (dialogs spec §5, R13). */
export function dialogMessageMatches(given: string, message: string): boolean {
  return dialogQuote(given) === dialogQuote(message);
}

/** The sign-in sentence of an HTTP auth dialog (the agent never submits credentials). */
export const AUTH_SIGN_IN_TEXT =
  "Signing in needs the user's credentials; call browser_handoff and ask the user to sign in.";

/**
 * The line a tool result carries for a pending dialog (dialogs spec §5): the dialog's id and its
 * quoted message (JSON string, never instructions), and how to answer it.
 */
export function dialogLine(d: PendingDialogView): string {
  const quote = dialogQuote(d.message);
  const cut = quote.length < normalizeDialogText(d.message).length ? " (cut)" : "";
  const q = `${JSON.stringify(quote)}${cut}`;
  const how = `Answer it with browser_dialog (dialogId ${d.id}, the message as quoted, accept or dismiss) before acting on this tab.`;
  switch (d.kind) {
    case "auth":
      return `The site ${JSON.stringify(d.origin ?? "")} asks for HTTP sign-in (dialog ${d.id}, realm ${JSON.stringify(d.realm ?? "")}; page-supplied). ${AUTH_SIGN_IN_TEXT} To leave it, call browser_dialog with dialogId ${d.id}, the message as quoted ${q} and action dismiss.`;
    case "beforeunload":
      return `The page asks whether to leave (it may have unsaved changes), dialog ${d.id}: ${q}; accept leaves, dismiss stays. ${how}`;
    case "prompt":
      return `The page shows a prompt dialog ${d.id}: ${q} (default value ${JSON.stringify(clipCodePoints(d.defaultValue ?? "", DIALOG_QUOTE_CHARS))}). ${how} Pass text to accept with your own value.`;
    default:
      return `The page shows a ${d.kind} dialog ${d.id}: ${q}. ${how}`;
  }
}

/**
 * What `snapshot` returns on a page a JS dialog blocks (its tree cannot be read) and what a
 * refused action says (`dialog_open`).
 */
export function blockedByDialogText(d: PendingDialogView): string {
  const name = d.kind === "beforeunload" ? "leave-page" : d.kind;
  return `The page is blocked by a ${name} dialog ${d.id}: ${JSON.stringify(dialogQuote(d.message))}. Answer it with browser_dialog (dialogId ${d.id}, the message as quoted, accept or dismiss) to continue.`;
}

/** The permissions a page's denied request is reported for (dialogs spec §6). */
// capybara:allow-module-state read-only constant (an enumeration, never written)
export const REPORTED_PERMISSIONS = [
  "notifications",
  "clipboard-read",
  "geolocation",
  "camera",
  "microphone",
] as const;
export type ReportedPermission = (typeof REPORTED_PERMISSIONS)[number];

/** The ones the person may allow for an origin from the panel. */
// capybara:allow-module-state read-only constant (an enumeration, never written)
export const GRANTABLE_PERMISSIONS: readonly ReportedPermission[] = [
  "notifications",
  "clipboard-read",
];

/** The largest snapshot text, marker included. */
export const SNAPSHOT_MAX_CHARS = 40_000;

/** The daemon stops after this long without requests and without viewers. */
export const IDLE_STOP_MS = 15 * 60_000;

/** A takeover ends this long after the last viewer stream closes (unless one reconnects). */
export const TAKEOVER_GRACE_MS = 60_000;

/** The most frames per second a viewer gets (a slow link gets fewer, see viewer-pacing.ts). */
export const VIEWER_MAX_FPS = 15;

/** The most frames a viewer may have unacknowledged before the daemon holds the next one. */
export const VIEWER_UNACKED_FRAMES = 2;

/** The longest `char` text one viewer message carries, in code points (a paste is cut to it). */
export const VIEWER_TEXT_MAX_CHARS = 10_000;

/** `text` cut to at most `max` code points (never half of a surrogate pair). */
export function clipCodePoints(text: string, max: number): string {
  if (text.length <= max) return text;
  return Array.from(text).slice(0, max).join("");
}

/** The cursor keywords a viewer may show (anything else is `default`). */
// capybara:allow-module-state read-only constant (a keyword list, never written)
export const VIEWER_CURSORS = [
  "default",
  "pointer",
  "text",
  "vertical-text",
  "crosshair",
  "move",
  "grab",
  "grabbing",
  "not-allowed",
  "no-drop",
  "wait",
  "progress",
  "help",
  "context-menu",
  "cell",
  "copy",
  "alias",
  "zoom-in",
  "zoom-out",
  "col-resize",
  "row-resize",
  "ew-resize",
  "ns-resize",
  "nesw-resize",
  "nwse-resize",
  "n-resize",
  "e-resize",
  "s-resize",
  "w-resize",
  "ne-resize",
  "nw-resize",
  "se-resize",
  "sw-resize",
  "all-scroll",
  "none",
] as const;

export type ViewerCursor = (typeof VIEWER_CURSORS)[number];

/** A known cursor keyword, else `default`. */
export function toViewerCursor(value: unknown): ViewerCursor {
  return typeof value === "string" && (VIEWER_CURSORS as readonly string[]).includes(value)
    ? (value as ViewerCursor)
    : "default";
}

/** The first byte of a binary frame message (a JSON message starts with `{`). */
export const FRAME_TAG = 0;
/** Tag, seq (u32), width (u16), height (u16), all big-endian, before the JPEG. */
export const FRAME_HEADER_BYTES = 9;

/** One screencast frame as the viewer receives it. */
export interface ViewerFrame {
  seq: number;
  width: number;
  height: number;
  jpeg: Uint8Array;
}

/** A frame as one binary viewer message. */
export function encodeFrame(f: ViewerFrame): Uint8Array {
  const out = new Uint8Array(FRAME_HEADER_BYTES + f.jpeg.byteLength);
  const v = new DataView(out.buffer);
  v.setUint8(0, FRAME_TAG);
  v.setUint32(1, f.seq >>> 0);
  v.setUint16(5, f.width);
  v.setUint16(7, f.height);
  out.set(f.jpeg, FRAME_HEADER_BYTES);
  return out;
}

/** The frame in a viewer message, or null when it is not a frame (a JSON message). */
export function decodeFrame(m: Uint8Array): ViewerFrame | null {
  if (m.byteLength < FRAME_HEADER_BYTES || m[0] !== FRAME_TAG) return null;
  const v = new DataView(m.buffer, m.byteOffset, m.byteLength);
  return {
    seq: v.getUint32(1),
    width: v.getUint16(5),
    height: v.getUint16(7),
    jpeg: m.subarray(FRAME_HEADER_BYTES),
  };
}

/**
 * The default cap, in bytes, of one viewer message (a frame's header and JPEG). A frame
 * above the cap is sent smaller or not at all. The daemon's environment variable
 * BROWSER_FRAME_MAX_BYTES overrides it (a provider whose stream frames are smaller sets it lower).
 */
export const DEFAULT_FRAME_MAX_BYTES = 256 * 1024;

/** The longest handoff message the daemon keeps. */
export const HANDOFF_MAX_CHARS = 4096;

/** The most tabs the browser keeps open, all conversations together (popups count too). */
export const MAX_TABS = 10;

/** The most tabs one conversation owns (popups count too). */
export const MAX_TABS_PER_CONVERSATION = 6;

/**
 * A conversation's tabs close after this long without a request, a viewer pinning it and a park
 * (equal to the daemon's own idle stop); its per-conversation state goes with them.
 */
export const CONVERSATION_IDLE_MS = 15 * 60_000;

/**
 * At the device's tab cap, a tab of another conversation is closed to make room only when that
 * conversation has been idle (no request) for at least this long (and is not in use).
 */
export const EVICT_MIN_IDLE_MS = 5 * 60_000;

/**
 * Long waits (browser long waits spec §6.2): the most watches the daemon keeps; a start past it
 * drops the oldest latched watch, else the oldest one.
 */
export const MAX_WATCHES = 16;
/**
 * A watch not polled for this long is dropped (below the daemon's IDLE_STOP_MS): each poll is the
 * watch's heartbeat, so a watch whose run ended or was skipped costs at most this long.
 */
export const WATCH_HEARTBEAT_MS = 10 * 60_000;
/** The longest condition text a watch or wait keeps (a text, a ref or a URL part). */
export const WAIT_CONDITION_MAX_CHARS = 2000;

/**
 * One wait condition: a text appears, an element ref appears, the active tab's URL contains a
 * string, the next navigation finishes, or the next download finishes saving into the workspace.
 */
export type WaitCondition =
  | { text: string }
  | { ref: string }
  | { urlContains: string }
  | { navigation: true }
  | { download: true };

/**
 * A watch's latched state (`watch_start` / `watch_poll` / `watch_end` replies). `met` with `at`
 * (ISO) and, for a download, `detail` (the saved path); `ended` with `reason`: `dialog` (a dialog
 * opened on the watched tab; `detail` its message), `tab_closed`, or `deadline` (its remaining
 * time passed on the device's clock); `unknown`: the daemon has no such watch (never started,
 * dropped without polls, evicted, or the browser restarted).
 */
export interface WatchState {
  state: "pending" | "met" | "ended" | "unknown";
  reason?: "dialog" | "tab_closed" | "deadline";
  at?: string;
  detail?: string;
}

/** The failure message of a request without its conversation fields. */
export const NO_CONVERSATION_MESSAGE = "the request names no conversation";

/**
 * The longest pending parks (a handoff, any conversation's) keep an otherwise idle daemon running,
 * counted from the oldest one (the person may take a while to sign in). The device's own idle
 * suspension can still end it sooner.
 */
export const HANDOFF_KEEPALIVE_MS = 24 * 60 * 60_000;

/** How a blocked reply starts when the proxy refused Playwright's browser download hosts. */
export const DOWNLOAD_BLOCKED_PREFIX =
  "The browser could not be downloaded into the device: its network settings block ";

/** The failure reply's message when a reply does not fit in one service message. */
export const REPLY_TOO_LARGE_MESSAGE =
  "The reply was too large to send; ask for less (a smaller maxBytes).";

/**
 * What every request carries besides its operation: the tool call's conversation and the root of
 * its conversation tree (equal outside sub-agents). Both non-empty strings, from the kernel's tool
 * call context; the daemon trusts them as it trusts the socket (spec §3).
 */
export interface RequestConversation {
  conversationId: string;
  rootConversationId: string;
  /**
   * The local ports the root's tree holds now (the kernel's live loopback port grants, sent by the
   * plugin server with every request): the whole set, which replaces the daemon's copy for the
   * root; absent leaves it unchanged. A tab reaches `localhost`, `127.0.0.1` or `[::1]` on a port
   * only while its owner's root holds it.
   */
  loopbackPorts?: number[];
}

/**
 * One operation of a request (what the plugin server builds from tool input).
 *
 * Acting operations (navigate, snapshot, screenshot, the element and coordinate actions, wait,
 * `tabs open` / `switch` / `close`) act on the conversation's active tab; a conversation with no
 * live tab first claims an unowned tab, else gets a new one (subject to the caps). Non-acting
 * operations never open a tab: `tabs list`, `tabs adopt`, `handoff_notice`, `handoff_clear` and
 * the watch operations (`watch_start` binds to the active tab, refused without one).
 *
 * `tabs list` lists the conversation's own tabs, then the tree's other tabs, then other trees'
 * tabs (titles clipped to 120 characters, URLs without query or fragment outside its own).
 * `tabs switch` / `close` take only the conversation's own tabs. `tabs adopt` moves `tabId` to the
 * conversation (owner and root) and makes it its active tab; refused while the tab's owner is in
 * use (a request in flight or a pending park).
 */
export type ToolOp =
  | { op: "navigate"; url?: string; action?: "back" | "forward" | "reload" }
  | {
      op: "tabs";
      action: "list" | "open" | "switch" | "close" | "adopt";
      tabId?: string;
      url?: string;
    }
  | { op: "snapshot" }
  | { op: "click" | "hover"; ref: string }
  | { op: "type"; ref: string; text: string; submit?: boolean }
  | { op: "select"; ref: string; values: string[] }
  | { op: "press"; key: string }
  | { op: "scroll"; ref?: string; dy: number }
  | { op: "upload"; ref: string; path: string }
  | { op: "click_at"; x: number; y: number }
  | { op: "type_at"; x: number; y: number; text: string }
  | {
      op: "wait";
      text?: string;
      ref?: string;
      navigation?: boolean;
      urlContains?: string;
      download?: boolean;
      timeoutMs: number;
    }
  | { op: "screenshot"; fullPage?: boolean; maxBytes: number }
  /**
   * Answers the conversation's pending dialog `dialogId` (dialogs spec §5): refused when it is not
   * a pending dialog of one of the conversation's own tabs, or when `message` does not match its
   * quote ({@link dialogMessageMatches}). Runs beside the action queue (the action that opened the
   * dialog may still be pending); refused while the person holds control. `text` only for a
   * prompt. An auth dialog takes only `dismiss`.
   */
  | { op: "dialog"; dialogId: string; message: string; action: "accept" | "dismiss"; text?: string }
  /**
   * The plugin server's handoff bookkeeping (not agent input, so allowed during a takeover). Per
   * conversation: the daemon keeps at most one pending handoff per conversation, the latest notice
   * wins, and a clear removes it only when its callId matches. Any other request of the same
   * conversation drops it (its run moved on); requests of other conversations leave it. Viewers
   * of the conversation's tree see it in `state.handoffs`. `handback` (the person answered Done)
   * also ends a takeover, so the request that follows is not refused as taken over.
   */
  | { op: "handoff_notice"; callId: string; message: string }
  | { op: "handoff_clear"; callId: string; handback?: boolean }
  /**
   * Long waits (browser long waits spec §6.2): the plugin server's bookkeeping of a parked
   * browser_wait, not agent input (allowed during a takeover, never queued behind actions, never
   * drops a pending handoff). `watch_start` arms a watch on the conversation's active tab
   * (idempotent per `watchId`) that latches the first outcome within `remainingMs` (the device's
   * clock); `watch_poll` returns the latched state and is its heartbeat; `watch_end` returns it
   * and forgets the watch. A pending watch is the conversation's park. Neither `watch_start` nor
   * `watch_poll` takes the hand back note or the conversation's unreported notes; `watch_end`
   * does, as an ordinary reply.
   */
  | { op: "watch_start"; watchId: string; condition: WaitCondition; remainingMs: number }
  | { op: "watch_poll"; watchId: string }
  | { op: "watch_end"; watchId: string }
  /**
   * The plugin server's refresh of a conversation tree's loopback ports outside a tool call (after
   * the person's grant or remove in the panel, and when a panel opens): only its `loopbackPorts`
   * matter, applied to the root the daemon knows for `conversationId` (the conversation itself
   * when it knows none). Never starts the browser, opens a tab or marks the conversation in use.
   */
  | { op: "loopback_ports" };

/** A request as it travels on the socket: an operation and its conversation. */
export type ToolRequest = ToolOp & RequestConversation;

/**
 * Why a request failed. `restart`: the browser was just installed into the provider's install
 * directory and sealed; the daemon exits and the plugin starts the service again. `unreachable`:
 * a navigation could not load its page (a net error, or no page within the navigation's time,
 * after which the navigation was stopped); the message names the host and what the device's
 * network answered for it. `network_unavailable`: the device's network proxy itself cannot be
 * reached (the device's network is down or being set up), whatever the address.
 */
export type ToolErrorCode =
  | "taken_over"
  /** The tab is blocked by a pending JS dialog; the message is {@link blockedByDialogText}. */
  | "dialog_open"
  | "no_such_ref"
  | "timeout"
  | "blocked"
  | "unreachable"
  | "network_unavailable"
  | "failed"
  | "restart"
  /**
   * The daemon's first start is still installing the browser (download and unpacking): the
   * message says how far it got; the plugin retries for a while, then passes it on.
   */
  | "installing";

/**
 * The calling conversation's own tab count after the request, and MAX_TABS_PER_CONVERSATION. On
 * every reply (ok or not) of a request that named its conversation; the plugin server turns it
 * into the result's last line.
 */
export interface TabCount {
  open: number;
  max: number;
}

/**
 * A host the device's network proxy refused during a request, with the refused port and the layer
 * that refused it: `address` when the proxy said the destination's address is closed (a name
 * resolving to a private or local address, or a closed IP literal: no host grant reaches it), else
 * `device` (the device's network settings). `class: "loopback"` marks an `address` refusal of
 * `localhost`, `127.0.0.1` or `[::1]` (the proxy's, or the daemon's own for a tab whose root does
 * not hold the port): a port the conversation can be granted. The plugin server reports these to
 * the kernel as they are.
 */
export interface BlockedHost {
  host: string;
  port: number;
  layer: "device" | "address";
  class?: "loopback";
}

export type ToolReply =
  | {
      ok: true;
      /** The conversation's active tab; absent when the conversation has no tab. */
      page?: { url: string; title: string; tabId: string };
      text?: string;
      /** base64 JPEG */
      image?: string;
      blockedHosts: BlockedHost[];
      /**
       * Set on this conversation's first ok reply after a takeover that concerned it ended (it
       * owned a tab when the takeover began, or the person used one of its tabs): when the person
       * took control (ISO).
       */
      userControlledSince?: string;
      tabs?: TabCount;
      /** The watch of a `watch_start` / `watch_poll` / `watch_end` request. */
      watch?: WatchState;
      /** A pending dialog of the calling conversation's tabs (its active tab's first). */
      dialog?: PendingDialogView;
    }
  | {
      ok: false;
      error: ToolErrorCode;
      message: string;
      blockedHosts: BlockedHost[];
      tabs?: TabCount;
    };

export type ViewerIn =
  | { t: "hello"; maxWidth: number; maxHeight: number }
  | { t: "resize"; maxWidth: number; maxHeight: number }
  | {
      t: "mouse";
      kind: "move" | "down" | "up" | "wheel";
      x: number;
      y: number;
      button?: "left" | "right";
      dx?: number;
      dy?: number;
    }
  | { t: "key"; kind: "down" | "up" | "char"; key: string; code?: string; text?: string }
  | { t: "nav"; url?: string; action?: "back" | "forward" | "reload" }
  /**
   * Tab actions on the viewer's tree. `open` (control only): a new tab owned by the viewer's
   * conversation, made its active tab and shown. `switch` (control only): shows a tab of the
   * tree; for a tab of the viewer's own conversation it also becomes that conversation's active
   * tab. `close` (control only): closes a tab of the tree. `adopt` (also in the watch state):
   * moves a tab of another tree (or an unowned one) to the viewer's conversation, as the tool's
   * adopt does; a tab of the viewer's own tree is ignored; refused while its owner is in use, which
   * answers `{ t: "notice", code: "tab_in_use" }`, or at the conversation's cap (`tab_cap`).
   */
  | { t: "tab"; action: "open" | "switch" | "close" | "adopt"; tabId?: string }
  /**
   * Chooses the viewer's shown tab among its tree's tabs (also in the watch state: it moves no
   * ownership and no agent's active tab). Any other tab id is ignored.
   */
  | { t: "show"; tabId: string }
  | { t: "takeover" }
  | { t: "handback" }
  | { t: "frame-ack"; seq: number }
  /** The answer to a `ping`, sent at once. */
  | { t: "pong"; id: number }
  /**
   * Answers the pending dialog `id` of a tab of the viewer's tree (control only; a stale id changes
   * nothing). `text` for a prompt; `username` / `password` for an auth dialog's accept: kept in
   * the daemon's memory only and sent only to the dialog's origin, never echoed anywhere.
   */
  | {
      t: "dialog";
      id: string;
      action: "accept" | "dismiss";
      text?: string;
      username?: string;
      password?: string;
    }
  /**
   * Allows a permission the page asked for (control only): only a grantable permission and only
   * for an origin–permission pair the daemon recorded on a tab of the viewer's tree. Lasts for the
   * daemon's life.
   */
  | { t: "permission"; origin: string; permission: string; allow: true }
  /** Switches the viewport profile (control only); hand back restores `desktop`. */
  | { t: "viewport"; profile: ViewportProfile }
  /**
   * Touch input in viewport coordinates (control only): dispatched as touch events in the `phone`
   * profile; in `desktop` a tap is a click and a one-finger pan scrolls.
   */
  | {
      t: "touch";
      kind: "start" | "move" | "end" | "cancel";
      points: { id: number; x: number; y: number }[];
    };

/** The largest tab icon sent to the panel (raw bytes; a larger one keeps the placeholder). */
export const FAVICON_MAX_BYTES = 8 * 1024;

/** Whether a value is a tab icon the daemon would send (the panel shows only these). */
export const isIconDataUrl = (s: unknown): s is string =>
  typeof s === "string" &&
  s.length <= 64 + Math.ceil((FAVICON_MAX_BYTES * 4) / 3) &&
  /^data:image\/(png|x-icon|gif|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(s);

export interface ViewerTab {
  id: string;
  title: string;
  url: string;
  /** Whether this is the viewer's shown tab (the one its frames and input are on). */
  active: boolean;
  /**
   * The tab's group in the viewer's tree: `"own"` for the viewer's own conversation, else an
   * opaque key per other conversation of the tree (`"sub1"`, `"sub2"`, …, stable for the
   * viewer's lifetime; no conversation names). `state.tabs` lists the `own` group first, then each
   * other group in order of first appearance.
   */
  group: string;
  /**
   * Set while the tab shows a verification page (a bot check or CAPTCHA): the panel offers the
   * person to complete it ("需要你完成验证 · 去验证"); cleared once the tab's page changes. A
   * stable field: the panel builds on `kind` and `url`.
   */
  blocker?: { kind: "verification"; url: string };
  /**
   * The site's icon as a `data:image/(png|x-icon|gif|jpeg|webp|svg+xml);base64,…` URL (at most
   * FAVICON_MAX_BYTES of image), fetched by the browser through the device's network rules;
   * absent until known or when the site has none (the panel shows a globe glyph).
   */
  favicon?: string;
  /** Set while the tab loads a document: the panel's icon slot shows a small spinner. */
  loading?: true;
}

/** A tab of another conversation tree as a viewer sees it: no per-tab detail beyond this. */
export interface ViewerOtherTab {
  id: string;
  title: string;
  url: string;
}

/** A pending handoff of the viewer's tree. */
export interface ViewerHandoff {
  callId: string;
  /**
   * The conversation that asked (from the trusted request): an opaque id the panel only echoes in
   * its handoff answer, never shows.
   */
  conversationId: string;
  /** At most HANDOFF_MAX_CHARS. */
  message: string;
  /** The tabs that conversation owns. */
  tabIds: string[];
}

/** The JSON viewer messages (frames are binary, {@link encodeFrame}). */
export type ViewerOut =
  | {
      t: "state";
      /** The tabs of the viewer's tree, grouped (see {@link ViewerTab.group}). */
      tabs: ViewerTab[];
      /** The viewer's shown tab; absent when the tree owns no tab (the panel's empty state). */
      shown?: string;
      /** Tabs of other conversation trees and unowned tabs, in tab order. */
      otherTabs: ViewerOtherTab[];
      /** Whether the shown tab is loading a document. */
      loading: boolean;
      /** Whether the shown tab's page is https. */
      secure: boolean;
      control: "agent" | "user";
      /**
       * The agent's latest click on the shown tab; `seq` grows with every click on any tab, so a
       * viewer flashes only new ones.
       */
      lastClick?: { x: number; y: number; seq: number };
      /** The tree's pending handoffs, oldest first (the newest is last). */
      handoffs: ViewerHandoff[];
      /**
       * The newest pending watch of the viewer's tree (a parked long wait): what the agent waits
       * for (`label`, at most 200 characters) and until when (ISO).
       */
      waiting?: { label: string; until: string };
      /** The pending dialogs of the tree's tabs (at most one per tab). */
      dialogs: PendingDialogView[];
      /** The viewport the page has now (input and the picture's aspect follow it). */
      viewport: ViewerViewport;
    }
  /**
   * A host the device refused for a page of the viewer's tree. `url`: the page to open once the
   * host is allowed (the blocked navigation, or the page whose resource was refused). With
   * `kind: "loopback"`, a local port (`port`) the tree does not hold: the panel offers to open it
   * for the conversation.
   */
  | {
      t: "blocked";
      host: string;
      url: string;
      port?: number;
      kind?: "loopback";
      /** For a loopback port a page's subresource requested: that page's host. */
      origin?: string;
    }
  /**
   * An informational dialog on a page of the viewer's tree: an alert (already closed) or a file
   * chooser. Decision dialogs are in `state.dialogs`.
   */
  | { t: "dialog"; kind: "alert" | "file"; message: string }
  /** A page of the viewer's tree asked for a permission, which was denied. */
  | { t: "permission"; origin: string; permission: ReportedPermission; grantable: boolean }
  /** Answered at once with `pong`: the round trip of a tiny message paces the frames. */
  | { t: "ping"; id: number }
  /** The page's cursor at the pointer, sent after a move when it changed (takeover only). */
  | { t: "cursor"; cursor: ViewerCursor }
  /**
   * A viewer `adopt` was refused: `tab_in_use`, the tab's owner is using it right now; `tab_cap`,
   * the viewer's conversation already owns MAX_TABS_PER_CONVERSATION tabs.
   */
  | { t: "notice"; code: "tab_in_use" | "tab_cap" };
