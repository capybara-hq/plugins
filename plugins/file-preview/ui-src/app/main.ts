/**
 * Boot of the embed app: bridge -> theme -> watchdog -> renderer. The previewer id comes from the
 * shell's `<meta name="previewer">`; the file arrives over the message bridge after `init`.
 * No `resize` messages: the panel has a fixed height and the renderers scroll internally.
 */
import type { PreviewerId } from "../../src/previewers.js";
import { loadRenderer as defaultLoadRenderer } from "../renderers/index.js";
import { type BridgeEvent, createBridge } from "./bridge.js";
import { showEmpty, showError, showLoading, translator, workerReason } from "./frame.js";
import { applyTheme, THEME } from "./theme.js";
import type { PreviewFile, RenderContext, Renderer, RunInWorker } from "./types.js";
import { createWorkerHost, WorkerTimeoutError } from "./worker-host.js";

/** The whole-file budget (parse + paint) before the shell gives up. */
export const RENDER_BUDGET_MS = 20_000;

export interface AppDeps {
  win?: Window;
  loadRenderer?: (id: PreviewerId) => Promise<Renderer>;
  runInWorker?: RunInWorker;
  /** Loads a worker module (`assets/<id>.worker.js`); tests pass a fake. */
  importModule?: (url: string) => Promise<{ default?: unknown }>;
  budgetMs?: number;
  /** Tests substitute the bridge to deliver more than one file; the page's bridge delivers one. */
  createBridge?: typeof createBridge;
}

const importModule = (url: string): Promise<{ default?: unknown }> => import(url);

const BASE_CSS = `
/* color-scheme follows the host theme (applyTheme); scrollbars are a thumb on a clear track, inherited */
:root { color-scheme: light dark; scrollbar-color: ${THEME.scrollThumb} transparent; }
html, body { height: 100%; margin: 0; }
body { font: 14px/1.5 ${THEME.font}; color: ${THEME.foreground}; background: ${THEME.background}; }
#root { position: relative; height: 100%; overflow: auto; }
.cap-content { height: 100%; }
.cap-status { position: absolute; inset: 0; background: ${THEME.background}; }
.cap-state { padding: 24px; text-align: center; color: ${THEME.mutedForeground}; }
.cap-error-title { font-weight: 600; color: ${THEME.foreground}; }
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
  // The worker scripts sit beside app.js: the shell is `…/ui/<id>`, the assets `…/ui/assets/`.
  // Creating the host touches neither `Worker` nor the modules; the first run does.
  const g = win as Window & typeof globalThis;
  const host = createWorkerHost({
    importModule: deps.importModule ?? importModule,
    Worker: g.Worker,
    createObjectURL: (b) => g.URL.createObjectURL(b),
    revokeObjectURL: (u) => g.URL.revokeObjectURL(u),
    assetBase: new URL("assets/", doc.baseURI).href,
  });
  const runInWorker = deps.runInWorker ?? host.run;
  const budgetMs = deps.budgetMs ?? RENDER_BUDGET_MS;

  const root = doc.getElementById("root");
  if (!root) throw new Error("file-preview: #root is missing");
  const style = doc.createElement("style");
  style.textContent = BASE_CSS;
  doc.head.append(style);

  // The renderer paints into `content`; loading / empty / error live in `status`, which overlays it
  // until the render succeeds. `content` is hidden with `visibility`, not `display:none`, so it is
  // laid out while the renderer runs and renderers that measure layout read real sizes.
  // `content` fills the viewport (a definite height): a renderer's own scroller (the sheet's
  // virtual table, the zip tree, pdf pages, docx, code) does the scrolling, not `#root`; a renderer
  // whose content overflows without a scroller of its own still scrolls through `#root`.
  const status = doc.createElement("div");
  status.className = "cap-status";
  const content = doc.createElement("div");
  content.className = "cap-content";
  content.style.visibility = "hidden";
  root.replaceChildren(status, content);

  let locale: "zh" | "en" = "en";
  let t = translator(locale);
  const controller = new AbortController();
  // the lifetime of the file being previewed: a new file or the teardown ends it
  let lifetimeOf: AbortController | undefined;
  let failed = false;
  let rendered = false;
  let initialized = false;

  const fail = (reason: string) => {
    // after teardown nothing is painted: the app is gone, its renderer's late errors with it
    if (controller.signal.aborted) return;
    failed = true;
    // the file is given up: no worker keeps parsing it
    host.dispose();
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
    lifetimeOf?.abort();
    const lifetime = new AbortController();
    lifetimeOf = lifetime;
    const onTeardown = () => lifetime.abort();
    controller.signal.addEventListener("abort", onTeardown);
    const fileController = new AbortController();
    const onAbort = () => fileController.abort();
    controller.signal.addEventListener("abort", onAbort);
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ctx: RenderContext = {
      root: content,
      locale,
      signal: fileController.signal,
      lifetime: lifetime.signal,
      t,
      runInWorker,
      showError: (reason) => {
        if (!settled) fail(reason);
      },
    };
    const timeout = new Promise<never>((_, reject) => {
      // shown as the shell's timeout message (workerReason)
      timer = setTimeout(() => reject(new WorkerTimeoutError("preview", budgetMs)), budgetMs);
    });
    try {
      const renderer = await Promise.race([loadRenderer(previewer as PreviewerId), timeout]);
      await Promise.race([renderer(file, ctx), timeout]);
      if (!failed) {
        rendered = true;
        // loading / empty / error are set on the status layer by frame.ts; success too
        status.dataset.state = "ready";
        status.replaceChildren();
        status.style.display = "none";
        content.style.visibility = "";
      }
    } catch (e) {
      if (!failed) fail(workerReason(e, locale));
    } finally {
      settled = true;
      clearTimeout(timer);
      fileController.abort();
      controller.signal.removeEventListener("abort", onAbort);
      // `onTeardown` stays: the lifetime ends with the embed or the next file, not with the render
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

  const stopBridge = (deps.createBridge ?? createBridge)(win, onEvent);
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
    // the running worker is terminated and its late result never reaches a renderer
    host.dispose();
  };
}

if (typeof document !== "undefined" && document.querySelector('meta[name="previewer"]')) {
  startApp();
}
