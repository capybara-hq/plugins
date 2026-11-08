import { describe, expect, it } from "vitest";
import { updateToInbound } from "../src/inbound.js";
import { type Kv, threadStore } from "../src/threads.js";

const memoryKv = () => {
  const data = new Map<string, string>();
  const kv = {
    get: async (key: string) => data.get(key) ?? null,
    set: async (key: string, value: string) => void data.set(key, value),
  } as Kv;
  return { kv };
};

const BOT = { id: 999, username: "mybot" };
const ann = { id: 42, is_bot: false, first_name: "Ann", last_name: "Lee" };
const group = { id: -100, type: "supergroup" };

const run = (message: Record<string, unknown>, store = threadStore(memoryKv().kv, "999")) =>
  updateToInbound({ update_id: 1, message }, BOT, store);
const privateMsg = (extra: Record<string, unknown> = {}) => ({
  message_id: 10,
  from: ann,
  chat: { id: 42, type: "private" },
  text: "hello",
  ...extra,
});
const groupMsg = (extra: Record<string, unknown> = {}) => ({
  message_id: 11,
  from: ann,
  chat: group,
  text: "@MyBot hi",
  entities: [{ type: "mention", offset: 0, length: 6 }],
  ...extra,
});

describe("updateToInbound", () => {
  it("turns a private text message into a dm event", async () => {
    expect(await run(privateMsg())).toEqual({
      type: "message",
      messageId: "42:10",
      target: { chatId: "42", chatType: "dm" },
      sender: { externalId: "42", tenantId: "global", displayName: "Ann Lee" },
      text: "hello",
      mentionsBot: true,
    });
  });

  it("omits displayName when the sender has no name", async () => {
    const ev = await run(privateMsg({ from: { id: 5, is_bot: false } }));
    expect(ev).toMatchObject({ sender: { externalId: "5", tenantId: "global" } });
    expect(ev && "sender" in ev && "displayName" in ev.sender).toBe(false);
  });

  it("strips a group mention (case-insensitive) and sends no threadId", async () => {
    const ev = await run(groupMsg());
    expect(ev).toMatchObject({
      messageId: "-100:11",
      target: { chatId: "-100", chatType: "group" },
      text: "hi",
      mentionsBot: true,
    });
    expect(ev && "target" in ev && "threadId" in ev.target).toBe(false);
  });

  it("drops group messages without a mention or a reply to the bot", async () => {
    expect(await run(groupMsg({ text: "hi all", entities: [] }))).toBeNull();
    expect(
      await run(
        groupMsg({ text: "@other hi", entities: [{ type: "mention", offset: 0, length: 6 }] }),
      ),
    ).toBeNull();
  });

  it("keeps the leading slash of a command after the mention", async () => {
    const ev = await run(
      groupMsg({
        text: "@mybot /fix 12",
        entities: [
          { type: "mention", offset: 0, length: 6 },
          { type: "bot_command", offset: 7, length: 4 },
        ],
      }),
    );
    expect(ev).toMatchObject({ text: "/fix 12" });
  });

  it("turns /cmd@bot into /cmd, in private and in groups", async () => {
    const entities = [{ type: "bot_command", offset: 0, length: 10 }];
    expect(await run(privateMsg({ text: "/new@mybot", entities }))).toMatchObject({ text: "/new" });
    expect(await run(groupMsg({ text: "/new@MyBot now", entities }))).toMatchObject({
      text: "/new now",
    });
    // addressed to another bot: not ours
    expect(
      await run(
        groupMsg({
          text: "/new@other",
          entities: [{ type: "bot_command", offset: 0, length: 10 }],
        }),
      ),
    ).toBeNull();
  });

  it("handles text_mention of the bot and of others", async () => {
    const ev = await run(
      groupMsg({
        text: "Bot thanks, Bob",
        entities: [
          { type: "text_mention", offset: 0, length: 3, user: { id: 999 } },
          { type: "text_mention", offset: 12, length: 3, user: { id: 7 } },
        ],
      }),
    );
    expect(ev).toMatchObject({ text: "thanks, @Bob" });
  });

  it("keeps mentions of other users and the line structure", async () => {
    const ev = await run(
      groupMsg({
        text: "ask @bob\n  @mybot\n  indented",
        entities: [
          { type: "mention", offset: 4, length: 4 },
          { type: "mention", offset: 11, length: 6 },
        ],
      }),
    );
    expect(ev).toMatchObject({ text: "ask @bob\n\n  indented" });
  });

  it("counts entity offsets in UTF-16 code units", async () => {
    const ev = await run(
      groupMsg({
        text: "😀 @mybot go",
        entities: [{ type: "mention", offset: 3, length: 6 }],
      }),
    );
    expect(ev).toMatchObject({ text: "😀 go" });
  });

  it("uses the caption of media and drops media without one", async () => {
    const photo = { photo: [{ file_id: "x" }] };
    expect(await run(privateMsg({ text: undefined, caption: "look", ...photo }))).toMatchObject({
      text: "look",
    });
    expect(
      await run(
        groupMsg({
          text: undefined,
          caption: "@mybot look",
          caption_entities: [{ type: "mention", offset: 0, length: 6 }],
          ...photo,
        }),
      ),
    ).toMatchObject({ text: "look" });
    expect(await run(privateMsg({ text: undefined, ...photo }))).toBeNull();
  });

  it("drops message_id 0, bot senders, edits, service messages and callbacks", async () => {
    expect(await run(privateMsg({ message_id: 0 }))).toBeNull();
    expect(await run(privateMsg({ from: { ...ann, is_bot: true } }))).toBeNull();
    const store = threadStore(memoryKv().kv, "999");
    expect(await updateToInbound({ edited_message: privateMsg() }, BOT, store)).toBeNull();
    expect(await updateToInbound({ channel_post: privateMsg() }, BOT, store)).toBeNull();
    expect(await updateToInbound({ callback_query: { id: "1" } }, BOT, store)).toBeNull();
    expect(
      await run({ message_id: 3, from: ann, chat: group, migrate_to_chat_id: -200 }),
    ).toBeNull();
    expect(await run({ message_id: 3, from: ann, chat: group, new_chat_title: "x" })).toBeNull();
    expect(await updateToInbound("junk", BOT, store)).toBeNull();
  });

  it("drops channel chats", async () => {
    expect(await run(privateMsg({ chat: { id: -5, type: "channel" } }))).toBeNull();
  });

  it("continues the recorded thread when replying to a bot message", async () => {
    const store = threadStore(memoryKv().kv, "999");
    await store.recordSent("-100", 50, "-100:40");
    const ev = await run(
      groupMsg({
        text: "and then?",
        entities: [],
        reply_to_message: { message_id: 50, from: { id: 999, is_bot: true } },
      }),
      store,
    );
    expect(ev).toMatchObject({ target: { threadId: "-100:40" }, mentionsBot: true });
  });

  it("sends no threadId when replying to an unrecorded bot message", async () => {
    const ev = await run(
      groupMsg({
        text: "and then?",
        entities: [],
        reply_to_message: { message_id: 51, from: { id: 999, is_bot: true } },
      }),
    );
    expect(ev && "target" in ev && "threadId" in ev.target).toBe(false);
  });

  it("uses the root message as threadId when replying to it", async () => {
    const ev = await run(groupMsg({ reply_to_message: { message_id: 40, from: ann } }));
    expect(ev).toMatchObject({ target: { threadId: "-100:40" } });
  });

  it("records the topic of a thread inside a forum topic", async () => {
    const store = threadStore(memoryKv().kv, "999");
    await run(groupMsg({ is_topic_message: true, message_thread_id: 77 }), store);
    expect(await store.topicOf("-100:11")).toBe(77);

    await store.recordSent("-100", 50, "-100:11");
    await run(
      groupMsg({
        message_id: 12,
        text: "more",
        entities: [],
        is_topic_message: true,
        message_thread_id: 77,
        reply_to_message: { message_id: 50, from: { id: 999, is_bot: true } },
      }),
      store,
    );
    expect(await store.topicOf("-100:11")).toBe(77);
  });

  it("does not record a topic outside forum topics", async () => {
    const store = threadStore(memoryKv().kv, "999");
    await run(groupMsg({ message_thread_id: 77 }), store);
    expect(await store.topicOf("-100:11")).toBeUndefined();
  });

  it("gives every event the global sender tenant", async () => {
    for (const m of [privateMsg(), groupMsg()]) {
      expect(await run(m)).toMatchObject({ sender: { tenantId: "global" } });
    }
  });
});
