// @vitest-environment jsdom
import { EMBED_PROTOCOL } from "@capybara-hq/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { MESSAGES, translator } from "../ui-src/app/frame.js";
import { startApp } from "../ui-src/app/main.js";
import type { PreviewFile, RenderContext } from "../ui-src/app/types.js";

const { render: renderSvg, GROUND } = await import("../ui-src/renderers/svg.js");
const { THEME, THEME_VARS } = await import("../ui-src/app/theme.js");

function file(text: string, name = "a.svg", contentType = "image/svg+xml"): PreviewFile {
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
  vi.restoreAllMocks();
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

  for (const previewer of ["svg"]) {
    it(`${previewer}: a 0-byte file is the empty state`, async () => {
      document.head.innerHTML = `<meta name="previewer" content="${previewer}">`;
      document.body.innerHTML = '<div id="root"></div>';
      const stop = startApp({ runInWorker: vi.fn() });
      post(init);
      post({
        protocol: EMBED_PROTOCOL,
        type: "file",
        name: `a.${previewer}`,
        contentType: "image/svg+xml",
        size: 0,
        data: new ArrayBuffer(0),
      });
      await vi.waitFor(() =>
        expect(document.querySelector('[data-state="empty"]')?.textContent).toBe(MESSAGES.en.empty),
      );
      stop();
    });
  }
});

describe("contrast in both themes", () => {
  it("draws the svg checkerboard with the theme's line color, not the faint hover fill", () => {
    expect(GROUND).toContain(THEME.border);
    expect(GROUND).not.toContain(THEME.hover);
    // the ground stays a variable-driven checker on the panel color
    expect(GROUND).toContain(THEME.panel);
    expect(GROUND).toContain(THEME_VARS.border);
  });
});
