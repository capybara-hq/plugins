import {
  DeviceAccessError,
  type DeviceServiceSpec,
  type ToolCallContext,
  ToolError,
  type ToolHandler,
  type ToolResult,
  type ToolSpec,
  validateInputForm,
} from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import type { ToolOp, ToolReply, ToolRequest } from "../daemon/protocol.js";
import type { BrowserDeps } from "../src/browser.js";
import { registerBrowserTools } from "../src/tools.js";
import {
  DEVICE_STOPPED_WHILE_WAITING,
  formatDuration,
  LONG_WAIT_NEEDS_CONDITION,
  WAIT_LOST,
  WATCH_POLL_TIMEOUT_MS,
  WATCHED_TAB_CLOSED,
  watchIdOf,
} from "../src/wait.js";
import type { WatchContext, WatchedInputRequired, Watcher } from "../src/watched-wait-sdk.js";

/**
 * browser_wait's long waits (browser long waits spec §6.1): a wait over 60 s with a condition
 * arms a daemon watch and parks as a watched InputRequired; the watcher polls with `ifRunning`;
 * the resumed call ends the watch and maps what happened.
 */

const SPEC: DeviceServiceSpec = {
  name: "browser",
  runtime: "node",
  entry: "daemon.mjs",
  args: [],
  files: { "daemon.mjs": new Uint8Array([1]) },
};
const PAGE = { url: "https://shop.example/order", title: "Order", tabId: "t1" };
const KEY = "ab".repeat(32);

interface Sent {
  op: ToolOp;
  conversationId: string;
  rootConversationId: string;
  ifRunning: boolean;
  timeoutMs: number;
}

function fake(answer: (req: ToolRequest) => ToolReply | Error) {
  const log: string[] = [];
  const sent: Sent[] = [];
  const deps: BrowserDeps = {
    deviceAccess: {
      async ensureService(_call, spec) {
        log.push("ensure");
        return { name: spec.name, state: "running", startedAt: "s1", stateDir: "/s" };
      },
      async request(_call, req) {
        const body = JSON.parse(new TextDecoder().decode(req.body)) as ToolRequest;
        const { conversationId, rootConversationId, ...op } = body;
        sent.push({
          op: op as ToolOp,
          conversationId,
          rootConversationId,
          ifRunning: req.ifRunning === true,
          timeoutMs: req.timeoutMs,
        });
        log.push(`request:${body.op}${req.ifRunning === true ? ":ifRunning" : ""}`);
        const a = answer(body);
        if (a instanceof Error) throw a;
        return new TextEncoder().encode(JSON.stringify(a));
      },
      reportBlockedHosts() {},
    },
    serviceSpec: async () => SPEC,
  };
  let handler: ToolHandler | undefined;
  let watcher: Watcher | undefined;
  let spec: ToolSpec | undefined;
  registerBrowserTools(
    {
      tools: {
        register(s, h, opts) {
          if (s.name !== "browser_wait") return;
          spec = s;
          handler = h;
          watcher = opts?.watch;
        },
      },
    },
    deps,
  );
  return {
    log,
    sent,
    spec: () => spec as ToolSpec,
    watcher: () => watcher as Watcher,
    run: (input: unknown, c: unknown = call()) => (handler as ToolHandler)(input, c as never),
  };
}

const call = (over: Record<string, unknown> = {}): ToolCallContext =>
  ({
    orgId: "org",
    accountId: "acc",
    ownerAccountId: "acc",
    agentId: "agent",
    conversationId: "conv",
    rootConversationId: "root",
    callId: "call-1",
    idempotencyKey: KEY,
    signal: new AbortController().signal,
    ...over,
  }) as ToolCallContext;

const ok = (extra: Partial<Extract<ToolReply, { ok: true }>> = {}): ToolReply => ({
  ok: true,
  page: PAGE,
  blockedHosts: [],
  ...extra,
});

const textOf = (r: unknown): string =>
  (r as ToolResult).content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

const startedAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

/** A resumed call of a parked wait on `condition`. */
const resumed = (
  outcome: "answered" | "woken" | "expired",
  condition: Record<string, unknown> = { text: "Paid" },
  ago = 3 * 60_000,
) =>
  call({
    resume: {
      state: { watchId: KEY.slice(0, 32), startedAt: startedAgo(ago), condition },
      answer: outcome === "answered" ? { end: "end" } : null,
      outcome,
    },
  });

