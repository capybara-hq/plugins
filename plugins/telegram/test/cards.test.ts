import type { ChannelCard } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { cardTokenStore } from "../src/actions.js";
import { renderCards } from "../src/cards.js";
import type { Kv } from "../src/threads.js";

const memoryKv = () => {
  const data = new Map<string, string>();
  const kv = {
    get: async (key: string) => data.get(key) ?? null,
    set: async (key: string, value: string) => {
      data.set(key, value);
    },
  } as Kv;
  return { kv, data };
};

const approval = (
  patch: Partial<Extract<ChannelCard, { kind: "approval" }>> = {},
): ChannelCard => ({
  kind: "approval",
  id: "ap1",
  title: "Run <b>deploy</b>",
  toolName: "deploy",
  agentName: "Bot <i>X</i>",
  inputPreview: "{}",
  scopes: ["once", "session", "always"],
  expiresAt: "2026-11-09T00:00:00Z",
  state: "pending",
  webUrl: "https://cap.example/c/1",
  ...patch,
});
const question = (
  patch: { multiSelect?: boolean; allowOther?: boolean; options?: string[] } = {},
): ChannelCard => ({
  kind: "question",
  id: "q1",
  state: "pending",
  webUrl: "https://cap.example/c/2",
  form: {
    title: "Pick one",
    fields: [
      {
        key: "env",
        label: "Env",
        schema: { type: "string", enum: patch.options ?? ["dev", "prod"] },
        ...(patch.multiSelect && { multiSelect: true }),
        ...(patch.allowOther && { allowOther: true }),
      },
    ],
  },
});

const setup = () => {
  const m = memoryKv();
  return { ...m, tokens: cardTokenStore(m.kv, "999") };
};
const buttons = (p: { replyMarkup?: { inline_keyboard: unknown[][] } }) =>
  (p.replyMarkup?.inline_keyboard ?? []).flat() as {
    text: string;
    callback_data?: string;
    url?: string;
  }[];

describe("renderCards", () => {
  it("pending approval: one callback button per scope, deny and a web link", async () => {
    const { tokens, data } = setup();
    const [p] = await renderCards([approval()], "en", tokens);
    const b = buttons(p as never);
    expect(b.map((x) => x.text)).toEqual([
      "Approve once",
      "Approve for session",
      "Always approve",
      "Deny",
      "Open on web",
    ]);
    for (const x of b.slice(0, 4)) {
      expect(x.callback_data).toMatch(/^cb:[A-Za-z0-9_-]{16}$/);
      expect(Buffer.byteLength(x.callback_data ?? "")).toBeLessThanOrEqual(64);
    }
    expect(b[4]?.url).toBe("https://cap.example/c/1");
    const stored = [...data.values()].map((v) => JSON.parse(v));
    expect(stored).toContainEqual({
      cardKind: "approval",
      cardId: "ap1",
      action: "approve",
      scope: "session",
    });
    expect(stored).toContainEqual({ cardKind: "approval", cardId: "ap1", action: "deny" });
  });

  it("zh labels, and only the offered scopes", async () => {
    const [p] = await renderCards([approval({ scopes: ["once"] })], "zh", setup().tokens);
    expect(buttons(p as never).map((x) => x.text)).toEqual(["批准一次", "拒绝", "在网页上查看"]);
  });

  it("decided approval: state line plus a web link only", async () => {
    const [p] = await renderCards([approval({ state: "approved" })], "en", setup().tokens);
    expect(buttons(p as never).map((x) => x.text)).toEqual(["Open on web"]);
    expect(p?.html).toContain("Approved");
  });

  it("escapes model-controlled names and drops the link line", async () => {
    const [p] = await renderCards([approval()], "en", setup().tokens);
    expect(p?.html).not.toContain("<b>deploy");
    expect(p?.html).toContain("&lt;b&gt;deploy&lt;/b&gt;");
    expect(p?.html).toContain("&lt;i&gt;X&lt;/i&gt;");
    expect(p?.html).not.toContain("cap.example");
  });

  it("single-select question: one button per option and a web link", async () => {
    const { tokens, data } = setup();
    const [p] = await renderCards([question()], "en", tokens);
    const b = buttons(p as never);
    expect(b.map((x) => x.text)).toEqual(["dev", "prod", "Open on web"]);
    expect(b[0]?.callback_data).toMatch(/^cb:/);
    expect([...data.values()].map((v) => JSON.parse(v))).toContainEqual({
      cardKind: "question",
      cardId: "q1",
      action: "answer",
      answer: { env: "prod" },
    });
  });

  it("multi-select, allowOther and over-long questions give a URL button only", async () => {
    for (const c of [
      question({ multiSelect: true }),
      question({ allowOther: true }),
      question({ options: ["a", "b", "c", "d", "e", "f"] }),
    ]) {
      const { tokens, data } = setup();
      const [p] = await renderCards([c], "en", tokens);
      const b = buttons(p as never);
      expect(b).toEqual([{ text: "Open on web", url: "https://cap.example/c/2" }]);
      expect(data.size).toBe(0);
    }
  });

  it("answered question has no option buttons", async () => {
    const c = { ...question(), state: "answered" } as ChannelCard;
    const [p] = await renderCards([c], "en", setup().tokens);
    expect(buttons(p as never).map((x) => x.text)).toEqual(["Open on web"]);
  });

  it("connect and bind cards are a URL button", async () => {
    const [c, b] = await renderCards(
      [
        { kind: "connect", appName: "Jira <x>", url: "https://x.example/auth?a=1&b=2" },
        { kind: "bind", url: "https://cap.example/bind", text: "Link your <account>" },
      ],
      "en",
      setup().tokens,
    );
    expect(buttons(c as never)).toEqual([
      { text: "Connect", url: "https://x.example/auth?a=1&b=2" },
    ]);
    expect(c?.html).toContain("Jira &lt;x&gt;");
    expect(c?.html).not.toContain("x.example");
    expect(buttons(b as never)).toEqual([
      { text: "Link account", url: "https://cap.example/bind" },
    ]);
    expect(b?.html).toContain("&lt;account&gt;");
    expect(b?.html).not.toContain("cap.example");
  });

  it("a non-http(s) url gets no button but the card still renders", async () => {
    const [p] = await renderCards(
      [approval({ state: "approved", webUrl: "javascript:alert(1)" })],
      "en",
      setup().tokens,
    );
    expect(p?.replyMarkup).toBeUndefined();
    expect(p?.html).toContain("Approved");
    expect(p?.html).not.toContain("javascript");
    const [b] = await renderCards(
      [{ kind: "bind", url: "tg://user?id=1", text: "Link" }],
      "en",
      setup().tokens,
    );
    expect(b?.replyMarkup).toBeUndefined();
  });

  it("without a kv only URL buttons are rendered", async () => {
    const tokens = cardTokenStore(undefined, "999");
    const [a, q] = await renderCards([approval(), question()], "en", tokens);
    expect(buttons(a as never)).toEqual([{ text: "Open on web", url: "https://cap.example/c/1" }]);
    expect(buttons(q as never)).toEqual([{ text: "Open on web", url: "https://cap.example/c/2" }]);
  });
});
