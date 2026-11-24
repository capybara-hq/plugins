// The browser daemon (spec §5): a device service listening on its unix socket. A request
// connection carries one tool request and gets one reply; a stream connection is one viewer.
// Takeover is decided here, for every conversation of the device at once (§9, §10).

import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { encodeServiceMessage, ServiceMessageDecoder } from "@capybara-hq/plugin-sdk";
import { ActionError, BrowserSession } from "./actions.js";
import { chromiumLaunchPlan, launchChromium } from "./chromium.js";
import {
  DEFAULT_FRAME_MAX_BYTES,
  type ToolReply,
  type ToolRequest,
  type ViewerIn,
} from "./protocol.js";
import { type Clock, DaemonState, systemClock } from "./state.js";
import { ViewerSession } from "./viewer.js";

export interface DaemonOptions {
  /** The unix socket to listen on (`CAPYBARA_SERVICE_SOCKET`). */
  socketPath: string;
  /** The service state directory (`CAPYBARA_SERVICE_STATE`): profile and browsers live here. */
  stateDir: string;
  /** The process environment (proxy variables, BROWSER_FRAME_MAX_BYTES). */
  env: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  /** Where Chromium is installed; default `<stateDir>/browsers` (tests share one download). */
  browsersPath?: string;
  clock?: Clock;
  idleMs?: number;
  /** Called when the daemon has been idle for its idle period. */
  onIdle?: () => void;
  /** Called when Chromium exits without the daemon closing it. */
  onBrowserGone?: () => void;
}

export interface Daemon {
  /** Resolves once Chromium runs (rejects when it cannot start). */
  ready: Promise<void>;
  state: DaemonState;
  close(): Promise<void>;
}

export const TAKEN_OVER_MESSAGE = "The user is controlling the browser; call wait or handoff.";

const enc = new TextEncoder();
const dec = new TextDecoder();

// capybara:allow-module-state read-only constant (device service process, not the kernel)
const REQUEST_OPS = new Set<string>([
  "navigate",
  "tabs",
  "snapshot",
  "click",
  "hover",
  "type",
  "select",
  "press",
  "scroll",
  "upload",
  "click_at",
  "type_at",
  "wait",
  "screenshot",
]);

/** The per-message cap of viewer frames from the environment, else the default. */
export function frameMaxBytes(env: Record<string, string | undefined>): number {
  const raw = env.BROWSER_FRAME_MAX_BYTES;
  const n = raw === undefined ? Number.NaN : Number(raw);
  return Number.isInteger(n) && n >= 4096 ? Math.min(n, 4 * 1024 * 1024) : DEFAULT_FRAME_MAX_BYTES;
}

function parse(raw: Uint8Array): unknown {
  try {
    return JSON.parse(dec.decode(raw));
  } catch {
    return undefined;
  }
}

function write(sock: Socket, value: unknown): boolean {
  if (sock.destroyed) return false;
  return sock.write(encodeServiceMessage(enc.encode(JSON.stringify(value))));
}

const fail = (message: string): ToolReply => ({
  ok: false,
  error: "failed",
  message,
  blockedHosts: [],
});

