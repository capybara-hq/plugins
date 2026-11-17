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
  docx,
  fullDocx,
  hostileDocx,
} from "./fixtures/docx/make.js";
import {
  ab,
  decoyDirectory,
  jszip,
  lyingSize,
  prepended,
  streamed,
  u8,
  withEntries,
  zip64Switch,
} from "./fixtures/zip/hostile.js";

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

describe("hostile archives never reach mammoth (ruling R21)", () => {
  const body = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
  /** A docx whose media holds an honest `bytes`-byte entry (zeros: 60 MiB zip to ~60 KiB). */
  const withBig = (text: string, bytes: number) =>
    withEntries(u8(docx(body(text), { image: false })), {
      "word/media/big.bin": new Uint8Array(bytes),
    });

  /** Runs the real convertDocx path with JSZip (mammoth's unzipper) and mammoth observed. */
  async function run(data: Uint8Array) {
    const loadAsync = vi.spyOn(jszip(), "loadAsync");
    const convert = vi.spyOn(mammoth, "convertToHtml");
    try {
      const out = await convertDocx({ data: ab(data) });
      return {
        out,
        jszipCalls: loadAsync.mock.calls.length,
        mammothCalls: convert.mock.calls.length,
      };
    } finally {
      loadAsync.mockRestore();
      convert.mockRestore();
    }
  }

  it("refuses a lying-size bomb before JSZip inflates it", async () => {
    // document.xml holds 8 MiB of text, its directory record says 1 KiB
    const base = u8(docx(body("a".repeat(8 * MIB)), { image: false }));
    const r = await run(lyingSize(base, "word/document.xml", 1024));
    expect(r.out).toEqual({ html: "", error: "too-large" });
    expect(r.mammothCalls).toBe(0);
    expect(r.jszipCalls).toBe(0);
  });

  it("refuses the decoy directory (prepended-bytes shift)", async () => {
    const real = withBig("FROM-B", 60 * MIB);
    const decoy = withBig("A", 1);
    const r = await run(decoyDirectory(decoy, real));
    expect(r.out.error).toBe("invalid");
    expect(r.out.html).not.toContain("FROM-B");
    expect(r.jszipCalls).toBe(0);
  });

  it("refuses the zip64 switch (0xFFFF record count)", async () => {
    const r = await run(zip64Switch(withBig("FROM-B", 60 * MIB)));
    expect(r.out).toEqual({ html: "", error: "invalid" });
    expect(r.jszipCalls).toBe(0);
  });

  it("refuses bytes prepended to a docx", async () => {
    const r = await run(prepended(u8(fullDocx())));
    expect(r.out).toEqual({ html: "", error: "invalid" });
    expect(r.jszipCalls).toBe(0);
  });

  it("still converts docx files from fflate, fflate's streaming writer and JSZip", async () => {
    const plain = await run(u8(fullDocx()));
    expect(plain.out.html).toContain("<h1>Quarterly Report</h1>");
    expect(plain.jszipCalls).toBe(1);
    expect((await run(streamed(u8(fullDocx())))).out.html).toContain("Quarterly Report");
    const JSZip = jszip();
    const z = new JSZip();
    for (const [name, data] of Object.entries((await import("fflate")).unzipSync(u8(fullDocx())))) {
      z.file(name, data);
    }
    const viaJszip = await z.generateAsync({
      type: "uint8array",
      compression: "DEFLATE",
      streamFiles: true,
    });
    expect((await run(viaJszip)).out.html).toContain("Quarterly Report");
  });
});
