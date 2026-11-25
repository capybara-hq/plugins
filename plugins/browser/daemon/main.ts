// The browser daemon (spec §5): a device service listening on its unix socket. A request
// connection carries one tool request of one conversation and gets one reply; a stream connection
// is one viewer, whose first stream message is the kernel's viewer context. Takeover is decided
// here, for every conversation of the device at once (§9, §10).

import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import {
  encodeServiceMessage,
  parseViewerContext,
  ServiceMessageDecoder,
} from "@capybara-hq/plugin-sdk";
import type { BrowserContext } from "playwright-core";
import {
  ActionError,
  BrowserSession,
  DEFAULT_DOWNLOAD_MAX_BYTES,
  proxyRefuses,
  TAKEN_OVER_MESSAGE,
} from "./actions.js";
import {
  BrowserInstalledError,
  browserProcessId,
  browserRevision,
  chromiumLaunchPlan,
  HEADLESS_SHELL_NOTE,
  killChromium,
  type LaunchPlan,
  launchChromium,
  playwrightDownloadHosts,
  processAlive,
  shippedRevisionNote,
} from "./chromium.js";
import { restoreCookies, saveCookies } from "./cookie-file.js";
import {
  DEFAULT_FRAME_MAX_BYTES,
  DOWNLOAD_BLOCKED_PREFIX,
  MAX_TABS_PER_CONVERSATION,
  NO_CONVERSATION_MESSAGE,
  REPLY_TOO_LARGE_MESSAGE,
  ROLL_CHECK_REQUEST,
  type ToolReply,
  type ToolRequest,
  type ViewerIn,
} from "./protocol.js";
import { SessionFile } from "./session-file.js";
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
  /** How long a conversation idles before its tabs close (default CONVERSATION_IDLE_MS). */
  conversationIdleMs?: number;
  /** Called when the daemon has been idle for its idle period. */
  onIdle?: () => void;
  /** How long a reply waits for the downloads its action started (default 10 s). */
  downloadWaitMs?: number;
  /** How long a navigation may take before it is stopped (default 30 s). */
  navigationTimeoutMs?: number;
  /** Called when Chromium exits without the daemon closing it. */
  onBrowserGone?: () => void;
  /** How long a stop waits for Chromium to close before killing it (default 3 s). */
  browserCloseGraceMs?: number;
  /** Installs and launches Chromium (default: launchChromium); tests make it fail. */
  launch?: (plan: LaunchPlan) => Promise<BrowserContext>;
  /**
   * Called once the first start installed the browser into the provider's install directory and
   * sealed it ({@link BrowserInstalledError}): the process should exit, so the next start (the
   * plugin asks for it) runs the browser read only. Called after the requests waiting on that
   * launch got their `restart` reply, or after {@link SEALED_EXIT_GRACE_MS} when none was waiting.
   */
  onSealed?: () => void;
}

/** How long a daemon that sealed its install with no request waiting stays before it exits. */
export const SEALED_EXIT_GRACE_MS = 2_000;

export interface Daemon {
  /**
   * Resolves once Chromium runs; rejects when its first launch fails. The daemon keeps running
   * then: every request answers the cause and launches Chromium again.
   */
  ready: Promise<void>;
  state: DaemonState;
  close(): Promise<void>;
}

export { TAKEN_OVER_MESSAGE };

/** Names the device's workspace root; the provider sets it for every service (ruling R26). */
export const SERVICE_WORKSPACE_ENV = "CAPYBARA_SERVICE_WORKSPACE";

/**
 * How long a stop waits for Chromium to close (it flushes the profile) before killing it: a stop
 * never hangs on a browser that does not answer.
 */
export const BROWSER_CLOSE_GRACE_MS = 3_000;

/** How often a stop checks whether the closed browser's process is gone. */
const PROCESS_POLL_MS = 10;

