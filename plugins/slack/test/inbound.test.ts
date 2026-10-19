import { describe, expect, it } from "vitest";
import { eventToInbound, stripBotMention } from "../src/inbound.js";

const BOT = "UBOT";
const body = (event: Record<string, unknown>, teamId = "T1") => ({
  type: "event_callback",
  team_id: teamId,
  event,
});
const dm = (extra: Record<string, unknown> = {}) => ({
  type: "message",
  channel_type: "im",
  channel: "D1",
  user: "U1",
  text: "hello &amp; &lt;bye&gt;",
  ts: "1700.000100",
  ...extra,
});

describe("stripBotMention", () => {
  it("removes the bot mention (with or without label) and tidies whitespace", () => {
    expect(stripBotMention("<@UBOT> hi", BOT)).toBe("hi");
    expect(stripBotMention("hey <@UBOT|capybara>  there", BOT)).toBe("hey there");
    expect(stripBotMention("<@UOTHER> hi <@UBOT>", BOT)).toBe("<@UOTHER> hi");
    // 只整理 @ 周围的空白，用户的缩进与换行保留
    expect(stripBotMention("<@UBOT>\n```\n  indented  code\n```\n\nnext", BOT)).toBe(
      "```\n  indented  code\n```\n\nnext",
    );
    expect(stripBotMention("a  b <@UBOT>\n  c", BOT)).toBe("a  b c");
  });
});

describe("eventToInbound", () => {
  it("DM message → message event (unescaped text, channel:ts ids, tenant = team)", () => {
    expect(eventToInbound(body(dm({ team: "T1" })), BOT)).toEqual({
      kind: "message",
      userId: "U1",
      profile: undefined,
      event: {
        type: "message",
        messageId: "D1:1700.000100",
        target: { chatId: "D1", chatType: "dm" },
        sender: { externalId: "U1", tenantId: "T1" },
        text: "hello & <bye>",
        mentionsBot: false,
      },
    });
  });

  it("sender tenant prefers user_team (shared channels), then team, then the envelope team", () => {
    const r1 = eventToInbound(body(dm({ team: "T1", user_team: "TEXT" })), BOT);
    expect(r1?.kind === "message" && r1.event.sender.tenantId).toBe("TEXT");
    const r2 = eventToInbound(body(dm(), "T9"), BOT);
    expect(r2?.kind === "message" && r2.event.sender.tenantId).toBe("T9");
  });

  it("passes user_profile through for the display name / avatar", () => {
    const r = eventToInbound(
      body(
        dm({
          user_profile: { display_name: "Ally", real_name: "Alice", image_72: "https://a/72.png" },
        }),
      ),
      BOT,
    );
    expect(r?.kind === "message" && r.profile).toEqual({
      displayName: "Ally",
      avatarUrl: "https://a/72.png",
    });
  });

  it("app_mention in a channel → group message with mentionsBot; mention stripped; no thread for top level", () => {
    const r = eventToInbound(
      body({ type: "app_mention", channel: "C1", user: "U1", text: "<@UBOT> do it", ts: "1.5" }),
      BOT,
    );
    expect(r?.kind === "message" && r.event).toEqual({
      type: "message",
      messageId: "C1:1.5",
      target: { chatId: "C1", chatType: "group" },
      sender: { externalId: "U1", tenantId: "T1" },
      text: "do it",
      mentionsBot: true,
    });
  });

  it("app_mention inside a thread → threadId is the root message id (channel:thread_ts)", () => {
    const r = eventToInbound(
      body({
        type: "app_mention",
        channel: "C1",
        user: "U1",
        text: "<@UBOT> more",
        ts: "1.9",
        thread_ts: "1.5",
      }),
      BOT,
    );
    expect(r?.kind === "message" && r.event.target).toEqual({
      chatId: "C1",
      chatType: "group",
      threadId: "C1:1.5",
    });
  });

  it("thread reply in a channel without a mention is forwarded with mentionsBot false", () => {
    const r = eventToInbound(
      body({
        type: "message",
        channel_type: "channel",
        channel: "C1",
        user: "U1",
        text: "follow up",
        ts: "1.9",
        thread_ts: "1.5",
      }),
      BOT,
    );
    expect(r?.kind === "message" && r.event).toMatchObject({
      messageId: "C1:1.9",
      target: { chatId: "C1", chatType: "group", threadId: "C1:1.5" },
      mentionsBot: false,
    });
  });

  it("ignores top-level channel chatter and channel messages that mention the bot (app_mention covers them)", () => {
    const chan = { type: "message", channel_type: "channel", channel: "C1", user: "U1", ts: "1.5" };
    expect(eventToInbound(body({ ...chan, text: "chatter" }), BOT)).toBeNull();
    expect(eventToInbound(body({ ...chan, text: "<@UBOT> hi", thread_ts: "1.1" }), BOT)).toBeNull();
  });

  it("ignores edits, deletes, bot messages, the bot's own messages, subtypes and empty text", () => {
    for (const e of [
      dm({ subtype: "message_changed" }),
      dm({ subtype: "message_deleted" }),
      dm({ subtype: "file_share", text: "" }),
      dm({ subtype: "channel_join" }),
      dm({ bot_id: "B1" }),
      dm({ user: BOT }),
      dm({ user: undefined }),
      dm({ text: "" }),
      dm({ text: "<@UBOT>" }),
      { type: "app_mention", channel: "C1", user: "U1", text: "<@UBOT> x", ts: "1", edited: {} },
      { type: "reaction_added", user: "U1" },
    ]) {
      expect(eventToInbound(body(e), BOT), JSON.stringify(e)).toBeNull();
    }
  });

  it("file_share with a caption and thread_broadcast pass through as text", () => {
    const f = eventToInbound(body(dm({ subtype: "file_share", text: "see attached" })), BOT);
    expect(f?.kind === "message" && f.event.text).toBe("see attached");
    const tb = eventToInbound(
      body({
        type: "message",
        subtype: "thread_broadcast",
        channel_type: "channel",
        channel: "C1",
        user: "U1",
        text: "also to channel",
        ts: "1.9",
        thread_ts: "1.5",
      }),
      BOT,
    );
    expect(tb?.kind === "message" && tb.event).toMatchObject({
      text: "also to channel",
      target: { chatId: "C1", chatType: "group", threadId: "C1:1.5" },
    });
  });

  it("team_join / user_change → directory_changed for the team", () => {
    expect(eventToInbound(body({ type: "team_join", user: { id: "U2" } }), BOT)).toEqual({
      kind: "directory",
      event: { type: "directory_changed", tenantId: "T1" },
    });
    expect(eventToInbound(body({ type: "user_change", user: { id: "U2" } }, "T7"), BOT)).toEqual({
      kind: "directory",
      event: { type: "directory_changed", tenantId: "T7" },
    });
  });

  it("malformed bodies are ignored", () => {
    expect(eventToInbound(null, BOT)).toBeNull();
    expect(eventToInbound({ event: "x" }, BOT)).toBeNull();
    expect(
      eventToInbound(body({ type: "message", channel_type: "im", user: "U1", text: "x" }), BOT),
    ).toBeNull();
  });
});
