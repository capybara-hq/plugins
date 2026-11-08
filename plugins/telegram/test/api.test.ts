import { type FakeTelegramServer, startFakeTelegram } from "@capybara-hq/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TelegramApiError, telegramApi } from "../src/api.js";

let fake: FakeTelegramServer;
beforeEach(async () => {
  fake = await startFakeTelegram();
});
afterEach(async () => {
  await fake.close();
});

const caught = async (p: Promise<unknown>): Promise<TelegramApiError> => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(TelegramApiError);
    return e as TelegramApiError;
  }
  throw new Error("expected a rejection");
};

/** Every way an error could be printed: message, JSON, cause. */
const printed = (e: TelegramApiError) =>
  `${String(e)} ${JSON.stringify(e)} ${String(e.cause ?? "")} ${e.stack ?? ""}`;

describe("telegramApi", () => {
  it("returns the result of a successful call", async () => {
    const api = telegramApi({ apiUrl: fake.apiUrl, token: fake.bot.token });
    const me = await api.call<{ id: number; username: string }>("getMe");
    expect(me).toMatchObject({ id: fake.bot.id, username: fake.bot.username });
  });

  it("POSTs the params as JSON", async () => {
    const api = telegramApi({ apiUrl: fake.apiUrl, token: fake.bot.token });
    await api.call("sendMessage", { chat_id: 42, text: "hi" });
    expect(fake.messages[0]).toMatchObject({ chatId: 42, text: "hi" });
  });

  it("a 401 throws with the method, code and description, never the token", async () => {
    const token = "999:not-a-known-token";
    const api = telegramApi({ apiUrl: fake.apiUrl, token });
    const e = await caught(api.call("getMe"));
    expect(e).toMatchObject({ method: "getMe", status: 401, errorCode: 401, network: false });
    expect(e.message).toBe("Telegram getMe failed: 401 Unauthorized");
    expect(printed(e)).not.toContain(token);
  });

  it("a 429 carries retryAfterSec", async () => {
    fake.failNext("sendMessage", {
      status: 429,
      description: "Too Many Requests: retry after 3",
      retryAfter: 3,
    });
    const api = telegramApi({ apiUrl: fake.apiUrl, token: fake.bot.token });
    const e = await caught(api.call("sendMessage", { chat_id: 1, text: "x" }));
    expect(e).toMatchObject({ status: 429, errorCode: 429, retryAfterSec: 3, network: false });
    expect(e.message).toBe("Telegram sendMessage failed: 429 Too Many Requests: retry after 3");
  });

  it("a migrated group carries migrateToChatId", async () => {
    fake.failNext("sendMessage", {
      status: 400,
      description: "Bad Request: group chat was upgraded to a supergroup chat",
      migrateToChatId: -1001234,
    });
    const api = telegramApi({ apiUrl: fake.apiUrl, token: fake.bot.token });
    const e = await caught(api.call("sendMessage", { chat_id: -5, text: "x" }));
    expect(e).toMatchObject({ errorCode: 400, migrateToChatId: -1001234 });
  });

  it("a refused connection throws a network error without the token or a cause", async () => {
    const { apiUrl } = fake;
    const token = fake.bot.token;
    await fake.close();
    const api = telegramApi({ apiUrl, token });
    const e = await caught(api.call("getMe"));
    expect(e).toMatchObject({ method: "getMe", network: true });
    expect(e.message).toBe("Telegram getMe failed: network error");
    expect(e.cause).toBeUndefined();
    expect(printed(e)).not.toContain(token);
    fake = await startFakeTelegram(); // afterEach closes it
  });

  it("a request over timeoutMs throws a timeout network error", async () => {
    fake.delay("getMe", 2000);
    const api = telegramApi({ apiUrl: fake.apiUrl, token: fake.bot.token, timeoutMs: 100 });
    const e = await caught(api.call("getMe"));
    expect(e).toMatchObject({ network: true });
    expect(e.message).toBe("Telegram getMe failed: timeout");
    expect(printed(e)).not.toContain(fake.bot.token);
    fake.delay("getMe", 0);
  });

  it("an aborted caller signal rejects with the signal's reason", async () => {
    fake.delay("getMe", 2000);
    const api = telegramApi({ apiUrl: fake.apiUrl, token: fake.bot.token });
    const ac = new AbortController();
    const p = api.call("getMe", undefined, ac.signal);
    ac.abort(new Error("stopped"));
    await expect(p).rejects.toThrow("stopped");
    fake.delay("getMe", 0);
  });
});