/** The most a stop spends writing the cookie file before it closes the browser. */
const COOKIE_SAVE_MS = 500;

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
/** Whether a request body is the kernel's roll check ({@link ROLL_CHECK_REQUEST}). */
function isRollCheck(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { capybara?: unknown }).capybara === JSON.parse(ROLL_CHECK_REQUEST).capybara
  );
}

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
  const sessionFile = new SessionFile(opts.stateDir, clock);
  const saved = sessionFile.read();
  /** The running browser session, once its launch finished (the tab counts read it). */
  let live: BrowserSession | undefined;
  const state = new DaemonState({
    clock,
    ...(opts.idleMs === undefined ? {} : { idleMs: opts.idleMs }),
    ...(opts.conversationIdleMs === undefined
      ? {}
      : { conversationIdleMs: opts.conversationIdleMs }),
    onIdle: () => {
      // an idle stop ends the session for good: nothing to restore at the next start
      sessionFile.forget();
      opts.onIdle?.();
    },
    onConversationIdle: (conversationId) => {
      void live?.closeConversation(conversationId);
    },
  });
  // A daemon restarted moments ago (a network change restarts the service) gets its pending
  // handoffs and parks back: the person's questions are still open in their conversations.
  if (saved !== undefined) sessionFile.restoreState(state, saved);

  const launch = opts.launch ?? launchChromium;
  const closeGraceMs = opts.browserCloseGraceMs ?? BROWSER_CLOSE_GRACE_MS;
  let current: Promise<BrowserSession> | undefined;
  /**
   * The process id of the browser `current` launched, asked right after its launch (stopBrowser
   * kills it); dropped when that browser closes or its launch fails.
   */
  let running:
    | { launch: Promise<BrowserSession>; pid: number | undefined; ctx: BrowserContext }
    | undefined;
  let restored = false;

  /** Resolves with `value`, or undefined once `ms` passed. */
  function within<T>(value: Promise<T>, ms: number): Promise<T | undefined> {
    let timer: unknown;
    return Promise.race([
      value,
      new Promise<undefined>((r) => {
        timer = clock.schedule(() => r(undefined), ms);
      }),
    ]).finally(() => clock.cancel(timer));
  }

  /**
   * The running browser, launched on first use. A failed launch is not kept: the next caller
   * launches again (a download the network refused may be allowed by then).
   */
  function browser(): Promise<BrowserSession> {
    if (current !== undefined) return current;
    if (closing) return Promise.reject(new Error("The browser daemon is stopping."));
    const starting: Promise<BrowserSession> = launch(plan).then(async (ctx) => {
      let pid: number | undefined;
      let failed = false;
      try {
        return await sessionOn(
          ctx,
          (id) => {
            pid = id;
          },
          () => failed,
        );
      } catch (e) {
        // Chromium runs but the session could not be set up: close it (killed after the grace)
        // and fail this launch with the original error; the next caller launches again
        failed = true;
        await closeOrKill(ctx.close(), () => pid);
        throw e;
      }
    });
    current = starting;
    starting.catch(() => {
      if (current === starting) current = undefined;
      live = undefined;
      if (running?.launch === starting) running = undefined;
    });
    return starting;

    /** The session on a launched browser: process id, close watch, tabs restored, saves. */
    async function sessionOn(
      ctx: BrowserContext,
      setPid: (pid: number | undefined) => void,
      failed: () => boolean,
    ): Promise<BrowserSession> {
      // before the process id lookup: a Chromium that exits during it is still reported
      let gone = false;
      ctx.on("close", () => {
        gone = true;
        if (running?.launch === starting) running = undefined;
        if (!closing && !failed()) opts.onBrowserGone?.();
      });
      const pid = await within(browserProcessId(ctx), BROWSER_CLOSE_GRACE_MS);
      setPid(pid);
      if (!gone) running = { launch: starting, pid, ctx };
      const workspace = opts.env[SERVICE_WORKSPACE_ENV];
      const session = new BrowserSession(ctx, {
        proxy: plan.proxy,
        clock,
        usage: state,
        workspace: workspace === undefined || workspace === "" ? undefined : workspace,
        downloadsTmp: plan.downloadsTmp,
        downloadMaxBytes: downloadMaxBytes(opts.env),
        ...(opts.downloadWaitMs === undefined ? {} : { downloadWaitMs: opts.downloadWaitMs }),
        ...(opts.navigationTimeoutMs === undefined
          ? {}
          : { navigationTimeoutMs: opts.navigationTimeoutMs }),
      });
      // a shipped browser of another revision runs: the next tool result says so
      if (plan.shippedDir !== undefined)
        session.note(shippedRevisionNote(plan.shippedDir, browserRevision(plan.build)));
      // macOS on an older capybara-device: the headless shell runs; the next tool result says how
      // to get the full browser
      if (plan.build === "chromium-headless-shell" && opts.browsersPath === undefined)
        session.note(HEADLESS_SHELL_NOTE);
      // A launch that finishes after a stop only gets closed (stopBrowser): no tabs restored and
      // no saves, which would write back the session file an idle stop just forgot.
      if (!closing) await restoreCookies(ctx, opts.stateDir);
      if (!restored && !closing) {
        restored = true;
        if (saved !== undefined) await sessionFile.restoreTabs(session, saved);
      }
      if (!closing) {
        const save = () => sessionFile.save(session, state);
        session.on(save);
        state.onChange(save);
      }
      if (!failed()) live = session;
      return session;
    }
  }

  /**
   * Waits for a closing browser at most the grace, then kills it by its process id (when known)
   * and waits at most one more grace: neither a stop nor a failed launch hangs on Chromium.
   */
  async function closeOrKill(
    closingBrowser: Promise<unknown>,
    pid: () => number | undefined,
  ): Promise<void> {
    const done = closingBrowser.then(
      () => true,
      () => true,
    );
    if ((await within(done, closeGraceMs)) === true) return;
    const id = pid();
    if (id === undefined) return;
    killChromium(id);
    // Playwright sees the process exit and finishes the close; a process that does not die
    // (D state) is left to the service's exit, where Playwright kills its group
    await within(done, closeGraceMs);
  }

  /** The failure reply of a launch that failed, with the download hosts the proxy refuses. */
  async function launchFailure(e: unknown): Promise<ToolReply> {
    // installed and sealed: this process may not run it; the plugin starts the service again
    if (e instanceof BrowserInstalledError)
      return { ok: false, error: "restart", message: e.message, blockedHosts: [] };
    // no read-only place for the browser: no download would help
    if (plan.unavailable !== undefined) return fail(plan.unavailable);
    const cause = e instanceof Error ? e.message.split("\n")[0] : String(e);
    const proxy = plan.proxy;
    const refused =
      proxy === undefined
        ? []
        : (
            await Promise.all(
              playwrightDownloadHosts(opts.env).map(async (h) =>
                (await proxyRefuses(proxy, h, 443)) ? h : undefined,
              ),
            )
          ).filter((h): h is string => h !== undefined);
    if (refused.length > 0)
      return {
        ok: false,
        error: "blocked",
        message: `${DOWNLOAD_BLOCKED_PREFIX}${refused.join(", ")}.`,
        blockedHosts: refused,
      };
    return fail(
      `The browser could not start in the device: ${cause}. The next browser call tries again.`,
    );
  }

  /**
   * Closes Chromium; one that has not closed within the grace is killed, and the stop waits at
   * most one more grace for that. A launch still running after the grace (an install included)
   * is abandoned: it closes in the background when it finishes, and in the service the process
   * exit ends it (an unfinished install has no marker, so the next start installs again).
   */
  async function stopBrowser(): Promise<void> {
    const starting = current;
    if (starting === undefined) return;
    // read before the close: the browser's close event drops `running`
    const r = running?.launch === starting ? running : undefined;
    const pid = r?.pid;
    // first, and outside the close grace: the service's SIGKILL can land in the middle of
    // Chromium's own write
    if (r !== undefined) await within(saveCookies(r.ctx, opts.stateDir), COOKIE_SAVE_MS);
    await closeOrKill(
      starting.then(
        async (session) => {
          await session.close();
          // Playwright may report the close before the process is done flushing the profile
          // (cookies): a restart on the same profile must not start before the process is gone
          if (pid !== undefined) await processGone(pid);
        },
        () => undefined,
      ),
      () => pid,
    );
  }

  /** Resolves once no process has the id (polled: the process is Playwright's child, not ours to await). */
  async function processGone(pid: number): Promise<void> {
    while (processAlive(pid)) await new Promise<void>((r) => clock.schedule(r, PROCESS_POLL_MS));
  }

  const ready = browser().then(() => undefined);
  ready.catch((e: unknown) => {
    // the start installed and sealed the browser: exit once the requests waiting on it answered
    // (each restart reply ends the process as well), or soon when none was waiting
    if (e instanceof BrowserInstalledError)
      clock.schedule(() => opts.onSealed?.(), SEALED_EXIT_GRACE_MS);
  });

  /**
   * Handoff bookkeeping from the plugin server, for the request's conversation: not agent input,
   * so allowed during a takeover. Never opens a tab.
   */
  async function handoffOp(
    req: Extract<ToolRequest, { op: "handoff_notice" | "handoff_clear" }>,
  ): Promise<ToolReply> {
    if (typeof req.callId !== "string" || req.callId === "")
      return fail("The handoff needs a callId.");
    const conv = req.conversationId;
    if (req.op === "handoff_notice") {
      if (typeof req.message !== "string") return fail("The handoff notice needs a message.");
      state.noticeHandoff(conv, req.rootConversationId, req.callId, req.message);
    } else {
      state.clearHandoff(conv, req.callId);
      // the person answered Done: they are finished with the browser, so a takeover they still
      // hold ends here and the snapshot the plugin asks for next is not refused
      if (req.handback === true) state.handback();
    }
    let session: BrowserSession;
    try {
      session = await browser();
    } catch (e) {
      return launchFailure(e);
    }
    const page = session.currentPage(conv);
    return {
      ok: true,
      ...(page === undefined ? {} : { page: await session.pageInfo(page) }),
      blockedHosts: [],
    };
  }

  /** Whether a request names its conversation and the root of its tree (non-empty strings). */
  const namesConversation = (raw: object): boolean => {
    const r = raw as { conversationId?: unknown; rootConversationId?: unknown };
    return (
      typeof r.conversationId === "string" &&
      r.conversationId !== "" &&
      typeof r.rootConversationId === "string" &&
      r.rootConversationId !== ""
    );
  };

  async function handleRequest(raw: unknown): Promise<ToolReply> {
    if (
      typeof raw !== "object" ||
      raw === null ||
      !REQUEST_OPS.has(String((raw as { op?: unknown }).op))
    ) {
      return fail("Unknown browser request.");
    }
    // no compatibility with a plugin server that does not name the conversation (pre-0.1.0)
    if (!namesConversation(raw)) return fail(NO_CONVERSATION_MESSAGE);
    const req = raw as ToolRequest;
    const conv = req.conversationId;
    // in use from arrival to reply (queued requests and wait included): adopt is refused meanwhile
    state.requestArrived(conv, req.rootConversationId);
    let reply: ToolReply;
    try {
      reply = await conversationRequest(req);
    } catch (e) {
      reply = fail(e instanceof ActionError ? e.message : String(e));
    } finally {
      state.requestFinished(conv);
    }
    // the conversation's own tab count after the request (the result's last line)
    return { ...reply, tabs: { open: live?.countOf(conv) ?? 0, max: MAX_TABS_PER_CONVERSATION } };
  }

  async function conversationRequest(req: ToolRequest): Promise<ToolReply> {
    if (req.op === "handoff_notice" || req.op === "handoff_clear") return handoffOp(req);
    // A browser tool call after a handoff notice means that conversation's run moved on: a run
    // aborted while waiting never sends handoff_clear, so the notice would stay up. Other
    // conversations' handoffs stay.
    state.dropHandoff(req.conversationId);
    if (state.control === "user" && req.op !== "wait") {
      return { ok: false, error: "taken_over", message: TAKEN_OVER_MESSAGE, blockedHosts: [] };
    }
    let session: BrowserSession;
    try {
      session = await browser();
    } catch (e) {
      return launchFailure(e);
    }
    const reply = await session.run(req, { takenOver: () => state.control === "user" });
    if (reply.ok) {
      const since = state.takeHandbackNote(req.conversationId);
      if (since !== undefined) reply.userControlledSince = since;
    }
    return reply;
  }

  const sockets = new Set<Socket>();

  function onConnection(sock: Socket): void {
    sockets.add(sock);
    const decoder = new ServiceMessageDecoder();
    let kind: "request" | "stream" | undefined;
    /** A stream's viewer context (its first stream message, written by the kernel). */
    let context: { conversationId: string; rootConversationId: string } | undefined;
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
        else if (first?.kind === "stream") kind = "stream";
        else sock.destroy();
        return;
      }
      if (kind === "stream" && context === undefined) {
        // the kernel writes the viewer context as the first stream message; anything else (an
        // older kernel, a panel's own message) closes the stream, and a later message of that
        // shape is never read as context
        const ctx = parseViewerContext(raw);
        if (ctx === null) {
          sock.destroy();
          return;
        }
        context = {
          conversationId: ctx.conversationId,
          rootConversationId: ctx.rootConversationId,
        };
        const viewerContext = context;
        opened = true;
        state.viewerOpened();
        browser().then(
          (session) => {
            if (sock.destroyed) return;
            viewer = new ViewerSession({
              browser: session,
              state,
              conversationId: viewerContext.conversationId,
              rootConversationId: viewerContext.rootConversationId,
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
                sendFrame: (frame) => {
                  if (sock.destroyed) return true;
                  // the frame cap keeps it far below the service message limit
                  return sock.write(encodeServiceMessage(frame));
                },
                whenDrained: () => new Promise((r) => sock.once("drain", () => r())),
              },
            });
            // messages that arrived while Chromium was starting were queued on the chain
          },
          () => sock.destroy(),
        );
        return;
      }
      if (kind === "request") {
        if (handled) return;
        handled = true;
        const body = parse(raw);
        // the kernel's roll check: answered from the control state alone (no browser start, no
        // activity), busy while a restart would lose what the person is doing
        if (isRollCheck(body)) {
          const reason =
            state.control === "user"
              ? "the person holds control of the browser"
              : state.handoffs().length > 0
                ? "a handoff to the person is pending"
                : undefined;
          write(sock, reason === undefined ? { busy: false } : { busy: true, reason });
          sock.end();
          return;
        }
        state.requestStarted();
        handleRequest(body)
          .catch((e): ToolReply => fail(e instanceof ActionError ? e.message : String(e)))
          .then((reply) => {
            write(sock, reply, () => write(sock, fail(REPLY_TOO_LARGE_MESSAGE), () => undefined));
            sock.end();
            // a restart reply: this process exits once the reply is out
            if (!reply.ok && reply.error === "restart") sock.once("close", () => opts.onSealed?.());
          })
          .catch(() => sock.destroy())
          .finally(() => state.requestEnded());
        return;
      }
      const msg = parse(raw) as ViewerIn | undefined;
      if (msg === undefined || typeof msg !== "object" || typeof msg.t !== "string") return;
      // the browser this stream opened with; a failed launch leaves no viewer (input is dropped)
      viewerChain = viewerChain
        .then(() => current)
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
      await stopBrowser();
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
