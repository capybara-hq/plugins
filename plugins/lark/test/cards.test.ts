import type { ChannelCard } from "@capybara-hq/plugin-sdk";
import { isChannelSendError } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { decodeActionValue, MULTI_FIELD, SUBMIT_NAME, VALUE_KEY } from "../src/actions.js";
import {
  CONTENT_BYTES_LIMIT,
  contentBytes,
  type LarkCard,
  renderSend,
  renderUpdate,
  TEXT_LIMIT,
} from "../src/cards.js";

type El = Record<string, unknown>;

/** 卡片里的全部组件（展开 column_set / column / form）。 */
function walk(card: LarkCard): El[] {
  const out: El[] = [];
  const visit = (els: unknown) => {
    for (const e of (els as El[] | undefined) ?? []) {
      out.push(e);
      if (Array.isArray(e.columns)) visit(e.columns);
      if (Array.isArray(e.elements)) visit(e.elements);
    }
  };
  visit((card.body as El).elements);
  return out;
}
const buttons = (card: LarkCard) => walk(card).filter((e) => e.tag === "button");
const label = (b: El) => (b.text as { content: string }).content;
const behavior = (b: El) => (b.behaviors as El[])[0] as El;
const actionOf = (b: El) => {
  const v = behavior(b).value as Record<string, string> | undefined;
  return v ? decodeActionValue(v[VALUE_KEY] as string) : null;
};
const markdown = (card: LarkCard) =>
  walk(card)
    .filter((e) => e.tag === "markdown")
    .map((e) => e.content as string)
    .join("\n");
const AT_TAG = /<\s*at[\s>/]/i;

const approval = (over: Partial<Extract<ChannelCard, { kind: "approval" }>> = {}): ChannelCard => ({
  kind: "approval",
  id: "apr_1",
  title: "Post an announcement",
  toolName: "post_announcement",
  appName: "Fake IM",
  agentName: "Helper",
  inputPreview: '{"text":"Office closed on Friday"}',
  scopes: ["always", "once", "session"],
  expiresAt: "2026-10-20T10:00:00Z",
  state: "pending",
  webUrl: "https://cap.example/c/1",
  ...over,
});

const question = (multi: boolean, options: string[], allowOther = false): ChannelCard => ({
  kind: "question",
  id: "q_1",
  state: "pending",
  webUrl: "https://cap.example/c/1",
  form: {
    title: { zh: "选环境", en: "Pick an environment" },
    fields: [
      {
        key: "env",
        label: { zh: "环境", en: "Environment" },
        schema: { type: "string", enum: options },
        ...(multi && { multiSelect: true }),
        ...(allowOther && { allowOther: true }),
      },
    ],
  },
});

describe("renderSend: text", () => {
  it("one JSON 2.0 shared card with a markdown element and a summary", () => {
    const [card, ...rest] = renderSend({ text: "Hello **world**" }, "en", "d");
    expect(rest).toEqual([]);
    expect(card).toMatchObject({
      schema: "2.0",
      config: { update_multi: true, summary: { content: "Hello **world**" } },
      body: { elements: [{ tag: "markdown", content: "Hello **world**" }] },
    });
    expect(card && "header" in card).toBe(false);
  });

  it("empty text still renders something", () => {
    expect(markdown(renderSend({ text: "  " }, "en", "d")[0] as LarkCard)).toBe("…");
  });

  it("splits long text across several cards, each within limits", () => {
    const text = Array.from(
      { length: 400 },
      (_, i) => `Paragraph ${i}: ${"word ".repeat(10)}`,
    ).join("\n");
    const cards = renderSend({ text }, "en", "d");
    expect(cards.length).toBeGreaterThan(1);
    for (const c of cards) {
      expect(markdown(c).length).toBeLessThanOrEqual(TEXT_LIMIT);
      expect(contentBytes(c)).toBeLessThanOrEqual(CONTENT_BYTES_LIMIT);
    }
  });

  it("worst-case characters still fit the 30 KB request limit", () => {
    const text = '"\\<&😀中'.repeat(4000);
    for (const c of renderSend({ text }, "en", "d")) {
      expect(contentBytes(c)).toBeLessThanOrEqual(CONTENT_BYTES_LIMIT);
    }
  });

  it("model text cannot ping all, also not via the summary or card fields", () => {
    const evil = "<at id=all></at> @all";
    const cards = renderSend(
      {
        text: evil,
        cards: [approval({ title: evil, agentName: evil, inputPreview: evil, toolName: evil })],
      },
      "en",
      "g",
    );
    for (const c of cards) expect(JSON.stringify(c)).not.toMatch(AT_TAG);
  });
});

