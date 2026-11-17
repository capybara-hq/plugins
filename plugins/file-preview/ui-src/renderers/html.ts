/**
 * The html previewer: the document sanitized into a shadow root ("rendered", the default) or its
 * source through the code renderer ("source"). Links never navigate; nothing loads or runs.
 */
import { showEmpty, showError } from "../app/frame.js";
import { mountSanitized, sanitizeHtml } from "../app/sanitize.js";
import { THEME } from "../app/theme.js";
import type { RenderContext, Renderer } from "../app/types.js";
import { mountCode } from "./code.js";

const STRINGS = {
  zh: { rendered: "预览", source: "源码", external: "外部资源和脚本未加载", mode: "显示方式" },
  en: {
    rendered: "Rendered",
    source: "Source",
    external: "External resources and scripts are not loaded",
    mode: "View",
  },
} as const;

const BAR_STYLE =
  "display:flex;align-items:center;gap:8px;padding:6px 8px;" +
  `border-bottom:1px solid ${THEME.border};background:${THEME.panel};color:${THEME.foreground}`;
const BUTTON_STYLE =
  "font:inherit;padding:2px 10px;cursor:pointer;color:inherit;" +
  `font-family:${THEME.font};border-radius:${THEME.radius};` +
  `background:transparent;border:1px solid ${THEME.border}`;
const NOTICE_STYLE = `color:${THEME.mutedForeground};font-size:12px`;
/** The pressed mode reads as selected in the embed's theme. */
const PRESSED_BG = THEME.hover;

const render: Renderer = async (file, ctx) => {
  if (file.data.byteLength === 0) {
    showEmpty(ctx.root, ctx.t);
    return;
  }
  const doc = ctx.root.ownerDocument;
  const s = STRINGS[ctx.locale];
  const text = new TextDecoder("utf-8").decode(file.data);
  const result = sanitizeHtml(text, doc);
  if (ctx.signal.aborted) return;

  const shell = doc.createElement("div");
  shell.className = "cap-html";
  shell.style.cssText = "display:flex;flex-direction:column;height:100%";

  const bar = doc.createElement("div");
  bar.className = "cap-html-bar";
  bar.style.cssText = BAR_STYLE;
  const group = doc.createElement("div");
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", s.mode);
  group.style.cssText = "display:flex;gap:4px";
  const button = (label: string, mode: "rendered" | "source") => {
    const b = doc.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.dataset.mode = mode;
    b.style.cssText = BUTTON_STYLE;
    return b;
  };
  const renderedBtn = button(s.rendered, "rendered");
  const sourceBtn = button(s.source, "source");
  group.append(renderedBtn, sourceBtn);
  bar.append(group);
  if (result.external) {
    const notice = doc.createElement("span");
    notice.className = "cap-html-notice";
    notice.setAttribute("role", "note");
    notice.textContent = s.external;
    notice.style.cssText = NOTICE_STYLE;
    bar.append(notice);
  }

  const renderedView = doc.createElement("div");
  renderedView.className = "cap-html-rendered";
  renderedView.style.cssText = "flex:1;min-height:0";
  mountSanitized(renderedView, result);

  const sourceView = doc.createElement("div");
  sourceView.className = "cap-html-source";
  sourceView.style.cssText = "flex:1;min-height:0;overflow:auto";
  sourceView.hidden = true;

  shell.append(bar, renderedView, sourceView);
  ctx.root.replaceChildren(shell);

  let sourceMounted = false;
  const select = (mode: "rendered" | "source") => {
    renderedBtn.setAttribute("aria-pressed", String(mode === "rendered"));
    sourceBtn.setAttribute("aria-pressed", String(mode === "source"));
    renderedBtn.style.background = mode === "rendered" ? PRESSED_BG : "transparent";
    sourceBtn.style.background = mode === "source" ? PRESSED_BG : "transparent";
    renderedView.hidden = mode !== "rendered";
    sourceView.hidden = mode !== "source";
    if (mode === "source" && !sourceMounted) {
      sourceMounted = true;
      // The shell's render has settled by now: its signal is spent and its showError is closed.
      // The source pane gets its own context; a failure shows inside the pane.
      const sourceCtx: RenderContext = {
        ...ctx,
        root: sourceView,
        // the source pane lives on after the render settles: it ends with the preview
        signal: ctx.lifetime,
        showError: (reason) => showError(sourceView, ctx.t, reason),
      };
      mountCode(sourceView, text, file.name, file.contentType, sourceCtx).catch((e: unknown) => {
        showError(sourceView, ctx.t, e instanceof Error ? e.message : String(e));
      });
    }
  };
  renderedBtn.addEventListener("click", () => select("rendered"));
  sourceBtn.addEventListener("click", () => select("source"));
  select("rendered");
};

export { render };
