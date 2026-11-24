// The browser daemon's message contract (browser use spec §5, §8–§10), shared by the daemon, the
// plugin server (tool requests) and the panel (viewer streams). Pure types and constants: no
// imports, so every side can load it (Node and the browser).
//
// Transport: the device service socket protocol of @capybara-hq/plugin-sdk (`device-service.ts`).
// Every message is one UTF-8 JSON value.
// - A request connection (`{"kind":"request"}`) carries one ToolRequest and gets one ToolReply.
// - A stream connection (`{"kind":"stream"}`) is one viewer: the viewer's first message is
//   `hello`; the daemon answers at once with a full `state` message and a first `frame`, then
//   sends `state` on every change. Frames are paced by the viewer's `frame-ack` (at most
//   VIEWER_UNACKED_FRAMES unacknowledged) and capped at VIEWER_MAX_FPS. A quiet stream is not a
//   dead one: Chromium sends frames only when the page changes, so the viewer keeps the last one.
// - Viewer coordinates are viewport CSS pixels (the panel maps them back through its scale).
// - Viewer key input: `down` / `up` carry a key name (KeyboardEvent.key); a printable key's `down`
//   types its character. `char` inserts composed text (IME) only; never send both for one key.

/** The fixed viewport; viewers never change it (§8). */
export const VIEWPORT = { width: 1280, height: 800 } as const;

/** The largest snapshot text, marker included. */
export const SNAPSHOT_MAX_CHARS = 40_000;

/** The daemon stops after this long without requests and without viewers. */
export const IDLE_STOP_MS = 15 * 60_000;

/** A takeover ends this long after the last viewer stream closes (unless one reconnects). */
export const TAKEOVER_GRACE_MS = 60_000;

/** The most frames per second a viewer gets. */
export const VIEWER_MAX_FPS = 5;

/** The most frames a viewer may have unacknowledged before the daemon holds the next one. */
export const VIEWER_UNACKED_FRAMES = 2;

/**
 * The default cap, in bytes, of one viewer message (a frame's JSON, base64 included). A frame
 * above the cap is sent smaller or not at all. The daemon's environment variable
 * BROWSER_FRAME_MAX_BYTES overrides it (a provider whose stream frames are smaller sets it lower).
 */
export const DEFAULT_FRAME_MAX_BYTES = 256 * 1024;

/** The longest handoff message the daemon keeps. */
export const HANDOFF_MAX_CHARS = 4096;

/** The most tabs the browser keeps open (popups count too). */
export const MAX_TABS = 10;

/**
 * The longest a pending handoff keeps an otherwise idle daemon running (the person may take a
 * while to sign in). The device's own idle suspension can still end it sooner.
 */
export const HANDOFF_KEEPALIVE_MS = 24 * 60 * 60_000;

/** How a blocked reply starts when the proxy refused Playwright's browser download hosts. */
export const DOWNLOAD_BLOCKED_PREFIX =
  "The browser could not be downloaded into the device: its network settings block ";

/** The failure reply's message when a reply does not fit in one service message. */
export const REPLY_TOO_LARGE_MESSAGE =
  "The reply was too large to send; ask for less (a smaller maxBytes).";

export type ToolRequest =
  | { op: "navigate"; url?: string; action?: "back" | "forward" | "reload" }
  | { op: "tabs"; action: "list" | "open" | "switch" | "close"; tabId?: string; url?: string }
  | { op: "snapshot" }
  | { op: "click" | "hover"; ref: string }
  | { op: "type"; ref: string; text: string; submit?: boolean }
  | { op: "select"; ref: string; values: string[] }
  | { op: "press"; key: string }
  | { op: "scroll"; ref?: string; dy: number }
  | { op: "upload"; ref: string; path: string }
  | { op: "click_at"; x: number; y: number }
  | { op: "type_at"; x: number; y: number; text: string }
  | { op: "wait"; text?: string; ref?: string; navigation?: boolean; timeoutMs: number }
  | { op: "screenshot"; fullPage?: boolean; maxBytes: number }
  /**
   * The plugin server's handoff bookkeeping (not agent input, so allowed during a takeover): the
   * daemon keeps at most one pending handoff, the latest notice wins, and a clear removes it only
   * when its callId matches. Viewers see it in `state.handoff`. `handback` (the person answered
   * Done) also ends a takeover, so the request that follows is not refused as taken over.
   */
  | { op: "handoff_notice"; callId: string; message: string }
  | { op: "handoff_clear"; callId: string; handback?: boolean };

export type ToolErrorCode = "taken_over" | "no_such_ref" | "timeout" | "blocked" | "failed";

export type ToolReply =
  | {
      ok: true;
      page: { url: string; title: string; tabId: string };
      text?: string;
      /** base64 JPEG */
      image?: string;
      blockedHosts: string[];
      /** Set on the first reply after a takeover ended: when the person took control (ISO). */
      userControlledSince?: string;
    }
  | { ok: false; error: ToolErrorCode; message: string; blockedHosts: string[] };

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
  | { t: "tab"; action: "open" | "switch" | "close"; tabId?: string }
  | { t: "takeover" }
  | { t: "handback" }
  | { t: "frame-ack"; seq: number };

export interface ViewerTab {
  id: string;
  title: string;
  url: string;
  active: boolean;
}

export type ViewerOut =
  | { t: "frame"; seq: number; jpeg: string; width: number; height: number }
  | {
      t: "state";
      tabs: ViewerTab[];
      loading: boolean;
      secure: boolean;
      control: "agent" | "user";
      /** The agent's latest click; `seq` grows with every click, so a viewer flashes only new ones. */
      lastClick?: { x: number; y: number; seq: number };
      /** The pending handoff question, if any (message at most HANDOFF_MAX_CHARS). */
      handoff?: { callId: string; message: string };
    }
  /** `url`: the page to open once the host is allowed (the blocked navigation, or the page whose resource was refused). */
  | { t: "blocked"; host: string; url: string }
  | { t: "dialog"; kind: "alert" | "confirm" | "prompt" | "file"; message: string };