describe("renderSend: approval card", () => {
  it("en: header, fields, preview, one button per scope (ordered) + deny + web link", () => {
    const [card] = renderSend({ text: "Approve?", cards: [approval()] }, "en", "g");
    if (!card) throw new Error("no card");
    expect(card.header).toMatchObject({
      title: { tag: "plain_text", content: "Approval: Post an announcement" },
      template: "orange",
    });
    const md = markdown(card);
    expect(md).toContain("Approve?");
    expect(md).toContain("Fake IM / post\\_announcement");
    expect(md).toContain("Helper");
    expect(md).toContain('```\n{"text":"Office closed on Friday"}\n```');
    expect(md).toContain("2026-10-20T10:00:00Z");
    const bs = buttons(card);
    expect(bs.map(label)).toEqual([
      "Approve once",
      "Approve for this session",
      "Always approve",
      "Deny",
      "Open on web",
    ]);
    expect(bs.map((b) => b.type)).toEqual(["primary", "default", "default", "danger", "default"]);
    expect(bs.slice(0, 4).map(actionOf)).toEqual([
      { k: "a", chat: "g", id: "apr_1", action: "approve", scope: "once" },
      { k: "a", chat: "g", id: "apr_1", action: "approve", scope: "session" },
      { k: "a", chat: "g", id: "apr_1", action: "approve", scope: "always" },
      { k: "a", chat: "g", id: "apr_1", action: "deny" },
    ]);
    expect(behavior(bs[4] as El)).toEqual({
      type: "open_url",
      default_url: "https://cap.example/c/1",
    });
    expect(card.config).toMatchObject({ summary: { content: "Approve?" } });
  });

  it("zh labels and the DM chat flag", () => {
    const [card] = renderSend({ text: "", cards: [approval({ scopes: ["once"] })] }, "zh", "d");
    if (!card) throw new Error("no card");
    expect(card.header).toMatchObject({ title: { content: "审批：Post an announcement" } });
    expect(buttons(card).map(label)).toEqual(["批准一次", "拒绝", "在网页上打开"]);
    expect(actionOf(buttons(card)[0] as El)).toMatchObject({ chat: "d" });
    expect(card.config).toMatchObject({ summary: { content: "审批：Post an announcement" } });
  });

  it("decided: state shown with who decided, no action buttons, only a details link", () => {
    const [card] = renderSend(
      { text: "", cards: [approval({ state: "approved", decidedBy: "Alice *A*" })] },
      "en",
      "g",
    );
    if (!card) throw new Error("no card");
    expect(card.header).toMatchObject({ template: "green" });
    expect(markdown(card)).toContain("Status: Approved (Alice \\*A\\*)");
    expect(buttons(card).map(label)).toEqual(["Details"]);
    const [denied] = renderSend({ text: "", cards: [approval({ state: "denied" })] }, "zh", "g");
    expect(denied?.header).toMatchObject({ template: "red" });
    expect(markdown(denied as LarkCard)).toContain("状态：已拒绝");
  });

  it("does not repeat a text identical to the card title", () => {
    const [card] = renderSend({ text: "Post an announcement", cards: [approval()] }, "en", "g");
    expect(markdown(card as LarkCard).split("Post an announcement").length - 1).toBe(0);
  });

  it("truncates a huge input preview and keeps fences intact", () => {
    const [card] = renderSend(
      { text: "", cards: [approval({ inputPreview: `${"```".repeat(10)}${"x".repeat(50_000)}` })] },
      "en",
      "g",
    );
    if (!card) throw new Error("no card");
    expect(contentBytes(card)).toBeLessThanOrEqual(CONTENT_BYTES_LIMIT);
    const md = markdown(card);
    expect((md.match(/^```$/gm) ?? []).length).toBe(2);
    expect(md).toContain("…");
  });

  it("an over-long card id falls back to the web link only", () => {
    const [card] = renderSend({ text: "", cards: [approval({ id: "x".repeat(3000) })] }, "en", "g");
    expect(buttons(card as LarkCard).map(label)).toEqual(["Open on web"]);
  });
});

describe("renderSend: question card", () => {
  it("single choice inline: one button per option", () => {
    const [card] = renderSend({ text: "", cards: [question(false, ["dev", "prod"])] }, "en", "d");
    if (!card) throw new Error("no card");
    expect(card.header).toMatchObject({ title: { content: "Question: Pick an environment" } });
    const bs = buttons(card);
    expect(bs.map(label)).toEqual(["dev", "prod", "Answer on the web"]);
    expect(actionOf(bs[1] as El)).toEqual({
      k: "q",
      chat: "d",
      id: "q_1",
      key: "env",
      value: "prod",
    });
  });

  it("multi choice inline: form with a multi-select and a submit button", () => {
    const [card] = renderSend({ text: "", cards: [question(true, ["a", "b", "c"])] }, "zh", "g");
    if (!card) throw new Error("no card");
    const els = walk(card);
    const form = els.find((e) => e.tag === "form");
    expect(form).toBeDefined();
    const select = els.find((e) => e.tag === "multi_select_static");
    expect(select).toMatchObject({
      name: MULTI_FIELD,
      options: [
        { text: { tag: "plain_text", content: "a" }, value: "0" },
        { text: { tag: "plain_text", content: "b" }, value: "1" },
        { text: { tag: "plain_text", content: "c" }, value: "2" },
      ],
    });
    const submit = buttons(card).find((b) => b.name === SUBMIT_NAME);
    expect(submit).toMatchObject({ form_action_type: "submit", text: { content: "提交" } });
    expect(actionOf(submit as El)).toEqual({
      k: "m",
      chat: "g",
      id: "q_1",
      key: "env",
      options: ["a", "b", "c"],
    });
  });

  it("not renderable inline → web link only", () => {
    const [card] = renderSend({ text: "", cards: [question(false, ["a", "b"], true)] }, "en", "d");
    expect(buttons(card as LarkCard).map(label)).toEqual(["Answer on the web"]);
  });

  it("answered: status + summary, details link", () => {
    const c = { ...question(false, ["a"]), state: "answered", answerSummary: "a" } as ChannelCard;
    const [card] = renderSend({ text: "", cards: [c] }, "en", "d");
    expect(markdown(card as LarkCard)).toContain("Status: Answered");
    expect(markdown(card as LarkCard)).toContain("Answer: a");
    expect(buttons(card as LarkCard).map(label)).toEqual(["Details"]);
  });
});

describe("renderSend: connect / bind cards and links", () => {
  it("connect and bind render link buttons", () => {
    const [c1] = renderSend(
      {
        text: "",
        cards: [{ kind: "connect", appName: "GitHub", url: "https://cap.example/connect" }],
      },
      "en",
      "d",
    );
    expect(markdown(c1 as LarkCard)).toContain("**GitHub** needs to be connected.");
    expect(behavior(buttons(c1 as LarkCard)[0] as El)).toEqual({
      type: "open_url",
      default_url: "https://cap.example/connect",
    });
    const [c2] = renderSend(
      {
        text: "Please link your account.",
        cards: [
          { kind: "bind", url: "https://cap.example/bind/x", text: "Please link your account." },
        ],
      },
      "zh",
      "d",
    );
    expect(buttons(c2 as LarkCard).map(label)).toEqual(["绑定账号"]);
    expect(markdown(c2 as LarkCard).split("Please link your account.").length - 1).toBe(1);
  });

  it("only http(s) links become buttons; others are shown as plain text", () => {
    for (const url of ["javascript:alert(1)", "ftp://x.example/a", "lark://open"]) {
      const [c] = renderSend(
        { text: "", cards: [{ kind: "connect", appName: "X", url }] },
        "en",
        "d",
      );
      expect(buttons(c as LarkCard)).toEqual([]);
      expect(markdown(c as LarkCard)).toContain("Connect:");
    }
  });
});

describe("renderUpdate", () => {
  it("returns the single card", () => {
    expect(markdown(renderUpdate({ text: "x" }, "en", "d"))).toBe("x");
  });

  it("text that needs more than one message → non-retryable too_large", () => {
    let err: unknown;
    try {
      renderUpdate({ text: "y".repeat(TEXT_LIMIT * 2) }, "en", "d");
    } catch (e) {
      err = e;
    }
    expect(isChannelSendError(err)).toBe(true);
    expect(err).toMatchObject({ retryable: false, reason: "too_large" });
  });
});
