import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeJinaRequest = {
  method: string;
  /** The raw request target, query included. */
  path: string;
  /** Header names lowercased. */
  headers: Record<string, string>;
  body: string;
};
export type FakeJinaReply = { status: number; body: string; delayMs?: number };
export type FakeJina = {
  url: string;
  requests: FakeJinaRequest[];
  respond(fn: (req: FakeJinaRequest) => FakeJinaReply): void;
  stop(): Promise<void>;
};

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** A local HTTP server standing in for Jina's search and reader APIs. */
export async function startFakeJina(): Promise<FakeJina> {
  const requests: FakeJinaRequest[] = [];
  let handler: (req: FakeJinaRequest) => FakeJinaReply = () => ({ status: 200, body: "{}" });
  const server = createServer(async (req, res) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v !== undefined) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
    }
    const rec: FakeJinaRequest = {
      method: req.method ?? "GET",
      path: req.url ?? "/",
      headers,
      body: await readBody(req),
    };
    requests.push(rec);
    const reply = handler(rec);
    if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
    if (res.destroyed) return;
    res.statusCode = reply.status;
    res.end(reply.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    respond(fn) {
      handler = fn;
    },
    stop() {
      return new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}
