import { describe, expect, it, vi } from "vitest";
import type { WorkerResponse } from "../ui-src/workers/protocol.js";
import { serve, type WorkerScope } from "../ui-src/workers/serve.js";

function fakeScope() {
  const posted: Array<{ message: WorkerResponse; transfer: Transferable[] }> = [];
  const scope: WorkerScope = {
    onmessage: null,
    postMessage: (message, transfer) =>
      posted.push({ message: message as WorkerResponse, transfer }),
  };
  const send = (data: unknown) => scope.onmessage?.(new MessageEvent("message", { data }));
  return { scope, posted, send };
}

describe("serve", () => {
  it("answers each request with its id, the output and the transfer list", async () => {
    const { scope, posted, send } = fakeScope();
    const buf = new ArrayBuffer(4);
    serve<number, { n: number; buf: ArrayBuffer }>(
      async (n) => ({
        output: { n: n * 2, buf },
        transfer: [buf],
      }),
      scope,
    );
    send({ id: 7, input: 21 });
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      message: { id: 7, ok: true, output: { n: 42, buf } },
      transfer: [buf],
    });
  });

  it("answers ok:false with the error message when the handler throws", async () => {
    const { scope, posted, send } = fakeScope();
    serve<string, never>((s) => {
      throw new Error(`cannot parse ${s}`);
    }, scope);
    send({ id: 1, input: "x" });
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]?.message).toEqual({ id: 1, ok: false, error: "cannot parse x" });
  });

  it("an empty or non-Error throw still yields a readable message", async () => {
    const { scope, posted, send } = fakeScope();
    serve<number, never>(async (n) => {
      throw n === 0 ? new Error("") : "plain";
    }, scope);
    send({ id: 1, input: 0 });
    send({ id: 2, input: 1 });
    await vi.waitFor(() => expect(posted).toHaveLength(2));
    const byId = Object.fromEntries(posted.map((p) => [p.message.id, p.message]));
    expect(byId[1]).toEqual({ id: 1, ok: false, error: "The worker failed" });
    expect(byId[2]).toEqual({ id: 2, ok: false, error: "plain" });
  });
});