describe("browser_wait: short waits", () => {
  it("a wait of 60 s stays in the call, with the new conditions too", async () => {
    const f = fake(() => ok());
    await f.run({ urlContains: "/paid", timeoutMs: 60_000 });
    expect(f.log).toEqual(["ensure", "request:wait"]);
    expect(f.sent[0]?.op).toEqual({ op: "wait", urlContains: "/paid", timeoutMs: 60_000 });
  });

  it("two conditions are a ToolError", async () => {
    const f = fake(() => ok());
    await expect(f.run({ text: "a", download: true })).rejects.toThrow(/at most one condition/);
    expect(f.log).toEqual([]);
  });
});

describe("browser_wait: long waits park the run", () => {
  it("arms a watch and returns a watched InputRequired with one end button", async () => {
    const f = fake((r) => (r.op === "watch_start" ? ok({ watch: { state: "pending" } }) : ok()));
    const r = (await f.run({ text: "Paid", timeoutMs: 3_600_000 })) as WatchedInputRequired;
    expect(f.sent[0]).toMatchObject({
      op: {
        op: "watch_start",
        watchId: KEY.slice(0, 32),
        condition: { text: "Paid" },
        remainingMs: 3_600_000,
      },
      conversationId: "conv",
      rootConversationId: "root",
      ifRunning: false,
    });
    expect(r.kind).toBe("input_required");
    expect(r.watch).toEqual({ deadlineMs: 3_600_000 });
    expect(validateInputForm(r.form)).toEqual([]);
    expect(r.form.fields).toHaveLength(1);
    expect(r.form.fields[0]?.choices).toEqual([
      { value: "end", label: { zh: "结束等待", en: "End wait" } },
    ]);
    expect(r.form.title).toEqual({
      zh: "智能体正在等待：页面出现“Paid”",
      en: 'The agent is waiting until the page shows "Paid"',
    });
    expect(r.state).toMatchObject({ watchId: KEY.slice(0, 32), condition: { text: "Paid" } });
  });

  it("a long wait without a condition is a ToolError", async () => {
    const f = fake(() => ok());
    await expect(f.run({ timeoutMs: 120_000 })).rejects.toThrow(
      new ToolError(LONG_WAIT_NEEDS_CONDITION),
    );
    expect(f.log).toEqual([]);
  });

  it("a condition already met at the start returns at once, without parking", async () => {
    const f = fake((r) =>
      r.op === "watch_start"
        ? ok({ watch: { state: "met", at: new Date().toISOString() } })
        : ok({ watch: { state: "met", at: new Date().toISOString() } }),
    );
    const r = await f.run({ text: "Paid", timeoutMs: 120_000 });
    expect(textOf(r)).toMatch(/Waited \d+ s: the text "Paid" appeared\./);
    expect(f.log).toEqual(["ensure", "request:watch_start", "request:watch_end:ifRunning"]);
  });

  it("the watch id is the first 32 hex characters of the idempotency key", () => {
    expect(watchIdOf({ idempotencyKey: KEY })).toBe(KEY.slice(0, 32));
    expect(() => watchIdOf({})).toThrow(ToolError);
  });

  it("the spec allows waits up to 24 h", () => {
    const f = fake(() => ok());
    const props = (f.spec().inputSchema as { properties: Record<string, { maximum?: number }> })
      .properties;
    expect(props.timeoutMs?.maximum).toBe(86_400_000);
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining(["text", "ref", "urlContains", "navigation", "download"]),
    );
  });
});

describe("browser_wait: the watcher", () => {
  const ctx = (state: unknown = { watchId: KEY.slice(0, 32) }): WatchContext =>
    ({ ...call(), state }) as unknown as WatchContext;

  it("polls with ifRunning, from the watch context's conversation, and never ensures", async () => {
    const f = fake(() => ok({ watch: { state: "pending" } }));
    expect(await f.watcher()(ctx())).toBe("pending");
    expect(f.log).toEqual(["request:watch_poll:ifRunning"]);
    expect(f.sent[0]).toMatchObject({
      op: { op: "watch_poll", watchId: KEY.slice(0, 32) },
      conversationId: "conv",
      rootConversationId: "root",
      ifRunning: true,
      timeoutMs: WATCH_POLL_TIMEOUT_MS,
    });
  });

  it("maps met, ended and unknown to settle", async () => {
    for (const state of ["met", "ended", "unknown"] as const) {
      const f = fake(() => ok({ watch: { state } }));
      expect(await f.watcher()(ctx())).toBe("settle");
    }
  });

  it("a stopped device settles; any other failure throws", async () => {
    const stopped = fake(() => new DeviceAccessError("not_running" as never, "not running"));
    expect(await stopped.watcher()(ctx())).toBe("settle");
    const broken = fake(() => new Error("socket closed"));
    await expect(broken.watcher()(ctx())).rejects.toThrow();
  });
});

