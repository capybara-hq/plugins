// The panel's takeover input (browser use spec §8): what makes driving the remote browser feel
// local. Kept apart from the panel's layout so a restyle of the panel does not touch it.
// - Pointer: down / up / wheel at once; moves coalesced to the newest position at most every
//   MOVE_EVERY_MS (hover effects, menus and tooltips render in the stream); a drag keeps reporting
//   outside the picture until the button is released.
// - Cursor: the daemon answers the page's cursor under the pointer; the picture shows it.
// - Press indicator: shown at the pointer on mousedown, before any frame comes back.
// - Keys and text: a visually hidden textarea holds the focus, so the IME (Chinese input) composes
//   there and paste works: keys go as `down` / `up`, composed and pasted text as `char`.
// Nothing here acts in the watch state: `interactive()` gates every event.
import {
  toViewerCursor,
  VIEWER_TEXT_MAX_CHARS,
  type ViewerCursor,
  type ViewerIn,
} from "../../daemon/protocol.js";

/** The newest pointer position is sent at most this often while it moves. */
export const MOVE_EVERY_MS = 33;
/** The press indicator stays at most this long when no frame comes back. */
export const PRESS_MAX_MS = 1000;

export interface InputOptions {
  window: Window & typeof globalThis;
  /** The picture: pointer events land here. */
  view: HTMLElement;
  /** The picture's container: the input sink and the press indicator live in it. */
  stage: HTMLElement;
  send(m: ViewerIn): void;
  /** Whether this panel drives the page now (the person holds control, not compact). */
  interactive(): boolean;
  /** Viewport coordinates of a client point over the picture (clamped to it). */
  toPage(clientX: number, clientY: number): { x: number; y: number };
  /** The accessible name of the input sink. */
  label: string;
}

export interface InputController {
  /** Interactivity may have changed: cursor, focus and indicator follow. */
  sync(): void;
  /** A frame was drawn: a press indicator from before it can go. */
  frame(): void;
  /** The page's cursor under the pointer (from the daemon). */
  cursor(value: unknown): void;
  /** Moves the keyboard focus to the input (takeover). */
  focus(): void;
  /** The element that holds the keyboard focus while driving. */
  readonly sink: HTMLTextAreaElement;
}

