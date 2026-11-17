/**
 * The code previewer: highlighted text with a line-number column and a wrap toggle. Highlighting
 * runs in the `code` worker; every span is built with `textContent`, never from markup.
 * `mountCode` is shared with the zip previewer and the html source mode.
 */

import { showEmpty } from "../app/frame.js";
import { THEME } from "../app/theme.js";
import type { RenderContext, Renderer } from "../app/types.js";
import { WorkerTimeoutError } from "../app/worker-host.js";
import type { HighlightInput, HighlightOutput } from "../shared/code.js";
import { capText, decodeText, languageFor } from "../shared/language.js";

/** The highlighting budget: shorter than the shell's, so the plain fallback appears in time. */
export const HIGHLIGHT_BUDGET_MS = 8_000;
const MAX_PLAIN_LINES = 20_000;

function plainLines(text: string): HighlightOutput {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  const truncated = lines.length > MAX_PLAIN_LINES;
  if (truncated) lines.length = MAX_PLAIN_LINES;
  return { lines: lines.map((content) => (content === "" ? [] : [{ content }])), truncated };
}

const STRINGS = {
  zh: {
    wrap: "自动换行",
    skipped: "高亮超时，已显示为纯文本",
    truncated: "文件过大，仅显示开头部分",
  },
  en: {
    wrap: "Wrap lines",
    skipped: "Highlighting timed out; shown as plain text",
    truncated: "File too large: only the beginning is shown",
  },
} as const;

const CSS = `
.cap-code { font: 13px/1.5 ${THEME.fontMono}; }
.cap-code-bar { display: flex; gap: 12px; align-items: center; padding: 4px 12px; position: sticky; top: 0;
  background: ${THEME.background}; border-bottom: 1px solid ${THEME.border}; z-index: 1;
  font-family: ${THEME.font}; font-size: 12px; color: ${THEME.mutedForeground}; }
.cap-code-bar button { font: inherit; cursor: pointer; color: inherit; background: none;
  border: 1px solid ${THEME.border}; border-radius: ${THEME.radius}; padding: 1px 8px; }
.cap-code-bar button[aria-pressed="true"] { color: ${THEME.foreground}; }
.cap-code-body { padding: 8px 0; min-width: min-content; }
.cap-code-row { display: grid; grid-template-columns: var(--cap-code-gutter, 4ch) 1fr; }
.cap-code-num { text-align: right; padding: 0 12px 0 8px; user-select: none; opacity: 0.55; }
.cap-code-line { min-height: 1.5em; margin: 0; padding-right: 12px; font: inherit; white-space: pre; tab-size: 4; }
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
    // an empty line gets an empty text node; CSS keeps its height (copied text stays clean)
    if (tokens.length === 0) line.append(doc.createTextNode(""));
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
  // the worker never gets (and the page never clones) more than the highlight cap
  const capped = capText(text);
  const run = (theme: "dark" | "light") =>
    ctx.runInWorker<HighlightInput, HighlightOutput>(
      "code",
      { text: capped.text, lang, theme },
      { budgetMs: HIGHLIGHT_BUDGET_MS },
    );

  let skipped = false;
  let result: HighlightOutput;
  try {
    result = await run(currentTheme(doc));
  } catch (e) {
    // a slow grammar must not fail the preview: the text shows plain
    if (!(e instanceof WorkerTimeoutError)) throw e;
    skipped = true;
    result = plainLines(capped.text);
  }
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
  if (result.truncated || capped.truncated) {
    const note = doc.createElement("span");
    note.className = "cap-code-truncated";
    note.textContent = s.truncated;
    bar.append(note);
  }
  const skippedNote = doc.createElement("span");
  skippedNote.className = "cap-code-skipped";
  skippedNote.textContent = s.skipped;
  if (skipped) bar.append(skippedNote);
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
      if (theme === shown) return;
      shown = theme;
      run(theme).then(
        (next) => {
          if (ctx.lifetime.aborted || currentTheme(doc) !== theme) return;
          paint(doc, body, next.lines);
          // the colors are real now: the "timed out" note no longer applies
          skippedNote.remove();
        },
        () => {},
      );
    });
    observer.observe(doc.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    ctx.lifetime.addEventListener("abort", () => observer.disconnect(), { once: true });
  }
}

const render: Renderer = async (file, ctx) => {
  await mountCode(ctx.root, decodeText(file.data), file.name, file.contentType, ctx);
};

export { render };
