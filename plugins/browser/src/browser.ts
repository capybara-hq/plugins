// The plugin server's side of a browser tool call (browser use spec §7, §9): the owner check, the
// service start, one request to the daemon, the refused hosts reported to the kernel, and the
// reply turned into a tool result or an actionable ToolError.
import {
  type DeviceAccessCtx,
  type DeviceServiceSpec,
  type ToolCallContext,
  ToolError,
  type ToolResult,
} from "@capybara-hq/plugin-sdk";
import {
  DOWNLOAD_BLOCKED_PREFIX,
  type ToolErrorCode,
  type ToolOp,
  type ToolReply,
} from "../daemon/protocol.js";
import { NOT_OWNER_MESSAGE, TAKEN_OVER_MESSAGE } from "./messages.js";

export { NOT_OWNER_MESSAGE, TAKEN_OVER_MESSAGE };

/** A service start (ensureService) that failed for a reason the kernel gave no text for. */
export const START_FAILED_MESSAGE =
  "The browser could not start in the device; retry, and ask the user to check the device if it keeps failing.";

/** The service name, declared in `permissions.deviceAccess.services`. */
export const SERVICE = "browser";

/** What a tool handler needs: the kernel's device access and the daemon's service spec. */
export interface BrowserDeps {
  deviceAccess: Pick<DeviceAccessCtx, "ensureService" | "request" | "reportBlockedHosts">;
  /** The daemon's service spec (its files are read once per extension instance). */
  serviceSpec: () => Promise<DeviceServiceSpec>;
  /** Where the cause of an unrecognised failure goes (never to the model). */
  log?: { warn(msg: string, meta?: Record<string, unknown>): void };
}

/**
 * What the model is told when the daemon still restarts after a fresh browser install (its start
 * and request kept racing the old process's exit).
 */
export const RESTARTING_MESSAGE =
  "The browser was just installed in the device and its service is restarting; call the tool again.";

/** How many times one tool call starts the service again after a fresh browser install. */
export const RESTART_ATTEMPTS = 3;

/**
 * How long one tool call waits, after a `restart` reply, for the old daemon process to exit and
 * a new one to answer (the old one closes Playwright and its socket first).
 */
export const RESTART_WAIT_MS = 30_000;

/** The pauses between the checks of that wait: they grow from the first to the last. */
const RESTART_PAUSE_FIRST_MS = 100;
const RESTART_PAUSE_MAX_MS = 1_000;

/**
 * Abortable pause within one call: resolves after `ms` or when the signal aborts. Extensions may
 * not use setTimeout (plugin-timer rule), so `AbortSignal.timeout` does the timing; both listeners
 * are removed at the end.
 */
const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = AbortSignal.timeout(ms);
    const done = () => {
      signal.removeEventListener("abort", done);
      timer.removeEventListener("abort", done);
      resolve();
    };
    signal.addEventListener("abort", done, { once: true });
    timer.addEventListener("abort", done, { once: true });
  });

/** The longest a daemon request may take, beyond an action's own wait. */
export const REQUEST_TIMEOUT_MS = 90_000;

/**
 * Every browser tool's time limit (`ToolSpec.timeoutMs`, instead of the deployment's
 * `tools.timeoutMs`): any tool may be a conversation's first, which first starts the device and
 * the service (instance resume or create, the service files, a Chromium download of about 200 MB)
 * and then makes one daemon request of up to {@link REQUEST_TIMEOUT_MS}.
 */
export const TOOL_TIMEOUT_MS = 300_000;

/** A successful daemon reply. */
export type OkReply = Extract<ToolReply, { ok: true }>;

/** Refuses a call whose trigger account is not the conversation's owner (spec §3 goal 2). */
export function assertOwner(call: ToolCallContext): void {
  if (call.ownerAccountId === undefined || call.accountId !== call.ownerAccountId)
    throw new ToolError(NOT_OWNER_MESSAGE);
}

