/**
 * Archive previewer: the directory tree on the left and the selected entry on the right.
 *
 * The archive is read in the `zip` worker under strict limits (see `workers/zip.logic.ts`). A
 * worker lives for one request, so this side keeps the archive bytes and the one running total of
 * inflated bytes (100 MiB for an archive and everything opened from it): an extraction reserves
 * the entry's declared size before it starts (the worker enforces actual == declared), and the
 * reservation stays when the selection moves on; a late result is cached, not dropped.
 * An entry is previewed by the renderer its extension picks; bitmaps become `<img src="blob:…">`.
 * A zip inside the archive opens one level deep; a zip inside that is listed but not opened.
 */
import type { PreviewerId } from "../../src/previewers.js";
import { showEmpty } from "../app/frame.js";
import { THEME } from "../app/theme.js";
import type { PreviewFile, RenderContext, Renderer } from "../app/types.js";
import type {
  ZipEntry,
  ZipErrorCode,
  ZipExtractInput,
  ZipExtractOutput,
  ZipListInput,
  ZipListOutput,
} from "../shared/zip.js";

const ARCHIVE_LIMIT = 100 * 1024 * 1024;
const ENTRY_LIMIT = 20 * 1024 * 1024;
/** Above this many entries only the first level of folders starts open. */
const OPEN_ALL_UP_TO = 500;
const MAX_NESTING = 1;

const STRINGS = {
  zh: {
    invalid: "这不是有效的压缩包（文件已损坏，或扩展名与内容不符）",
    truncated: "压缩包内条目过多，仅列出前 10 000 项",
    locked: "已加密",
    encrypted: "此条目已加密，无法预览",
    tooLarge: "此条目超过 20 MiB，无法预览",
    limit: "已达到此压缩包的解压上限（100 MiB）",
    nested: "不再展开压缩包中的压缩包",
    noPreview: "此类型的文件无法预览",
    loading: "正在读取…",
    pick: "选择左侧的文件进行预览",
    folder: "文件夹",
    corrupt: "此条目已损坏，无法读取",
    unsupported: "不支持此条目的压缩方式",
    notFound: "在压缩包中找不到此条目",
  },
  en: {
    invalid: "This is not a valid zip archive (the file is corrupt or not what its name says)",
    truncated: "The archive has too many entries: showing the first 10,000",
    locked: "Encrypted",
    encrypted: "This entry is encrypted and cannot be previewed",
    tooLarge: "This entry is larger than 20 MiB and cannot be previewed",
    limit: "This archive reached its decompression limit (100 MiB)",
    nested: "An archive inside an archive is not opened",
    noPreview: "This file type cannot be previewed",
    loading: "Reading…",
    pick: "Select a file on the left to preview it",
    folder: "Folder",
    corrupt: "This entry is corrupt and cannot be read",
    unsupported: "This entry's compression method is not supported",
    notFound: "This entry was not found in the archive",
  },
} as const;

const STYLE = `
.cap-zip{display:flex;height:100%;min-height:0;font-family:${THEME.font};font-size:13px}
.cap-zip-side{flex:0 0 280px;max-width:45%;display:flex;flex-direction:column;min-height:0;border-right:1px solid ${THEME.border}}
.cap-zip-note{padding:6px 12px;font-size:12px;color:${THEME.mutedForeground}}
.cap-zip-tree{margin:0;padding:0;list-style:none;overflow:auto;flex:1;min-height:0}
.cap-zip-tree ul{margin:0;padding:0 0 0 14px;list-style:none}
.cap-zip-tree ul[hidden]{display:none}
.cap-zip-row{display:flex;gap:8px;align-items:baseline;width:100%;text-align:left;font:inherit;color:inherit;background:none;border:0;padding:3px 10px;cursor:pointer}
.cap-zip-row:hover{background:${THEME.hover}}
.cap-zip-row[aria-current="true"]{background:${THEME.hover};color:${THEME.accent}}
.cap-zip-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cap-zip-folder>.cap-zip-name{font-weight:600}
.cap-zip-meta{flex:none;font-size:11px;color:${THEME.mutedForeground};font-family:${THEME.fontMono}}
.cap-zip-lock{flex:none;font-size:11px;color:${THEME.danger}}
.cap-zip-detail{flex:1;min-width:0;min-height:0;overflow:auto;display:flex;flex-direction:column}
.cap-zip-pane{flex:1;min-height:0;display:flex;flex-direction:column;overflow:auto}
.cap-zip-error{padding:16px;color:${THEME.danger}}
.cap-zip-image{max-width:100%;max-height:100%;object-fit:contain;margin:auto;padding:12px;box-sizing:border-box}
`;

