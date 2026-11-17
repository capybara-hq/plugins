// @vitest-environment jsdom

import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { EMBED_PROTOCOL } from "@capybara-hq/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { MESSAGES, translator } from "../ui-src/app/frame.js";
import { startApp } from "../ui-src/app/main.js";
import type { PreviewFile, RenderContext } from "../ui-src/app/types.js";
import {
  PAGE_BUDGET_MS,
  type PdfDeps,
  type PdfDocument,
  type PdfLib,
  type PdfPage,
  renderPdf,
} from "../ui-src/renderers/pdf.js";

const BASE = "https://host.test/plugin-ui/file-preview/ui/assets/";
const FIXTURES = join(import.meta.dirname, "fixtures/pdf");
const PDFJS_DIR = dirname(
  createRequire(join(import.meta.dirname, "../package.json")).resolve("pdfjs-dist/package.json"),
);

/** The scroller's size as the layout would report it (jsdom has no layout). */
let viewport = { width: 632, height: 500 };

beforeEach(() => {
  viewport = { width: 632, height: 500 };
  for (const [prop, key] of [
    ["clientWidth", "width"],
    ["clientHeight", "height"],
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains("cap-pdf-pages") ? viewport[key] : 0;
      },
    });
  }
});

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeWorker {
  static instances: FakeWorker[] = [];
  terminate = vi.fn();
  constructor(readonly url: string) {
    FakeWorker.instances.push(this);
  }
}

interface RenderCall {
  page: number;
  scale: number;
  cancel: Mock<() => void>;
  resolve: () => void;
  reject: (e: Error) => void;
}

/** A pdf.js stand-in: `pages` pages of 600 x 800 at scale 1; every render waits for the test. */
function fakeLib(opts: { pages?: number; openError?: Error; autoResolve?: boolean } = {}) {
  const renders: RenderCall[] = [];
  const params: Array<Record<string, unknown>> = [];
  const ports: unknown[] = [];
  const destroy = vi.fn(async () => {});
  const doc: PdfDocument = {
    numPages: opts.pages ?? 3,
    async getPage(n: number): Promise<PdfPage> {
      return {
        getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale }),
        render: ({ viewport: vp }) => {
          const { promise, resolve, reject } = deferred<void>();
          const call: RenderCall = {
            page: n,
            scale: vp.width / 600,
            cancel: vi.fn<() => void>(() =>
              reject(
                Object.assign(new Error("cancelled"), { name: "RenderingCancelledException" }),
              ),
            ),
            resolve,
            reject,
          };
          renders.push(call);
          if (opts.autoResolve !== false) resolve();
          return { promise, cancel: call.cancel };
        },
        cleanup: () => true,
      };
    },
    destroy,
  };
  const lib: PdfLib = {
    getDocument(p) {
      params.push(p as Record<string, unknown>);
      return {
        promise: opts.openError ? Promise.reject(opts.openError) : Promise.resolve(doc),
        destroy,
      };
    },
    PDFWorker: class {
      constructor({ port }: { port: unknown }) {
        ports.push(port);
      }
      destroy() {}
    },
  };
  return { lib, renders, params, ports, destroy };
}

function deps(lib: PdfLib, extra: Partial<PdfDeps> = {}): PdfDeps {
  return {
    loadPdfjs: async () => lib,
    importModule: async (url) => {
      if (url === `${BASE}pdfjs.worker.js`) return { default: "/* pdf.js worker */" };
      throw new Error(`unexpected import ${url}`);
    },
    Worker: FakeWorker as unknown as typeof Worker,
    createObjectURL: () => "blob:null/1",
    revokeObjectURL: vi.fn(),
    assetBase: BASE,
    devicePixelRatio: 1,
    ...extra,
  };
}

function context(locale: "zh" | "en" = "en") {
  const root = document.createElement("div");
  document.body.append(root);
  const showError = vi.fn<(reason: string) => void>();
  const controller = new AbortController();
  const ctx: RenderContext = {
    root,
    locale,
    signal: controller.signal,
    lifetime: new AbortController().signal,
    t: translator(locale),
    runInWorker: vi.fn(),
    showError,
  };
  return { ctx, root, showError, controller };
}

function pdfFile(data: ArrayBuffer = new ArrayBuffer(8)): PreviewFile {
  return { name: "a.pdf", contentType: "application/pdf", size: data.byteLength, data };
}

