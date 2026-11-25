import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { probeProxy } from "../../daemon/actions.js";

/** A listener on a free port; `onConnection` decides what happens to each connection. */
async function listener(onConnection: (sock: import("node:net").Socket) => void) {
  const server = createServer(onConnection);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no address");
  return { port: addr.port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe("proxy probe", () => {
  it("a proxy nobody listens on is down", async () => {
    const l = await listener(() => undefined);
    await l.close();
    expect(await probeProxy(`http://127.0.0.1:${l.port}`, "a.test", 443)).toEqual({
      verdict: "proxy_down",
      reason: "",
    });
  });

  it("a proxy that took the connection and then reset it is not down", async () => {
    // a proxy dropping the client when its upstream fails, instead of answering 502
    const l = await listener((sock) => sock.resetAndDestroy());
    try {
      expect(await probeProxy(`http://127.0.0.1:${l.port}`, "a.test", 443)).toEqual({
        verdict: "unknown",
        reason: "",
      });
    } finally {
      await l.close();
    }
  });
});
