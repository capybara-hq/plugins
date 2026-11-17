// @vitest-environment jsdom
import { EMBED_PROTOCOL } from "@capybara-hq/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { MESSAGES, translator } from "../ui-src/app/frame.js";
import { startApp } from "../ui-src/app/main.js";
import type { PreviewFile, RenderContext } from "../ui-src/app/types.js";

const mountCode = vi.fn(async (root: HTMLElement, text: string) => {
  root.textContent = `code:${text.length}`;
});
vi.mock("../ui-src/renderers/code.js", () => ({
  mountCode: (...args: Parameters<typeof mountCode>) => mountCode(...args),
  render: async () => {},
}));

const { render: renderHtml, PRESSED_BG } = await import("../ui-src/renderers/html.js");
const { render: renderSvg, GROUND } = await import("../ui-src/renderers/svg.js");
const { THEME, THEME_VARS } = await import("../ui-src/app/theme.js");

const NOTICE = {
  zh: "外部资源和脚本未加载",
  en: "External resources and scripts are not loaded",
};

function file(text: string, name = "page.html", contentType = "text/html"): PreviewFile {
  const data = new TextEncoder().encode(text).buffer as ArrayBuffer;
  return { name, contentType, size: data.byteLength, data };
}

function context(
  locale: "zh" | "en" = "en",
  lifetime: AbortSignal = new AbortController().signal,
): RenderContext & { showError: Mock<(reason: string) => void> } {
  const root = document.createElement("div");
  document.body.append(root);
  return {
    root,
    locale,
    signal: new AbortController().signal,
    lifetime,
    t: translator(locale),
    runInWorker: vi.fn(),
    showError: vi.fn<(reason: string) => void>(),
  };
}

afterEach(() => {
  document.body.replaceChildren();
  document.head.replaceChildren();
  mountCode.mockClear();
  vi.restoreAllMocks();
});

describe("html renderer", () => {
  it("defaults to the rendered document in a shadow root", async () => {
    const ctx = context();
    await renderHtml(file("<p>hello</p><script>alert(1)</script>"), ctx);
    const host = ctx.root.querySelector(".cap-html-host");
    expect(host?.shadowRoot?.querySelector("p")?.textContent).toBe("hello");
    expect(host?.shadowRoot?.querySelector("script")).toBeNull();
    const rendered = ctx.root.querySelector('button[data-mode="rendered"]');
    const source = ctx.root.querySelector('button[data-mode="source"]');
    expect(rendered?.getAttribute("aria-pressed")).toBe("true");
    expect(source?.getAttribute("aria-pressed")).toBe("false");
    expect(mountCode).not.toHaveBeenCalled();
    // nothing of the page reaches the embed's own tree
    expect(ctx.root.querySelector("script, p")).toBeNull();
  });

  it("mounts the code renderer with the original source on the toggle", async () => {
    const ctx = context();
    const src = "<!doctype html><p onclick='x()'>hello</p>";
    await renderHtml(file(src), ctx);
    const source = ctx.root.querySelector('button[data-mode="source"]') as HTMLButtonElement;
    source.click();
    expect(mountCode).toHaveBeenCalledTimes(1);
    const [root, text, name, contentType, codeCtx] = mountCode.mock.calls[0] as unknown as [
      HTMLElement,
      string,
      string,
      string,
      RenderContext,
    ];
    expect(text).toBe(src);
    expect(name).toBe("page.html");
    expect(contentType).toBe("text/html");
    expect(root.classList.contains("cap-html-source")).toBe(true);
    expect(codeCtx.root).toBe(root);
    expect(codeCtx.signal.aborted).toBe(false);
    expect(root.hidden).toBe(false);
    expect((ctx.root.querySelector(".cap-html-rendered") as HTMLElement).hidden).toBe(true);
    expect(source.getAttribute("aria-pressed")).toBe("true");
    // back and forth again: mounted once, the rendered view comes back
    (ctx.root.querySelector('button[data-mode="rendered"]') as HTMLButtonElement).click();
    source.click();
    expect(mountCode).toHaveBeenCalledTimes(1);
  });

  it("ties the source pane's work to the preview's lifetime", async () => {
    const life = new AbortController();
    const ctx = context("en", life.signal);
    const render = new AbortController();
    await renderHtml(file("<p>x</p>"), { ...ctx, signal: render.signal });
    // the shell aborts the render signal once the render settles; the toggle comes later
    render.abort();
    (ctx.root.querySelector('button[data-mode="source"]') as HTMLButtonElement).click();
    const codeCtx = (mountCode.mock.calls[0] as unknown as unknown[])[4] as RenderContext;
    expect(codeCtx.signal.aborted).toBe(false);
    expect(codeCtx.lifetime).toBe(life.signal);
    life.abort();
    expect(codeCtx.signal.aborted).toBe(true);
  });

  it("decodes a UTF-16 page (BOM) like the code previewer", async () => {
    const ctx = context();
    const src = "<p>你好</p>";
    const bytes = new Uint8Array(2 + src.length * 2);
    bytes.set([0xff, 0xfe]);
    for (let i = 0; i < src.length; i++) {
      bytes[2 + i * 2] = src.charCodeAt(i) & 0xff;
      bytes[3 + i * 2] = src.charCodeAt(i) >> 8;
    }
    const data = bytes.buffer as ArrayBuffer;
    await renderHtml(
      { name: "page.html", contentType: "text/html", size: data.byteLength, data },
      ctx,
    );
    const host = ctx.root.querySelector(".cap-html-host");
    expect(host?.shadowRoot?.querySelector("p")?.textContent).toBe("你好");
  });

  it("shows a source failure inside the source pane", async () => {
    const ctx = context();
    mountCode.mockRejectedValueOnce(new Error("highlighter broke"));
    await renderHtml(file("<p>x</p>"), ctx);
    (ctx.root.querySelector('button[data-mode="source"]') as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(ctx.root.querySelector(".cap-html-source")?.textContent).toContain(
        "highlighter broke",
      ),
    );
  });

  it("shows the notice only when something external was removed", async () => {
    for (const locale of ["en", "zh"] as const) {
      const plain = context(locale);
      await renderHtml(file("<p>x</p>"), plain);
      expect(plain.root.querySelector(".cap-html-notice")).toBeNull();
      expect(plain.root.textContent).not.toContain(NOTICE[locale]);

      const remote = context(locale);
      await renderHtml(file('<img src="https://cdn.example/a.png"><p>x</p>'), remote);
      expect(remote.root.querySelector(".cap-html-notice")?.textContent).toBe(NOTICE[locale]);

      const script = context(locale);
      await renderHtml(file("<script>alert(1)</script><p>x</p>"), script);
      expect(script.root.querySelector(".cap-html-notice")?.textContent).toBe(NOTICE[locale]);
    }
  });

  it("renders links that do not navigate", async () => {
    const ctx = context();
    await renderHtml(file('<a href="https://example.com">x</a>'), ctx);
    const a = ctx.root.querySelector(".cap-html-host")?.shadowRoot?.querySelector("a");
    expect(a?.hasAttribute("href")).toBe(false);
    expect(a?.getAttribute("title")).toBe("https://example.com");
  });

  it("shows the empty state for 0 bytes", async () => {
    const ctx = context();
    await renderHtml(file(""), ctx);
    expect(ctx.root.textContent).toBe(MESSAGES.en.empty);
    expect(ctx.root.querySelector(".cap-html-host")).toBeNull();
  });
});