function fixture(name: string): PreviewFile {
  const b = readFileSync(join(FIXTURES, name));
  return pdfFile(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

const indicator = (root: HTMLElement) => root.querySelector(".cap-pdf-indicator")?.textContent;
const button = (root: HTMLElement, action: string) => {
  const b = root.querySelector<HTMLButtonElement>(`button[data-action="${action}"]`);
  if (!b) throw new Error(`no ${action} button`);
  return b;
};
const scroller = (root: HTMLElement) => root.querySelector(".cap-pdf-pages") as HTMLElement;
const renderedPages = (renders: RenderCall[]) => [...new Set(renders.map((r) => r.page))].sort();

describe("pdf renderer", () => {
  it("opens the document through pdf.js's worker port, with no fetch, eval or WebAssembly", async () => {
    FakeWorker.instances = [];
    const { lib, params, ports } = fakeLib();
    const { ctx, showError } = context();
    await renderPdf(pdfFile(), ctx, deps(lib));
    expect(showError).not.toHaveBeenCalled();
    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0]?.url).toBe("blob:null/1");
    expect(ports).toEqual([FakeWorker.instances[0]]);
    const p = params[0] ?? {};
    expect(p.useWorkerFetch).toBe(false);
    expect(p.useWasm).toBe(false);
    expect(p.enableXfa).toBe(false);
    expect(p.disableWorkerRendering).toBe(true);
    expect(p.cMapUrl).toBe(`${BASE}pdfjs-cmap/`);
    expect(p.cMapPacked).toBe(true);
    expect(p.standardFontDataUrl).toBe(`${BASE}pdfjs-font/`);
    expect(typeof p.BinaryDataFactory).toBe("function");
    expect(p.worker).toBeDefined();
  });

  it("shows the page indicator 1 / 3", async () => {
    const { lib } = fakeLib({ pages: 3 });
    const { ctx, root } = context();
    await renderPdf(pdfFile(), ctx, deps(lib));
    expect(indicator(root)).toBe("1 / 3");
  });

  it("renders only the pages in the viewport plus one, and more as the person scrolls", async () => {
    const { lib, renders } = fakeLib({ pages: 6 });
    const { ctx, root } = context();
    await renderPdf(pdfFile(), ctx, deps(lib));
    // fit width: (632 - 2 * 16) / 600 = 1 -> pages are 800 px tall, the viewport 500 px
    await vi.waitFor(() => expect(renderedPages(renders)).toEqual([1, 2]));
    expect(renders.every((r) => r.scale === 1)).toBe(true);

    // page 4 starts at 16 + 3 * (800 + 16) = 2464
    const s = scroller(root);
    s.scrollTop = 2464 + 10;
    s.dispatchEvent(new Event("scroll"));
    await vi.waitFor(() => expect(renderedPages(renders)).toEqual([1, 2, 3, 4, 5]));
    expect(indicator(root)).toBe("4 / 6");
    expect(renders.filter((r) => r.page === 6)).toHaveLength(0);
  });

  it("drops the canvases of pages far from the viewport and repaints them on return", async () => {
    const { lib, renders } = fakeLib({ pages: 20 });
    const { ctx, root } = context();
    await renderPdf(pdfFile(), ctx, deps(lib));
    await vi.waitFor(() => expect(root.querySelector('[data-page="1"] canvas')).not.toBeNull());
    const s = scroller(root);
    s.scrollTop = 16 + 15 * 816; // page 16
    s.dispatchEvent(new Event("scroll"));
    await vi.waitFor(() => expect(root.querySelector('[data-page="16"] canvas')).not.toBeNull());
    expect(root.querySelector('[data-page="1"] canvas')).toBeNull();
    const before = renders.filter((r) => r.page === 1).length;
    s.scrollTop = 0;
    s.dispatchEvent(new Event("scroll"));
    await vi.waitFor(() => expect(root.querySelector('[data-page="1"] canvas')).not.toBeNull());
    expect(renders.filter((r) => r.page === 1).length).toBe(before + 1);
  });

  it("zooms to 100 %, in, out and back to fit width, re-rendering only the visible pages", async () => {
    viewport = { width: 1216, height: 500 }; // fit width = (1216 - 32) / 600 ~ 1.973
    const { lib, renders } = fakeLib({ pages: 5 });
    const { ctx, root } = context();
    await renderPdf(pdfFile(), ctx, deps(lib));
    await vi.waitFor(() => expect(renderedPages(renders)).toEqual([1, 2]));
    expect(renders[0]?.scale).toBeCloseTo(1184 / 600);

    const at = (from: number) => renders.slice(from);
    let mark = renders.length;
    button(root, "actual").click();
    await vi.waitFor(() => expect(renderedPages(at(mark))).toEqual([1, 2]));
    expect(at(mark).every((r) => r.scale === 1)).toBe(true);
    expect(root.querySelector(".cap-pdf-zoom")?.textContent).toBe("100%");

    mark = renders.length;
    button(root, "zoom-in").click();
    await vi.waitFor(() => expect(renderedPages(at(mark))).toEqual([1, 2]));
    expect(at(mark).every((r) => r.scale === 1.25)).toBe(true);

    mark = renders.length;
    viewport.height = 700;
    button(root, "zoom-out").click();
    button(root, "zoom-out").click();
    await vi.waitFor(() => expect(at(mark).some((r) => r.scale === 0.75)).toBe(true));
    // at 75 % pages are 600 px: in a 700 px viewport pages 1 and 2 show, page 3 is the +1
    await vi.waitFor(() =>
      expect(renderedPages(at(mark).filter((r) => r.scale === 0.75))).toEqual([1, 2, 3]),
    );
    expect(at(mark).some((r) => r.page > 3)).toBe(false);

    mark = renders.length;
    button(root, "fit").click();
    await vi.waitFor(() => expect(renderedPages(at(mark))).toEqual([1, 2]));
    expect(at(mark)[0]?.scale).toBeCloseTo(1184 / 600);
  });

  it("gives a page 10 s: a hung page shows an inline error and the next page still renders", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { lib, renders } = fakeLib({ pages: 3, autoResolve: false });
    const { ctx, root, showError } = context();
    const done = renderPdf(pdfFile(), ctx, deps(lib));
    // flush without moving the clock (vi.waitFor would advance fake timers)
    await vi.advanceTimersByTimeAsync(0);
    expect(renderedPages(renders)).toEqual([1, 2]);
    // page 2 paints, page 1 hangs
    renders.find((r) => r.page === 2)?.resolve();
    await vi.advanceTimersByTimeAsync(PAGE_BUDGET_MS - 1);
    expect(root.querySelector('[data-page="1"] .cap-pdf-page-error')).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await done;
    const err = root.querySelector('[data-page="1"] .cap-pdf-page-error');
    expect(err?.textContent).toBe("This page took too long to render");
    expect(renders.find((r) => r.page === 1)?.cancel).toHaveBeenCalled();
    expect(root.querySelector('[data-page="2"] canvas')).not.toBeNull();
    expect(root.querySelector('[data-page="2"] .cap-pdf-page-error')).toBeNull();
    expect(showError).not.toHaveBeenCalled();
    expect(PAGE_BUDGET_MS).toBe(10_000);
  });

  it("a page that fails to render shows an inline error; the others still render", async () => {
    const { lib, renders } = fakeLib({ pages: 3, autoResolve: false });
    const { ctx, root } = context("zh");
    const done = renderPdf(pdfFile(), ctx, deps(lib));
    await vi.waitFor(() => expect(renderedPages(renders)).toEqual([1, 2]));
    renders.find((r) => r.page === 1)?.reject(new Error("bad operator"));
    renders.find((r) => r.page === 2)?.resolve();
    await done;
    await vi.waitFor(() =>
      expect(root.querySelector('[data-page="1"] .cap-pdf-page-error')?.textContent).toBe(
        "此页无法渲染：bad operator",
      ),
    );
    expect(root.querySelector('[data-page="2"] canvas')).not.toBeNull();
  });

  it("a password-protected PDF shows its message and asks for no password", async () => {
    const e = Object.assign(new Error("No password given"), { name: "PasswordException", code: 1 });
    const { lib } = fakeLib({ openError: e });
    const { ctx, showError } = context();
    await renderPdf(pdfFile(), ctx, deps(lib));
    expect(showError).toHaveBeenCalledWith("This is a password-protected PDF");
    expect(FakeWorker.instances.at(-1)?.terminate).toHaveBeenCalled();
  });

  it("a PDF with no pages says so in the frame", async () => {
    const { lib } = fakeLib({ pages: 0 });
    const { ctx, root, showError } = context();
    await renderPdf(pdfFile(), ctx, deps(lib));
    expect(showError).not.toHaveBeenCalled();
    expect(root.textContent).toContain("This PDF has no pages");
  });

  it("stops and cleans up when the shell aborts before the document opened", async () => {
    const { lib, destroy } = fakeLib();
    const { promise, resolve } = deferred<PdfDocument>();
    const opened = vi.fn();
    const slow: PdfLib = {
      ...lib,
      getDocument: () => {
        opened();
        return { promise, destroy };
      },
    };
    const { ctx, root, controller, showError } = context();
    const done = renderPdf(pdfFile(), ctx, deps(slow));
    await vi.waitFor(() => expect(opened).toHaveBeenCalled());
    const worker = FakeWorker.instances.at(-1);
    controller.abort();
    await done;
    expect(destroy).toHaveBeenCalled();
    expect(worker?.terminate).toHaveBeenCalled();
    resolve(await lib.getDocument({}).promise);
    expect(root.querySelector(".cap-pdf-pages")).toBeNull();
    expect(showError).not.toHaveBeenCalled();
  });

  it("a worker that cannot start is an inline error, not the watchdog", async () => {
    const { lib } = fakeLib();
    const { ctx, showError } = context();
    await renderPdf(
      pdfFile(),
      ctx,
      deps(lib, { importModule: async () => ({ default: undefined }) }),
    );
    expect(showError).toHaveBeenCalledWith(expect.stringContaining("pdfjs.worker.js"));
  });
});

