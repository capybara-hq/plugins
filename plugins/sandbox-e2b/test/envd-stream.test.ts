import { afterEach, describe, expect, it, vi } from "vitest";
import { envdStart } from "../src/e2b-api.js";

const frame = (flags: number, msg: unknown): Uint8Array => {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const head = Buffer.alloc(5);
  head.writeUInt8(flags, 0);
  head.writeUInt32BE(body.byteLength, 1);
  return Buffer.concat([head, body]);
};

const target = { url: "https://49983-sbx.e2b.app", sandboxId: "sbx", accessToken: "t" };

describe("envdStart", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Under load, aborting fetch's signal sometimes leaves a body that is already being read
  // untouched, so the read went on until the command's output closed (#13). The body here ignores
  // the signal the same way.
  it("an abort ends the stream even when the response body ignores the signal", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(frame(0, { event: { start: { pid: 7 } } }));
            },
          }),
          { status: 200 },
        ),
    );
    const conn = new AbortController();
    const events: unknown[] = [];
    const done = envdStart(
      target,
      "sandbox",
      { cmd: "sleep", args: ["20"] },
      (e) => {
        events.push(e);
        if ("start" in e) conn.abort(new Error("stopped"));
      },
      conn.signal,
    );
    await expect(done).rejects.toThrow("stopped");
    expect(events).toEqual([{ start: { pid: 7 } }]);
  }, 2000);
});
