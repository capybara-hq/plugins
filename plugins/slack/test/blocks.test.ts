import type { ChannelCard } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { decodeActionValue } from "../src/actions.js";
import {
  renderCard,
  renderSend,
  renderUpdate,
  SECTION_TEXT_LIMIT,
  TEXT_LIMIT,
} from "../src/blocks.js";

type Block = Record<string, unknown> & { type: string };
type El = {
  type: string;
  action_id: string;
  value?: string;
  url?: string;
  style?: string;
  text: { text: string };
  options?: { value: string; text: { text: string } }[];
};

const ID = "6f1c0d7e-1111-4222-8333-944455556666";
const WEB = "https://cap.example/c/1";
const approval = (over: Partial<Extract<ChannelCard, { kind: "approval" }>> = {}): ChannelCard => ({
  kind: "approval",
  id: ID,
  title: "Post an announcement",
  toolName: "post_announcement",
  appName: "Fake IM",
  agentName: "Helper",
  inputPreview: "Post announcement: Office closed",
  scopes: ["once", "session", "always"],
  expiresAt: "2026-10-20T10:00:00Z",
  state: "pending",
  webUrl: WEB,
  ...over,
});
const question = (multi: boolean, n: number, over: Record<string, unknown> = {}): ChannelCard => ({
  kind: "question",
  id: ID,
  state: "pending",
  webUrl: WEB,
  form: {
    title: { en: "Which env?", zh: "哪个环境？" },
    fields: [
      {
        key: "env",
        label: { en: "Environment", zh: "环境" },
        schema: { type: "string", enum: Array.from({ length: n }, (_, i) => `env${i}`) },
        ...(multi && { multiSelect: true }),
      },
    ],
  },
  ...over,
});

const elements = (blocks: Block[]) =>
  blocks.filter((b) => b.type === "actions").flatMap((b) => b.elements as El[]);
const buttons = (blocks: Block[]) => elements(blocks).filter((e) => e.type === "button");
const allText = (blocks: Block[]) => JSON.stringify(blocks);

describe("renderCard: approval", () => {
  it("pending: one approve button per allowed scope, a deny button and a web link (en)", () => {
    const blocks = renderCard(approval(), "en") as Block[];
    const bs = buttons(blocks);
    expect(bs.map((b) => b.text.text)).toEqual([
      "Approve once",
      "Approve for this session",
      "Always approve",
      "Deny",
      "Open on web",
    ]);
    expect(bs.map((b) => b.value && decodeActionValue(b.value))).toEqual([
      { k: "a", id: ID, action: "approve", scope: "once" },
      { k: "a", id: ID, action: "approve", scope: "session" },
      { k: "a", id: ID, action: "approve", scope: "always" },
      { k: "a", id: ID, action: "deny" },
      undefined,
    ]);
    expect(bs[0]?.style).toBe("primary");
    expect(bs[3]?.style).toBe("danger");
    expect(bs[4]?.url).toBe(WEB);
    expect(new Set(bs.map((b) => b.action_id)).size).toBe(bs.length);
    const t = allText(blocks);
    expect(t).toContain("Post an announcement");
    expect(t).toContain("Fake IM / post_announcement");
    expect(t).toContain("Helper");
    expect(t).toContain("Office closed");
  });

  it("the summary is a plain_text section labelled by locale, never a code block or mrkdwn", () => {
    const evil = "*bold* <!channel> <https://evil.example|x> `code` & co";
    const summary = (locale: "en" | "zh") =>
      (renderCard(approval({ inputPreview: evil }), locale) as Block[]).find(
        (b) => (b.text as { type?: string } | undefined)?.type === "plain_text",
      );
    expect(summary("en")).toEqual({
      type: "section",
      text: { type: "plain_text", text: `Summary: ${evil}`, emoji: false },
    });
    expect(summary("zh")?.text).toMatchObject({ text: `摘要：${evil}` });
    expect(allText(renderCard(approval(), "en") as Block[])).not.toContain("```");
    // an empty summary shows nothing
    const none = renderCard(approval({ inputPreview: "" }), "en") as Block[];
    expect(allText(none)).not.toContain("Summary");
  });

  it("only the allowed scopes get buttons; zh labels", () => {
    const bs = buttons(renderCard(approval({ scopes: ["once"] }), "zh") as Block[]);
    expect(bs.map((b) => b.text.text)).toEqual(["批准一次", "拒绝", "在网页上打开"]);
    expect(allText(renderCard(approval(), "zh") as Block[])).toContain("审批");
  });

  it("decided: buttons removed, status with decider shown, details link kept", () => {
    const en = renderCard(approval({ state: "approved", decidedBy: "Alice" }), "en") as Block[];
    expect(buttons(en).map((b) => b.text.text)).toEqual(["Details"]);
    expect(allText(en)).toContain("Approved (Alice)");
    const zh = renderCard(approval({ state: "denied" }), "zh") as Block[];
    expect(allText(zh)).toContain("已拒绝");
    expect(buttons(zh).map((b) => b.text.text)).toEqual(["详情"]);
  });

  it("a denied card shows the person's reason, escaped", () => {
    const en = renderCard(approval({ state: "denied", denyReason: "Use <b> & co" }), "en");
    expect(allText(en as Block[])).toContain("Reason: Use &lt;b&gt; &amp; co");
    const ok = renderCard(approval({ state: "approved", denyReason: "x" }), "en") as Block[];
    expect(allText(ok)).not.toContain("Reason");
  });

  it("long summaries are truncated to fit a section block", () => {
    const blocks = renderCard(approval({ inputPreview: "x".repeat(10_000) }), "en") as Block[];
    for (const b of blocks) {
      const text = (b.text as { text?: string } | undefined)?.text ?? "";
      expect(text.length).toBeLessThanOrEqual(SECTION_TEXT_LIMIT);
    }
  });
});