describe("browser_wait: the resumed call", () => {
  it("met: the result says how long it waited and the download's path", async () => {
    const f = fake(() =>
      ok({ watch: { state: "met", at: new Date().toISOString(), detail: "/w/downloads/a.csv" } }),
    );
    const r = await f.run(
      { download: true, timeoutMs: 600_000 },
      resumed("woken", { download: true }),
    );
    expect(textOf(r)).toContain("Waited 3 min: a download finished (/w/downloads/a.csv).");
    expect(textOf(r)).toContain("Page: Order - https://shop.example/order (tab t1)");
    // never ensureService: a resumed wait starts nothing
    expect(f.log).toEqual(["request:watch_end:ifRunning"]);
  });

  it("a dialog on the watched tab: the result with the dialog line", async () => {
    const f = fake(() => ok({ watch: { state: "ended", reason: "dialog", detail: "Leave?" } }));
    const r = await f.run({ text: "Paid", timeoutMs: 600_000 }, resumed("woken"));
    expect(textOf(r)).toContain('The page opened a dialog while waiting. Dialog: "Leave?".');
  });

  it("tab closed is a ToolError", async () => {
    const f = fake(() => ok({ watch: { state: "ended", reason: "tab_closed" } }));
    await expect(f.run({ text: "Paid", timeoutMs: 600_000 }, resumed("woken"))).rejects.toThrow(
      new ToolError(WATCHED_TAB_CLOSED),
    );
  });

  it("not met: the person ended it, the deadline passed, or the kernel woke it", async () => {
    const pending = () => ok({ watch: { state: "pending" } });
    await expect(
      fake(pending).run({ text: "Paid", timeoutMs: 600_000 }, resumed("answered")),
    ).rejects.toThrow(
      'The user ended the wait before the text "Paid" appeared; ask the user how to continue.',
    );
    await expect(
      fake(pending).run({ text: "Paid", timeoutMs: 600_000 }, resumed("expired")),
    ).rejects.toThrow('The text "Paid" appeared did not happen within 3 min.');
    await expect(
      fake(() => ok({ watch: { state: "ended", reason: "deadline" } })).run(
        { text: "Paid", timeoutMs: 600_000 },
        resumed("answered"),
      ),
    ).rejects.toThrow(/did not happen within 3 min/);
    await expect(
      fake(pending).run({ text: "Paid", timeoutMs: 600_000 }, resumed("woken")),
    ).rejects.toThrow(/The wait was interrupted after 3 min before the text "Paid" appeared/);
  });

  it("a stopped device: the device-stopped ToolError, and no ensureService", async () => {
    const f = fake(() => new DeviceAccessError("not_running" as never, "not running"));
    await expect(f.run({ text: "Paid", timeoutMs: 600_000 }, resumed("woken"))).rejects.toThrow(
      new ToolError(DEVICE_STOPPED_WHILE_WAITING),
    );
    expect(f.log).toEqual(["request:watch_end:ifRunning"]);
  });

  it("an unknown watch: one immediate check with ifRunning; met or lost", async () => {
    const met = fake((r) => (r.op === "watch_end" ? ok({ watch: { state: "unknown" } }) : ok()));
    const r = await met.run({ text: "Paid", timeoutMs: 600_000 }, resumed("woken"));
    expect(textOf(r)).toContain('the text "Paid" appeared');
    expect(met.log).toEqual(["request:watch_end:ifRunning", "request:wait:ifRunning"]);
    expect(met.sent[1]?.op).toMatchObject({ op: "wait", text: "Paid" });
    const lost = fake((r) =>
      r.op === "watch_end"
        ? ok({ watch: { state: "unknown" } })
        : { ok: false, error: "timeout", message: "no", blockedHosts: [] },
    );
    await expect(lost.run({ text: "Paid", timeoutMs: 600_000 }, resumed("woken"))).rejects.toThrow(
      new ToolError(WAIT_LOST),
    );
  });
});

describe("formatDuration", () => {
  it("reads as seconds, minutes and hours", () => {
    expect(formatDuration(45_000)).toBe("45 s");
    expect(formatDuration(185_000)).toBe("3 min 5 s");
    expect(formatDuration(2 * 3_600_000 + 10 * 60_000)).toBe("2 h 10 min");
  });
});
