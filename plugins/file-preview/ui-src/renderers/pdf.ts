/**
 * The pdf previewer: pdf.js (legacy build) renders page by page into canvases, only the pages in
 * the viewport plus one on each side, each within its own budget.
 *
 * pdf.js runs in a Web Worker started like every other worker of the embed: the build ships
 * `assets/pdfjs.worker.js`, an ES module whose default export is pdf.js's worker bundle; this file
 * `import()`s it, starts a `Worker` from a `blob:` URL of the text and hands it to pdf.js as its
 * port (`new PDFWorker({ port })`, the per-document form of `GlobalWorkerOptions.workerPort`).
 * Nothing is fetched (WebKit refuses `connect-src 'self'` in the opaque-origin embed):
 * - cmaps and standard fonts come through `BinaryDataFactory`, which pdf.js calls on the main
 *   thread when `useWorkerFetch` is false; it `import()`s the build's `pdfjs-cmap-<file>.js` /
 *   `pdfjs-font-<file>.js` modules, whose default export is the file's base64;
 * - `useWasm: false`: JPEG 2000 / JBIG2 images use the JS decoders bundled into the worker, colour
 *   profiles and PostScript functions their JS paths;
 * - pdf.js 6 has no eval code path (the old `isEvalSupported` option is gone), XFA is off, and the
 *   offscreen renderer worker (`disableWorkerRendering`) is off since it would load its own script.
 * A password-protected PDF gets a message, never a password prompt.
 */
import type { PreviewFile, RenderContext, Renderer } from "../app/types.js";

/** The budget of one page (load + paint). */
export const PAGE_BUDGET_MS = 10_000;

const STRINGS = {
  zh: {
    password: "这是受密码保护的 PDF",
    invalid: "PDF 文件已损坏或不完整",
    noPages: "此 PDF 没有页面",
    pageError: "此页无法渲染",
    pageTimeout: "此页渲染超时",
    page: "页码",
    zoomIn: "放大",
    zoomOut: "缩小",
    fit: "适合宽度",
    actual: "实际大小",
    toolbar: "PDF 工具栏",
  },
  en: {
    password: "This is a password-protected PDF",
    invalid: "The PDF is damaged or incomplete",
    noPages: "This PDF has no pages",
    pageError: "This page could not be rendered",
    pageTimeout: "This page took too long to render",
    page: "Page",
    zoomIn: "Zoom in",
    zoomOut: "Zoom out",
    fit: "Fit width",
    actual: "Actual size",
    toolbar: "PDF toolbar",
  },
} as const;

type Strings = Record<keyof (typeof STRINGS)["en"], string>;

/** The slice of pdf.js this renderer uses (tests pass a stand-in). */
export interface PdfViewport {
  width: number;
  height: number;
}
export interface PdfRenderTask {
  promise: Promise<void>;
  cancel(): void;
}
export interface PdfPage {
  getViewport(o: { scale: number }): PdfViewport;
  render(o: {
    canvas: HTMLCanvasElement;
    viewport: PdfViewport;
    transform?: number[];
  }): PdfRenderTask;
  cleanup(): unknown;
}
export interface PdfDocument {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
  destroy(): Promise<void>;
}
export interface PdfLib {
  getDocument(params: Record<string, unknown>): {
    promise: Promise<PdfDocument>;
    destroy(): Promise<void>;
  };
  PDFWorker: new (o: { port: Worker }) => unknown;
}

export interface PdfDeps {
  loadPdfjs: () => Promise<PdfLib>;
  /** Loads a module of the build by absolute URL: `(url) => import(url)` in the embed. */
  importModule: (url: string) => Promise<{ default?: unknown }>;
  Worker: typeof Worker;
  createObjectURL: (b: Blob) => string;
  revokeObjectURL: (url: string) => void;
  /** The URL of the built assets, ending in `/`. */
  assetBase: string;
  devicePixelRatio?: number;
}

/** Served names are flat: anything else pdf.js asks for is refused, not imported. */
const DATA_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;
/** Space around and between pages, in CSS px. */
const PAD = 16;
const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;
/** Pages kept painted beyond the rendered window on each side; further ones drop their canvas. */
const KEEP_PAINTED = 4;
/** Safari's canvas limit: a larger backing store paints nothing, so the pixel ratio gives way. */
const MAX_CANVAS_PIXELS = 16_777_216;

