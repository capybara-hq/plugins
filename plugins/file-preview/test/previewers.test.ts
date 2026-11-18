import {
  FILE_PREVIEW_MAX_BYTES,
  previewerAccepts,
  validateFilePreviewProvider,
} from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { PREVIEWERS, type PreviewerId, toProvider } from "../src/previewers.js";

/** The ids of the previewers that take this file, in table order. */
const takers = (name: string, contentType: string): PreviewerId[] =>
  PREVIEWERS.filter((p) =>
    previewerAccepts(
      { accepts: p.accepts, maxBytes: FILE_PREVIEW_MAX_BYTES },
      { name, contentType, size: 1 },
    ),
  ).map((p) => p.id);

describe("PREVIEWERS", () => {
  it("is a valid file-preview@1 provider with the six ids in order", () => {
    expect(validateFilePreviewProvider(toProvider())).toEqual([]);
    expect(PREVIEWERS.map((p) => p.id)).toEqual(["code", "zip", "sheet", "docx", "pdf", "svg"]);
  });

  it("never claims Markdown, CSV / TSV or bitmap images (the built-ins stay first)", () => {
    expect(takers("a.md", "text/markdown")).toEqual([]);
    expect(takers("a.markdown", "application/octet-stream")).toEqual([]);
    expect(takers("a.csv", "text/csv")).toEqual([]);
    expect(takers("a.tsv", "text/tab-separated-values")).toEqual([]);
    expect(takers("a.tsv", "application/octet-stream")).toEqual([]);
    expect(takers("a.png", "image/png")).toEqual([]);
    expect(takers("a.jpg", "image/jpeg")).toEqual([]);
  });

  it("code takes source files by extension or by MIME type", () => {
    expect(takers("a.tsx", "application/octet-stream")).toEqual(["code"]);
    expect(takers("a.ts", "text/plain")).toEqual(["code"]);
    expect(takers("a.py", "text/x-python")).toEqual(["code"]);
    expect(takers("A.GO", "application/octet-stream")).toEqual(["code"]);
  });

  it("never claims HTML (the kernel renders it) and has no html embed", () => {
    expect(takers("r.html", "text/html")).toEqual([]);
    expect(takers("a.htm", "text/html")).toEqual([]);
    expect(takers("a.html", "application/octet-stream")).toEqual([]);
    expect(toProvider().previewers.map((p) => p.id)).not.toContain("html");
    expect(PREVIEWERS.map((p) => p.id)).not.toContain("html");
  });

  it("sheet takes xlsx / xlsm only; zip takes jar; docx, pdf and svg by type and extension", () => {
    expect(takers("a.xlsx", "application/octet-stream")).toEqual(["sheet"]);
    expect(takers("a.xlsm", "application/octet-stream")).toEqual(["sheet"]);
    expect(takers("a.xls", "application/vnd.ms-excel")).toEqual([]);
    expect(takers("a.jar", "application/java-archive")).toEqual(["zip"]);
    expect(takers("b", "application/zip")).toEqual(["zip"]);
    expect(
      takers("b", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    ).toEqual(["docx"]);
    expect(takers("b", "application/pdf")).toEqual(["pdf"]);
    expect(takers("a.svg", "image/svg+xml")).toEqual(["svg"]);
  });

  it("every title is bilingual", () => {
    for (const p of PREVIEWERS) {
      expect(p.title.zh).not.toBe("");
      expect(p.title.en).not.toBe("");
    }
  });
});
