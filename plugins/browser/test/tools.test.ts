import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DeviceAccessError,
  type DeviceServiceSpec,
  type InputRequired,
  type ToolCallContext,
  ToolError,
  type ToolHandler,
  type ToolResult,
  type ToolSpec,
  validateInputForm,
  validateToolSpec,
} from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  DOWNLOAD_BLOCKED_PREFIX,
  REPLY_TOO_LARGE_MESSAGE,
  type ToolReply,
  type ToolRequest,
} from "../daemon/protocol.js";
import {
  type BrowserDeps,
  NOT_OWNER_MESSAGE,
  REQUEST_TIMEOUT_MS,
  RESTART_ATTEMPTS,
  RESTARTING_MESSAGE,
  TAKEN_OVER_MESSAGE,
  TOOL_TIMEOUT_MS,
} from "../src/browser.js";
import { registerHandoffTool } from "../src/handoff.js";
import { serviceSpecLoader } from "../src/service.js";
import { registerBrowserTools, SCREENSHOT_MAX_BYTES } from "../src/tools.js";

const SPEC: DeviceServiceSpec = {
  name: "browser",
  runtime: "node",
  entry: "daemon.mjs",
  args: [],
  files: { "daemon.mjs": new Uint8Array([1]) },
};

const PAGE = { url: "https://example.com/", title: "Example", tabId: "t1" };

/** A fake ctx.deviceAccess whose service answers `answer(req)`; it records every call. */
function fake(
  answer: (req: ToolRequest) => ToolReply = () => ({ ok: true, page: PAGE, blockedHosts: [] }),
) {
  const log: string[] = [];
  const requests: ToolRequest[] = [];
  const reported: { hosts: string[]; url?: string | undefined }[] = [];
  let failWith: Error | undefined;
  /** Requests that throw instead of answering (the daemon's socket gone), by request index. */
  const requestFailures = new Map<number, Error>();
  const deps: BrowserDeps = {
    deviceAccess: {
      async ensureService(_call, spec) {
        log.push(`ensure:${spec.name}`);
        if (failWith) throw failWith;
        return {
          name: spec.name,
          state: "running",
          startedAt: "2026-11-24T00:00:00Z",
          stateDir: "/s",
        };
      },
      async request(_call, req) {
        const body = JSON.parse(new TextDecoder().decode(req.body)) as ToolRequest;
        log.push(`request:${req.service}:${body.op}`);
        requests.push(body);
        const failure = requestFailures.get(requests.length - 1);
        if (failure) throw failure;
        return new TextEncoder().encode(JSON.stringify(answer(body)));
      },
      reportBlockedHosts(_call, hosts, opts) {
        log.push("report");
        reported.push({ hosts, url: opts?.url });
      },
    },
    serviceSpec: async () => SPEC,
  };
  const tools = new Map<string, { spec: ToolSpec; handler: ToolHandler }>();
  const reg = {
    register: (spec: ToolSpec, handler: ToolHandler) =>
      void tools.set(spec.name, { spec, handler }),
  };
  registerBrowserTools({ tools: reg }, deps);
  registerHandoffTool({ tools: reg }, deps);
  return {
    deps,
    log,
    requests,
    reported,
    tools,
    fail: (e: Error) => {
      failWith = e;
    },
    failRequest: (index: number, e: Error) => {
      requestFailures.set(index, e);
    },
    run: (name: string, input: unknown, c: ToolCallContext = call()) => {
      const t = tools.get(name);
      if (!t) throw new Error(`no tool ${name}`);
      return t.handler(input, c);
    },
  };
}

const call = (over: Partial<ToolCallContext> = {}): ToolCallContext => ({
  orgId: "org",
  accountId: "acc",
  ownerAccountId: "acc",
  agentId: "agent",
  conversationId: "conv",
  callId: "call-1",
  signal: new AbortController().signal,
  ...over,
});

const textOf = (r: ToolResult | InputRequired): string =>
  "content" in r
    ? r.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n")
    : "";

const POLICIES: Record<string, "allow" | "ask"> = {
  browser_navigate: "allow",
  browser_tabs: "allow",
  browser_snapshot: "allow",
  browser_screenshot: "allow",
  browser_wait: "allow",
  browser_handoff: "allow",
  browser_click: "ask",
  browser_type: "ask",
  browser_select: "ask",
  browser_press: "ask",
  browser_scroll: "ask",
  browser_hover: "ask",
  browser_upload: "ask",
  browser_click_at: "ask",
  browser_type_at: "ask",
};