describe("renderCard: question", () => {
  it("inline single-select: one button per option plus a web link", () => {
    const blocks = renderCard(question(false, 3), "en") as Block[];
    const bs = buttons(blocks);
    expect(bs.map((b) => b.text.text)).toEqual(["env0", "env1", "env2", "Answer on the web"]);
    expect(decodeActionValue(bs[1]?.value ?? "")).toEqual({
      k: "q",
      id: ID,
      key: "env",
      value: "env1",
    });
    expect(allText(blocks)).toContain("Which env?");
  });

  it("inline multi-select: checkboxes + submit (zh)", () => {
    const blocks = renderCard(question(true, 4), "zh") as Block[];
    const cb = elements(blocks).find((e) => e.type === "checkboxes");
    expect(cb?.action_id).toBe("cap_m_select");
    expect(cb?.options?.map((o) => [o.value, o.text.text])).toEqual([
      ["0", "env0"],
      ["1", "env1"],
      ["2", "env2"],
      ["3", "env3"],
    ]);
    expect(blocks.find((b) => elements([b]).includes(cb as El))?.block_id).toBe(`cap_m_${ID}`);
    const submit = buttons(blocks).find((b) => b.action_id === "cap_m_submit");
    expect(submit?.text.text).toBe("提交");
    expect(decodeActionValue(submit?.value ?? "")).toEqual({
      k: "m",
      id: ID,
      key: "env",
      options: ["env0", "env1", "env2", "env3"],
    });
    expect(allText(blocks)).toContain("哪个环境？");
  });

  it("not renderable inline (too many options): only a web link", () => {
    const bs = buttons(renderCard(question(false, 6), "en") as Block[]);
    expect(bs.map((b) => [b.text.text, b.url])).toEqual([["Answer on the web", WEB]]);
  });

  it("options too long for a button value fall back to the web link", () => {
    const card = question(false, 2);
    if (card.kind !== "question") throw new Error();
    const f = card.form.fields[0];
    if (f && "enum" in f.schema) f.schema.enum = ["a", "y".repeat(2100)];
    const bs = buttons(renderCard(card, "en") as Block[]);
    expect(bs.map((b) => b.text.text)).toEqual(["Answer on the web"]);
  });

  it("answered: no inputs, answer summary shown", () => {
    const blocks = renderCard(
      question(false, 3, { state: "answered", answerSummary: "env: env1" }),
      "en",
    ) as Block[];
    expect(elements(blocks).filter((e) => e.type !== "button" || !e.url)).toEqual([]);
    expect(allText(blocks)).toContain("Answered");
    expect(allText(blocks)).toContain("env: env1");
  });
});

