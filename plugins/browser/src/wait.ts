// browser_wait (browser use spec §9, browser long waits spec §6.1): a wait of 60 s or less runs in
// the call; a longer one needs a condition and parks the run as a watched input wait. The first
// invocation arms a watch in the daemon and returns a watched InputRequired; the watcher polls the
// watch (its heartbeat) through `ifRunning` requests, which never start the service or resume the
// device; the resumed invocation ends the watch and reports what happened.
import { ToolError, type ToolHandler, type ToolResult } from "@capybara-hq/plugin-sdk";
import type { ToolOp, WaitCondition, WatchState } from "../daemon/protocol.js";
import {
  type BrowserDeps,
  deviceAccessErrorCode,
  type OkReply,
  REQUEST_TIMEOUT_MS,
  requestIfRunning,
  runRequest,
  toResult,
} from "./browser.js";
import { WAIT_FORM } from "./i18n.js";
import type {
  WatchContext,
  WatchedCall,
  WatchedInputRequired,
  Watcher,
} from "./watched-wait-sdk.js";

/** The longest wait that runs in the call (the daemon's own cap on `op: "wait"`). */
export const WAIT_INLINE_MAX_MS = 60_000;
/** The longest browser_wait (the kernel bounds a parked one further). */
export const WAIT_MAX_MS = 86_400_000;
/** The default wait. */
export const WAIT_DEFAULT_MS = 10_000;
/** How long one watcher poll may take (the kernel aborts a watcher after 5 s). */
export const WATCH_POLL_TIMEOUT_MS = 4_000;
/** The one look at a condition after the daemon lost its watch (a wait of this long). */
const CHECK_NOW_MS = 500;
/** How long the resumed invocation's `watch_end` may take. */
const WATCH_END_TIMEOUT_MS = 10_000;

/** A long wait without a condition. */
export const LONG_WAIT_NEEDS_CONDITION =
  "A wait longer than 60000 ms needs a condition (text, ref, urlContains, navigation or download); to continue later without one, finish and let the user or a scheduled task start a new run.";
/** The device or the daemon stopped while a long wait was parked. */
export const DEVICE_STOPPED_WHILE_WAITING =
  "The device stopped while waiting (it was suspended or reached its running limit); the page state is gone. Call browser_wait again if still needed.";
/** The watched tab closed. */
export const WATCHED_TAB_CLOSED =
  "The tab being watched was closed; check the tabs with browser_tabs.";
/** The daemon lost the watch and the condition does not hold now. */
export const WAIT_LOST =
  "The browser lost track of the wait; the condition does not hold now. Call browser_wait again if still needed.";