describe("browser tools", () => {
  it("navigate ensures the service then requests navigate", async () => {
    const f = fake();
    const r = await f.run("browser_navigate", { url: "https://example.com" });
    expect(f.log).toEqual(["ensure:browser", "request:browser:navigate"]);
    expect(f.requests[0]).toEqual({ op: "navigate", url: "https://example.com" });
    expect(textOf(r)).toContain("Example");
    expect(textOf(r)).toContain("https://example.com/");
  });

  it("non-owner trigger fails with the owner message", async () => {
    const f = fake();
    await expect(f.run("browser_snapshot", {}, call({ accountId: "other" }))).rejects.toThrow(
      new ToolError("Browser tools only run for the conversation's owner on their own device."),
    );
    expect(NOT_OWNER_MESSAGE).toBe(
      "Browser tools only run for the conversation's owner on their own device.",
    );
    expect(f.log).toEqual([]);
  });

  it("a restart reply starts the service again and retries the request", async () => {
    // the daemon installed the browser into the install directory, sealed it and exits
    let n = 0;
    const f = fake(() =>
      n++ === 0
        ? { ok: false, error: "restart", message: "installed", blockedHosts: [] }
        : { ok: true, page: PAGE, blockedHosts: [] },
    );
    // the old process's socket is gone before its process: the next request fails meanwhile
    f.failRequest(1, new Error("device service browser.browser is not running"));
    const r = await f.run("browser_snapshot", {});
    expect(textOf(r)).toContain("Example");
    expect(f.log).toEqual([
      "ensure:browser",
      "request:browser:snapshot",
      "ensure:browser",
      "request:browser:snapshot",
      "ensure:browser",
      "request:browser:snapshot",
    ]);
  });

  it("a daemon that keeps asking for a restart ends in an actionable error", async () => {
    const f = fake(() => ({ ok: false, error: "restart", message: "installed", blockedHosts: [] }));
    await expect(f.run("browser_snapshot", {})).rejects.toThrow(new ToolError(RESTARTING_MESSAGE));
    expect(f.log.filter((l) => l.startsWith("ensure"))).toHaveLength(RESTART_ATTEMPTS + 1);
  });

  it("a failed request without a restart is not retried", async () => {
    const f = fake();
    f.failRequest(0, new Error("boom"));
    await expect(f.run("browser_snapshot", {})).rejects.toBeInstanceOf(ToolError);
    expect(f.log).toEqual(["ensure:browser", "request:browser:snapshot"]);
  });

  it("blocked hosts are reported to deviceAccess", async () => {
    const f = fake(() => ({ ok: true, page: PAGE, blockedHosts: ["cdn.example.net"] }));
    await f.run("browser_navigate", { url: "https://example.com" });
    expect(f.reported).toEqual([{ hosts: ["cdn.example.net"], url: PAGE.url }]);
  });

  it("blocked hosts on a failed reply are reported before the error", async () => {
    const f = fake(() => ({
      ok: false,
      error: "blocked",
      message: "The device's network settings block a.example.",
      blockedHosts: ["a.example"],
    }));
    await expect(f.run("browser_navigate", { url: "https://a.example" })).rejects.toBeInstanceOf(
      ToolError,
    );
    expect(f.reported).toEqual([{ hosts: ["a.example"], url: undefined }]);
  });

  it("taken_over maps to the actionable ToolError", async () => {
    const f = fake(() => ({ ok: false, error: "taken_over", message: "x", blockedHosts: [] }));
    await expect(f.run("browser_click", { ref: "e1" })).rejects.toThrow(
      new ToolError("The user is controlling the browser; call browser_wait or browser_handoff."),
    );
    expect(TAKEN_OVER_MESSAGE).toBe(
      "The user is controlling the browser; call browser_wait or browser_handoff.",
    );
  });

  it("first result after takeover carries the user-control note", async () => {
    const f = fake(() => ({
      ok: true,
      page: PAGE,
      blockedHosts: [],
      userControlledSince: "2026-11-24T10:00:00.000Z",
    }));
    const r = await f.run("browser_snapshot", {});
    expect(
      textOf(r).startsWith(
        "The user controlled the browser from 2026-11-24T10:00:00.000Z; now at https://example.com/ (Example).",
      ),
    ).toBe(true);
  });

  it("daemon errors become actionable ToolErrors", async () => {
    const f = fake(() => ({
      ok: false,
      error: "no_such_ref",
      message: "No element e9.",
      blockedHosts: [],
    }));
    const e = await f.run("browser_click", { ref: "e9" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ToolError);
    expect((e as Error).message).toContain("No element e9.");
    expect((e as Error).message).toContain("browser_snapshot");
  });

  it("device access refusals map to actionable text", async () => {
    const f = fake();
    f.fail(new DeviceAccessError("no_device", "kernel text"));
    await expect(f.run("browser_snapshot", {})).rejects.toThrow(
      new ToolError(
        "This conversation has no device; ask the user to pick a device for the conversation first.",
      ),
    );
    const g = fake();
    g.fail(new DeviceAccessError("capability_missing", "kernel text"));
    const e = await g.run("browser_snapshot", {}).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ToolError);
    expect((e as Error).message).toMatch(/device/);
  });

  it("an unrecognised failure is a generic retryable error, the cause logged only", async () => {
    const f = fake(() => {
      throw new Error("ECONNRESET 10.0.0.7:6379");
    });
    const warned: unknown[] = [];
    f.deps.log = { warn: (_m, meta) => void warned.push(meta) };
    const e = await f.run("browser_snapshot", {}).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ToolError);
    expect((e as Error).message).toBe(
      "The browser service in the device failed; retry, and ask the user to check the device if it keeps failing.",
    );
    expect(JSON.stringify(warned)).not.toBe("[]");
    const g = fake();
    g.fail(new ToolError("The device service browser was not started: denied. Ask the user."));
    await expect(g.run("browser_snapshot", {})).rejects.toThrow(/was not started/);
  });

  it("screenshot retries once with half the bytes when the reply was too large", async () => {
    const sizes: number[] = [];
    const f = fake((req) => {
      if (req.op !== "screenshot") return { ok: true, page: PAGE, blockedHosts: [] };
      sizes.push(req.maxBytes);
      return sizes.length === 1
        ? { ok: false, error: "failed", message: REPLY_TOO_LARGE_MESSAGE, blockedHosts: [] }
        : { ok: true, page: PAGE, blockedHosts: [], image: "AAAA" };
    });
    const r = (await f.run("browser_screenshot", {})) as ToolResult;
    expect(r.content).toContainEqual({ type: "image", mimeType: "image/jpeg", data: "AAAA" });
    expect(sizes).toEqual([SCREENSHOT_MAX_BYTES, SCREENSHOT_MAX_BYTES / 2]);
    // once only
    const g = fake(() => ({
      ok: false,
      error: "failed",
      message: REPLY_TOO_LARGE_MESSAGE,
      blockedHosts: [],
    }));
    await expect(g.run("browser_screenshot", {})).rejects.toThrow(/too large/);
    expect(g.requests).toHaveLength(2);
  });

  it("a blocked host gets one next step", async () => {
    const f = fake(() => ({
      ok: false,
      error: "blocked",
      message: "The device's network settings block x.test.",
      blockedHosts: ["x.test"],
    }));
    const e = await f.run("browser_navigate", { url: "https://x.test" }).catch((x: unknown) => x);
    expect((e as Error).message).toBe(
      "The device's network settings block x.test. The network note says whether the host can be allowed from this conversation; if it is not allowed, use another site.",
    );
  });

  it("a refused browser download host gets its own next step", async () => {
    const f = fake(() => ({
      ok: false,
      error: "blocked",
      message: `${DOWNLOAD_BLOCKED_PREFIX}cdn.playwright.dev.`,
      blockedHosts: ["cdn.playwright.dev"],
    }));
    const e = await f.run("browser_snapshot", {}).catch((x: unknown) => x);
    expect((e as Error).message).toBe(
      `${DOWNLOAD_BLOCKED_PREFIX}cdn.playwright.dev. Ask the user to allow these hosts so the browser can be installed, then retry.`,
    );
    expect((e as Error).message).not.toMatch(/another site/);
  });

  it("a service start that fails has its own text", async () => {
    const f = fake();
    f.fail(new Error("spawn failed"));
    const e = await f.run("browser_snapshot", {}).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ToolError);
    expect((e as Error).message).toBe(
      "The browser could not start in the device; retry, and ask the user to check the device if it keeps failing.",
    );
  });

  it("screenshot returns an image block", async () => {
    const f = fake(() => ({
      ok: true,
      page: PAGE,
      blockedHosts: [],
      image: "AAAA",
      text: "Screenshot 1280x800",
    }));
    const r = (await f.run("browser_screenshot", { fullPage: true })) as ToolResult;
    expect(r.content).toContainEqual({ type: "image", mimeType: "image/jpeg", data: "AAAA" });
    const req = f.requests[0] as Extract<ToolRequest, { op: "screenshot" }>;
    expect(req.fullPage).toBe(true);
    expect(req.maxBytes).toBeGreaterThan(0);
  });

  it("maps each tool to its daemon request", async () => {
    const f = fake();
    await f.run("browser_tabs", { action: "open", url: "https://a.example" });
    await f.run("browser_type", { ref: "e2", text: "hi", submit: true });
    await f.run("browser_select", { ref: "e3", values: ["a"] });
    await f.run("browser_press", { key: "Enter" });
    await f.run("browser_scroll", { dy: 400 });
    await f.run("browser_hover", { ref: "e4" });
    await f.run("browser_upload", { ref: "e5", path: "/work/a.pdf" });
    await f.run("browser_click_at", { x: 10, y: 20 });
    await f.run("browser_type_at", { x: 10, y: 20, text: "q" });
    await f.run("browser_wait", { text: "Done", timeoutMs: 5000 });
    expect(f.requests).toEqual([
      { op: "tabs", action: "open", url: "https://a.example" },
      { op: "type", ref: "e2", text: "hi", submit: true },
      { op: "select", ref: "e3", values: ["a"] },
      { op: "press", key: "Enter" },
      { op: "scroll", dy: 400 },
      { op: "hover", ref: "e4" },
      { op: "upload", ref: "e5", path: "/work/a.pdf" },
      { op: "click_at", x: 10, y: 20 },
      { op: "type_at", x: 10, y: 20, text: "q" },
      { op: "wait", text: "Done", timeoutMs: 5000 },
    ]);
  });

  it("click declares defaultPolicy ask and snapshot declares allow", () => {
    const f = fake();
    expect([...f.tools.keys()].sort()).toEqual(Object.keys(POLICIES).sort());
    for (const [name, policy] of Object.entries(POLICIES)) {
      expect(f.tools.get(name)?.spec.defaultPolicy, name).toBe(policy);
    }
  });

  it("every tool declares a time limit that covers the device's first start and its own wait", () => {
    const f = fake();
    // any tool may be the first call: the instance start, the service files, the Chromium
    // download, then one daemon request (REQUEST_TIMEOUT_MS covers browser_wait's own wait)
    expect(TOOL_TIMEOUT_MS).toBeGreaterThan(REQUEST_TIMEOUT_MS + 120_000);
    for (const name of f.tools.keys())
      expect(f.tools.get(name)?.spec.timeoutMs, name).toBe(TOOL_TIMEOUT_MS);
  });

  it("tool descriptions are English and pass validateToolSpec", () => {
    const f = fake();
    for (const { spec } of f.tools.values()) {
      expect(validateToolSpec(spec), spec.name).toEqual([]);
      expect(spec.name).not.toContain(".");
      expect(spec.description, spec.name).not.toMatch(/[㐀-鿿]/);
      expect(spec.description.length, spec.name).toBeGreaterThanOrEqual(20);
    }
    expect(f.tools.get("browser_upload")?.spec.description).toMatch(/workspace/);
  });
});

