/**
 * Markdown → Lark 卡片 JSON 2.0 富文本（`markdown` 组件）。
 *
 * 依据（2026-10-20 查阅）：https://open.larksuite.com/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-components/content-components/rich-text
 * - JSON 2.0 的富文本支持除 HTMLBlock 外的全部 CommonMark 语法（标题、强调、列表、引用、代码块、表格、链接），
 *   所以模型回复的 Markdown 基本原样保留；
 * - 另外解析一组 HTML 风格的标签：`<at>`（**@ 人，`<at id=all></at>` 是 @所有人**）、`<person>`、`<font>`、
 *   `<a>`、`<link>`、`<text_tag>`、`<raw>`、`<local_datetime>`、`<number_tag>`、`<br>`、`<hr>`；
 * - 特殊字符用 HTML 实体 `&#编号;` 转义；超链接只支持 http / https。
 *
 * 防注入（与 Slack 的 `<!channel>` 同等关键）：模型文本不能借这些标签 @ 所有人 / 任何人或改写卡片。
 * - 代码之外：`&` → `&#38;`、`<` → `&#60;`、`\` → `&#92;`（反斜杠不能用来抵消下文给方括号加的转义）。于是任何 `<tag` 都不成立；模型写的实体（`&#60;at …`）也只会原样显示。
 * - 链接（与 Slack 的 mrkdwn.ts 一致）：只有地址为 `http(s)://` 或 `mailto:` 的 `[文字](地址)` 与 `<地址>` 自动链接
 *   做成链接——地址里会破坏语法的字符（空格、括号、方括号、`<` `>` `"` `\`）百分号编码，地址里不做实体转义；
 *   其余写法（`javascript:`、`lark://`、`data:` 等地址、图片 `![…](…)`、引用式链接 `[x][1]` / `[1]: …`）一律把
 *   `[` `]` 加反斜杠，作为普通文字显示。
 * - 代码之内（行内代码、``` / ~~~ 代码块）：CommonMark 不解析其中的标签，为了代码可原样复制不做实体转义；
 *   但不确定 Lark 的渲染器是否在代码里也认 `<at>`（或先解码实体），所以把 `<at`、`&#60;at`、`&lt;at`、`&#x3c;at`
 *   在 `at` 前插入 U+200B（零宽空格）拆开，其余字符不动。
 * 纯文本里的 `@all` 不会 @ 人（卡片只认 `<at>` 标签），原样保留。
 */

/** 零宽空格（U+200B）。 */
const ZWSP = "\u200b";

/**
 * 把 `<at` / `</at`（含实体写法 `&#60;at`、`&lt;at`、`&#x3c;at`，大小写不敏感）拆开，使其不再是标签。用于代码内容，
 * 以及纯文本字段（卡片标题、按钮文字、摘要：本不解析标签，仍兜底处理）。
 */
