import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ChannelSendError } from "@capybara-hq/plugin-sdk";
import { type FakeTelegramServer, startFakeTelegram } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTelegramChannel } from "../src/channel.js";
import type { Kv } from "../src/threads.js";

/**
 * Tables go out as rich messages (sendRichMessage / editMessageText with rich_message). The core
 * fake Telegram server has no rich methods (sendRichMessage answers 404, an edit without `text`
 * answers "message text is empty"), so it checks the fallback; a small stub here answers the rich
 * methods for the success paths.
 */

interface StubCall {
  method: string;
  params: Record<string, unknown>;
}
type StubAnswer = { status: number; body: Record<string, unknown> };

let stub: Server;
let stubUrl: string;
const stubCalls: StubCall[] = [];
/** Answers queued per method; otherwise every call succeeds with a new message id. */
const queued = new Map<string, StubAnswer[]>();
let nextId = 100;

const failWith = (method: string, status: number, description: string, extra = {}) => {
  queued.set(method, [
    ...(queued.get(method) ?? []),
    { status, body: { ok: false, error_code: status, description, ...extra } },
  ]);
};

beforeAll(async () => {
  stub = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      const method = /\/bot[^/]+\/(\w+)$/.exec(req.url ?? "")?.[1] ?? "";
      const params = JSON.parse(raw || "{}") as Record<string, unknown>;
      stubCalls.push({ method, params });
      const answer = queued.get(method)?.shift() ?? {
        status: 200,
        body: { ok: true, result: { message_id: nextId++ } },
      };
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => stub.close(() => r()));
});

const warnings: string[] = [];
beforeEach(() => {
  stubCalls.length = 0;
  queued.clear();
  warnings.length = 0;
});
const log = { info() {}, warn: (m: string) => void warnings.push(m), error() {} };
const memoryKv = () => {
  const data = new Map<string, string>();
  const kv = {
    get: async (key: string) => data.get(key) ?? null,
    set: async (key: string, value: string) => {
      data.set(key, value);
    },
  } as unknown as Kv;
  return { kv, data };
};
const base = {
  config: { botToken: "111:plain" },
  locale: "en" as const,
  signal: new AbortController().signal,
};
const dm = { chatId: "42", chatType: "dm" as const };
const TABLE = "Results:\n\n| Name | Score |\n|:--|--:|\n| **a** | 1 |";
const methods = () => stubCalls.map((c) => c.method);
const sendErr = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => undefined,
    (x) => x,
  );
  expect(e).toBeInstanceOf(ChannelSendError);
  return e as ChannelSendError;
};

describe("send with a table", () => {
  const make = (kv?: Kv) => createTelegramChannel({ apiUrl: stubUrl, log, ...(kv && { kv }) });

  it("sends one rich message with the table as HTML", async () => {
    const r = await make().send({ ...base, target: dm, message: { text: TABLE } });
    expect(methods()).toEqual(["sendRichMessage"]);
    const p = stubCalls[0]?.params;
    expect(p).toEqual({
      chat_id: "42",
      rich_message: {
        html:
          'Results:<table bordered striped><tr><th align="left">Name</th><th align="right">Score</th></tr>' +
          '<tr><td align="left"><b>a</b></td><td align="right">1</td></tr></table>',
      },
    });
    expect(r.messageId).toBe(`42:${nextId - 1}`);
  });

  it("text without a table and a table with a card stay plain HTML", async () => {
    await make().send({ ...base, target: dm, message: { text: "**no table**" } });
    expect(methods()).toEqual(["sendMessage"]);
    stubCalls.length = 0;
    await make().send({
      ...base,
      target: dm,
      message: {
        text: TABLE,
        cards: [
          {
            kind: "approval",
            id: "ap1",
            title: "Run deploy",
            toolName: "deploy",
            agentName: "Bot",
            inputPreview: "{}",
            scopes: ["once"],
            expiresAt: "2026-11-09T00:00:00Z",
            state: "pending",
            webUrl: "https://cap.example/c/1",
          },
        ],
      },
    });
    expect(methods()).not.toContain("sendRichMessage");
  });

  it("replies in the thread and records the rich message", async () => {
    const { kv, data } = memoryKv();
    await kv.set("topic/111/-100:5", "77", { ttlSeconds: 1 });
    const r = await make(kv).send({
      ...base,
      target: { chatId: "-100", chatType: "group", threadId: "-100:5" },
      message: { text: TABLE },
    });
    expect(stubCalls[0]?.params).toMatchObject({
      reply_parameters: { message_id: 5, allow_sending_without_reply: true },
      message_thread_id: 77,
    });
    expect(data.get(`thread/111/${r.messageId}`)).toBe("-100:5");
  });

  it("falls back to the plain HTML list when Telegram refuses the rich message", async () => {
    failWith("sendRichMessage", 400, "Bad Request: RICH_MESSAGE_HTML_INVALID");
    const r = await make().send({ ...base, target: dm, message: { text: TABLE } });
    expect(methods()).toEqual(["sendRichMessage", "sendMessage"]);
    expect(stubCalls[1]?.params).toMatchObject({ parse_mode: "HTML" });
    expect(String(stubCalls[1]?.params.text)).toContain("• <b>a</b> — 1");
    expect(r.messageId).toBe(`42:${nextId - 1}`);
    expect(warnings.join(" ")).toContain("refused a rich message");
    expect(warnings.join(" ")).not.toContain("plain:");
  });

  it("does not fall back on a flood wait, a blocked bot or a network-level failure", async () => {
    failWith("sendRichMessage", 429, "Too Many Requests: retry after 2", {
      parameters: { retry_after: 2 },
    });
    expect(
      await sendErr(make().send({ ...base, target: dm, message: { text: TABLE } })),
    ).toMatchObject({ retryable: true, retryAfterMs: 2000 });
    failWith("sendRichMessage", 403, "Forbidden: bot was blocked by the user");
    expect(
      await sendErr(make().send({ ...base, target: dm, message: { text: TABLE } })),
    ).toMatchObject({ retryable: false, reason: "target_gone" });
    failWith("sendRichMessage", 502, "Bad Gateway");
    expect(
      await sendErr(make().send({ ...base, target: dm, message: { text: TABLE } })),
    ).toMatchObject({ retryable: true });
    expect(methods()).toEqual(["sendRichMessage", "sendRichMessage", "sendRichMessage"]);
  });

  it("a long reply with a table is one rich message, not split", async () => {
    const text = `${"word ".repeat(1200)}\n\n${TABLE}`;
    await make().send({ ...base, target: dm, message: { text } });
    expect(methods()).toEqual(["sendRichMessage"]);
  });
});

