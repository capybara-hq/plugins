/**
 * The docx previewer: mammoth (in a worker) converts the document to HTML, `sanitizeHtml` makes it
 * inert and `mountSanitized` puts it in a shadow root, as a page on a readable-width sheet.
 */
import { showEmpty } from "../app/frame.js";
import { mountSanitized, sanitizeHtml } from "../app/sanitize.js";
import { THEME } from "../app/theme.js";
import type { Renderer } from "../app/types.js";
import type { DocxInput, DocxOutput } from "../shared/docx.js";

const STRINGS = {
  zh: {
    tooLarge: "文档过大，无法预览",
    external: "外部资源和脚本未加载",
    invalid: "这不是有效的 .docx 文档（文件已损坏，或扩展名与内容不符）",
  },
  en: {
    tooLarge: "The document is too large to preview",
    external: "External resources and scripts are not loaded",
    invalid: "This is not a valid .docx document (the file is corrupt or not what its name says)",
  },
} as const;

/** The document as a page: readable line length, centered, in the shadow root's own colors. */
const DOCUMENT_CSS = `
body{box-sizing:border-box;max-width:820px;margin:0 auto;padding:32px 40px;
font:15px/1.65 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
overflow-wrap:anywhere}
h1,h2,h3,h4,h5,h6{line-height:1.3;margin:1.4em 0 .5em}
p{margin:0 0 .8em}
img{max-width:100%;height:auto}
table{border-collapse:collapse;margin:0 0 1em;max-width:100%}
td,th{border:1px solid #c8c8c8;padding:4px 8px;vertical-align:top}
a{color:#1a56b0;text-decoration:underline;cursor:default}
`;

export const render: Renderer = async (file, ctx) => {
  if (file.size === 0 || file.data.byteLength === 0) {
    showEmpty(ctx.root, ctx.t);
    return;
  }
  let out: DocxOutput;
  try {
    // a copy travels to the worker: transferring file.data would detach it for a retry
    const data = file.data.slice(0);
    out = await ctx.runInWorker<DocxInput, DocxOutput>("docx", { data }, { transfer: [data] });
  } catch (e) {
    if (ctx.signal.aborted) return;
    ctx.showError(e instanceof Error ? e.message : String(e));
    return;
  }
  if (ctx.signal.aborted) return;
  if (out.error !== undefined) {
    const s = STRINGS[ctx.locale];
    ctx.showError(out.error === "too-large" ? s.tooLarge : s.invalid);
    return;
  }
  const doc = ctx.root.ownerDocument;
  const result = sanitizeHtml(out.html, doc);
  if (result.fragment.textContent?.trim() === "" && result.fragment.querySelector("img") === null) {
    showEmpty(ctx.root, ctx.t);
    return;
  }
  result.styles.unshift(DOCUMENT_CSS);
  const view = doc.createElement("div");
  view.className = "cap-docx";
  view.style.cssText = `flex:1;min-height:0;overflow:auto;background:${THEME.panel}`;
  mountSanitized(view, result);
  const shell = doc.createElement("div");
  shell.style.cssText = "display:flex;flex-direction:column;height:100%";
  if (result.external) {
    const notice = doc.createElement("div");
    notice.className = "cap-docx-notice";
    notice.setAttribute("role", "note");
    notice.textContent = STRINGS[ctx.locale].external;
    notice.style.cssText =
      `padding:6px 8px;font-size:12px;color:${THEME.mutedForeground};` +
      `border-bottom:1px solid ${THEME.border};background:${THEME.panel}`;
    shell.append(notice);
  }
  shell.append(view);
  ctx.root.replaceChildren(shell);
};