/** What the parked wait keeps for its resume. */
interface WaitState {
  watchId: string;
  startedAt: string;
  condition: WaitCondition;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** The input's conditions (each one that is set). */
export function conditionsOf(i: Record<string, unknown>): WaitCondition[] {
  const out: WaitCondition[] = [];
  const text = str(i.text);
  if (text !== undefined) out.push({ text });
  const ref = str(i.ref);
  if (ref !== undefined) out.push({ ref });
  const urlContains = str(i.urlContains);
  if (urlContains !== undefined) out.push({ urlContains });
  if (i.navigation === true) out.push({ navigation: true });
  if (i.download === true) out.push({ download: true });
  return out;
}

/** The condition as the model reads it in a result. */
export function describeCondition(c: WaitCondition): string {
  if ("text" in c) return `the text ${JSON.stringify(c.text)} appeared`;
  if ("ref" in c) return `element ${c.ref} appeared`;
  if ("urlContains" in c) return `the URL contains ${JSON.stringify(c.urlContains)}`;
  if ("navigation" in c) return "a navigation finished";
  return "a download finished";
}

/** The condition before it happened (the not-met texts). */
function pendingCondition(c: WaitCondition): string {
  if ("text" in c) return `the text ${JSON.stringify(c.text)} appeared`;
  if ("ref" in c) return `element ${c.ref} appeared`;
  if ("urlContains" in c) return `the URL contained ${JSON.stringify(c.urlContains)}`;
  if ("navigation" in c) return "a navigation";
  return "a download finished";
}

/** The localized question title for a condition. */
function formTitle(c: WaitCondition): { zh: string; en: string } {
  const cut = (s: string) => (s.length <= 60 ? s : `${s.slice(0, 59)}…`);
  const p = WAIT_FORM.titlePrefix;
  if ("text" in c)
    return {
      zh: `${p.zh}${WAIT_FORM.text.zh}“${cut(c.text)}”`,
      en: `${p.en}${WAIT_FORM.text.en}"${cut(c.text)}"`,
    };
  if ("ref" in c)
    return { zh: `${p.zh}${WAIT_FORM.ref.zh}${c.ref}`, en: `${p.en}${WAIT_FORM.ref.en}${c.ref}` };
  if ("urlContains" in c)
    return {
      zh: `${p.zh}${WAIT_FORM.urlContains.zh}“${cut(c.urlContains)}”`,
      en: `${p.en}${WAIT_FORM.urlContains.en}"${cut(c.urlContains)}"`,
    };
  const k = "navigation" in c ? WAIT_FORM.navigation : WAIT_FORM.download;
  return { zh: `${p.zh}${k.zh}`, en: `${p.en}${k.en}` };
}

/** A duration as the model reads it: `45 s`, `3 min 5 s`, `2 h 10 min`. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 === 0 ? `${m} min` : `${m} min ${s % 60} s`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`;
}

/** The first 32 hex characters of the call's idempotency key: stable across the call's rounds. */
export function watchIdOf(call: { idempotencyKey?: string | undefined }): string {
  const key = call.idempotencyKey;
  if (typeof key !== "string" || key.length < 32)
    throw new ToolError(
      "browser_wait cannot park this wait: the call has no idempotency key. Retry with a wait of at most 60000 ms.",
    );
  return key.slice(0, 32);
}

/** The watch state of a reply (an unreadable one is `unknown`). */
function watchOf(reply: OkReply): WatchState {
  const w = reply.watch as Partial<WatchState> | undefined;
  const states = ["pending", "met", "ended", "unknown"];
  return typeof w === "object" && w !== null && states.includes(String(w.state))
    ? (w as WatchState)
    : { state: "unknown" };
}

/** The in-call wait (60 s or less): one `op: "wait"` with the condition. */
function inlineWait(i: Record<string, unknown>, timeoutMs: number): ToolOp {
  const c = conditionsOf(i)[0];
  return {
    op: "wait",
    timeoutMs,
    ...(c === undefined ? {} : c),
  } as ToolOp;
}

/** A result: the reply's page, with `line` before the daemon's text. */
function resultWith(reply: OkReply, line: string): ToolResult {
  return toResult({ ...reply, text: [line, reply.text].filter((x) => x).join("\n") });
}

/** The handler of browser_wait. */
export function waitHandler(deps: BrowserDeps): ToolHandler {
  const handler = async (input: unknown, call: WatchedCall): Promise<unknown> => {
    const i = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
    const conditions = conditionsOf(i);
    if (conditions.length > 1)
      throw new ToolError(
        "browser_wait takes at most one condition (text, ref, urlContains, navigation or download); pass one and retry.",
      );
    const asked =
      typeof i.timeoutMs === "number" && Number.isFinite(i.timeoutMs)
        ? i.timeoutMs
        : WAIT_DEFAULT_MS;
    const timeoutMs = Math.max(0, Math.min(WAIT_MAX_MS, Math.floor(asked)));
    // a resumed long wait (its state names the watch)
    const resumed = call.resume?.state as WaitState | undefined;
    if (call.resume !== undefined && resumed?.watchId !== undefined)
      return resume(deps, call, resumed);
    if (timeoutMs <= WAIT_INLINE_MAX_MS) {
      const req = inlineWait(i, timeoutMs);
      return toResult(await runRequest(deps, call as never, req, timeoutMs + REQUEST_TIMEOUT_MS));
    }
    const condition = conditions[0];
    if (condition === undefined) throw new ToolError(LONG_WAIT_NEEDS_CONDITION);
    const watchId = watchIdOf(call);
    const started = await runRequest(deps, call as never, {
      op: "watch_start",
      watchId,
      condition,
      remainingMs: timeoutMs,
    });
    const state: WaitState = { watchId, startedAt: new Date().toISOString(), condition };
    // already decided at the start (the text is on the page): no need to park
    if (watchOf(started).state !== "pending") return resume(deps, call, state);
    const asking: WatchedInputRequired = {
      kind: "input_required",
      form: {
        title: formTitle(condition),
        fields: [
          {
            key: "end",
            label: WAIT_FORM.end,
            schema: { type: "string", enum: ["end"] },
            required: true,
            choices: [{ value: "end", label: WAIT_FORM.endButton }],
          },
        ],
      },
      state,
      watch: { deadlineMs: timeoutMs },
    };
    return asking;
  };
  return handler as unknown as ToolHandler;
}

/** The watcher of browser_wait: one `watch_poll` (the watch's heartbeat), never starting anything. */
export function waitWatcher(deps: BrowserDeps): Watcher {
  return async (ctx: WatchContext) => {
    const state = ctx.state as WaitState | null;
    if (typeof state?.watchId !== "string") return "settle";
    let reply: OkReply;
    try {
      reply = await requestIfRunning(
        deps,
        ctx as never,
        { op: "watch_poll", watchId: state.watchId },
        WATCH_POLL_TIMEOUT_MS,
      );
    } catch (e) {
      // the device or its daemon stopped: the resumed handler finds out (and resumes nothing)
      if (deviceAccessErrorCode(e) === "not_running") return "settle";
      throw e;
    }
    return watchOf(reply).state === "pending" ? "pending" : "settle";
  };
}

/** The resumed invocation: end the watch and say what happened. */
async function resume(deps: BrowserDeps, call: WatchedCall, state: WaitState): Promise<ToolResult> {
  const elapsed = formatDuration(Date.now() - Date.parse(state.startedAt));
  const c = state.condition;
  let reply: OkReply;
  try {
    reply = await requestIfRunning(
      deps,
      call as never,
      { op: "watch_end", watchId: state.watchId },
      WATCH_END_TIMEOUT_MS,
    );
  } catch (e) {
    if (deviceAccessErrorCode(e) === "not_running")
      throw new ToolError(DEVICE_STOPPED_WHILE_WAITING);
    throw e;
  }
  const watch = watchOf(reply);
  if (watch.state === "met") {
    const at = watch.at === undefined ? Date.now() : Date.parse(watch.at);
    const waited = formatDuration(at - Date.parse(state.startedAt));
    const detail = watch.detail === undefined ? "" : ` (${watch.detail})`;
    return resultWith(reply, `Waited ${waited}: ${describeCondition(c)}${detail}.`);
  }
  if (watch.state === "ended" && watch.reason === "dialog")
    return resultWith(
      reply,
      `The page opened a dialog while waiting.${watch.detail === undefined ? "" : ` Dialog: ${JSON.stringify(watch.detail)}.`}`,
    );
  if (watch.state === "ended" && watch.reason === "tab_closed")
    throw new ToolError(WATCHED_TAB_CLOSED);
  if (watch.state === "unknown") {
    // the daemon dropped or lost the watch: one look at the condition now
    if (!("download" in c) && !("navigation" in c)) {
      const now = await requestIfRunning(
        deps,
        call as never,
        { op: "wait", timeoutMs: CHECK_NOW_MS, ...c } as ToolOp,
        CHECK_NOW_MS + REQUEST_TIMEOUT_MS,
      ).catch(() => undefined);
      if (now !== undefined) return resultWith(now, `Waited ${elapsed}: ${describeCondition(c)}.`);
    }
    throw new ToolError(WAIT_LOST);
  }
  // not met: pending, or ended at the device's deadline
  const outcome =
    call.resume?.outcome ??
    (call.resume?.answer !== null && call.resume?.answer !== undefined ? "answered" : "expired");
  if (watch.state === "ended" && watch.reason === "deadline")
    throw new ToolError(
      `${capitalize(pendingCondition(c))} did not happen within ${elapsed}. Check the page with browser_snapshot, then retry or call browser_wait.`,
    );
  if (outcome === "answered")
    throw new ToolError(
      `The user ended the wait before ${pendingCondition(c)}; ask the user how to continue.`,
    );
  if (outcome === "woken")
    throw new ToolError(
      `The wait was interrupted after ${elapsed} before ${pendingCondition(c)} (the browser service could not be checked). Call browser_wait again if still needed.`,
    );
  throw new ToolError(
    `${capitalize(pendingCondition(c))} did not happen within ${elapsed}. Check the page with browser_snapshot, then retry or call browser_wait.`,
  );
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