describe("update with a table", () => {
  const make = () => createTelegramChannel({ apiUrl: stubUrl, log });

  it("edits the message into a rich message", async () => {
    await make().update({ ...base, target: dm, messageId: "42:7", message: { text: TABLE } });
    expect(methods()).toEqual(["editMessageText"]);
    expect(stubCalls[0]?.params).toEqual({
      chat_id: "42",
      message_id: 7,
      rich_message: { html: expect.stringContaining("<table bordered striped>") },
    });
  });

  it("resolves on 'message is not modified' without a plain edit", async () => {
    failWith("editMessageText", 400, "Bad Request: message is not modified: same content");
    await make().update({ ...base, target: dm, messageId: "42:7", message: { text: TABLE } });
    expect(methods()).toEqual(["editMessageText"]);
  });

  it("falls back to a plain HTML edit when the rich edit is refused", async () => {
    failWith("editMessageText", 400, "Bad Request: RICH_MESSAGE_TABLE_COLS_TOO_MANY");
    await make().update({ ...base, target: dm, messageId: "42:7", message: { text: TABLE } });
    expect(methods()).toEqual(["editMessageText", "editMessageText"]);
    expect(stubCalls[1]?.params).toMatchObject({ parse_mode: "HTML" });
    expect(stubCalls[1]?.params.rich_message).toBeUndefined();
  });

  it("a long reply with a table fits one rich edit (no too_large)", async () => {
    const text = `${"word ".repeat(1200)}\n\n${TABLE}`;
    await make().update({ ...base, target: dm, messageId: "42:7", message: { text } });
    expect(methods()).toEqual(["editMessageText"]);
  });

  it("a retryable failure of the rich edit is thrown, not hidden by a plain edit", async () => {
    failWith("editMessageText", 500, "Internal Server Error");
    const e = await sendErr(
      make().update({ ...base, target: dm, messageId: "42:7", message: { text: TABLE } }),
    );
    expect(e.retryable).toBe(true);
    expect(methods()).toEqual(["editMessageText"]);
  });
});

describe("against the core fake Telegram server (no rich methods)", () => {
  let tg: FakeTelegramServer;
  beforeAll(async () => {
    tg = await startFakeTelegram({
      bots: [{ token: "111:plain", id: 111, username: "plain_bot" }],
    });
  });
  afterAll(async () => {
    await tg?.close();
  });

  it("a 404 for sendRichMessage falls back to the plain list; the edit falls back too", async () => {
    const channel = createTelegramChannel({ apiUrl: tg.apiUrl, log });
    const r = await channel.send({ ...base, target: dm, message: { text: TABLE } });
    expect(tg.calls.map((c) => c.method)).toEqual(["sendRichMessage", "sendMessage"]);
    expect(tg.messages[0]?.text).toContain("• <b>a</b> — 1");
    await channel.update({
      ...base,
      target: dm,
      messageId: r.messageId,
      message: { text: `${TABLE}\n| b | 2 |` },
    });
    expect(tg.edits[0]?.text).toContain("• <b>b</b> — 2");
  });
});
