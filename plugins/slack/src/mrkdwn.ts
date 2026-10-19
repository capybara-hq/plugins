/**
 * Markdown → Slack mrkdwn（https://docs.slack.dev/messaging/formatting-message-text ，2026-10-20 查阅）：
 * 粗体 `*x*`、斜体 `_x_`、删除线 `~x~`、行内代码与代码块（不支持语言标注）、链接 `<url|text>`、引用 `>`；
 * 没有标题与列表语法——标题转为粗体行，无序列表转为「•」，有序列表原样保留。
 * 文本里的 `&`、`<`、`>` 必须转义为 `&amp;`、`&lt;`、`&gt;`（Slack 用它们做控制序列）。
 */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const BOLD = "\u0001";
const HOLD = "\u0000";

/** 非代码片段的行内格式。 */
function formatSpan(seg: string): string {
  const held: string[] = [];
  const hold = (v: string) => {
    held.push(v);
    return `${HOLD}${held.length - 1}${HOLD}`;
  };
  let s = seg
    .replace(
      /\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/g,
      (_m, label: string, url: string) =>
        hold(`<${url.replace(/&/g, "&amp;")}|${esc(label.replace(/\|/g, "¦"))}>`),
    )
    .replace(/<((?:https?:\/\/|mailto:)[^>\s]+)>/g, (_m, url: string) =>
      hold(`<${url.replace(/&/g, "&amp;")}>`),
    );
  s = esc(s)
    .replace(/\*\*\*(?=\S)(.*?\S)\*\*\*/g, `${BOLD}_$1_${BOLD}`)
    .replace(/\*\*(?=\S)(.*?\S)\*\*/g, `${BOLD}$1${BOLD}`)
    .replace(/(?<!\w)__(?=\S)(.*?\S)__(?!\w)/g, `${BOLD}$1${BOLD}`)
    .replace(/(?<![\w*])\*(?=[^\s*])([^*]*?[^\s*])\*(?![\w*])/g, "_$1_")
    .replace(/(?<![\w*])\*([^\s*])\*(?![\w*])/g, "_$1_")
    .replace(/~~(?=\S)(.*?\S)~~/g, "~$1~")
    .replaceAll(BOLD, "*");
  return s.replace(
    new RegExp(`${HOLD}(\\d+)${HOLD}`, "g"),
    (_m, i: string) => held[Number(i)] ?? "",
  );
}

/** 一行（非代码块）的行内转换：行内代码原样（只转义），其余做格式转换。 */
function inline(line: string): string {
  let out = "";
  let last = 0;
  for (const m of line.matchAll(/`[^`\n]+`/g)) {
    out += formatSpan(line.slice(last, m.index)) + esc(m[0]);
    last = m.index + m[0].length;
  }
  return out + formatSpan(line.slice(last));
}

function convertLine(line: string): string {
  const h = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
  if (h) {
    const body = (h[1] ?? "").replace(/\*\*|__/g, "");
    return body === "" ? "" : `*${inline(body)}*`;
  }
  const li = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (li) return `${li[1]}• ${inline(li[2] ?? "")}`;
  const q = /^(\s*)>\s?(.*)$/.exec(line);
  if (q) return `${q[1]}> ${inline(q[2] ?? "")}`;
  return inline(line);
}

/** 把模型回复的 Markdown 转为 Slack mrkdwn。 */
export function markdownToMrkdwn(md: string): string {
  const out: string[] = [];
  let inFence = false;
  for (const line of md.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      out.push("```");
      inFence = !inFence;
      continue;
    }
    out.push(inFence ? esc(line) : convertLine(line));
  }
  if (inFence) out.push("```");
  return out.join("\n");
}

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;

/** 在 `max` 以内切下一段：优先在空格处（去掉该空格），否则硬切（不拆代理对）。 */
function cut(s: string, max: number): [string, string] {
  const sp = s.lastIndexOf(" ", max);
  if (sp > max / 2) return [s.slice(0, sp), s.slice(sp + 1)];
  let at = max;
  if (isHigh(s.charCodeAt(at - 1))) at--;
  return [s.slice(0, at), s.slice(at)];
}

/**
 * 把 mrkdwn 文本拆成每段不超过 `limit` 个字符（UTF-16 码元，不少于 Slack 的字符计数）：按行装箱（段落间的空行
 * 落在段首 / 段尾时去掉），单行过长时优先在空格处切；切在代码块中间时本段补上收尾的 ``` 、下一段重新开头。
 */
export function splitMrkdwn(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let cur: string[] = [];
  let len = 0;
  let open = false;
  const push = (l: string) => {
    len += (cur.length > 0 ? 1 : 0) + l.length;
    cur.push(l);
  };
  const flush = (final = false) => {
    const lines = [...cur];
    while (lines.length > 0 && (lines[0] ?? "").trim() === "") lines.shift();
    while (lines.length > 0 && (lines.at(-1) ?? "").trim() === "") lines.pop();
    let s = lines.join("\n");
    if (open && !final) s += "\n```";
    if (s.trim() !== "" && s !== "```\n```") out.push(s);
    cur = [];
    len = 0;
    if (open && !final) push("```");
  };
  for (const line of text.split("\n")) {
    const isFence = /^\s*```/.test(line);
    const reserve = (isFence ? !open : open) ? 4 : 0;
    const room = () => limit - reserve - (cur.length > 0 ? len + 1 : 0);
    if (line.length <= room()) {
      push(line);
    } else if (cur.length > 0 && line.length <= limit - reserve - (open ? 4 : 0)) {
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
    if (isFence) open = !open;
  }
  flush(true);
  return out;
}