describe("renderCard: connect and bind", () => {
  it("non-http(s) link targets are shown as plain text, never as a button", () => {
    const blocks = renderCard(
      { kind: "connect", appName: "X", url: "javascript:alert(1)" },
      "en",
    ) as Block[];
    expect(buttons(blocks)).toEqual([]);
    expect(allText(blocks)).toContain("javascript:alert(1)");
    const ok = renderCard(approval({ webUrl: "ftp://x.example/a" }), "en") as Block[];
    expect(buttons(ok).some((b) => b.url !== undefined)).toBe(false);
    expect(buttons(ok).map((b) => b.text.text)).toContain("Deny");
  });

  it("connect: link button", () => {
    const bs = buttons(
      renderCard(
        { kind: "connect", appName: "GitHub", url: "https://cap.example/x" },
        "en",
      ) as Block[],
    );
    expect(bs.map((b) => [b.text.text, b.url])).toEqual([["Connect", "https://cap.example/x"]]);
  });

  it("bind: link button with its text (zh)", () => {
    const blocks = renderCard(
      { kind: "bind", url: "https://cap.example/bind/cap_bind_x", text: "请先绑定" },
      "zh",
    ) as Block[];
    expect(buttons(blocks).map((b) => [b.text.text, b.url])).toEqual([
      ["绑定账号", "https://cap.example/bind/cap_bind_x"],
    ]);
    expect(allText(blocks)).toContain("请先绑定");
  });
});

describe("renderSend / renderUpdate", () => {
  it("plain text → one message with mrkdwn text and no blocks", () => {
    expect(renderSend({ text: "**hi**" }, "en")).toEqual([{ text: "*hi*" }]);
    expect(renderSend({ text: "as is. " }, "en")).toEqual([{ text: "as is. " }]);
  });

  it("oversize text is split into several messages; each within Slack's 4000-character text limit", () => {
    expect(TEXT_LIMIT).toBe(4000);
    const para = `${"word ".repeat(150).trim()}\n\n`;
    const posts = renderSend({ text: para.repeat(20) }, "en");
    expect(posts.length).toBeGreaterThan(1);
    for (const p of posts) expect(p.text.length).toBeLessThanOrEqual(TEXT_LIMIT);
  });

  it("cards go on the last message with the text as a section; fallback text set", () => {
    const posts = renderSend(
      {
        text: "Please link first",
        cards: [{ kind: "bind", url: "https://cap.example/b", text: "Please link first" }],
      },
      "en",
    );
    expect(posts).toHaveLength(1);
    const p = posts[0];
    expect(p?.text).toBe("Please link first");
    expect(Array.isArray(p?.blocks)).toBe(true);
  });

  it("card fallback text (no message text) is escaped", () => {
    const [p] = renderSend(
      { text: "", cards: [approval({ title: "<!channel> deploy & go" })] },
      "en",
    );
    expect(p?.text).not.toContain("<!");
    expect(p?.text).toContain("&lt;!channel&gt; deploy &amp; go");
  });

  it("text duplicated by the card title is not repeated as its own section", () => {
    const [p] = renderSend({ text: "Post an announcement", cards: [approval()] }, "en");
    const occurrences = JSON.stringify(p?.blocks).split("Post an announcement").length - 1;
    expect(occurrences).toBe(1);
  });

  it("long text with a card: earlier chunks are plain messages, the card rides on the last", () => {
    const posts = renderSend(
      {
        text: "a ".repeat(5000),
        cards: [{ kind: "connect", appName: "X", url: "https://x.example" }],
      },
      "en",
    );
    expect(posts.length).toBeGreaterThan(1);
    expect(posts.slice(0, -1).every((p) => p.blocks === undefined)).toBe(true);
    expect(posts.at(-1)?.blocks).toBeDefined();
  });

  it("update that does not fit one message throws a non-retryable too_large ChannelSendError", () => {
    expect(renderUpdate({ text: "ok" }, "en")).toEqual({ text: "ok" });
    try {
      renderUpdate({ text: "x".repeat(TEXT_LIMIT + 1) }, "en");
      expect.unreachable();
    } catch (e) {
      expect(e).toMatchObject({ name: "ChannelSendError", retryable: false, reason: "too_large" });
    }
  });
});

