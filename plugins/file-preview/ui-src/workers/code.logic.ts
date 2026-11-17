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
import dart from "shiki/langs/dart.mjs";
import dockerfile from "shiki/langs/dockerfile.mjs";
import dotenv from "shiki/langs/dotenv.mjs";
import go from "shiki/langs/go.mjs";
import graphql from "shiki/langs/graphql.mjs";
import groovy from "shiki/langs/groovy.mjs";
import html from "shiki/langs/html.mjs";
import ini from "shiki/langs/ini.mjs";
import java from "shiki/langs/java.mjs";
import javascript from "shiki/langs/javascript.mjs";
import json from "shiki/langs/json.mjs";
import jsonc from "shiki/langs/jsonc.mjs";
import jsx from "shiki/langs/jsx.mjs";
import kotlin from "shiki/langs/kotlin.mjs";
import log from "shiki/langs/log.mjs";
import lua from "shiki/langs/lua.mjs";
import make from "shiki/langs/make.mjs";
import php from "shiki/langs/php.mjs";
import powershell from "shiki/langs/powershell.mjs";
import proto from "shiki/langs/proto.mjs";
import python from "shiki/langs/python.mjs";
import r from "shiki/langs/r.mjs";
import ruby from "shiki/langs/ruby.mjs";
import rust from "shiki/langs/rust.mjs";
import scala from "shiki/langs/scala.mjs";
import scss from "shiki/langs/scss.mjs";
import shellscript from "shiki/langs/shellscript.mjs";
import sql from "shiki/langs/sql.mjs";
import svelte from "shiki/langs/svelte.mjs";
import swift from "shiki/langs/swift.mjs";
import toml from "shiki/langs/toml.mjs";
import tsx from "shiki/langs/tsx.mjs";
import typescript from "shiki/langs/typescript.mjs";
import vue from "shiki/langs/vue.mjs";
import xml from "shiki/langs/xml.mjs";
import yaml from "shiki/langs/yaml.mjs";
import githubDark from "shiki/themes/github-dark.mjs";
import githubLight from "shiki/themes/github-light.mjs";
import type { HighlightInput, HighlightOutput } from "../shared/code.js";

/** Highlight at most this much text and this many lines; the rest is dropped (`truncated`). */
export const MAX_CHARS = 1024 * 1024;
export const MAX_LINES = 20_000;
/** A line longer than this is left plain (Shiki's tokenizer slows down on very long lines). */
const MAX_TOKENIZED_LINE = 5_000;

const LANGS = [
  c,
  cpp,
  csharp,
  css,
  dart,
  dockerfile,
  dotenv,
  go,
  graphql,
  groovy,
  html,
  ini,
  java,
  javascript,
  json,
  jsonc,
  jsx,
  kotlin,
  log,
  lua,
  make,
  php,
  powershell,
  proto,
  python,
  r,
  ruby,
  rust,
  scala,
  scss,
  shellscript,
  sql,
  svelte,
  swift,
  toml,
  tsx,
  typescript,
  vue,
  xml,
  yaml,
];

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
  let truncated = false;
  if (text.length > MAX_CHARS) {
    text = text.slice(0, MAX_CHARS);
    truncated = true;
  }
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
  const hl = await getHighlighter();
  if (!hl.getLoadedLanguages().includes(input.lang)) return plain();
  const tokens = hl.codeToTokensBase(lines.join("\n"), {
    lang: input.lang,
    theme: input.theme === "dark" ? "github-dark" : "github-light",
    tokenizeMaxLineLength: MAX_TOKENIZED_LINE,
  });
  return {
    lines: tokens.map((line) =>
      line.map((t) =>
        t.color === undefined ? { content: t.content } : { content: t.content, color: t.color },
      ),
    ),
    truncated,
  };
}