const CSS = `
.cap-pdf { display: flex; flex-direction: column; height: 100%; }
.cap-pdf-bar { display: flex; align-items: center; gap: 4px; padding: 4px 8px; flex: none;
  border-bottom: 1px solid var(--cap-border, rgba(127,127,127,.3));
  background: var(--cap-background, Canvas); font-size: 12px; }
.cap-pdf-bar button { font: inherit; color: inherit; background: transparent; cursor: pointer;
  border: 1px solid var(--cap-border, rgba(127,127,127,.3)); border-radius: 4px; padding: 2px 8px; }
.cap-pdf-bar button:hover { background: var(--cap-muted, rgba(127,127,127,.12)); }
.cap-pdf-indicator { margin-right: auto; font-variant-numeric: tabular-nums; }
.cap-pdf-zoom { min-width: 3.5em; text-align: center; font-variant-numeric: tabular-nums; }
.cap-pdf-pages { flex: 1; min-height: 0; overflow: auto; padding: ${PAD}px; box-sizing: border-box;
  background: var(--cap-muted, rgba(127,127,127,.12)); }
.cap-pdf-page { position: relative; margin: 0 auto ${PAD}px; background: #fff;
  box-shadow: 0 1px 3px rgba(0,0,0,.25); }
.cap-pdf-page canvas { display: block; width: 100%; height: 100%; }
.cap-pdf-page-error { position: absolute; inset: 0; display: flex; align-items: center;
  justify-content: center; padding: 16px; text-align: center; color: #555; font-size: 13px;
  overflow-wrap: anywhere; }
.cap-pdf-empty { padding: 24px; text-align: center; color: var(--cap-muted-foreground, GrayText); }
`;

function message(e: unknown): string {
  return e instanceof Error && e.message !== "" ? e.message : String(e);
}

function base64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * pdf.js's `BinaryDataFactory` (called on the main thread with `useWorkerFetch: false`): reads
 * cmaps and standard fonts from the build's base64 modules instead of fetching them.
 */
function dataFactory(importModule: PdfDeps["importModule"], assetBase: string) {
  return class AssetDataFactory {
    async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
      const prefix =
        kind === "cMapUrl" ? "pdfjs-cmap-" : kind === "standardFontDataUrl" ? "pdfjs-font-" : null;
      if (prefix === null || !DATA_NAME_RE.test(filename)) {
        throw new Error(`pdf data "${kind}/${filename}" is not shipped`);
      }
      const mod = await importModule(`${assetBase}${prefix}${filename}.js`);
      if (typeof mod.default !== "string") throw new Error(`pdf data "${filename}" is malformed`);
      return base64Bytes(mod.default);
    }
  };
}

/** Starts pdf.js's worker from a `blob:` URL of the shipped bundle (no fetch, `worker-src blob:`). */
async function startWorker(deps: PdfDeps, started: (w: Worker) => void): Promise<Worker> {
  const src = `${deps.assetBase}pdfjs.worker.js`;
  const mod = await deps.importModule(src);
  if (typeof mod.default !== "string") throw new Error(`${src} has no worker source`);
  const url = deps.createObjectURL(new Blob([mod.default], { type: "text/javascript" }));
  try {
    const w = new deps.Worker(url);
    started(w);
    return w;
  } finally {
    deps.revokeObjectURL(url);
  }
}

function isPasswordError(e: unknown): boolean {
  return (
    typeof e === "object" && e !== null && (e as { name?: unknown }).name === "PasswordException"
  );
}

type Zoom = "fit" | number;

interface PageSlot {
  el: HTMLDivElement;
  /** Size at scale 1: the first page's until this page is loaded. */
  base: PdfViewport;
  /** The zoom generation painted (or being painted) into this slot; -1 = none. */
  generation: number;
  task: PdfRenderTask | undefined;
}

