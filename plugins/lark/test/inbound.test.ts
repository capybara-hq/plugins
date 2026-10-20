import { describe, expect, it } from "vitest";
import { eventToInbound, postToText, stripMentions } from "../src/inbound.js";

const BOT = "ou_bot";
const botMention = { key: "@_user_1", id: { open_id: BOT }, name: "Capybara", tenant_key: "t1" };
const bobMention = { key: "@_user_2", id: { open_id: "ou_bob" }, name: "Bob", tenant_key: "t1" };

function receive(message: Record<string, unknown>, sender: Record<string, unknown> = {}) {
  return {
    schema: "2.0",
    header: {
      event_id: "ev_1",
      event_type: "im.message.receive_v1",
      create_time: "1760000000000",
      token: "tok",
      app_id: "cli_a1b2c3d4e5f60718",
      tenant_key: "t1",
    },
    event: {
      sender: {
        sender_id: { open_id: "ou_alice", union_id: "on_alice" },
        sender_type: "user",
        tenant_key: "t1",
        ...sender,
      },
      message: {
        message_id: "om_1",
        create_time: "1760000000000",
        chat_id: "oc_dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
        ...message,
      },
    },
  };
}

describe("stripMentions", () => {
  it("removes the bot placeholder, keeps others as @name, keeps newlines and indentation", () => {
    const mentions = [botMention, bobMention];
    expect(stripMentions("@_user_1 hi @_user_2", mentions, BOT)).toEqual({
      text: "hi @Bob",
      mentionsBot: true,
    });
    expect(stripMentions("look:\n    code  line\n@_user_1", mentions, BOT).text).toBe(
      "look:\n    code  line",
    );
    expect(stripMentions("a  b @_user_1\n  c", mentions, BOT).text).toBe("a  b\n  c");
    expect(stripMentions("x @_user_1 y", mentions, BOT).text).toBe("x y");
    expect(stripMentions("hi @_user_2", [bobMention], BOT)).toEqual({
      text: "hi @Bob",
      mentionsBot: false,
    });
  });

  it("@_user_1 does not eat @_user_10", () => {
    const m10 = { key: "@_user_10", id: { open_id: "ou_ten" }, name: "Ten" };
    expect(stripMentions("@_user_1 @_user_10", [botMention, m10], BOT).text).toBe("@Ten");
  });
});

describe("postToText", () => {
  it("flattens rich text to plain text with links, code blocks and mentions", () => {
    const content = {
      title: "Deploy",
      content: [
        [
          { tag: "at", user_id: "@_user_1", user_name: "Capybara" },
          { tag: "text", text: " please run " },
          { tag: "a", href: "https://ci.example/run", text: "the job" },
        ],
        [{ tag: "img", image_key: "img_1" }],
        [{ tag: "code_block", language: "BASH", text: "make deploy\n  --prod" }],
        [{ tag: "hr" }],
        [
          { tag: "text", text: "thanks " },
          { tag: "emotion", emoji_type: "SMILE" },
        ],
      ],
    };
    const r = postToText(content, [botMention], BOT);
    expect(r.mentionsBot).toBe(true);
    expect(r.text).toBe(
      "Deploy\nplease run [the job](https://ci.example/run)\n```bash\nmake deploy\n  --prod\n```\n---\nthanks :SMILE:",
    );
  });

  it("accepts the locale-wrapped form", () => {
    const r = postToText(
      { en_us: { title: "", content: [[{ tag: "text", text: "hi" }]] } },
      [],
      BOT,
    );
    expect(r.text).toBe("hi");
  });
});

