import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeServiceMessage, ServiceMessageDecoder } from "@capybara-hq/plugin-sdk";
import { type Daemon, type DaemonOptions, startDaemon } from "../../daemon/main.js";
import type { ToolReply, ToolRequest, ViewerIn, ViewerOut } from "../../daemon/protocol.js";

/**
 * One Chromium download shared by every test run on this machine (never the person's own browser
 * or Playwright cache): the daemon installs into it on first use.
 */
export const TEST_BROWSERS = join(tmpdir(), "capybara-playwright-browsers");

const enc = new TextEncoder();
const dec = new TextDecoder();

export interface TestDaemon {
  daemon: Daemon;
  stateDir: string;
  socketPath: string;
  stop(): Promise<void>;
}

/** A daemon on a fresh state directory (or `stateDir`), with the shared browser cache. */
export async function startTestDaemon(
  opts: Partial<DaemonOptions> & { stateDir?: string } = {},
): Promise<TestDaemon> {
  const stateDir = opts.stateDir ?? mkdtempSync(join(tmpdir(), "cbd-"));
  const socketPath = join(stateDir, "sock");
  const daemon = await startDaemon({
    socketPath,
    stateDir,
    env: {},
    browsersPath: TEST_BROWSERS,
    // A stop waits for Chromium to close and flush the profile, however long a loaded machine
    // takes: the daemon's default grace (3 s) kills it, which loses what was not yet written (a
    // cookie, a half-committed Cookies file). Tests that need the kill pass their own grace.
    browserCloseGraceMs: 60_000,
    ...opts,
  });
  await daemon.ready;
  return {
    daemon,
    stateDir,
    socketPath,
    stop: () => daemon.close(),
  };
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

function send(sock: Socket, value: unknown): void {
  sock.write(encodeServiceMessage(enc.encode(JSON.stringify(value))));
}

/** One tool request on its own connection, as the provider makes it. */
export function request(socketPath: string, req: ToolRequest): Promise<ToolReply> {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath);
    const decoder = new ServiceMessageDecoder();
    let reply: ToolReply | undefined;
    sock.on("connect", () => {
      send(sock, { kind: "request" });
      send(sock, req);
    });
    sock.on("data", (chunk: Buffer) => {
      for (const m of decoder.push(chunk)) reply = JSON.parse(dec.decode(m)) as ToolReply;
    });
    sock.on("error", reject);
    sock.on("close", () => {
      if (reply === undefined) reject(new Error("connection closed without a reply"));
      else resolve(reply);
    });
  });
}

export interface TestViewer {
  messages: ViewerOut[];
  send(m: ViewerIn): void;
  /** Resolves with the first message (already received or later) matching `pred`. */
  next<T extends ViewerOut>(pred: (m: ViewerOut) => m is T): Promise<T>;
  next(pred: (m: ViewerOut) => boolean): Promise<ViewerOut>;
  /** Like `next`, but only messages received after this call. */
  after(pred: (m: ViewerOut) => boolean): Promise<ViewerOut>;
  close(): Promise<void>;
  /** Acks every frame automatically (default on). */
  autoAck: boolean;
}

/** A viewer stream on its own connection, as the kernel relay opens it. */
export function openViewer(
  socketPath: string,
  hello: { maxWidth: number; maxHeight: number },
): Promise<TestViewer> {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath);
    const decoder = new ServiceMessageDecoder();
    const messages: ViewerOut[] = [];
    const waiters: {
      from: number;
      pred: (m: ViewerOut) => boolean;
      done: (m: ViewerOut) => void;
    }[] = [];
    const viewer: TestViewer = {
      messages,
      autoAck: true,
      send: (m) => send(sock, m),
      next: ((pred: (m: ViewerOut) => boolean) => waitFrom(0, pred)) as TestViewer["next"],
      after: (pred) => waitFrom(messages.length, pred),
      close: () =>
        new Promise<void>((r) => {
          if (sock.destroyed) r();
          else {
            sock.once("close", () => r());
            sock.end();
          }
        }),
    };
    function waitFrom(from: number, pred: (m: ViewerOut) => boolean): Promise<ViewerOut> {
      const hit = messages.slice(from).find(pred);
      if (hit !== undefined) return Promise.resolve(hit);
      return new Promise((done) => waiters.push({ from, pred, done }));
    }
    sock.on("connect", () => {
      send(sock, { kind: "stream" });
      send(sock, { t: "hello", ...hello });
      resolve(viewer);
    });
    sock.on("data", (chunk: Buffer) => {
      for (const raw of decoder.push(chunk)) {
        const m = JSON.parse(dec.decode(raw)) as ViewerOut;
        messages.push(m);
        if (m.t === "frame" && viewer.autoAck) viewer.send({ t: "frame-ack", seq: m.seq });
        for (const w of [...waiters]) {
          if (messages.length - 1 >= w.from && w.pred(m)) {
            waiters.splice(waiters.indexOf(w), 1);
            w.done(m);
          }
        }
      }
    });
    sock.on("error", reject);
  });
}

export type Route = (req: IncomingMessage, res: ServerResponse) => void;

/** A local HTTP server for fixture pages; `routes` maps a path to an HTML string or a handler. */
export async function startFixtureServer(
  routes: Record<string, string | Route>,
): Promise<{ url: string; server: Server; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const route = routes[path];
    if (route === undefined) {
      res.writeHead(404).end("not found");
    } else if (typeof route === "string") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(route);
    } else {
      route(req, res);
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no address");
  return {
    url: `http://127.0.0.1:${addr.port}`,
    server,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** The pixel size of a JPEG (its first SOF marker). */
export function jpegSize(b64: string): { width: number; height: number } {
  const b = Buffer.from(b64, "base64");
  let i = 2;
  while (i < b.length) {
    const marker = b[i + 1] ?? 0;
    const len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  throw new Error("no SOF marker");
}
