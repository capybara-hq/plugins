/**
 * Boot of the embed app: bridge -> theme -> watchdog -> renderer. The previewer id comes from the
 * shell's `<meta name="previewer">`; the file arrives over the message bridge after `init`.
 * No `resize` messages: the panel has a fixed height and the renderers scroll internally.
 */
import type { PreviewerId } from "../../src/previewers.js";
import { loadRenderer as defaultLoadRenderer } from "../renderers/index.js";
import { type BridgeEvent, createBridge } from "./bridge.js";
import { MESSAGES, showEmpty, showError, showLoading, translator } from "./frame.js";
import { applyTheme } from "./theme.js";
import type { PreviewFile, RenderContext, Renderer, RunInWorker } from "./types.js";

/** The whole-file budget (parse + paint) before the shell gives up. */
export const RENDER_BUDGET_MS = 20_000;

export interface AppDeps {
  win?: Window;
  loadRenderer?: (id: PreviewerId) => Promise<Renderer>;
  runInWorker?: RunInWorker;
  budgetMs?: number;
}

const workersNotAvailable: RunInWorker = () =>
  Promise.reject(new Error("workers not available yet"));

const BASE_CSS = `
:root { color-scheme: light dark; }
html, body { height: 100%; margin: 0; }
body { font: 14px/1.5 system-ui, sans-serif; color: var(--cap-foreground, CanvasText);
  background: var(--cap-background, Canvas); }
#root { position: relative; height: 100%; overflow: auto; }
.cap-status { position: absolute; inset: 0; background: var(--cap-background, Canvas); }
.cap-state { padding: 24px; text-align: center; color: var(--cap-muted-foreground, GrayText); }
.cap-error-title { font-weight: 600; color: var(--cap-foreground, CanvasText); }
.cap-error-reason { margin: 8px 0; overflow-wrap: anywhere; }
`;

function message(e: unknown): string {
  return e instanceof Error && e.message !== "" ? e.message : String(e);
}

/** Starts the app in `win`; returns the function that tears it down. */
export function startApp(deps: AppDeps = {}): () => void {
  const win = deps.win ?? window;
  const doc = win.document;
  const loadRenderer = deps.loadRenderer ?? defaultLoadRenderer;
  const runInWorker = deps.runInWorker ?? workersNotAvailable;
  const budgetMs = deps.budgetMs ?? RENDER_BUDGET_MS;

  const root = doc.getElementById("root");
  if (!root) throw new Error("file-preview: #root is missing");
  const style = doc.createElement("style");
  style.textContent = BASE_CSS;
  doc.head.append(style);

  // The renderer paints into `content`; loading / empty / error live in `status`, which overlays it
  // until the render succeeds. `content` is hidden with `visibility`, not `display:none`, so it is
  // laid out while the renderer runs and renderers that measure layout read real sizes.
  const status = doc.createElement("div");
  status.className = "cap-status";
  const content = doc.createElement("div");
  content.style.visibility = "hidden";
  root.replaceChildren(status, content);

  let locale: "zh" | "en" = "en";
  let t = translator(locale);
  const controller = new AbortController();
  let failed = false;
  let rendered = false;
  let initialized = false;

  const fail = (reason: string) => {
    failed = true;
    content.style.visibility = "hidden";
    status.style.display = "";
    showError(status, t, reason);
  };

  const run = async (file: PreviewFile) => {
    if (file.size === 0) {
      showEmpty(status, t);
      return;
    }
    showLoading(status, t);
    const previewer = doc.querySelector('meta[name="previewer"]')?.getAttribute("content") ?? "";
    const fileController = new AbortController();
    const onAbort = () => fileController.abort();
    controller.signal.addEventListener("abort", onAbort);
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ctx: RenderContext = {
      root: content,
      locale,
      signal: fileController.signal,
      t,
      runInWorker,
      showError: (reason) => {
        if (!settled) fail(reason);
      },
    };
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(MESSAGES[locale].timeout)), budgetMs);
    });
    try {
      const renderer = await Promise.race([loadRenderer(previewer as PreviewerId), timeout]);
      await Promise.race([renderer(file, ctx), timeout]);
      if (!failed) {
        rendered = true;
        status.replaceChildren();
        status.style.display = "none";
        content.style.visibility = "";
      }
    } catch (e) {
      if (!failed) fail(message(e));
    } finally {
      settled = true;
      clearTimeout(timer);
      fileController.abort();
      controller.signal.removeEventListener("abort", onAbort);
    }
  };

  const onEvent = (e: BridgeEvent) => {
    switch (e.type) {
      case "init":
        locale = e.locale;
        t = translator(locale);
        doc.documentElement.lang = locale;
        applyTheme(doc, e.theme, e.tokens);
        // a later init (the page re-sent it) only re-themes: never loading over a painted preview
        if (!initialized) showLoading(status, t);
        initialized = true;
        break;
      case "theme":
        applyTheme(doc, e.theme, e.tokens);
        break;
      case "file":
        void run(e.file);
        break;
    }
  };

  const stopBridge = createBridge(win, onEvent);
  // once the preview is painted, a stray error must not replace it
  const onError = (e: ErrorEvent) => {
    if (!rendered) fail(e.message || message(e.error));
  };
  const onRejection = (e: PromiseRejectionEvent) => {
    if (!rendered) fail(message(e.reason));
  };
  win.addEventListener("error", onError);
  win.addEventListener("unhandledrejection", onRejection);

  return () => {
    stopBridge();
    win.removeEventListener("error", onError);
    win.removeEventListener("unhandledrejection", onRejection);
    controller.abort();
  };
}

if (typeof document !== "undefined" && document.querySelector('meta[name="previewer"]')) {
  startApp();
}