export function mountInput(opts: InputOptions): InputController {
  const win = opts.window;
  const doc = win.document;
  const { view, stage, send, interactive } = opts;

  // ---- input sink ----
  const sink = doc.createElement("textarea");
  sink.id = "input-sink";
  sink.setAttribute("aria-label", opts.label);
  sink.setAttribute("autocomplete", "off");
  sink.setAttribute("autocapitalize", "off");
  sink.setAttribute("autocorrect", "off");
  sink.spellcheck = false;
  sink.tabIndex = -1;
  // invisible but focusable, where the IME can anchor its candidate window (at the pointer)
  Object.assign(sink.style, {
    position: "absolute",
    left: "0px",
    top: "0px",
    width: "1px",
    height: "1px",
    padding: "0",
    border: "0",
    margin: "0",
    opacity: "0",
    resize: "none",
    overflow: "hidden",
    pointerEvents: "none",
    whiteSpace: "pre",
  } satisfies Partial<CSSStyleDeclaration>);
  stage.appendChild(sink);

  // ---- press indicator ----
  const press = doc.createElement("div");
  press.id = "press";
  press.hidden = true;
  press.setAttribute("aria-hidden", "true");
  Object.assign(press.style, {
    position: "absolute",
    width: "18px",
    height: "18px",
    margin: "-9px 0 0 -9px",
    borderRadius: "50%",
    border: "2px solid var(--cb-accent, Highlight)",
    pointerEvents: "none",
  } satisfies Partial<CSSStyleDeclaration>);
  stage.appendChild(press);
  let pressTimer: ReturnType<typeof setTimeout> | undefined;
  /** The indicator waits for the first frame after the button was released. */
  let pressReleased = false;

  let cursor: ViewerCursor = "default";
  /** focus() came before control did (a takeover on its way): focus again once it arrives. */
  let focusWanted = false;
  /** The button held down in the picture (a drag reports until it is released). */
  let held: "left" | "right" | null = null;
  let moveTimer: ReturnType<typeof setTimeout> | undefined;
  let nextMove: { x: number; y: number } | null = null;

  const inStage = (clientX: number, clientY: number) => {
    const r = stage.getBoundingClientRect();
    return { left: clientX - r.left, top: clientY - r.top };
  };

  function placeSink(clientX: number, clientY: number): void {
    const p = inStage(clientX, clientY);
    sink.style.left = `${Math.round(p.left)}px`;
    sink.style.top = `${Math.round(p.top)}px`;
  }

  function showPress(clientX: number, clientY: number): void {
    const p = inStage(clientX, clientY);
    press.style.left = `${Math.round(p.left)}px`;
    press.style.top = `${Math.round(p.top)}px`;
    press.setAttribute("data-state", "down");
    press.hidden = false;
    pressReleased = false;
    if (pressTimer !== undefined) clearTimeout(pressTimer);
    pressTimer = setTimeout(hidePress, PRESS_MAX_MS);
  }

  function hidePress(): void {
    if (pressTimer !== undefined) clearTimeout(pressTimer);
    pressTimer = undefined;
    press.hidden = true;
    press.removeAttribute("data-state");
    pressReleased = false;
  }

  function applyCursor(): void {
    view.style.cursor = interactive() ? cursor : "default";
  }

  // ---- pointer ----

  /** Sends the newest position now, then at most every MOVE_EVERY_MS while it keeps moving. */
  function queueMove(p: { x: number; y: number }): void {
    nextMove = p;
    if (moveTimer !== undefined) return;
    flushMove();
  }

  function flushMove(): void {
    const p = nextMove;
    nextMove = null;
    if (p === null) {
      moveTimer = undefined;
      return;
    }
    if (interactive()) send({ t: "mouse", kind: "move", ...p });
    moveTimer = setTimeout(flushMove, MOVE_EVERY_MS);
  }

  /** A position that waits is sent before a button or wheel event (they carry their own too). */
  function dropMove(): void {
    nextMove = null;
  }

  view.addEventListener("mousedown", (e) => {
    if (!interactive()) return;
    // keep the focus in the sink (the canvas would take it), so keys and the IME reach the page
    e.preventDefault();
    const button = e.button === 2 ? "right" : "left";
    held = button;
    dropMove();
    placeSink(e.clientX, e.clientY);
    sink.focus();
    showPress(e.clientX, e.clientY);
    send({ t: "mouse", kind: "down", ...opts.toPage(e.clientX, e.clientY), button });
  });

  const release = (e: MouseEvent) => {
    if (held === null) return;
    const button = held;
    held = null;
    if (!interactive()) return;
    dropMove();
    press.setAttribute("data-state", "up");
    pressReleased = true;
    send({ t: "mouse", kind: "up", ...opts.toPage(e.clientX, e.clientY), button });
  };
  // the release counts wherever it happens (a drag that leaves the picture)
  win.addEventListener("mouseup", release);

  const moved = (e: MouseEvent) => {
    if (!interactive()) return;
    queueMove(opts.toPage(e.clientX, e.clientY));
  };
  view.addEventListener("mousemove", moved);
  win.addEventListener("mousemove", (e) => {
    // outside the picture only while dragging
    if (held !== null && e.target !== view) moved(e);
  });

  view.addEventListener(
    "wheel",
    (e) => {
      if (!interactive()) return;
      e.preventDefault();
      dropMove();
      send({
        t: "mouse",
        kind: "wheel",
        ...opts.toPage(e.clientX, e.clientY),
        dx: e.deltaX,
        dy: e.deltaY,
      });
    },
    { passive: false },
  );
  view.addEventListener("contextmenu", (e) => e.preventDefault());

  // ---- keys and text ----

  const composing = (e: KeyboardEvent) => e.isComposing || e.key === "Process" || e.keyCode === 229;
  /** Cmd/Ctrl+V: the browser's paste event carries the text (a key would paste nothing). */
  const isPasteShortcut = (e: KeyboardEvent) =>
    (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "v";

  function sendText(text: string): void {
    if (text === "") return;
    const t = text.slice(0, VIEWER_TEXT_MAX_CHARS);
    send({ t: "key", kind: "char", key: t, text: t });
  }

  sink.addEventListener("keydown", (e) => {
    if (!interactive() || e.key === "Escape" || composing(e) || isPasteShortcut(e)) return;
    e.preventDefault();
    send({ t: "key", kind: "down", key: e.key, code: e.code });
  });
  sink.addEventListener("keyup", (e) => {
    if (!interactive() || e.key === "Escape" || composing(e) || isPasteShortcut(e)) return;
    e.preventDefault();
    send({ t: "key", kind: "up", key: e.key, code: e.code });
  });
  sink.addEventListener("compositionend", (e) => {
    if (interactive()) sendText(e.data ?? "");
    sink.value = "";
  });
  sink.addEventListener("input", (e) => {
    const ie = e as InputEvent;
    // composition text is sent once, at compositionend; other insertions (dictation, the emoji
    // picker) as they come
    if (ie.isComposing || (ie.inputType ?? "").includes("Composition")) return;
    if (interactive()) sendText(sink.value);
    sink.value = "";
  });
  sink.addEventListener("paste", (e) => {
    e.preventDefault();
    if (!interactive()) return;
    sendText(e.clipboardData?.getData("text/plain") ?? "");
  });

  return {
    sink,
    sync() {
      applyCursor();
      if (!interactive()) {
        held = null;
        nextMove = null;
        hidePress();
        return;
      }
      // the takeover this panel asked for is in effect: the keys go to the page from now on
      if (focusWanted) {
        focusWanted = false;
        sink.focus();
      }
    },
    frame() {
      if (pressReleased) hidePress();
    },
    cursor(value: unknown) {
      cursor = toViewerCursor(value);
      applyCursor();
    },
    focus() {
      focusWanted = !interactive();
      sink.focus();
    },
  };
}