describe("eventToInbound", () => {
  it("DM text → message event (dm target, sender open_id + tenant_key)", () => {
    expect(eventToInbound(receive({}), BOT)).toEqual({
      kind: "message",
      openId: "ou_alice",
      event: {
        type: "message",
        messageId: "om_1",
        target: { chatId: "oc_dm", chatType: "dm" },
        sender: { externalId: "ou_alice", tenantId: "t1" },
        text: "hello",
        mentionsBot: false,
      },
    });
  });

  it("group @bot top-level → group target without threadId, mention stripped", () => {
    const c = eventToInbound(
      receive({
        chat_id: "oc_g",
        chat_type: "group",
        content: JSON.stringify({ text: "@_user_1 deploy it" }),
        mentions: [botMention],
      }),
      BOT,
    );
    expect(c?.kind === "message" && c.event).toMatchObject({
      target: { chatId: "oc_g", chatType: "group" },
      text: "deploy it",
      mentionsBot: true,
    });
    expect(c?.kind === "message" && "threadId" in c.event.target).toBe(false);
  });

  it("group reply in a thread → threadId is root_id (om_…), never thread_id (omt_…)", () => {
    const c = eventToInbound(
      receive({
        message_id: "om_3",
        root_id: "om_root",
        parent_id: "om_2",
        thread_id: "omt_abc",
        chat_id: "oc_g",
        chat_type: "group",
        content: JSON.stringify({ text: "@_user_1 and now?" }),
        mentions: [botMention],
      }),
      BOT,
    );
    expect(c?.kind === "message" && c.event.target).toEqual({
      chatId: "oc_g",
      chatType: "group",
      threadId: "om_root",
    });
  });

  it("thread reply without @ is forwarded with mentionsBot=false; top-level without @ is ignored", () => {
    const inThread = eventToInbound(
      receive({ root_id: "om_root", chat_id: "oc_g", chat_type: "group" }),
      BOT,
    );
    expect(inThread?.kind === "message" && inThread.event.mentionsBot).toBe(false);
    expect(eventToInbound(receive({ chat_id: "oc_g", chat_type: "group" }), BOT)).toBeNull();
    expect(
      eventToInbound(
        receive({
          chat_id: "oc_g",
          chat_type: "group",
          content: JSON.stringify({ text: "@_user_2 hi" }),
          mentions: [bobMention],
        }),
        BOT,
      ),
    ).toBeNull();
  });

  it("post messages are handled as text", () => {
    const c = eventToInbound(
      receive({
        message_type: "post",
        content: JSON.stringify({ title: "", content: [[{ tag: "text", text: "rich hi" }]] }),
      }),
      BOT,
    );
    expect(c?.kind === "message" && c.event.text).toBe("rich hi");
  });

  it("ignores other types, bots, the bot itself, empty text, unknown chat types", () => {
    const ignored = [
      receive({ message_type: "image", content: JSON.stringify({ image_key: "img" }) }),
      receive({ message_type: "file", content: "{}" }),
      receive({}, { sender_type: "app" }),
      receive({}, { sender_id: { open_id: BOT } }),
      receive({ content: JSON.stringify({ text: "   " }) }),
      receive({ content: JSON.stringify({ text: "@_user_1" }), mentions: [botMention] }),
      receive({ chat_type: "unknown" }),
      receive({ content: "not json" }),
      receive({}, { sender_id: {} }),
      { ...receive({}), header: { ...receive({}).header, event_type: "im.message.recalled_v1" } },
      {
        ...receive({}),
        header: { ...receive({}).header, event_type: "im.message.reaction.created_v1" },
      },
      null,
      {},
    ];
    for (const p of ignored) expect(eventToInbound(p, BOT)).toBeNull();
  });

  it("falls back to the header tenant_key when the sender has none", () => {
    const c = eventToInbound(receive({}, { tenant_key: undefined }), BOT);
    expect(c?.kind === "message" && c.event.sender.tenantId).toBe("t1");
  });

  it("contact user created / updated / deleted → directory_changed for the tenant", () => {
    for (const t of [
      "contact.user.created_v3",
      "contact.user.updated_v3",
      "contact.user.deleted_v3",
    ]) {
      const p = {
        schema: "2.0",
        header: { event_id: "e", event_type: t, tenant_key: "t9", app_id: "cli_x" },
        event: { object: { open_id: "ou_x" } },
      };
      expect(eventToInbound(p, BOT)).toEqual({
        kind: "directory",
        event: { type: "directory_changed", tenantId: "t9" },
      });
    }
  });
});
