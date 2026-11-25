import { encodeServiceMessage } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  RELAY_FELL_BEHIND,
  RELAY_HARD_CAP_BYTES,
  RELAY_HIGH_WATER_BYTES,
  type RelayTransport,
  relayStream,
} from "../src/services.js";

/**
 * The relay stream's bound on unread messages (src/services.ts, shared with device-e2b): fed
 * through its sink without anybody reading, it pauses a transport that can pause above the high
 * water mark (resuming at half), and closes one that cannot at the hard cap.
 */

const MIB = 1024 * 1024;
const frame = (bytes: number) => encodeServiceMessage(new Uint8Array(bytes));

const transport = (pausable: boolean) => {
  const calls: string[] = [];
  const io: RelayTransport = {
    write: async () => undefined,
    close: () => calls.push("close"),
    ...(pausable && {
      pause: () => calls.push("pause"),
      resume: () => calls.push("resume"),
    }),
  };
  return { io, calls };
};

describe("relay stream backpressure", () => {
  it("pauses a pausable transport above the high water mark and resumes at half", async () => {
    const { io, calls } = transport(true);
    const { sink, stream } = relayStream("tx.svc", io);
    sink.stderr(new TextEncoder().encode("ready\n"));
    const count = RELAY_HIGH_WATER_BYTES / MIB;
    for (let i = 0; i < count; i++) sink.stdout(frame(MIB));
    expect(calls).toEqual([]);
    sink.stdout(frame(MIB));
    expect(calls).toEqual(["pause"]);
    const it = stream.messages[Symbol.asyncIterator]();
    for (let i = 0; i < count / 2; i++) await it.next();
    expect(calls).toEqual(["pause"]);
    await it.next();
    expect(calls).toEqual(["pause", "resume"]);
    stream.close("done");
    expect(await stream.closed).toEqual({ reason: "done" });
  });

  it("closes a stream whose transport cannot pause at the hard cap", async () => {
    const { io, calls } = transport(false);
    const { sink, stream } = relayStream("tx.svc", io);
    sink.stderr(new TextEncoder().encode("ready\n"));
    for (let i = 0; i < RELAY_HARD_CAP_BYTES / MIB - 1; i++) sink.stdout(frame(MIB));
    expect(calls).toEqual([]);
    sink.stdout(frame(MIB));
    expect(calls).toEqual(["close"]);
    expect(await stream.closed).toEqual({ reason: RELAY_FELL_BEHIND });
    // later output is dropped; what was queued can still be read, then the stream ends
    sink.stdout(frame(MIB));
    let read = 0;
    for await (const _ of stream.messages) read++;
    expect(read).toBe(RELAY_HARD_CAP_BYTES / MIB);
  });

  it("never pauses for messages a reader takes as they come", async () => {
    const { io, calls } = transport(true);
    const { sink, stream } = relayStream("tx.svc", io);
    sink.stderr(new TextEncoder().encode("ready\n"));
    const it = stream.messages[Symbol.asyncIterator]();
    for (let i = 0; i < 40; i++) {
      const next = it.next();
      sink.stdout(frame(MIB));
      expect((await next).value?.byteLength).toBe(MIB);
    }
    expect(calls).toEqual([]);
  });
});

describe("relay stream messages iterator", () => {
  it("return() closes the stream", async () => {
    const { io, calls } = transport(true);
    const { sink, stream } = relayStream("tx.svc", io);
    sink.stderr(new TextEncoder().encode("ready\n"));
    sink.stdout(frame(1));
    for await (const _ of stream.messages) break;
    expect(calls).toEqual(["close"]);
    expect(await stream.closed).toEqual({ reason: "the reader stopped reading" });
  });

  it("rejects a second next() while one is waiting", async () => {
    const { io } = transport(true);
    const { sink, stream } = relayStream("tx.svc", io);
    sink.stderr(new TextEncoder().encode("ready\n"));
    const it = stream.messages[Symbol.asyncIterator]();
    const first = it.next();
    await expect(it.next()).rejects.toThrow(/one reader/);
    sink.stdout(frame(3));
    expect((await first).value).toHaveLength(3);
    stream.close("done");
  });
});