describe("browser_handoff", () => {
  it("handoff returns InputRequired then resumes with the page state", async () => {
    const f = fake((req) =>
      req.op === "snapshot"
        ? { ok: true, page: PAGE, blockedHosts: [], text: '- button "Go" [ref=e1]' }
        : { ok: true, page: PAGE, blockedHosts: [] },
    );
    const first = (await f.run("browser_handoff", { message: "Please sign in." })) as InputRequired;
    expect(first.kind).toBe("input_required");
    expect(validateInputForm(first.form)).toEqual([]);
    expect(first.form.title).toBe("Please sign in.");
    const field = first.form.fields[0];
    expect(field?.key).toBe("done");
    expect(field?.schema).toEqual({ type: "boolean" });
    expect(field?.label).toEqual({ zh: "完成", en: "Done" });
    expect(f.requests).toEqual([
      { op: "handoff_notice", callId: "call-1", message: "Please sign in." },
    ]);

    const r = await f.run(
      "browser_handoff",
      { message: "Please sign in." },
      call({ resume: { state: first.state, answer: { done: true } } }),
    );
    expect(f.requests.slice(1).map((q) => q.op)).toEqual(["handoff_clear", "snapshot"]);
    // Done hands the browser back (a takeover the person still holds ends before the snapshot)
    expect(f.requests[1]).toEqual({ op: "handoff_clear", callId: "call-1", handback: true });
    expect(textOf(r)).toContain("https://example.com/");
    expect(textOf(r)).toContain("[ref=e1]");
  });

  it("cancel resumes with the cancel error", async () => {
    const f = fake();
    for (const answer of [null, { done: false }]) {
      await expect(
        f.run("browser_handoff", { message: "m" }, call({ resume: { state: {}, answer } })),
      ).rejects.toThrow(
        new ToolError(
          "The user cancelled the handoff; ask the user how to continue, or try another approach.",
        ),
      );
    }
    expect(f.requests.map((q) => q.op)).toEqual(["handoff_clear", "handoff_clear"]);
    // a cancel leaves a takeover as it is
    for (const q of f.requests) expect(q).toEqual({ op: "handoff_clear", callId: "call-1" });
  });

  it("a failed clear keeps the person's answer, unless the call was aborted", async () => {
    const boom = (req: ToolRequest): ToolReply => {
      if (req.op === "handoff_clear") throw new Error("relay dropped");
      return { ok: true, page: PAGE, blockedHosts: [], text: "tree" };
    };
    const f = fake(boom);
    const r = await f.run(
      "browser_handoff",
      { message: "m" },
      call({ resume: { state: {}, answer: { done: true } } }),
    );
    expect(textOf(r)).toContain("tree");
    const g = fake(boom);
    await expect(
      g.run("browser_handoff", { message: "m" }, call({ resume: { state: {}, answer: null } })),
    ).rejects.toThrow(/cancelled the handoff/);
    const aborted = new AbortController();
    aborted.abort();
    const h = fake(boom);
    await expect(
      h.run(
        "browser_handoff",
        { message: "m" },
        call({ signal: aborted.signal, resume: { state: {}, answer: { done: true } } }),
      ),
    ).rejects.toThrow("relay dropped");
  });

  it("handoff refuses a non-owner", async () => {
    const f = fake();
    await expect(
      f.run("browser_handoff", { message: "m" }, call({ accountId: "x" })),
    ).rejects.toThrow(NOT_OWNER_MESSAGE);
  });
});

describe("service spec", () => {
  it("lists every file under the service directory, keyed by relative path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "browser-svc-"));
    try {
      await mkdir(join(dir, "vendor", "pw"), { recursive: true });
      await writeFile(join(dir, "daemon.mjs"), "x");
      await writeFile(join(dir, "vendor", "pw", "index.mjs"), "y");
      const spec = await serviceSpecLoader(pathToFileURL(`${dir}/`))();
      expect(spec).toMatchObject({
        name: "browser",
        runtime: "node",
        entry: "daemon.mjs",
        args: [],
      });
      expect(Object.keys(spec.files).sort()).toEqual(["daemon.mjs", "vendor/pw/index.mjs"]);
      expect(new TextDecoder().decode(spec.files["vendor/pw/index.mjs"])).toBe("y");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a missing build fails the load and the next call retries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "browser-svc-"));
    try {
      const load = serviceSpecLoader(pathToFileURL(`${dir}/`));
      await expect(load()).rejects.toThrow(/daemon\.mjs is missing/);
      await writeFile(join(dir, "daemon.mjs"), "x");
      await expect(load()).resolves.toMatchObject({ entry: "daemon.mjs" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
