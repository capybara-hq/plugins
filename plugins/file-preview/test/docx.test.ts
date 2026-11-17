// @vitest-environment jsdom
import mammoth from "mammoth";
import { describe, expect, it, vi } from "vitest";
import { translator } from "../ui-src/app/frame.js";
import type { PreviewFile, RenderContext } from "../ui-src/app/types.js";
import { render } from "../ui-src/renderers/docx.js";
import type { DocxInput, DocxOutput } from "../ui-src/shared/docx.js";
import { convertDocx } from "../ui-src/workers/docx.worker.js";
import {
  blankDocx,
  corruptDocx,
  declareSizes,
  fullDocx,
  hostileDocx,
} from "./fixtures/docx/make.js";

function setup(data: ArrayBuffer, locale: "zh" | "en" = "en") {
  const root = document.createElement("div");
  document.body.append(root);
  const errors: string[] = [];
  const file: PreviewFile = {
    name: "a.docx",
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    size: data.byteLength,
    data,
  };
  const ctx: RenderContext = {
    root,
    locale,
    signal: new AbortController().signal,
    lifetime: new AbortController().signal,
    t: translator(locale),
    runInWorker: (async <I, O>(_w: string, input: I) =>
      (await convertDocx(input as DocxInput)) as unknown as O) as RenderContext["runInWorker"],
    showError: (r) => errors.push(r),
  };
  const shadow = () =>
    (root.querySelector(".cap-html-host") as HTMLElement | null)?.shadowRoot ?? undefined;
  return { file, ctx, root, errors, shadow };
}

describe("convertDocx", () => {
  it("converts to html with the image inlined as a data uri", async () => {
    const out: DocxOutput = await convertDocx({ data: fullDocx() });
    expect(out.error).toBeUndefined();
    expect(out.html).toContain("<h1>Quarterly Report</h1>");
    expect(out.html).toMatch(/<img[^>]+src="data:image\/png;base64,/);
  });

  it("reports a corrupt file as invalid", async () => {
    expect(await convertDocx({ data: corruptDocx() })).toEqual({ html: "", error: "invalid" });
  });
});

const MIB = 1024 * 1024;

describe("convertDocx limits", () => {
  it("refuses a declared total over 100 MiB without calling mammoth", async () => {
    const spy = vi.spyOn(mammoth, "convertToHtml");
    const out = await convertDocx({ data: declareSizes(fullDocx(), [40 * MIB]) });
    expect(out).toEqual({ html: "", error: "too-large" });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("refuses one entry that declares more than 50 MiB", async () => {
    const spy = vi.spyOn(mammoth, "convertToHtml");
    const out = await convertDocx({ data: declareSizes(fullDocx(), [51 * MIB, 1]) });
    expect(out.error).toBe("too-large");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("does not turn an unexpected error into invalid", async () => {
    const spy = vi
      .spyOn(mammoth, "convertToHtml")
      .mockRejectedValue(new RangeError("out of memory"));
    await expect(convertDocx({ data: fullDocx() })).rejects.toThrow("out of memory");
    spy.mockRestore();
  });

  it("reports a mammoth parse failure as invalid", async () => {
    const spy = vi.spyOn(mammoth, "convertToHtml").mockRejectedValue(new Error("bad xml"));
    expect(await convertDocx({ data: fullDocx() })).toEqual({ html: "", error: "invalid" });
    spy.mockRestore();
  });
});

describe("docx renderer", () => {
  it("shows the too-large reason in the locale", async () => {
    const big = declareSizes(fullDocx(), [40 * MIB]);
    const en = setup(big);
    await render(en.file, en.ctx);
    expect(en.errors[0]).toMatch(/too large/);
    const zh = setup(big, "zh");
    await render(zh.file, zh.ctx);
    expect(zh.errors[0]).toMatch(/过大/);
  });

  it("shows the external-resources notice only when the sanitizer dropped one", async () => {
    const plain = setup(fullDocx());
    await render(plain.file, plain.ctx);
    expect(plain.root.querySelector(".cap-docx-notice")).toBeNull();
    const ext = setup(fullDocx());
    ext.ctx.runInWorker = (async () => ({
      html: '<p>x</p><img src="https://evil.example/a.png">',
    })) as unknown as RenderContext["runInWorker"];
    await render(ext.file, ext.ctx);
    expect(ext.root.querySelector(".cap-docx-notice")?.textContent).toMatch(/not loaded/);
  });

  it("shows heading, list items, table cells and the embedded image in a shadow root", async () => {
    const { file, ctx, shadow, errors } = setup(fullDocx());
    await render(file, ctx);
    const sr = shadow();
    expect(sr).toBeDefined();
    expect(sr?.querySelector("h1")?.textContent).toBe("Quarterly Report");
    expect([...(sr?.querySelectorAll("li") ?? [])].map((l) => l.textContent)).toEqual([
      "first item",
      "second item",
    ]);
    expect([...(sr?.querySelectorAll("td") ?? [])].map((c) => c.textContent)).toEqual([
      "A1",
      "B1",
      "A2",
      "B2",
    ]);
    expect(sr?.querySelector("img")?.getAttribute("src")).toMatch(/^data:image\/png/);
    expect(errors).toEqual([]);
    // the page's content never leaks into the light DOM
    expect(ctx.root.querySelector("h1")).toBeNull();
  });

  it("keeps a literal <script> as text and makes the hyperlink non-navigating", async () => {
    const { file, ctx, shadow } = setup(hostileDocx());
    await render(file, ctx);
    const sr = shadow();
    expect(sr?.querySelector("script")).toBeNull();
    expect(sr?.textContent).toContain("<script>alert(1)</script>");
    const a = sr?.querySelector("a");
    expect(a?.textContent).toBe("click me");
    expect(a?.hasAttribute("href")).toBe(false);
    expect(a?.getAttribute("title")).toBe("https://example.com/page");
  });

  it("shows the inline error for a corrupt docx, in the locale", async () => {
    const en = setup(corruptDocx());
    await render(en.file, en.ctx);
    expect(en.errors).toHaveLength(1);
    expect(en.errors[0]).toMatch(/not a valid \.docx/);
    const zh = setup(corruptDocx(), "zh");
    await render(zh.file, zh.ctx);
    expect(zh.errors[0]).toMatch(/\.docx/);
    expect(zh.errors[0]).toMatch(/[一-鿿]/);
  });

  it("shows the empty state for 0 bytes and for a document without content", async () => {
    const zero = setup(new ArrayBuffer(0));
    await render(zero.file, zero.ctx);
    expect(zero.root.dataset.state).toBe("empty");
    const blank = setup(blankDocx());
    await render(blank.file, blank.ctx);
    expect(blank.root.dataset.state).toBe("empty");
    expect(blank.errors).toEqual([]);
  });

  it("paints nothing once the render attempt was aborted", async () => {
    const { file, ctx, root } = setup(fullDocx());
    const ac = new AbortController();
    ac.abort();
    await render(file, { ...ctx, signal: ac.signal });
    expect(root.querySelector(".cap-html-host")).toBeNull();
  });
});
