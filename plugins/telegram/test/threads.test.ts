import { describe, expect, it } from "vitest";
import { type Kv, threadStore } from "../src/threads.js";

function memoryKv() {
  const data = new Map<string, string>();
  const ttls = new Map<string, number>();
  const kv: Kv = {
    async get(key) {
      return data.get(key) ?? null;
    },
    async set(key, value, opts) {
      data.set(key, value);
      ttls.set(key, opts.ttlSeconds);
    },
  } as Kv;
  return { kv, data, ttls };
}

describe("threadStore", () => {
  it("records sent messages and topics under bot-scoped keys with a 30 day TTL", async () => {
    const { kv, data, ttls } = memoryKv();
    const store = threadStore(kv, "123");
    await store.recordSent("-100", 7, "-100:5");
    await store.recordTopic("-100:5", 99);
    expect(data.get("thread/123/-100:7")).toBe("-100:5");
    expect(data.get("topic/123/-100:5")).toBe("99");
    expect(ttls.get("thread/123/-100:7")).toBe(2_592_000);
    expect(ttls.get("topic/123/-100:5")).toBe(2_592_000);
    expect(await store.threadOfMessage("-100", 7)).toBe("-100:5");
    expect(await store.topicOf("-100:5")).toBe(99);
  });

  it("misses on unknown keys and on another bot's records", async () => {
    const { kv } = memoryKv();
    await threadStore(kv, "123").recordSent("-100", 7, "-100:5");
    const other = threadStore(kv, "456");
    expect(await other.threadOfMessage("-100", 7)).toBeUndefined();
    expect(await other.topicOf("-100:5")).toBeUndefined();
  });

  it("without a kv, lookups miss and writes do nothing", async () => {
    const store = threadStore(undefined, "123");
    await store.recordSent("-100", 7, "t");
    await store.recordTopic("t", 1);
    expect(await store.threadOfMessage("-100", 7)).toBeUndefined();
    expect(await store.topicOf("t")).toBeUndefined();
  });
});
