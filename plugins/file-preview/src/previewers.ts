/**
 * The previewers of this plugin: the single source for the `file-preview@1` provider, the `ui`
 * contributions (one embed per previewer, same id) and the shell routes `/ui/<id>`.
 *
 * Never claimed (the kernel's built-ins stay first): Markdown, CSV / TSV and bitmap images.
 */

import { FILE_PREVIEW_MAX_BYTES, type FilePreviewProvider } from "@capybara-hq/plugin-sdk";

export type PreviewerId = "code" | "zip" | "sheet" | "docx" | "pdf" | "svg" | "html";

export interface PreviewerSpec {
  id: PreviewerId;
  title: { zh: string; en: string };
  accepts: { mimeTypes: string[]; extensions: string[] };
}

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// capybara:allow-module-state read-only table, never mutated
export const PREVIEWERS: readonly PreviewerSpec[] = Object.freeze([
  {
    id: "code",
    title: { zh: "代码", en: "Code" },
    accepts: {
      mimeTypes: [
        "text/plain",
        "text/css",
        "text/javascript",
        "text/x-python",
        "application/json",
        "application/xml",
        "application/yaml",
        "application/sql",
      ],
      extensions: [
        "ts",
        "tsx",
        "js",
        "jsx",
        "mjs",
        "cjs",
        "py",
        "go",
        "rs",
        "java",
        "kt",
        "swift",
        "c",
        "h",
        "cpp",
        "hpp",
        "cs",
        "rb",
        "php",
        "sh",
        "bash",
        "zsh",
        "ps1",
        "sql",
        "json",
        "jsonc",
        "yaml",
        "yml",
        "toml",
        "ini",
        "xml",
        "css",
        "scss",
        "vue",
        "svelte",
        "dockerfile",
        "makefile",
        "gradle",
        "proto",
        "graphql",
        "lua",
        "r",
        "dart",
        "scala",
        "txt",
        "log",
        "env",
      ],
    },
  },
  {
    id: "zip",
    title: { zh: "压缩包", en: "Archive" },
    accepts: { mimeTypes: ["application/zip"], extensions: ["zip", "jar"] },
  },
  {
    id: "sheet",
    title: { zh: "表格", en: "Spreadsheet" },
    accepts: { mimeTypes: [XLSX], extensions: ["xlsx", "xlsm"] },
  },
  {
    id: "docx",
    title: { zh: "文档", en: "Document" },
    accepts: { mimeTypes: [DOCX], extensions: ["docx"] },
  },
  {
    id: "pdf",
    title: { zh: "PDF", en: "PDF" },
    accepts: { mimeTypes: ["application/pdf"], extensions: ["pdf"] },
  },
  {
    id: "svg",
    title: { zh: "SVG", en: "SVG" },
    accepts: { mimeTypes: ["image/svg+xml"], extensions: ["svg"] },
  },
  {
    id: "html",
    title: { zh: "网页", en: "Web page" },
    accepts: { mimeTypes: ["text/html"], extensions: ["html", "htm"] },
  },
] satisfies PreviewerSpec[]);

/** The `file-preview@1` provider: every previewer at the byte cap, embed id = previewer id. */
export function toProvider(): FilePreviewProvider {
  return {
    previewers: PREVIEWERS.map((p) => ({
      id: p.id,
      title: p.title,
      accepts: p.accepts,
      maxBytes: FILE_PREVIEW_MAX_BYTES,
      embed: p.id,
    })),
  };
}
