// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { MESSAGES, translator } from "../ui-src/app/frame.js";
import type { RenderContext } from "../ui-src/app/types.js";
import { mountCode, render } from "../ui-src/renderers/code.js";
import { decodeText, languageFor } from "../ui-src/shared/language.js";
import { highlight, MAX_CHARS, MAX_LINES } from "../ui-src/workers/code.logic.js";

describe("languageFor", () => {
  it("maps extension, file name and MIME type", () => {
    expect(languageFor("a.tsx", "application/octet-stream")).toBe("tsx");
    expect(languageFor("Dockerfile", "application/octet-stream")).toBe("dockerfile");
    expect(languageFor("x.unknown", "text/plain")).toBe("text");
    expect(languageFor("a.py", "text/x-python")).toBe("python");
    expect(languageFor("noext", "application/json; charset=utf-8")).toBe("json");
  });
});

describe("decodeText", () => {
  it("decodes UTF-16LE and BE by BOM and drops the UTF-8 BOM", () => {
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]))).toBe("hi");
    expect(decodeText(new Uint8Array([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69]))).toBe("hi");
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x68]))).toBe("h");
  });
  it("shows invalid UTF-8 and NUL bytes as replacement characters without throwing", () => {
    expect(decodeText(new Uint8Array([0x61, 0xff, 0x62]))).toBe("a�b");
    expect(decodeText(new Uint8Array([0x61, 0x00, 0x62]))).toBe("a�b");
  });
});

describe("highlight (worker logic)", () => {
  it("cuts at 20 000 lines", async () => {
    const out = await highlight({ text: "x\n".repeat(25_000), lang: "text", theme: "light" });
    expect(out.lines).toHaveLength(MAX_LINES);
    expect(out.truncated).toBe(true);
  });
  it("cuts a 2 MiB single line at 1 MiB", async () => {
    const out = await highlight({
      text: "a".repeat(2 * 1024 * 1024),
      lang: "javascript",
      theme: "dark",
    });
    expect(out.truncated).toBe(true);
    const total = out.lines.flat().reduce((n, t) => n + t.content.length, 0);
    expect(total).toBe(MAX_CHARS);
  });
  it("colors tokens of a known language and keeps plain text uncolored", async () => {
    const js = await highlight({ text: "const a = 1;\n", lang: "javascript", theme: "dark" });
    expect(js.truncated).toBe(false);
    expect(js.lines).toHaveLength(1);
    expect(js.lines[0]?.some((t) => t.color !== undefined)).toBe(true);
    const plain = await highlight({ text: "a\nb", lang: "text", theme: "light" });
    expect(plain.lines.map((l) => l.map((t) => t.content).join(""))).toEqual(["a", "b"]);
    expect(plain.lines.flat().every((t) => t.color === undefined)).toBe(true);
  });
});

function makeCtx(locale: "zh" | "en" = "en"): RenderContext {
  const root = document.createElement("div");
  document.body.append(root);
  return {
    root,
    locale,
    signal: new AbortController().signal,
    t: translator(locale),
    runInWorker: vi.fn(async (_id, input) => highlight(input as never)) as never,
    showError: vi.fn(),
  };
}

describe("mountCode", () => {
  it("builds spans via textContent only", async () => {
    const ctx = makeCtx();
    await mountCode(ctx.root, "<img src=x onerror=alert(1)>\nline2", "a.txt", "text/plain", ctx);
    expect(ctx.root.querySelector("img")).toBeNull();
    expect(ctx.root.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(ctx.root.querySelectorAll(".cap-code-row")).toHaveLength(2);
    expect(ctx.root.querySelector(".cap-code-num")?.textContent).toBe("1");
  });
  it("shows the empty state for empty text", async () => {
    const ctx = makeCtx();
    await mountCode(ctx.root, "", "a.txt", "text/plain", ctx);
    expect(ctx.root.textContent).toBe(MESSAGES.en.empty);
  });
  it("flips data-wrap with the toggle", async () => {
    const ctx = makeCtx();
    await mountCode(ctx.root, "a", "a.ts", "", ctx);
    const wrap = ctx.root.querySelector<HTMLElement>(".cap-code");
    expect(wrap?.dataset.wrap).toBe("off");
    ctx.root.querySelector("button")?.click();
    expect(wrap?.dataset.wrap).toBe("on");
    ctx.root.querySelector("button")?.click();
    expect(wrap?.dataset.wrap).toBe("off");
  });
  it("notes truncation", async () => {
    const ctx = makeCtx("zh");
    await mountCode(ctx.root, "x\n".repeat(MAX_LINES + 1), "a.log", "", ctx);
    expect(ctx.root.querySelector(".cap-code-truncated")?.textContent).toContain("仅显示");
  });
  it("does not paint after abort", async () => {
    const ac = new AbortController();
    const ctx = { ...makeCtx(), signal: ac.signal };
    ctx.runInWorker = (async (_id: string, input: unknown) => {
      ac.abort();
      return highlight(input as never);
    }) as never;
    await mountCode(ctx.root, "a", "a.ts", "", ctx);
    expect(ctx.root.childElementCount).toBe(0);
  });
  it("decodes UTF-16 files in render", async () => {
    const ctx = makeCtx();
    const bytes = new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]);
    await render({ name: "a.txt", contentType: "text/plain", size: 6, data: bytes.buffer }, ctx);
    expect(ctx.root.textContent).toContain("hi");
  });
});
