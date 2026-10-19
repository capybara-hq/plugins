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
  inputPreview: '{"text":"Office closed"}',
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

  it("long input previews are truncated to fit a section block", () => {
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