describe("tables", () => {
  type Table = { type: "table"; rows: Record<string, unknown>[][]; column_settings: unknown[] };
  const tablesOf = (p: { blocks?: Record<string, unknown>[] }) =>
    (p.blocks ?? []).filter((b) => b.type === "table") as Table[];
  const ATTEMPTS = [
    "**实际情况**",
    "| 尝试 | 结果 |",
    "|---|---|",
    "| 列出会话（第 1 次） | 报错：`Could not obtain an access token: the app's authorization server is unavailable` |",
    "| 列出会话（第 2 次） | 报错：`The user has not connected Slack`（提示已弹出连接卡片） |",
    "| 读取刚才那个私信频道 D0BBPQXM55F | 同样报错：`The user has not connected Slack` |",
  ].join("\n");

  it("the reported reply: the text before it in a section, then a native table block", () => {
    const posts = renderSend({ text: ATTEMPTS }, "zh");
    expect(posts).toHaveLength(1);
    const p = posts[0] as (typeof posts)[number];
    expect(p.blocks?.map((b) => b.type)).toEqual(["section", "table"]);
    expect(p.blocks?.[0]).toEqual({
      type: "section",
      text: { type: "mrkdwn", text: "*实际情况*" },
    });
    const [t] = tablesOf(p);
    expect(t?.rows).toHaveLength(4);
    expect(t?.column_settings).toEqual([{ is_wrapped: true }, { is_wrapped: true }]);
    expect(t?.rows[0]?.[0]).toEqual({
      type: "rich_text",
      elements: [
        {
          type: "rich_text_section",
          elements: [{ type: "text", text: "尝试", style: { bold: true } }],
        },
      ],
    });
    expect(t?.rows[1]?.[0]).toEqual({ type: "raw_text", text: "列出会话（第 1 次）" });
    expect(t?.rows[2]?.[1]).toEqual({
      type: "rich_text",
      elements: [
        {
          type: "rich_text_section",
          elements: [
            { type: "text", text: "报错：" },
            { type: "text", text: "The user has not connected Slack", style: { code: true } },
            { type: "text", text: "（提示已弹出连接卡片）" },
          ],
        },
      ],
    });
    // The notification text and the text-only fallback show the table as a list.
    expect(p.text).toBe(
      [
        "*实际情况*",
        "",
        "• *列出会话（第 1 次）* — 报错：`Could not obtain an access token: the app's authorization server is unavailable`",
        "• *列出会话（第 2 次）* — 报错：`The user has not connected Slack`（提示已弹出连接卡片）",
        "• *读取刚才那个私信频道 D0BBPQXM55F* — 同样报错：`The user has not connected Slack`",
      ].join("\n"),
    );
    expect(p.fallback).toEqual([{ text: p.text }]);
  });

  it("inline formatting in cells: bold, italic, strike, links (http only); mentions stay literal", () => {
    const md = [
      "| a | b |",
      "|---|---|",
      "| ***x*** ~~y~~ _z_ | [**doc**](https://d.example/?a=1&b=2) <https://e.example> [js](javascript:x) |",
      "| <!channel> <@U1> & | |",
    ].join("\n");
    const [t] = tablesOf(renderSend({ text: md }, "en")[0] as never);
    expect(t?.rows[1]?.[0]).toEqual({
      type: "rich_text",
      elements: [
        {
          type: "rich_text_section",
          elements: [
            { type: "text", text: "x", style: { bold: true, italic: true } },
            { type: "text", text: " " },
            { type: "text", text: "y", style: { strike: true } },
            { type: "text", text: " " },
            { type: "text", text: "z", style: { italic: true } },
          ],
        },
      ],
    });
    expect(t?.rows[1]?.[1]).toEqual({
      type: "rich_text",
      elements: [
        {
          type: "rich_text_section",
          elements: [
            { type: "link", url: "https://d.example/?a=1&b=2", text: "doc", style: { bold: true } },
            { type: "text", text: " " },
            { type: "link", url: "https://e.example", text: "https://e.example" },
            { type: "text", text: " [js](javascript:x)" },
          ],
        },
      ],
    });
    // Rich text is literal: no escaping, and no way to mention anyone.
    expect(t?.rows[2]?.[0]).toEqual({ type: "raw_text", text: "<!channel> <@U1> &" });
    expect(t?.rows[2]?.[1]).toEqual({ type: "raw_text", text: "\u00a0" });
  });

  it("one table per message: text between tables leads the next table; text after is its own post", () => {
    const md = "intro\n\n| a |\n|---|\n| 1 |\n\nbetween\n| b |\n|---|\n| 2 |\n\n以上是结果。";
    const posts = renderSend({ text: md }, "zh");
    expect(posts.map((p) => p.blocks?.map((b) => b.type) ?? "text")).toEqual([
      ["section", "table"],
      ["section", "table"],
      "text",
    ]);
    expect(posts[1]?.blocks?.[0]).toEqual({
      type: "section",
      text: { type: "mrkdwn", text: "between" },
    });
    expect(posts[2]).toEqual({ text: "以上是结果。" });
  });

  it("a table first: no section; a card after a table goes in a post of its own", () => {
    const posts = renderSend(
      {
        text: "| a |\n|---|\n| 1 |",
        cards: [{ kind: "connect", appName: "X", url: "https://x.example" }],
      },
      "en",
    );
    expect(posts.map((p) => p.blocks?.map((b) => b.type))).toEqual([
      ["table"],
      ["section", "actions"],
    ]);
  });

  it("over 100 rows: several tables in several posts, each with the header", () => {
    const rows = Array.from({ length: 150 }, (_, i) => `| r${i} | v |`).join("\n");
    const posts = renderSend({ text: `| k | v |\n|---|---|\n${rows}` }, "en");
    expect(posts).toHaveLength(2);
    const [a, b] = posts.map((p) => tablesOf(p)[0]);
    expect(a?.rows).toHaveLength(100);
    expect(b?.rows).toHaveLength(52);
    expect(b?.rows[0]).toEqual(a?.rows[0]);
    expect(b?.rows[1]?.[0]).toEqual({ type: "raw_text", text: "r99" });
    for (const p of posts) expect(p.text.length).toBeLessThanOrEqual(TEXT_LIMIT);
  });

  it("over 10,000 characters: split by rows within the limit, never mid-row", () => {
    const rows = Array.from({ length: 30 }, (_, i) => `| r${i} | ${"x".repeat(900)} |`).join("\n");
    const posts = renderSend({ text: `| k | v |\n|---|---|\n${rows}` }, "en");
    expect(posts.length).toBeGreaterThan(2);
    let total = 0;
    for (const p of posts) {
      const t = tablesOf(p)[0];
      const chars = JSON.stringify(t?.rows).match(/x+/g)?.join("").length ?? 0;
      expect(chars).toBeLessThanOrEqual(10_000);
      total += (t?.rows.length ?? 0) - 1;
    }
    expect(total).toBe(30);
  });

  it("over 20 columns: no native table, a list in the text", () => {
    const head = Array.from({ length: 21 }, (_, i) => `c${i}`);
    const md = `|${head.join("|")}|\n|${head.map(() => "-").join("|")}|\n|${head.map((h) => `${h}v`).join("|")}|`;
    const posts = renderSend({ text: md }, "en");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.blocks).toBeUndefined();
    expect(posts[0]?.text).toMatch(/^• \*c0v\*\n {3}c1: c1v\n/);
  });

  it("long text before a table: earlier parts are posts of their own, the last leads the table", () => {
    const md = `${"word ".repeat(1000)}\n\n| a |\n|---|\n| 1 |`;
    const posts = renderSend({ text: md }, "en");
    expect(posts.length).toBe(2);
    expect(posts[0]?.blocks).toBeUndefined();
    const sec = posts[1]?.blocks?.[0] as { type: string; text: { text: string } };
    expect(sec.type).toBe("section");
    expect(sec.text.text.length).toBeLessThanOrEqual(SECTION_TEXT_LIMIT);
  });

  it("renderUpdate keeps a message with one table in one post", () => {
    const p = renderUpdate({ text: ATTEMPTS }, "zh");
    expect(p.blocks?.map((b) => b.type)).toEqual(["section", "table"]);
  });

  it("a table in a code fence stays code (no table block)", () => {
    const posts = renderSend({ text: "```\n| a |\n|---|\n| 1 |\n```" }, "en");
    expect(posts).toEqual([{ text: "```\n| a |\n|---|\n| 1 |\n```" }]);
  });
});