describe("pdf in the shell", () => {
  it("a 0-byte pdf shows the empty state without loading pdf.js", async () => {
    document.head.innerHTML = '<meta name="previewer" content="pdf">';
    document.body.innerHTML = '<div id="root"></div>';
    const loadRenderer = vi.fn(async () => (await import("../ui-src/renderers/pdf.js")).render);
    const stop = startApp({ loadRenderer });
    try {
      const post = (data: unknown) =>
        window.dispatchEvent(new MessageEvent("message", { data, source: window.parent }));
      post({ protocol: EMBED_PROTOCOL, type: "init", locale: "en", theme: "dark", tokens: {} });
      post({
        protocol: EMBED_PROTOCOL,
        type: "file",
        name: "empty.pdf",
        contentType: "application/pdf",
        size: 0,
        data: new ArrayBuffer(0),
      });
      await vi.waitFor(() =>
        expect(document.getElementById("root")?.textContent).toBe(MESSAGES.en.empty),
      );
      expect(loadRenderer).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });
});

describe("pdf renderer with the real pdf.js (legacy build, Node fake worker)", () => {
  type Real = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

  /** The real library, minus the bits a Node test cannot do: the worker port and canvas paint. */
  async function realLib(onOperatorList?: (page: number) => void): Promise<PdfLib> {
    const real: Real = await import("pdfjs-dist/legacy/build/pdf.mjs");
    return {
      PDFWorker: class {
        destroy() {}
      },
      getDocument(params) {
        // Node has no Worker: pdf.js falls back to its in-process worker; the port is not passed
        const { worker: _worker, ...rest } = params as Record<string, unknown>;
        const task = real.getDocument(rest as Parameters<Real["getDocument"]>[0]);
        return {
          destroy: () => task.destroy(),
          promise: task.promise.then((doc) => ({
            numPages: doc.numPages,
            destroy: () => task.destroy(),
            async getPage(n: number) {
              const page = await doc.getPage(n);
              return {
                getViewport: (o: { scale: number }) => page.getViewport(o),
                // the worker side runs for real (fonts and cmaps load); only the canvas paint is skipped
                render: () => ({
                  promise: page.getOperatorList().then(() => onOperatorList?.(n)),
                  cancel: () => {},
                }),
                cleanup: () => page.cleanup(),
              };
            },
          })),
        };
      },
    };
  }

  /** Serves the built data modules from the installed pdfjs-dist, as the build would. */
  const imported: string[] = [];
  const importModule = async (url: string) => {
    imported.push(url);
    const name = url.slice(BASE.length);
    const m = /^pdfjs-(cmap|font)-([A-Za-z0-9][A-Za-z0-9.-]*)\.js$/.exec(name);
    if (m) {
      const dir = m[1] === "cmap" ? "cmaps" : "standard_fonts";
      return { default: readFileSync(join(PDFJS_DIR, dir, m[2] as string)).toString("base64") };
    }
    if (name === "pdfjs.worker.js") return { default: "" };
    throw new Error(`unexpected import ${url}`);
  };

  it("renders the 3-page fixture: 1 / 3, CJK cmap loaded through a module import", async () => {
    viewport = { width: 632, height: 5000 };
    imported.length = 0;
    const painted: number[] = [];
    const { ctx, root, showError } = context();
    await renderPdf(
      fixture("three-pages.pdf"),
      ctx,
      deps(await realLib((n) => painted.push(n)), { importModule }),
    );
    expect(showError).not.toHaveBeenCalled();
    expect(indicator(root)).toBe("1 / 3");
    await vi.waitFor(() => expect(painted.sort()).toEqual([1, 2, 3]));
    expect(imported).toContain(`${BASE}pdfjs-cmap-UniGB-UCS2-H.bcmap.js`);
    expect(readdirSync(join(PDFJS_DIR, "cmaps"))).toContain("UniGB-UCS2-H.bcmap");
  });

  it("an encrypted fixture shows the password-protected message", async () => {
    const { ctx, showError } = context("zh");
    await renderPdf(fixture("encrypted.pdf"), ctx, deps(await realLib(), { importModule }));
    expect(showError).toHaveBeenCalledWith("这是受密码保护的 PDF");
  });

  it("a truncated fixture is an inline error with the reason (Review Focus 5)", async () => {
    const { ctx, showError } = context();
    await renderPdf(fixture("truncated.pdf"), ctx, deps(await realLib(), { importModule }));
    expect(showError).toHaveBeenCalledTimes(1);
    expect(showError.mock.calls[0]?.[0]).toMatch(/^The PDF is damaged or incomplete: .+/);
  });
});
