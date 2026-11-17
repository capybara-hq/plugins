/**
 * The highlighting of the code previewer, separate from `code.worker.ts` (which only wires it to
 * `serve`) so tests can run it in Node. Shiki core with the JavaScript regex engine: no WebAssembly.
 */

import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import c from "shiki/langs/c.mjs";
import cpp from "shiki/langs/cpp.mjs";
import csharp from "shiki/langs/csharp.mjs";
import css from "shiki/langs/css.mjs";
import dockerfile from "shiki/langs/dockerfile.mjs";
import dotenv from "shiki/langs/dotenv.mjs";
import go from "shiki/langs/go.mjs";
import html from "shiki/langs/html.mjs";
import ini from "shiki/langs/ini.mjs";
import java from "shiki/langs/java.mjs";
import javascript from "shiki/langs/javascript.mjs";
import json from "shiki/langs/json.mjs";
import jsonc from "shiki/langs/jsonc.mjs";
import jsx from "shiki/langs/jsx.mjs";
import kotlin from "shiki/langs/kotlin.mjs";
import log from "shiki/langs/log.mjs";
import make from "shiki/langs/make.mjs";
import powershell from "shiki/langs/powershell.mjs";
import proto from "shiki/langs/proto.mjs";
import python from "shiki/langs/python.mjs";
import ruby from "shiki/langs/ruby.mjs";
import rust from "shiki/langs/rust.mjs";
import scss from "shiki/langs/scss.mjs";
import shellscript from "shiki/langs/shellscript.mjs";
import sql from "shiki/langs/sql.mjs";
import swift from "shiki/langs/swift.mjs";
import toml from "shiki/langs/toml.mjs";
import tsx from "shiki/langs/tsx.mjs";
import typescript from "shiki/langs/typescript.mjs";
import xml from "shiki/langs/xml.mjs";
import yaml from "shiki/langs/yaml.mjs";
import githubDark from "shiki/themes/github-dark.mjs";
import githubLight from "shiki/themes/github-light.mjs";
import type { HighlightInput, HighlightOutput } from "../shared/code.js";
import { capText, MAX_HIGHLIGHT_CHARS } from "../shared/language.js";

/** Highlight at most this much text and this many lines; the rest is dropped (`truncated`). */
export const MAX_CHARS = MAX_HIGHLIGHT_CHARS;
export const MAX_LINES = 20_000;
/** A line longer than this is left plain (Shiki's tokenizer slows down on very long lines). */
const MAX_TOKENIZED_LINE = 5_000;
/** Shiki gives up on one line after this many ms (it then returns the line as one plain token). */
const LINE_TIME_LIMIT_MS = 200;

/** The one list of grammars: the keys are the Shiki ids `languageFor` can return. */
export const LANG_MODULES = {
  c,
  cpp,
  csharp,
  css,
  dockerfile,
  dotenv,
  go,
  html,
  ini,
  java,
  javascript,
  json,
  jsonc,
  jsx,
  kotlin,
  log,
  make,
  powershell,
  proto,
  python,
  ruby,
  rust,
  scss,
  shellscript,
  sql,
  swift,
  toml,
  tsx,
  typescript,
  xml,
  yaml,
};

const LANGS = Object.values(LANG_MODULES);

let highlighter: Promise<HighlighterCore> | undefined;

function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= createHighlighterCore({
    themes: [githubDark, githubLight],
    langs: LANGS,
    engine: createJavaScriptRegexEngine(),
  });
  return highlighter;
}

export function splitLines(text: string): { lines: string[]; truncated: boolean } {
  const capped = capText(text, MAX_CHARS);
  let truncated = capped.truncated;
  text = capped.text;
  const lines = text.split(/\r\n|\r|\n/);
  // a trailing newline ends the last line; it does not start another
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  if (lines.length > MAX_LINES) {
    lines.length = MAX_LINES;
    truncated = true;
  }
  return { lines, truncated };
}

export async function highlight(input: HighlightInput): Promise<HighlightOutput> {
  const { lines, truncated } = splitLines(input.text);
  const plain = (): HighlightOutput => ({
    lines: lines.map((content) => [{ content }]),
    truncated,
  });
  try {
    const hl = await getHighlighter();
    if (!hl.getLoadedLanguages().includes(input.lang)) return plain();
    const tokens = hl.codeToTokensBase(lines.join("\n"), {
      lang: input.lang,
      theme: input.theme === "dark" ? "github-dark" : "github-light",
      tokenizeMaxLineLength: MAX_TOKENIZED_LINE,
      tokenizeTimeLimit: LINE_TIME_LIMIT_MS,
    });
    return {
      lines: tokens.map((line) =>
        line.map((t) =>
          t.color === undefined ? { content: t.content } : { content: t.content, color: t.color },
        ),
      ),
      truncated,
    };
  } catch {
    // a grammar or engine failure shows the text plain: the preview never fails over colors
    return plain();
  }
}