export async function startDaemon(opts: DaemonOptions): Promise<Daemon> {
  const clock = opts.clock ?? systemClock;
  const frameCap = frameMaxBytes(opts.env);
  const plan = chromiumLaunchPlan({
    stateDir: opts.stateDir,
    env: opts.env,
    platform: opts.platform ?? process.platform,
    ...(opts.browsersPath === undefined ? {} : { browsersPath: opts.browsersPath }),
  });
  mkdirSync(opts.stateDir, { recursive: true });

  let closing = false;
  const state = new DaemonState({
    clock,
    ...(opts.idleMs === undefined ? {} : { idleMs: opts.idleMs }),
    onIdle: () => opts.onIdle?.(),
  });

  const browser: Promise<BrowserSession> = launchChromium(plan).then((ctx) => {
    ctx.on("close", () => {
      if (!closing) opts.onBrowserGone?.();
    });
    return new BrowserSession(ctx, { proxy: plan.proxy, clock });
  });
  const ready = browser.then(() => undefined);
  ready.catch(() => undefined);

  async function handleRequest(raw: unknown): Promise<ToolReply> {
    if (
      typeof raw !== "object" ||
      raw === null ||
      !REQUEST_OPS.has(String((raw as { op?: unknown }).op))
    ) {
      return fail("Unknown browser request.");
    }
    const req = raw as ToolRequest;
    if (state.control === "user" && req.op !== "wait") {
      return { ok: false, error: "taken_over", message: TAKEN_OVER_MESSAGE, blockedHosts: [] };
    }
    let session: BrowserSession;
    try {
      session = await browser;
    } catch (e) {
      return fail(`The browser could not start: ${e instanceof Error ? e.message : String(e)}`);
    }
    const reply = await session.run(req);
    if (reply.ok) {
      const since = state.takeHandbackNote();
      if (since !== undefined) reply.userControlledSince = since;
    }
    return reply;
  }

  const sockets = new Set<Socket>();

  function onConnection(sock: Socket): void {
    sockets.add(sock);
    const decoder = new ServiceMessageDecoder();
    let kind: "request" | "stream" | undefined;
    let handled = false;
    let viewer: ViewerSession | undefined;
    let viewerChain: Promise<void> = Promise.resolve();

    const end = () => {
      sockets.delete(sock);
      if (viewer !== undefined) {
        const v = viewer;
        viewer = undefined;
        void v.close();
        state.viewerClosed();
      }
    };
    sock.on("close", end);
    sock.on("error", () => sock.destroy());

    const onMessage = (raw: Uint8Array) => {
      if (kind === undefined) {
        const first = parse(raw) as { kind?: unknown } | undefined;
        if (first?.kind === "request") kind = "request";
        else if (first?.kind === "stream") {
          kind = "stream";
          state.viewerOpened();
          browser.then(
            (session) => {
              if (sock.destroyed) return;
              viewer = new ViewerSession({
                browser: session,
                state,
                clock,
                frameMaxBytes: frameCap,
                transport: {
                  send: (m) => write(sock, m),
                  whenDrained: () => new Promise((r) => sock.once("drain", () => r())),
                },
              });
              // messages that arrived while Chromium was starting were queued on the chain
            },
            () => sock.destroy(),
          );
        } else sock.destroy();
        return;
      }
      if (kind === "request") {
        if (handled) return;
        handled = true;
        state.requestStarted();
        handleRequest(parse(raw))
          .catch((e) => fail(e instanceof ActionError ? e.message : String(e)))
          .then((reply) => {
            write(sock, reply);
            sock.end();
          })
          .finally(() => state.requestEnded());
        return;
      }
      const msg = parse(raw) as ViewerIn | undefined;
      if (msg === undefined || typeof msg !== "object" || typeof msg.t !== "string") return;
      viewerChain = viewerChain
        .then(() => browser)
        .then(() => viewer?.handle(msg))
        .catch(() => undefined);
    };

    sock.on("data", (chunk: Buffer) => {
      let msgs: Uint8Array[];
      try {
        msgs = decoder.push(chunk);
      } catch {
        sock.destroy();
        return;
      }
      for (const m of msgs) onMessage(m);
    });
  }

  if (existsSync(opts.socketPath)) unlinkSync(opts.socketPath);
  const server: Server = createServer(onConnection);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  chmodSync(opts.socketPath, 0o600);

  return {
    ready,
    state,
    async close() {
      if (closing) return;
      closing = true;
      state.dispose();
      await new Promise<void>((r) => {
        server.close(() => r());
        for (const s of sockets) s.destroy();
      });
      const session = await browser.catch(() => undefined);
      await session?.close();
      if (existsSync(opts.socketPath)) {
        try {
          unlinkSync(opts.socketPath);
        } catch {
          // already gone
        }
      }
    },
  };
}
