// The browser daemon (spec §5): a device service listening on its unix socket. A request
// connection carries one tool request and gets one reply; a stream connection is one viewer.
// Takeover is decided here, for every conversation of the device at once (§9, §10).

import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { encodeServiceMessage, ServiceMessageDecoder } from "@capybara-hq/plugin-sdk";
import {
  ActionError,
  BrowserSession,
  DEFAULT_DOWNLOAD_MAX_BYTES,
  TAKEN_OVER_MESSAGE,
} from "./actions.js";
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
  /** How long a reply waits for the downloads its action started (default 10 s). */
  downloadWaitMs?: number;
  /** Called when Chromium exits without the daemon closing it. */
  onBrowserGone?: () => void;
}

export interface Daemon {
  /** Resolves once Chromium runs (rejects when it cannot start). */
  ready: Promise<void>;
  state: DaemonState;
  close(): Promise<void>;
}

export { TAKEN_OVER_MESSAGE };

/** Names the device's workspace root; the provider sets it for every service (ruling R26). */
export const SERVICE_WORKSPACE_ENV = "CAPYBARA_SERVICE_WORKSPACE";

const enc = new TextEncoder();
const dec = new TextDecoder();

// capybara:allow-module-state read-only constant (device service process, not the kernel)
const REQUEST_OPS = new Set<string>([
  "handoff_notice",
  "handoff_clear",
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

/** The cap on downloads in progress from BROWSER_DOWNLOAD_MAX_BYTES, else the default. */
export function downloadMaxBytes(env: Record<string, string | undefined>): number {
  const raw = env.BROWSER_DOWNLOAD_MAX_BYTES;
  const n = raw === undefined ? Number.NaN : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_DOWNLOAD_MAX_BYTES;
}

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

/**
 * Writes one message; false when the socket is gone or backed up. A message above the service
 * message limit is not sent (`tooLarge` is called): encodeServiceMessage throws a RangeError for it.
 */
function write(sock: Socket, value: unknown, tooLarge?: () => void): boolean {
  if (sock.destroyed) return false;
  let framed: Uint8Array;
  try {
    framed = encodeServiceMessage(enc.encode(JSON.stringify(value)));
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    tooLarge?.();
    return false;
  }
  return sock.write(framed);
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
    const workspace = opts.env[SERVICE_WORKSPACE_ENV];
    return new BrowserSession(ctx, {
      proxy: plan.proxy,
      clock,
      workspace: workspace === undefined || workspace === "" ? undefined : workspace,
      downloadsTmp: plan.downloadsTmp,
      downloadMaxBytes: downloadMaxBytes(opts.env),
      ...(opts.downloadWaitMs === undefined ? {} : { downloadWaitMs: opts.downloadWaitMs }),
    });
  });
  const ready = browser.then(() => undefined);
  ready.catch(() => undefined);

  /** Handoff bookkeeping from the plugin server: not agent input, so allowed during a takeover. */
  async function handoffOp(
    req: Extract<ToolRequest, { op: "handoff_notice" | "handoff_clear" }>,
  ): Promise<ToolReply> {
    if (typeof req.callId !== "string" || req.callId === "")
      return fail("The handoff needs a callId.");
    if (req.op === "handoff_notice") {
      if (typeof req.message !== "string") return fail("The handoff notice needs a message.");
      state.noticeHandoff(req.callId, req.message);
    } else {
      state.clearHandoff(req.callId);
    }
    let session: BrowserSession;
    try {
      session = await browser;
    } catch (e) {
      return fail(`The browser could not start: ${e instanceof Error ? e.message : String(e)}`);
    }
    return { ok: true, page: await session.pageInfo(await session.activePage()), blockedHosts: [] };
  }

  async function handleRequest(raw: unknown): Promise<ToolReply> {
    if (
      typeof raw !== "object" ||
      raw === null ||
      !REQUEST_OPS.has(String((raw as { op?: unknown }).op))
    ) {
      return fail("Unknown browser request.");
    }
    const req = raw as ToolRequest;
    if (req.op === "handoff_notice" || req.op === "handoff_clear") return handoffOp(req);
    // A browser tool call after a handoff notice means that run moved on: a run aborted while
    // waiting never sends handoff_clear, so the notice would stay up. (Any conversation of the
    // device clears it; they are all the owner's.)
    state.dropHandoff();
    if (state.control === "user" && req.op !== "wait") {
      return { ok: false, error: "taken_over", message: TAKEN_OVER_MESSAGE, blockedHosts: [] };
    }
    let session: BrowserSession;
    try {
      session = await browser;
    } catch (e) {
      return fail(`The browser could not start: ${e instanceof Error ? e.message : String(e)}`);
    }
    const reply = await session.run(req, { takenOver: () => state.control === "user" });
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
    // set when this connection counted itself as a viewer: every open is balanced by one close,
    // also when the socket closes before Chromium is ready and no ViewerSession exists
    let opened = false;
    let viewerChain: Promise<void> = Promise.resolve();

    const end = () => {
      sockets.delete(sock);
      if (viewer !== undefined) {
        const v = viewer;
        viewer = undefined;
        void v.close();
      }
      if (opened) {
        opened = false;
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
          opened = true;
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
                  send: (m) => {
                    // a message above the service limit is dropped, never thrown
                    let dropped = false;
                    const ok = write(sock, m, () => {
                      dropped = true;
                    });
                    return ok || dropped || sock.destroyed;
                  },
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
            write(sock, reply, () =>
              write(
                sock,
                fail("The reply was too large to send; ask for less (a smaller maxBytes)."),
                () => undefined,
              ),
            );
            sock.end();
          })
          .catch(() => sock.destroy())
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