/** The kernel's refusal codes (`DeviceAccessError`), matched by shape across SDK copies. */
function deviceAccessCode(e: unknown): string | undefined {
  if (!(e instanceof Error) || e.name !== "DeviceAccessError") return undefined;
  const code = (e as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** Actionable text for a `DeviceAccessError` code; other errors pass through unchanged. */
export function deviceAccessToolError(e: unknown): unknown {
  switch (deviceAccessCode(e)) {
    case "no_device":
      return new ToolError(
        "This conversation has no device; ask the user to pick a device for the conversation first.",
      );
    case "provider_unavailable":
      return new ToolError(
        "The conversation's device is unavailable (its provider is not loaded or not on in this org); ask the user to check the device.",
      );
    case "capability_missing":
      return new ToolError(
        "The conversation's device cannot run the browser (its provider has no device services); ask the user to pick a device on a provider that supports them.",
      );
    case "not_owner":
      return new ToolError(NOT_OWNER_MESSAGE);
    case "service_not_declared":
      return new ToolError(
        "The browser plugin's manifest does not declare its device service; ask an admin to check the installed browser plugin version.",
      );
    default:
      return e;
  }
}

/** Actionable text for a daemon error reply (the daemon's own message plus the next step). */
function daemonToolError(code: ToolErrorCode, message: string): ToolError {
  switch (code) {
    case "taken_over":
      return new ToolError(TAKEN_OVER_MESSAGE);
    case "no_such_ref":
      return new ToolError(`${message} Call browser_snapshot for the current element refs.`);
    case "timeout":
      return new ToolError(
        `${message} Check the page with browser_snapshot, then retry or call browser_wait.`,
      );
    case "unreachable":
      // the daemon's message names the host and what the device's network answered for it
      return new ToolError(`${message} Check the address before retrying.`);
    case "blocked":
      // the browser's own download was refused: allowing it is the only way on
      if (message.startsWith(DOWNLOAD_BLOCKED_PREFIX))
        return new ToolError(
          `${message} Ask the user to allow these hosts so the browser can be installed, then retry.`,
        );
      // the one next step after a refused host, whatever refused it (the daemon's messages give
      // none): the kernel raises the network ask from the reported hosts when the device's own
      // list can take them (and reruns once allowed), and its network note says which
      return new ToolError(
        `${message} The network note says whether the host can be allowed from this conversation; if it is not allowed, use another site.`,
      );
    default:
      return new ToolError(`${message} Check the page with browser_snapshot before retrying.`);
  }
}

/** Parses the daemon's reply; a malformed one is a failure the model can retry. */
function parseReply(bytes: Uint8Array): ToolReply {
  let reply: unknown;
  try {
    reply = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    reply = undefined;
  }
  const r = reply as Partial<ToolReply> | undefined;
  if (typeof r !== "object" || r === null || typeof r.ok !== "boolean")
    throw new ToolError(
      "The browser service answered something unreadable; retry, and ask the user to check the device if it keeps failing.",
    );
  return r as ToolReply;
}

/**
 * What a failed `ensureService` / `request` throws: a DeviceAccessError as its actionable text, a
 * ToolError (the kernel's own, e.g. the command review's refusal) as is, an abort as is, and
 * anything else as a generic retryable error (the cause goes to the log only).
 */
function failure(deps: BrowserDeps, call: ToolCallContext, e: unknown, starting: boolean): unknown {
  const mapped = deviceAccessToolError(e);
  if (mapped !== e) return mapped;
  if (e instanceof ToolError || (e instanceof Error && e.name === "ToolError")) return e;
  if (call.signal.aborted) return e;
  deps.log?.warn(starting ? "browser service start failed" : "browser service call failed", {
    err: e,
  });
  if (starting) return new ToolError(START_FAILED_MESSAGE);
  return new ToolError(
    "The browser service in the device failed; retry, and ask the user to check the device if it keeps failing.",
  );
}

/**
 * One request to the daemon for a tool call: owner check, `ensureService`, `request`, then the
 * refused hosts to `reportBlockedHosts` (on success and failure alike). Resolves the ok reply;
 * a failure reply or a device access refusal throws an actionable ToolError. A `restart` reply
 * (the daemon installed the browser into the provider's install directory and sealed it, then
 * exits: capybara-hq/plugins#209) starts the service again, reviewed like every start, at most
 * {@link RESTART_ATTEMPTS} times, all in this call: while `ensureService` still reports the old
 * process (its start time) no request goes to it, and a request failing while the new one comes
 * up is retried, both with growing pauses for at most {@link RESTART_WAIT_MS}.
 */
export async function runRequest(
  deps: BrowserDeps,
  call: ToolCallContext,
  req: ToolOp,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<OkReply> {
  assertOwner(call);
  let reply: ToolReply;
  // set once the daemon answered `restart`: the start time of the process that is exiting (the
  // next start runs the sealed browser), and when this call stops waiting for that
  let exiting: { startedAt: string | null } | undefined;
  let waitUntil = 0;
  let pauseMs = RESTART_PAUSE_FIRST_MS;
  const waitMore = async () => {
    if (call.signal.aborted || Date.now() + pauseMs > waitUntil) return false;
    await pause(pauseMs, call.signal);
    pauseMs = Math.min(pauseMs * 2, RESTART_PAUSE_MAX_MS);
    return !call.signal.aborted;
  };
  for (let restarts = 0; ; ) {
    let startedAt: string | null;
    try {
      ({ startedAt } = await deps.deviceAccess.ensureService(call, await deps.serviceSpec()));
    } catch (e) {
      throw failure(deps, call, e, true);
    }
    // the old process is still running (it closes its browser first): it would only answer
    // `restart` again or drop the request, so wait for it to go
    if (exiting !== undefined && startedAt !== null && startedAt === exiting.startedAt) {
      if (await waitMore()) continue;
      if (call.signal.aborted) throw failure(deps, call, call.signal.reason, true);
      throw new ToolError(RESTARTING_MESSAGE);
    }
    try {
      const body = new TextEncoder().encode(JSON.stringify(req));
      reply = parseReply(
        await deps.deviceAccess.request(call, { service: SERVICE, body, timeoutMs }),
      );
    } catch (e) {
      // the sealed daemon may still be exiting, or the new one not yet listening
      if (exiting !== undefined && !call.signal.aborted) {
        if (await waitMore()) continue;
        if (!call.signal.aborted) throw new ToolError(RESTARTING_MESSAGE);
      }
      throw failure(deps, call, e, false);
    }
    if (reply.ok || reply.error !== "restart") break;
    if (restarts >= RESTART_ATTEMPTS) throw new ToolError(RESTARTING_MESSAGE);
    restarts++;
    exiting = { startedAt };
    waitUntil = Date.now() + RESTART_WAIT_MS;
    pauseMs = RESTART_PAUSE_FIRST_MS;
  }
  const hosts = Array.isArray(reply.blockedHosts)
    ? reply.blockedHosts.filter((h): h is string => typeof h === "string" && h !== "")
    : [];
  if (hosts.length > 0)
    deps.deviceAccess.reportBlockedHosts(
      call,
      hosts,
      reply.ok && reply.page !== undefined ? { url: reply.page.url } : {},
    );
  if (!reply.ok) throw daemonToolError(reply.error, reply.message);
  return reply;
}

/** The page line every result starts with (after the takeover note, if any). */
function pageLine(page: NonNullable<OkReply["page"]>): string {
  return `Page: ${page.title === "" ? "(no title)" : page.title} - ${page.url} (tab ${page.tabId})`;
}

/**
 * The tool result of an ok reply: the takeover note when the person had control (spec §9), the
 * page line, the daemon's text, and the screenshot as an image block.
 */
export function toResult(reply: OkReply): ToolResult {
  const lines: string[] = [];
  if (reply.userControlledSince !== undefined && reply.page !== undefined)
    lines.push(
      `The user controlled the browser from ${reply.userControlledSince}; now at ${reply.page.url} (${reply.page.title}).`,
    );
  if (reply.page !== undefined) lines.push(pageLine(reply.page));
  if (reply.text !== undefined && reply.text !== "") lines.push(reply.text);
  return {
    content: [
      { type: "text", text: lines.join("\n") },
      ...(reply.image === undefined
        ? []
        : [{ type: "image" as const, mimeType: "image/jpeg", data: reply.image }]),
    ],
  };
}