export const neutralizeAt = (s: string) =>
  s.replace(/(<|&(?:#0*60|#x0*3c|lt);?)(\s*\/?\s*)(at)(?=[\s>/&]|$)/gi, `$1${ZWSP}$2$3`);

const LINK_SCHEME = /^(?:https?:\/\/|mailto:)/i;

/** 文本字符的转义（代码之外、链接之外）。 */
function escChar(c: string): string {
  switch (c) {
    case "&":
      return "&#38;";
    case "<":
      return "&#60;";
    case "[":
      return "\\[";
    case "]":
      return "\\]";
    case "\\":
      return "&#92;";
    default:
      return c;
  }
}
const escText = (s: string) => s.replace(/[&<[\]\\]/g, escChar);

/** 链接地址：会破坏 `[文字](地址)` 语法的字符百分号编码；`&` 原样（地址里不做实体转义）。 */
const encodeDest = (url: string) =>
  url.replace(
    /[\s()<>[\]"\\`]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );

/**
 * 从 `s[open]`（`(`）之后读一个内联链接地址：到空白或不配对的 `)` 为止（地址里的括号要配对，如维基百科链接）。
 * 返回地址与收尾 `)` 之后的位置；不是合法的 `(地址)` 返回 undefined。
 */
function readDest(s: string, open: number): { dest: string; end: number } | undefined {
  let depth = 0;
  for (let i = open + 1; i < s.length; i++) {
    const c = s[i] as string;
    if (/\s/.test(c)) return undefined;
    if (c === "(") depth++;
    else if (c === ")") {
      if (depth === 0) return i > open + 1 ? { dest: s.slice(open + 1, i), end: i + 1 } : undefined;
      depth--;
    }
  }
  return undefined;
}

/** 代码之外的一段文本：认出允许的链接，其余转义（见文件注释）。 */
function escapeText(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i] as string;
    if (c === "<") {
      const m = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(s.slice(i));
      if (m) {
        const url = m[1] as string;
        out += `[${escText(url)}](${encodeDest(url)})`;
        i += m[0].length;
        continue;
      }
    }
    if (c === "[" && s[i - 1] !== "!") {
      const close = s.indexOf("]", i + 1);
      const label = close > i ? s.slice(i + 1, close) : "";
      if (close > i && !/[[\]\n]/.test(label) && s[close + 1] === "(") {
        const d = readDest(s, close + 1);
        if (d && LINK_SCHEME.test(d.dest)) {
          out += `[${escText(label)}](${encodeDest(d.dest)})`;
          i = d.end;
          continue;
        }
      }
    }
    out += escChar(c);
    i++;
  }
  return out;
}

/** 一行（不在代码块里）：行内代码只做 `<at` 拆分，其余转义。 */
function convertLine(line: string): string {
  let out = "";
  let last = 0;
  for (const m of line.matchAll(/`[^`\n]+`/g)) {
    out += escapeText(line.slice(last, m.index)) + neutralizeAt(m[0]);
    last = m.index + m[0].length;
  }
  return out + escapeText(line.slice(last));
}

/** 一个已打开的代码块围栏：字符（反引号或波浪号）、长度、开头行的 info 字符串。 */
export interface Fence {
  char: "`" | "~";
  len: number;
  info: string;
}

/**
 * 按 CommonMark 判断一行是否打开代码块围栏：至多 3 个空格缩进，3 个以上同种字符；反引号围栏的 info 字符串
 * 不能含反引号（"```a```" 是行内代码，不是围栏）。
 */
export function fenceOpener(line: string): Fence | undefined {
  const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!m) return undefined;
  const run = m[1] as string;
  const info = m[2] as string;
  if (run[0] === "`" && info.includes("`")) return undefined;
  return { char: run[0] as "`" | "~", len: run.length, info: info.trim() };
}

/** 按 CommonMark 判断一行是否收尾 `fence`：同种字符、不短于开头，后面只有空白。 */
export function fenceCloses(line: string, fence: Fence): boolean {
  const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return m !== null && (m[1] as string)[0] === fence.char && (m[1] as string).length >= fence.len;
}

/** 把模型回复的 Markdown 转为卡片富文本内容（见文件注释）。 */
export function toCardMarkdown(md: string): string {
  const out: string[] = [];
  let fence: Fence | undefined;
  for (const line of md.replace(/\r\n?/g, "\n").split("\n")) {
    if (fence !== undefined) {
      if (fenceCloses(line, fence)) fence = undefined;
      out.push(neutralizeAt(line));
      continue;
    }
    fence = fenceOpener(line);
    out.push(fence !== undefined ? neutralizeAt(line) : convertLine(line));
  }
  return out.join("\n");
}

/**
 * 把一个值（agent 名、工具名、决定人等）按纯文本显示：行内 Markdown 标点加反斜杠，行首的 `#` / `-` / `+`
 * （标题、列表）加反斜杠，`&` / `<` 转实体。先加反斜杠再转实体，实体里的 `#` 不会被转义。
 */
export function escapePlain(s: string): string {
  return s
    .replace(/[\\`*_~[\]()!|>]/g, (c) => `\\${c}`)
    .replace(/^(\s*)([#+-])/gm, "$1\\$2")
    .replace(/&/g, "&#38;")
    .replace(/</g, "&#60;");
}

/** 代码块内容：拆 `<at`，并打断连续的反引号（不让内容提前收尾代码块）。 */
export function codeSafe(s: string): string {
  return neutralizeAt(s).replace(/`(?=`)/g, `\`${ZWSP}`);
}

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;

/** 硬切点 `at` 落在实体（`&#38;` 之类）或代理对中间时往前退。 */
function safeCut(s: string, at: number): number {
  let i = at;
  if (i > 0 && isHigh(s.charCodeAt(i - 1))) i--;
  const amp = s.lastIndexOf("&", i - 1);
  if (amp >= 0 && i - amp <= 8) {
    const semi = s.indexOf(";", amp);
    if (semi >= i && /^&#?\w+;$/.test(s.slice(amp, semi + 1))) i = amp;
  }
  return i > 0 ? i : at;
}

/**
 * 在 `max` 以内切下一段：优先在空格处（去掉该空格），否则硬切（不拆实体与代理对）。切点落在行内代码
 * （之前有奇数个反引号）里时退到该段代码之前（它前面是空格就去掉空格）；代码段从行首开始、本身就超长时只能切开。
 */
function cut(s: string, max: number): [string, string] {
  const sp = s.lastIndexOf(" ", max);
  let at = sp > max / 2 ? sp : safeCut(s, max);
  let skip = sp > max / 2 ? 1 : 0;
  const ticks = (s.slice(0, at).match(/`/g) ?? []).length;
  if (ticks % 2 === 1) {
    const open = s.lastIndexOf("`", at - 1);
    if (open > 0) {
      const spaced = s[open - 1] === " " && open > 1;
      at = spaced ? open - 1 : open;
      skip = spaced ? 1 : 0;
    }
  }
  return [s.slice(0, at), s.slice(at + skip)];
}

/**
 * 把（已转换的）卡片 Markdown 拆成每段不超过 `limit` 个 UTF-16 码元：按行装箱（段首 / 段尾的空行去掉），
 * 单行过长时优先在空格处切；切在代码块中间时本段补上同字符、同长度的收尾围栏，下一段用原开头（含 info）重新打开。
 */
export function splitMarkdown(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let cur: string[] = [];
  let len = 0;
  // 当前打开的围栏（与 toCardMarkdown 同一套判定）；重开时用同样的字符、长度与 info，收尾用同样的字符与长度
  let open: Fence | undefined;
  const opener = (f: Fence) => f.char.repeat(f.len) + f.info;
  const closer = (f: Fence) => f.char.repeat(f.len);
  const push = (l: string) => {
    len += (cur.length > 0 ? 1 : 0) + l.length;
    cur.push(l);
  };
  const flush = (final = false) => {
    const lines = [...cur];
    while (lines.length > 0 && (lines[0] ?? "").trim() === "") lines.shift();
    while (lines.length > 0 && (lines.at(-1) ?? "").trim() === "") lines.pop();
    if (open !== undefined && !final) lines.push(closer(open));
    const s = lines.join("\n");
    const emptyBlock =
      open !== undefined && lines.length === 2 && lines[0] === opener(open) && !final;
    if (s.trim() !== "" && !emptyBlock) out.push(s);
    cur = [];
    len = 0;
    if (open !== undefined && !final) push(opener(open));
  };
  for (const line of text.split("\n")) {
    const opens = open === undefined ? fenceOpener(line) : undefined;
    const closes = open !== undefined && fenceCloses(line, open);
    const inside = opens ?? (closes ? undefined : open);
    // 留出补收尾围栏的位置（换行 + 围栏长度）
    const reserve = inside !== undefined ? inside.len + 1 : 0;
    const room = () => limit - reserve - (cur.length > 0 ? len + 1 : 0);
    if (line.length <= room()) {
      push(line);
    } else if (
      cur.length > 0 &&
      line.length <= limit - reserve - (open !== undefined ? opener(open).length + 1 : 0)
    ) {
      flush();
      push(line);
    } else {
      let rest = line;
      while (rest.length > 0) {
        if (room() < Math.min(rest.length, 8)) flush();
        const r = room();
        if (rest.length <= r) {
          push(rest);
          break;
        }
        const [piece, remainder] = cut(rest, r);
        push(piece);
        rest = remainder;
        flush();
      }
    }
    if (opens !== undefined) open = opens;
    else if (closes) open = undefined;
  }
  flush(true);
  return out;
}