/**
 * The extensions each previewer accepts, mirroring `PREVIEWERS` in `src/previewers.ts` (a test
 * keeps them equal). `src/previewers.ts` imports the SDK, which the browser bundle must not pull
 * in, so the embed carries its own copy of the extension rules.
 */
export const EXTENSIONS: Record<PreviewerId, readonly string[]> = {
  code: [
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
  zip: ["zip", "jar"],
  sheet: ["xlsx", "xlsm"],
  docx: ["docx"],
  pdf: ["pdf"],
  svg: ["svg"],
  html: ["html", "htm"],
};
const MIME: Record<PreviewerId, string> = {
  code: "text/plain",
  zip: "application/zip",
  sheet: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  svg: "image/svg+xml",
  html: "text/html",
};

const BITMAPS: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};
/** Text the code previewer shows for entries no other previewer claims. */
const AS_CODE = new Set(["md", "markdown", "csv", "tsv"]);

function extOf(name: string): string {
  const base = (name.split("/").pop() ?? name).toLowerCase();
  const dot = base.lastIndexOf(".");
  return dot < 0 ? base : base.slice(dot + 1);
}

/** The previewer an entry name selects, by the same extension rules the host uses. */
function previewerFor(name: string): { id: PreviewerId; mime: string } | undefined {
  const ext = extOf(name);
  if (AS_CODE.has(ext)) return { id: "code", mime: "text/plain" };
  const id = (Object.keys(EXTENSIONS) as PreviewerId[]).find((k) => EXTENSIONS[k].includes(ext));
  return id === undefined ? undefined : { id, mime: MIME[id] };
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

interface Node {
  name: string;
  entry?: ZipEntry;
  children: Map<string, Node>;
}

function buildTree(entries: ZipEntry[]): Node {
  const root: Node = { name: "", children: new Map() };
  for (const e of entries) {
    const parts = e.path.split("/").filter((p) => p !== "");
    let at = root;
    parts.forEach((part, i) => {
      const last = i === parts.length - 1;
      let key = part;
      let next = at.children.get(key);
      // a repeated path keeps its own node: the records are distinct (extracted by index)
      if (last && next?.entry !== undefined) {
        for (let n = 2; at.children.has(key); n++) key = `${part} (${n})`;
        next = undefined;
      }
      if (next === undefined) {
        next = { name: key, children: new Map() };
        at.children.set(key, next);
      }
      if (last) next.entry = e;
      at = next;
    });
  }
  return root;
}

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  if (className !== undefined) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function ensureStyle(doc: Document): void {
  if (doc.getElementById("cap-zip-style")) return;
  const style = el(doc, "style", undefined, STYLE);
  style.id = "cap-zip-style";
  doc.head.append(style);
}

/**
 * The renderer of an entry. It does not use `loadRenderer` from `./index.js`: importing the index
 * from a renderer folds the index into a shared chunk and the app's per-renderer lazy imports
 * move out of `app.js` (the zip previewer itself is handled in place, one level deep).
 */
async function entryRenderer(id: PreviewerId): Promise<Renderer> {
  switch (id) {
    case "code":
      return (await import("./code.js")).render;
    case "sheet":
      return (await import("./sheet.js")).render;
    case "docx":
      return (await import("./docx.js")).render;
    case "pdf":
      return (await import("./pdf.js")).render;
    case "svg":
      return (await import("./svg.js")).render;
    case "html":
      return (await import("./html.js")).render;
    case "zip":
      return render;
  }
}

/** What one top-level archive and every archive opened from it share. */
interface Budget {
  limit: number;
  /** Declared bytes of every extraction started (finished or in flight). */
  reserved: number;
  /** Extracted entries by `<archive path>#<index>`: a reopened archive finds them again. */
  cache: Map<string, ArrayBuffer>;
  pending: Map<string, Promise<ArrayBuffer>>;
}

async function renderArchive(
  file: PreviewFile,
  ctx: RenderContext,
  depth: number,
  budget: Budget,
  prefix: string,
): Promise<void> {
  const s = STRINGS[ctx.locale];
  const doc = ctx.root.ownerDocument;
  if (file.size === 0 || file.data.byteLength === 0) {
    showEmpty(ctx.root, ctx.t);
    return;
  }
  // a copy goes to each worker: transferring file.data would detach the archive for the next one
  const send = <O>(
    input: Omit<ZipListInput, "data"> | Omit<ZipExtractInput, "data">,
  ): Promise<O> => {
    const data = file.data.slice(0);
    return ctx.runInWorker<ZipListInput | ZipExtractInput, O>(
      "zip",
      { ...input, data } as ZipListInput | ZipExtractInput,
      { transfer: [data] },
    );
  };

  let listing: ZipListOutput;
  try {
    listing = await send<ZipListOutput>({ op: "list" });
  } catch (e) {
    if (ctx.signal.aborted) return;
    ctx.showError(e instanceof Error ? e.message : String(e));
    return;
  }
  if (ctx.signal.aborted) return;
  if (listing.error === "invalid") {
    ctx.showError(s.invalid);
    return;
  }
  if (listing.entries.length === 0) {
    showEmpty(ctx.root, ctx.t);
    return;
  }

  ensureStyle(doc);
  const wrap = el(doc, "div", "cap-zip");
  const side = el(doc, "div", "cap-zip-side");
  if (listing.truncated) side.append(el(doc, "div", "cap-zip-note cap-zip-truncated", s.truncated));
  const treeEl = el(doc, "ul", "cap-zip-tree");
  const detail = el(doc, "div", "cap-zip-detail");
  detail.append(el(doc, "div", "cap-zip-note", s.pick));
  side.append(treeEl);
  wrap.append(side, detail);

  let selection: AbortController | undefined;
  let imageUrl: string | undefined;
  let current: HTMLElement | undefined;
  const dropImage = () => {
    if (imageUrl !== undefined) URL.revokeObjectURL(imageUrl);
    imageUrl = undefined;
  };
  const stop = () => {
    selection?.abort();
    dropImage();
  };
  ctx.lifetime.addEventListener("abort", stop, { once: true });

  const errorText = (e: unknown): string => {
    const m = e instanceof Error ? e.message : String(e);
    const codes: Record<ZipErrorCode, string> = {
      invalid: s.invalid,
      "entry-too-large": s.tooLarge,
      limit: s.limit,
      corrupt: s.corrupt,
      "unsupported-method": s.unsupported,
      encrypted: s.encrypted,
      "not-found": s.notFound,
    };
    return Object.hasOwn(codes, m) ? codes[m as ZipErrorCode] : m;
  };

  const select = async (entry: ZipEntry, rowEl: HTMLElement) => {
    stop();
    current?.removeAttribute("aria-current");
    current = rowEl;
    rowEl.setAttribute("aria-current", "true");
    const sel = new AbortController();
    selection = sel;
    const pane = el(doc, "div", "cap-zip-pane");
    detail.replaceChildren(pane);
    const fail = (text: string) => {
      pane.replaceChildren(el(doc, "div", "cap-zip-error", text));
    };
    if (entry.encrypted) {
      fail(s.encrypted);
      return;
    }
    const ext = extOf(entry.path);
    const name = entry.path.split("/").pop() ?? entry.path;
    const isZip = EXTENSIONS.zip.includes(ext);
    if (isZip && depth >= MAX_NESTING) {
      pane.replaceChildren(el(doc, "div", "cap-zip-note", s.nested));
      return;
    }
    const target = BITMAPS[ext] === undefined ? previewerFor(name) : undefined;
    if (BITMAPS[ext] === undefined && target === undefined) {
      pane.replaceChildren(el(doc, "div", "cap-zip-note", s.noPreview));
      return;
    }

    const key = `${prefix}${entry.index}`;
    let bytes = budget.cache.get(key);
    if (bytes === undefined) {
      pane.replaceChildren(el(doc, "div", "cap-zip-note", s.loading));
      let job = budget.pending.get(key);
      if (job === undefined) {
        // reserve the declared size first: concurrent and abandoned extractions all count
        if (entry.size <= ENTRY_LIMIT && budget.reserved + entry.size > budget.limit) {
          fail(s.limit);
          return;
        }
        const size = entry.size;
        if (size <= ENTRY_LIMIT) budget.reserved += size;
        const started = send<ZipExtractOutput>({
          op: "extract",
          index: entry.index,
          budget: size,
        }).then(
          (out) => {
            budget.cache.set(key, out.data);
            budget.pending.delete(key);
            return out.data;
          },
          (e: unknown) => {
            // nothing was kept: the reservation goes back
            if (size <= ENTRY_LIMIT) budget.reserved -= size;
            budget.pending.delete(key);
            throw e;
          },
        );
        budget.pending.set(key, started);
        job = started;
      }
      try {
        bytes = await job;
      } catch (e) {
        if (!sel.signal.aborted) fail(errorText(e));
        return;
      }
      if (sel.signal.aborted) return;
    }

    const bitmap = BITMAPS[ext];
    if (bitmap !== undefined) {
      imageUrl = URL.createObjectURL(new Blob([bytes.slice(0)], { type: bitmap }));
      const img = el(doc, "img", "cap-zip-image");
      img.src = imageUrl;
      img.alt = name;
      pane.replaceChildren(img);
      return;
    }
    const inner: PreviewFile = {
      name,
      contentType: target?.mime ?? "",
      size: bytes.byteLength,
      data: bytes.slice(0),
    };
    const subCtx: RenderContext = {
      ...ctx,
      root: pane,
      signal: sel.signal,
      lifetime: sel.signal,
      showError: (reason) => {
        if (!sel.signal.aborted) fail(reason);
      },
    };
    try {
      if (isZip) await renderArchive(inner, subCtx, depth + 1, budget, `${key}/`);
      else await (await entryRenderer((target as { id: PreviewerId }).id))(inner, subCtx);
    } catch (e) {
      if (!sel.signal.aborted) fail(errorText(e));
    }
  };

  const openAll = listing.entries.length <= OPEN_ALL_UP_TO;
  const mount = (node: Node, into: HTMLElement, level: number) => {
    const sorted = [...node.children.values()].sort((a, b) => {
      const fa = a.children.size > 0 || a.entry?.dir === true;
      const fb = b.children.size > 0 || b.entry?.dir === true;
      if (fa !== fb) return fa ? -1 : 1;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    for (const child of sorted) {
      const li = el(doc, "li");
      const isFolder = child.children.size > 0 || child.entry?.dir === true;
      const btn = el(doc, "button", isFolder ? "cap-zip-row cap-zip-folder" : "cap-zip-row");
      btn.type = "button";
      btn.append(el(doc, "span", "cap-zip-name", child.name));
      const entry = child.entry;
      if (isFolder) {
        btn.title = s.folder;
        const list = el(doc, "ul");
        list.hidden = !(openAll || level === 0);
        btn.setAttribute("aria-expanded", String(!list.hidden));
        btn.addEventListener("click", () => {
          list.hidden = !list.hidden;
          btn.setAttribute("aria-expanded", String(!list.hidden));
        });
        li.append(btn, list);
        mount(child, list, level + 1);
      } else if (entry !== undefined) {
        btn.dataset.encrypted = String(entry.encrypted);
        if (entry.encrypted) btn.append(el(doc, "span", "cap-zip-lock", s.locked));
        btn.append(el(doc, "span", "cap-zip-meta", formatSize(entry.size)));
        if (entry.modified !== "") btn.title = entry.modified;
        btn.addEventListener("click", () => void select(entry, btn));
        li.append(btn);
      }
      into.append(li);
    }
  };
  mount(buildTree(listing.entries), treeEl, 0);

  ctx.root.dataset.state = "ready";
  ctx.root.replaceChildren(wrap);
}

/** A renderer with its own archive budget (the tests lower it; the shell uses `render`). */
export function createRender(limit: number): Renderer {
  return (file, ctx) =>
    renderArchive(file, ctx, 0, { limit, reserved: 0, cache: new Map(), pending: new Map() }, "");
}

export const render: Renderer = createRender(ARCHIVE_LIMIT);
