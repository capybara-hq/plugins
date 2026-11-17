/**
 * The code previewer: highlighted text with a line-number column and a wrap toggle. Highlighting
 * runs in the `code` worker; every span is built with `textContent`, never from markup.
 * `mountCode` is shared with the zip previewer and the html source mode.
 */

import { showEmpty } from "../app/frame.js";
import {
  decodeText,
  type HighlightInput,
  type HighlightOutput,
  languageFor,
} from "../app/language.js";
import type { RenderContext, Renderer } from "../app/types.js";

const STRINGS = {
  zh: { wrap: "自动换行", truncated: "文件过大，仅显示并高亮开头部分" },
  en: {
    wrap: "Wrap lines",
    truncated: "File too large: only the beginning is shown and highlighted",
  },
} as const;

const CSS = `
.cap-code { font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.cap-code-bar { display: flex; gap: 12px; align-items: center; padding: 4px 12px; position: sticky; top: 0;
  background: var(--cap-background, Canvas); border-bottom: 1px solid var(--cap-border, #8884); z-index: 1;
  font-family: system-ui, sans-serif; font-size: 12px; color: var(--cap-muted-foreground, GrayText); }
.cap-code-bar button { font: inherit; cursor: pointer; color: inherit; background: none;
  border: 1px solid var(--cap-border, #8884); border-radius: 4px; padding: 1px 8px; }
.cap-code-bar button[aria-pressed="true"] { color: var(--cap-foreground, CanvasText); }
.cap-code-body { padding: 8px 0; min-width: min-content; }
.cap-code-row { display: grid; grid-template-columns: var(--cap-code-gutter, 4ch) 1fr; }
.cap-code-num { text-align: right; padding: 0 12px 0 8px; user-select: none; opacity: 0.55; }
.cap-code-line { margin: 0; padding-right: 12px; font: inherit; white-space: pre; tab-size: 4; }
.cap-code[data-wrap="on"] .cap-code-line { white-space: pre-wrap; overflow-wrap: anywhere; }
`;

function ensureStyle(doc: Document): void {
  if (doc.getElementById("cap-code-style")) return;
  const style = doc.createElement("style");
  style.id = "cap-code-style";
  style.textContent = CSS;
  doc.head.append(style);
}

function currentTheme(doc: Document): "dark" | "light" {
  return doc.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

function paint(doc: Document, body: HTMLElement, lines: HighlightOutput["lines"]): void {
  const frag = doc.createDocumentFragment();
  const width = `${String(lines.length).length + 2}ch`;
  body.style.setProperty("--cap-code-gutter", width);
  lines.forEach((tokens, i) => {
    const row = doc.createElement("div");
    row.className = "cap-code-row";
    const num = doc.createElement("span");
    num.className = "cap-code-num";
    num.textContent = String(i + 1);
    const line = doc.createElement("pre");
    line.className = "cap-code-line";
    for (const tok of tokens) {
      const span = doc.createElement("span");
      span.textContent = tok.content;
      if (tok.color !== undefined) span.style.color = tok.color;
      line.append(span);
    }
    // an empty line keeps its height
    if (tokens.length === 0) line.textContent = "​";
    row.append(num, line);
    frag.append(row);
  });
  body.replaceChildren(frag);
}

export async function mountCode(
  root: HTMLElement,
  text: string,
  name: string,
  contentType: string,
  ctx: RenderContext,
): Promise<void> {
  if (text === "") {
    showEmpty(root, ctx.t);
    return;
  }
  const doc = root.ownerDocument;
  const s = STRINGS[ctx.locale];
  const lang = languageFor(name, contentType);
  const run = (theme: "dark" | "light") =>
    ctx.runInWorker<HighlightInput, HighlightOutput>("code", { text, lang, theme });

  const result = await run(currentTheme(doc));
  if (ctx.signal.aborted) return;

  ensureStyle(doc);
  const wrap = doc.createElement("div");
  wrap.className = "cap-code";
  wrap.dataset.wrap = "off";
  const bar = doc.createElement("div");
  bar.className = "cap-code-bar";
  const toggle = doc.createElement("button");
  toggle.type = "button";
  toggle.textContent = s.wrap;
  toggle.setAttribute("aria-pressed", "false");
  toggle.addEventListener("click", () => {
    const on = wrap.dataset.wrap !== "on";
    wrap.dataset.wrap = on ? "on" : "off";
    toggle.setAttribute("aria-pressed", String(on));
  });
  bar.append(toggle);
  if (result.truncated) {
    const note = doc.createElement("span");
    note.className = "cap-code-truncated";
    note.textContent = s.truncated;
    bar.append(note);
  }
  const body = doc.createElement("div");
  body.className = "cap-code-body";
  paint(doc, body, result.lines);
  wrap.append(bar, body);
  root.dataset.state = "ready";
  root.replaceChildren(wrap);

  // a theme switch re-colors the tokens without a reload; a failed re-run keeps the old colors
  const view = doc.defaultView;
  if (view && typeof view.MutationObserver === "function") {
    let shown = currentTheme(doc);
    const observer = new view.MutationObserver(() => {
      const theme = currentTheme(doc);
      if (!wrap.isConnected) return observer.disconnect();
      if (theme === shown) return;
      shown = theme;
      run(theme).then(
        (next) => {
          if (wrap.isConnected && currentTheme(doc) === theme) paint(doc, body, next.lines);
        },
        () => {},
      );
    });
    observer.observe(doc.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  }
}

const render: Renderer = async (file, ctx) => {
  await mountCode(ctx.root, decodeText(file.data), file.name, file.contentType, ctx);
};

export { render };