/** Renders `file` with injectable pdf.js, worker and module loading. */
export async function renderPdf(
  file: PreviewFile,
  ctx: RenderContext,
  deps: PdfDeps,
): Promise<void> {
  const s: Strings = STRINGS[ctx.locale];
  const doc0 = ctx.root.ownerDocument;
  let worker: Worker | undefined;
  let loading: ReturnType<PdfLib["getDocument"]> | undefined;
  let pdf: PdfDocument | undefined;
  /** Until this renderer resolves, the shell's abort means "stop": afterwards the pages live on. */
  let resolved = false;
  const cleanup = () => {
    void loading?.destroy().catch(() => {});
    worker?.terminate();
  };
  const onAbort = () => {
    if (!resolved) cleanup();
  };
  ctx.signal.addEventListener("abort", onAbort);
  /** Rejects once the shell aborts, so no await outlives it. */
  const aborted = new Promise<never>((_, reject) => {
    const fire = () => reject(new Error("aborted"));
    if (ctx.signal.aborted) fire();
    else ctx.signal.addEventListener("abort", fire);
  });
  aborted.catch(() => {});
  const live = <T>(p: Promise<T>) => Promise.race([p, aborted]);

  try {
    const lib = await live(deps.loadPdfjs());
    await live(
      startWorker(deps, (w) => {
        worker = w;
        // the shell gave up while the worker module was loading: it must not outlive the file
        if (ctx.signal.aborted && !resolved) w.terminate();
      }),
    );
    const port = worker as unknown as Worker;
    loading = lib.getDocument({
      data: new Uint8Array(file.data),
      worker: new lib.PDFWorker({ port }),
      // pdf.js wants these set (with a trailing slash) but never fetches them: the factory maps
      // each request to its `pdfjs-<kind>-<file>.js` module
      BinaryDataFactory: dataFactory(deps.importModule, deps.assetBase),
      cMapUrl: `${deps.assetBase}pdfjs-cmap/`,
      cMapPacked: true,
      standardFontDataUrl: `${deps.assetBase}pdfjs-font/`,
      useWorkerFetch: false,
      useWasm: false,
      enableXfa: false,
      disableWorkerRendering: true,
      isOffscreenCanvasSupported: true,
      stopAtErrors: false,
    });
    pdf = await live(loading.promise);
  } catch (e) {
    ctx.signal.removeEventListener("abort", onAbort);
    cleanup();
    if (ctx.signal.aborted) return;
    if (isPasswordError(e)) ctx.showError(s.password);
    else if (worker === undefined || loading === undefined) ctx.showError(message(e));
    else ctx.showError(`${s.invalid}: ${message(e)}`);
    return;
  }

  const pdfDoc = pdf;
  if (pdfDoc.numPages === 0) {
    const empty = doc0.createElement("div");
    empty.className = "cap-pdf-empty";
    empty.textContent = s.noPages;
    ctx.root.replaceChildren(empty);
    resolved = true;
    ctx.signal.removeEventListener("abort", onAbort);
    cleanup();
    return;
  }

  let first: PdfPage;
  try {
    first = await live(pdfDoc.getPage(1));
  } catch (e) {
    ctx.signal.removeEventListener("abort", onAbort);
    cleanup();
    if (!ctx.signal.aborted) ctx.showError(`${s.invalid}: ${message(e)}`);
    return;
  }
  const firstBase = first.getViewport({ scale: 1 });

  // ---- the frame: toolbar + scrolling pages
  const style = doc0.createElement("style");
  style.textContent = CSS;
  const frame = doc0.createElement("div");
  frame.className = "cap-pdf";
  const bar = doc0.createElement("div");
  bar.className = "cap-pdf-bar";
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", s.toolbar);
  const indicator = doc0.createElement("span");
  indicator.className = "cap-pdf-indicator";
  indicator.setAttribute("aria-label", s.page);
  indicator.setAttribute("aria-live", "polite");
  const zoomLabel = doc0.createElement("span");
  zoomLabel.className = "cap-pdf-zoom";
  const mkButton = (action: string, text: string, label: string) => {
    const b = doc0.createElement("button");
    b.type = "button";
    b.dataset.action = action;
    b.textContent = text;
    b.title = label;
    b.setAttribute("aria-label", label);
    return b;
  };
  const zoomOut = mkButton("zoom-out", "−", s.zoomOut);
  const zoomIn = mkButton("zoom-in", "+", s.zoomIn);
  const fitButton = mkButton("fit", s.fit, s.fit);
  const actualButton = mkButton("actual", "100%", s.actual);
  bar.append(indicator, zoomOut, zoomLabel, zoomIn, fitButton, actualButton);
  const scroller = doc0.createElement("div");
  scroller.className = "cap-pdf-pages";
  scroller.tabIndex = 0;
  frame.append(bar, scroller);

  const slots: PageSlot[] = [];
  for (let n = 1; n <= pdfDoc.numPages; n++) {
    const el = doc0.createElement("div");
    el.className = "cap-pdf-page";
    el.dataset.page = String(n);
    slots.push({ el, base: firstBase, generation: -1, task: undefined });
    scroller.append(el);
  }
  ctx.root.style.height = "100%";
  ctx.root.replaceChildren(style, frame);

  // ---- layout, arithmetic (no measuring per page): page i starts at PAD + sum(h_j + PAD), j < i
  let zoom: Zoom = "fit";
  let scale = 1;
  let generation = 0;
  const dpr = deps.devicePixelRatio ?? 1;

  const fitScale = () => {
    const width = scroller.clientWidth - 2 * PAD;
    return width > 0 ? width / firstBase.width : 1;
  };
  const layout = () => {
    for (const slot of slots) {
      slot.el.style.width = `${Math.floor(slot.base.width * scale)}px`;
      slot.el.style.height = `${Math.floor(slot.base.height * scale)}px`;
    }
    zoomLabel.textContent = `${Math.round(scale * 100)}%`;
  };
  const tops = (): number[] => {
    const out: number[] = [];
    let y = PAD;
    for (const slot of slots) {
      out.push(y);
      y += Math.floor(slot.base.height * scale) + PAD;
    }
    return out;
  };

  const pageError = (slot: PageSlot, text: string) => {
    const err = doc0.createElement("div");
    err.className = "cap-pdf-page-error";
    err.setAttribute("role", "alert");
    err.textContent = text;
    slot.el.replaceChildren(err);
  };

  /** Paints page `n` at the current zoom; settles (painted or inline error) within the budget. */
  const paint = async (n: number): Promise<void> => {
    const slot = slots[n - 1] as PageSlot;
    const gen = generation;
    slot.generation = gen;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const budget = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        slot.task?.cancel();
        reject(new Error(s.pageTimeout));
      }, PAGE_BUDGET_MS);
    });
    budget.catch(() => {});
    try {
      const page = n === 1 ? first : await Promise.race([pdfDoc.getPage(n), budget]);
      if (gen !== generation) return;
      const base = page.getViewport({ scale: 1 });
      if (base.width !== slot.base.width || base.height !== slot.base.height) {
        slot.base = base;
        layout();
      }
      const viewport = page.getViewport({ scale });
      const ratio = Math.min(
        dpr,
        Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, viewport.width * viewport.height)),
      );
      const canvas = doc0.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
      canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
      const task = page.render({
        canvas,
        viewport,
        ...(ratio !== 1 ? { transform: [ratio, 0, 0, ratio, 0, 0] } : {}),
      });
      slot.task = task;
      await Promise.race([task.promise, budget]);
      if (gen !== generation) return;
      slot.el.replaceChildren(canvas);
    } catch (e) {
      if (gen !== generation) return;
      if (timedOut) pageError(slot, s.pageTimeout);
      else {
        const name = (e as { name?: unknown } | null)?.name;
        if (name === "RenderingCancelledException") return;
        pageError(slot, `${s.pageError}${ctx.locale === "zh" ? "：" : ": "}${message(e)}`);
      }
    } finally {
      clearTimeout(timer);
      if (slot.generation === gen) slot.task = undefined;
    }
  };

  /** Updates the indicator and paints the visible pages ±1 not painted at this zoom yet. */
  const update = (): Promise<void>[] => {
    const top = scroller.scrollTop;
    const height = Math.max(1, scroller.clientHeight);
    const bottom = top + height;
    const starts = tops();
    let firstVisible = -1;
    let lastVisible = -1;
    let current = 1;
    let best = -1;
    starts.forEach((y, i) => {
      const h = Math.floor((slots[i] as PageSlot).base.height * scale);
      const overlap = Math.min(bottom, y + h) - Math.max(top, y);
      if (overlap > 0) {
        if (firstVisible < 0) firstVisible = i;
        lastVisible = i;
        if (overlap > best) {
          best = overlap;
          current = i + 1;
        }
      }
    });
    if (firstVisible < 0) {
      // between pages (in a gap): the nearest page above
      const above = starts.findLastIndex((y) => y <= top);
      firstVisible = lastVisible = Math.max(0, above);
      current = firstVisible + 1;
    }
    indicator.textContent = `${current} / ${slots.length}`;
    const work: Promise<void>[] = [];
    const from = Math.max(0, firstVisible - 1);
    const to = Math.min(slots.length - 1, lastVisible + 1);
    for (let i = from; i <= to; i++) {
      if ((slots[i] as PageSlot).generation !== generation) work.push(paint(i + 1));
    }
    // pages far from the viewport give their canvas back (a long PDF would hold one per page)
    slots.forEach((slot, i) => {
      if (i >= from - KEEP_PAINTED && i <= to + KEEP_PAINTED) return;
      if (slot.task !== undefined || slot.el.firstChild === null) return;
      slot.el.replaceChildren();
      slot.generation = -1;
    });
    return work;
  };

  const setZoom = (next: Zoom) => {
    // keep the page at the top of the viewport where it is
    const starts = tops();
    const anchor = Math.max(
      0,
      starts.findLastIndex((y) => y <= scroller.scrollTop),
    );
    const offset = (scroller.scrollTop - (starts[anchor] ?? 0)) / scale;
    zoom = next;
    const nextScale = next === "fit" ? fitScale() : next;
    if (nextScale === scale && slots.every((sl) => sl.generation === generation)) {
      layout();
      return;
    }
    scale = nextScale;
    generation++;
    for (const slot of slots) {
      slot.task?.cancel();
      slot.task = undefined;
      slot.generation = -1;
      // a stale page keeps its old paint, stretched to the new size, until it is visible again
    }
    layout();
    scroller.scrollTop = (tops()[anchor] ?? 0) + offset * scale;
    void update();
  };
  const currentScale = () => scale;
  zoomIn.addEventListener("click", () => {
    const next = ZOOM_STEPS.find((z) => z > currentScale() + 1e-6);
    if (next !== undefined) setZoom(next);
  });
  zoomOut.addEventListener("click", () => {
    const next = ZOOM_STEPS.findLast((z) => z < currentScale() - 1e-6);
    if (next !== undefined) setZoom(next);
  });
  fitButton.addEventListener("click", () => setZoom("fit"));
  actualButton.addEventListener("click", () => setZoom(1));
  scroller.addEventListener("scroll", () => void update(), { passive: true });
  const view = doc0.defaultView as (Window & typeof globalThis) | null;
  if (view && typeof view.ResizeObserver === "function") {
    let lastWidth = scroller.clientWidth;
    new view.ResizeObserver(() => {
      if (scroller.clientWidth === lastWidth) return;
      lastWidth = scroller.clientWidth;
      if (zoom === "fit") setZoom("fit");
      else void update();
    }).observe(scroller);
  }

  scale = fitScale();
  layout();
  const initial = update();
  // the shell shows the preview once the first page settled (painted or an inline error); the rest
  // keep painting after this resolves, and the shell's abort no longer stops them
  try {
    await live(initial[0] ?? Promise.resolve());
  } catch {
    // aborted by the shell: stop everything
    ctx.signal.removeEventListener("abort", onAbort);
    cleanup();
    return;
  }
  resolved = true;
  ctx.signal.removeEventListener("abort", onAbort);
}

const importModule = (url: string): Promise<{ default?: unknown }> => import(url);

/** The renderer the shell loads: real pdf.js, worker and module loading. */
const render: Renderer = (file, ctx) => {
  const g = ctx.root.ownerDocument.defaultView as Window & typeof globalThis;
  return renderPdf(file, ctx, {
    loadPdfjs: async () => (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfLib,
    importModule,
    Worker: g.Worker,
    createObjectURL: (b) => g.URL.createObjectURL(b),
    revokeObjectURL: (u) => g.URL.revokeObjectURL(u),
    assetBase: new URL("assets/", ctx.root.ownerDocument.baseURI).href,
    devicePixelRatio: g.devicePixelRatio || 1,
  });
};

export { render };