describe("svg renderer", () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:http://embed/1");
    URL.revokeObjectURL = vi.fn();
  });

  const SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>';

  it("paints exactly one blob: img and never an svg element", async () => {
    const ctx = context();
    const done = renderSvg(file(SVG, "a.svg", "image/svg+xml"), ctx);
    const imgs = ctx.root.querySelectorAll("img");
    expect(imgs).toHaveLength(1);
    expect(imgs[0]?.getAttribute("src")).toMatch(/^blob:/);
    expect(document.querySelectorAll("svg, script")).toHaveLength(0);
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0]?.[0] as Blob;
    expect(blob.type).toBe("image/svg+xml");
    imgs[0]?.dispatchEvent(new Event("load"));
    await done;
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:http://embed/1");
    expect(ctx.showError).not.toHaveBeenCalled();
    expect(document.querySelectorAll("svg")).toHaveLength(0);
  });

  it("reports an svg the browser cannot decode", async () => {
    const ctx = context("zh");
    const done = renderSvg(file("not svg", "a.svg", "image/svg+xml"), ctx);
    ctx.root.querySelector("img")?.dispatchEvent(new Event("error"));
    await done;
    expect(ctx.showError).toHaveBeenCalledWith("不是有效的 SVG 图像");
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });

  it("shows the empty state for 0 bytes", async () => {
    const ctx = context();
    await renderSvg(file("", "a.svg", "image/svg+xml"), ctx);
    expect(ctx.root.textContent).toBe(MESSAGES.en.empty);
    expect(ctx.root.querySelector("img")).toBeNull();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});

describe("in the shell", () => {
  const post = (data: unknown) =>
    window.dispatchEvent(new MessageEvent("message", { data, source: window.parent }));
  const init = { protocol: EMBED_PROTOCOL, type: "init", locale: "en", theme: "dark", tokens: {} };

  for (const previewer of ["html", "svg"]) {
    it(`${previewer}: a 0-byte file is the empty state`, async () => {
      document.head.innerHTML = `<meta name="previewer" content="${previewer}">`;
      document.body.innerHTML = '<div id="root"></div>';
      const stop = startApp({ runInWorker: vi.fn() });
      post(init);
      post({
        protocol: EMBED_PROTOCOL,
        type: "file",
        name: `a.${previewer}`,
        contentType: "text/html",
        size: 0,
        data: new ArrayBuffer(0),
      });
      await vi.waitFor(() =>
        expect(document.querySelector('[data-state="empty"]')?.textContent).toBe(MESSAGES.en.empty),
      );
      stop();
    });
  }

  it("html: renders through the shell's renderer table", async () => {
    document.head.innerHTML = '<meta name="previewer" content="html">';
    document.body.innerHTML = '<div id="root"></div>';
    const stop = startApp({ runInWorker: vi.fn() });
    post(init);
    const data = new TextEncoder().encode("<p>shell</p>").buffer;
    post({
      protocol: EMBED_PROTOCOL,
      type: "file",
      name: "a.html",
      contentType: "text/html",
      size: data.byteLength,
      data,
    });
    await vi.waitFor(() =>
      expect(
        document.querySelector(".cap-html-host")?.shadowRoot?.querySelector("p")?.textContent,
      ).toBe("shell"),
    );
    stop();
  });
});

describe("contrast in both themes", () => {
  it("draws the svg checkerboard with the theme's line color, not the faint hover fill", () => {
    expect(GROUND).toContain(THEME.border);
    expect(GROUND).not.toContain(THEME.hover);
    // the ground stays a variable-driven checker on the panel color
    expect(GROUND).toContain(THEME.panel);
    expect(GROUND).toContain(THEME_VARS.border);
  });

  it("marks the pressed html mode with the accent at low alpha, clearly unlike hover", () => {
    expect(PRESSED_BG).toContain(THEME.accent);
    expect(PRESSED_BG).toMatch(/color-mix\(in srgb, .+ \d+%, transparent\)/);
    expect(PRESSED_BG).not.toBe(THEME.hover);
  });
});
