import {
  DeviceOfflineError,
  DeviceRequestNotSentError,
  FileSystemGoneError,
  isDeviceOfflineError,
  isDeviceRequestNotSent,
  isProjectPathRefusedError,
  isSandboxGoneError,
  isSandboxOperationOutcomeUnknownError,
  isSandboxPermissionUnsupportedError,
  isSandboxScopeDeniedError,
  isSandboxScopeValidationError,
  isSandboxWorkUnsettledError,
  type ProjectPathRefusedError,
  type SandboxExecutionRef,
  SandboxPermissionUnsupportedError,
  ToolError,
} from "@capybara-hq/plugin-sdk";
import type { BindInstanceRequest } from "@capybara-hq/plugin-sdk/device-protocol";
import { describe, expect, it } from "vitest";
import plugin, {
  createDeviceLocalProvider,
  EXEC_DEADLINE_MARGIN_MS,
  FRAME_ENVELOPE_BYTES,
  type LocalDeviceHandle,
  maxReadBytes,
  ON_MACHINE_PREFIX,
  OP_DEADLINE_MS,
  POLICY_REFUSAL_PREFIX,
  PROJECT_REFUSAL_TEXT,
  relayer,
} from "../src/index.js";
import {
  type Answer,
  fakeBinder,
  fakeDialIn,
  fakeLog,
  LIMITS,
  memoryStore,
  ROOTS,
  rejection,
  type SentRequest,
  scopeOf,
  signal,
} from "./fakes.js";

const DEVICE = "dev-1";
const EXEC_RESULT = { exitCode: 0, stdout: "ok", stderr: "", truncated: false, timedOut: false };

/**
 * A machine that answers every protocol 6 operation: `create` with its roots, `bindInstance` by the
 * binder's chain rules, everything else with `answers[op]` (default a null result).
 */
function machine(answers: Partial<Record<string, (req: SentRequest) => Answer>> = {}) {
  const binder = fakeBinder(DEVICE);
  const roots = { current: ROOTS };
  const answer = (req: SentRequest): Answer => {
    const own = answers[req.op];
    if (own) return own(req);
    if (req.op === "create") return { ok: true, result: { roots: roots.current } };
    if (req.op === "bindInstance") return binder.bind(req.args as unknown as BindInstanceRequest);
    if (req.op === "exec") return { ok: true, result: EXEC_RESULT };
    return { ok: true, result: null };
  };
  return { answer, binder, roots };
}

/** A provider over a fake channel to `m`, with an in-memory store. */
function setup(m = machine()) {
  const dial = fakeDialIn(m.answer);
  const { store, rows } = memoryStore();
  const { log, warnings } = fakeLog();
  let clock = 1_000_000;
  const provider = createDeviceLocalProvider({ dialIn: dial.channel, log }, store, {
    now: () => clock++,
  });
  return { provider, dial, store, rows, warnings, m };
}

/** A created instance's handle (the machine answered create and the binding). */
async function created(s: ReturnType<typeof setup>): Promise<LocalDeviceHandle> {
  const h = (await s.provider.create({
    name: `cap-device-${DEVICE}`,
    limits: LIMITS,
    fileSystem: { id: DEVICE },
    signal: signal(),
  })) as LocalDeviceHandle;
  s.dial.sent.length = 0;
  return h;
}

describe("device-local manifest", () => {
  it("provides device-provider@1 over the capybara-device/6 dial-in protocol", () => {
    expect(plugin.name).toBe("device-local");
    expect(plugin.provides).toEqual(["device-provider@1"]);
    expect(plugin.permissions).toEqual({ dialIn: { protocol: "capybara-device/6" } });
  });

  it("declares concurrent exec, the network allowlist and no session isolation", () => {
    const { provider } = setup();
    expect(provider.concurrentExec).toBe(true);
    expect(provider.networkAllowlist).toBe(true);
    expect(provider.sessionIsolation).toBe(false);
  });
});

describe("the protocol 6 codec", () => {
  it("exec relays a protocol 6 exec body and parses the result strictly", async () => {
    const s = setup(
      machine({
        exec: () => ({ ok: true, result: { ...EXEC_RESULT, extra: "dropped" } }),
      }),
    );
    const h = await created(s);
    const scope = scopeOf();
    const op = await s.provider.operation?.(h, scope, signal());
    const r = await op?.exec({
      command: "ls",
      cwd: ROOTS.workspace,
      timeoutMs: 1000,
      maxOutputBytes: 100,
      signal: signal(),
    });
    expect(r).toEqual(EXEC_RESULT);
    const [req] = s.dial.sent;
    expect(req).toMatchObject({ deviceId: DEVICE, op: "exec", timeoutMs: 1000 + 5000 });
    expect(req?.args).toEqual({
      scope,
      command: "ls",
      cwd: ROOTS.workspace,
      timeoutMs: 1000,
      maxOutputBytes: 100,
      limits: { ...LIMITS, network: { kind: "allowlist", hosts: ["example.com"] } },
    });
    expect(EXEC_DEADLINE_MARGIN_MS).toBe(5000);
  });

  it("a malformed result body throws a ToolError naming the machine, never passes through", async () => {
    const bodies: Answer[] = [
      { ok: "yes", result: EXEC_RESULT },
      { ok: true, result: { ...EXEC_RESULT, exitCode: "0" } },
      { ok: true, result: { ...EXEC_RESULT, stdout: undefined } },
      { ok: false, error: { kind: "nope", message: "x" } },
      "not an object",
    ];
    let next: Answer = null;
    const s = setup(machine({ exec: () => next }));
    const h = await created(s);
    const op = await s.provider.operation?.(h, scopeOf(), signal());
    for (const body of bodies) {
      next = body;
      const e = await rejection(
        op?.exec({ command: "ls", timeoutMs: 1000, maxOutputBytes: 100, signal: signal() }) ??
          Promise.resolve(),
      );
      expect(e).toBeInstanceOf(ToolError);
      expect((e as Error).message).toMatch(/^The connected machine sent an invalid answer to exec/);
    }
  });

  it("a read larger than maxReadBytes is cut to what fits one frame before the request", async () => {
    const s = setup(machine({ readFile: () => ({ ok: true, result: null }) }));
    const h = await created(s);
    const op = await s.provider.operation?.(h, scopeOf(), signal());
    await op?.readFile(`${ROOTS.workspace}/big`, { maxBytes: 64 * 1024 * 1024, signal: signal() });
    await op?.readFile(`${ROOTS.workspace}/small`, { maxBytes: 10, signal: signal() });
    expect(s.dial.sent.map((r) => r.args.maxBytes)).toEqual([maxReadBytes(16 * 1024 * 1024), 10]);
    expect(maxReadBytes(FRAME_ENVELOPE_BYTES + 4000)).toBe(3000);
    expect(maxReadBytes(FRAME_ENVELOPE_BYTES)).toBe(0);
  });

  it("reads, output reads and tails are sized by the connection's negotiated capacity", async () => {
    const s = setup(
      machine({
        readFile: () => ({ ok: true, result: null }),
        backgroundReadOutput: () => ({ ok: true, result: { unavailable: "lost" } }),
        backgroundTail: () => ({ ok: true, result: { unavailable: "lost" } }),
      }),
    );
    const h = await created(s);
    s.dial.state.capacity = FRAME_ENVELOPE_BYTES + 4000;
    const op = await s.provider.operation?.(h, scopeOf(), signal());
    await op?.readFile(`${ROOTS.workspace}/big`, { maxBytes: 1_000_000, signal: signal() });
    const ref: SandboxExecutionRef = {
      executionId: "exec-1",
      operationId: "operation-1",
      instanceId: DEVICE,
      instanceGeneration: h.generation,
    };
    await s.provider.background?.readOutput(h, ref, {
      offset: 0,
      maxBytes: 65_536,
      signal: signal(),
    });
    await s.provider.background?.tail(h, ref, { maxBytes: 65_536, signal: signal() });
    expect(s.dial.sent.slice(-3).map((r) => r.args.maxBytes)).toEqual([3000, 3000, 3000]);
  });

  it("a write that cannot fit one frame is refused before anything is sent", async () => {
    const s = setup();
    const h = await created(s);
    s.dial.state.capacity = FRAME_ENVELOPE_BYTES + 4000;
    const before = s.dial.sent.length;
    const op = await s.provider.operation?.(h, scopeOf(), signal());
    const e = await rejection(
      op?.writeFile(`${ROOTS.workspace}/big`, new Uint8Array(3001), signal()) ?? Promise.resolve(),
    );
    expect(e).toBeInstanceOf(ToolError);
    expect((e as Error).message).toMatch(/too large .* at most 3000/);
    expect(s.dial.sent.length).toBe(before);
  });

  it("no capacity (no machine now) or an unreadable one is the device being offline", async () => {
    const s = setup(machine({ readFile: () => ({ ok: true, result: null }) }));
    const h = await created(s);
    const before = s.dial.sent.length;
    const op = await s.provider.operation?.(h, scopeOf(), signal());
    s.dial.state.capacity = null;
    const a = await rejection(
      op?.readFile(`${ROOTS.workspace}/f`, { maxBytes: 10, signal: signal() }) ?? Promise.resolve(),
    );
    expect(isDeviceOfflineError(a)).toBe(true);
    s.dial.state.capacity = () => {
      throw new Error("redis down");
    };
    const b = await rejection(
      op?.readFile(`${ROOTS.workspace}/f`, { maxBytes: 10, signal: signal() }) ?? Promise.resolve(),
    );
    expect(isDeviceOfflineError(b)).toBe(true);
    expect(((b as Error).cause as Error).message).toBe("redis down");
    expect(s.dial.sent.length).toBe(before);
  });

  it("a request body that is not valid protocol 6 is never sent", async () => {
    const s = setup();
    const h = await created(s);
    const op = await s.provider.operation?.(h, scopeOf(), signal());
    await expect(
      op?.readFile("relative/path", { maxBytes: 10, signal: signal() }),
    ).rejects.toThrow();
    expect(s.dial.sent).toEqual([]);
  });

  it("DeviceOfflineError from the channel surfaces as the kernel's offline error", async () => {
    const offline = new DeviceOfflineError(DEVICE);
    const s = setup(
      machine({
        stat: () => {
          throw offline;
        },
      }),
    );
    const h = await created(s);
    const op = await s.provider.operation?.(h, scopeOf(), signal());
    const e = await rejection(op?.stat(ROOTS.workspace, signal()) ?? Promise.resolve());
    expect(e).toBe(offline);
    expect(isDeviceOfflineError(e)).toBe(true);
    expect((e as DeviceOfflineError).code).toBe("device.offline");
  });

  it("a request the gateway never sent rethrows DeviceRequestNotSentError unchanged", async () => {
    const notSent = new DeviceRequestNotSentError("The machine's connection changed; retry it");
    const s = setup(
      machine({
        exec: () => {
          throw notSent;
        },
        backgroundStatus: () => {
          throw notSent;
        },
      }),
    );
    const h = await created(s);
    const op = await s.provider.operation?.(h, scopeOf(), signal());
    const e = await rejection(
      op?.exec({ command: "ls", timeoutMs: 100, maxOutputBytes: 10, signal: signal() }) ??
        Promise.resolve(),
    );
    expect(e).toBe(notSent);
    expect(isDeviceRequestNotSent(e)).toBe(true);
    const ref: SandboxExecutionRef = {
      executionId: "e",
      operationId: "operation-1",
      instanceId: DEVICE,
      instanceGeneration: h.generation,
    };
    expect(
      await rejection(s.provider.background?.status(h, ref, signal()) as Promise<unknown>),
    ).toBe(notSent);
  });

  it("maps each typed machine failure to the SDK error the kernel knows", async () => {
    let failure: Record<string, unknown> = { kind: "error", message: "boom" };
    const s = setup(
      machine({
        stat: () => ({ ok: false, error: failure }),
        list: () => ({ ok: false, error: failure }),
        browseScan: () => ({ ok: false, error: failure }),
      }),
    );
    const h = await created(s);
    const op = await s.provider.operation?.(h, scopeOf(), signal());
    const statError = async (kind: string) => {
      failure = { kind, message: "boom" };
      return rejection(op?.stat(ROOTS.workspace, signal()) ?? Promise.resolve());
    };
    expect(isSandboxScopeDeniedError(await statError("denied"))).toBe(true);
    expect(isSandboxPermissionUnsupportedError(await statError("unsupported"))).toBe(true);
    expect(isSandboxWorkUnsettledError(await statError("unsettled"))).toBe(true);
    expect(isSandboxOperationOutcomeUnknownError(await statError("unknown"))).toBe(true);
    expect(isSandboxScopeValidationError(await statError("invalid"))).toBe(true);
    expect(isSandboxGoneError(await statError("gone"))).toBe(true);
    expect(await statError("fs_gone")).toBeInstanceOf(FileSystemGoneError);
    const policy = await statError("policy");
    expect(policy).toBeInstanceOf(ToolError);
    expect((policy as Error).message).toBe(
      `${POLICY_REFUSAL_PREFIX}boom (ask the machine's owner to allow it, or use another way)`,
    );
    const error = await statError("error");
    expect((error as Error).message).toBe(
      `${ON_MACHINE_PREFIX}boom (check the path or command and retry)`,
    );
    // a policy refusal of a project listing is no longer a refused path: only a code is
    failure = { kind: "policy", message: "another connection's directory" };
    const listPolicy = await rejection(
      op?.list?.(ROOTS.workspace, { limit: 1, signal: signal() }) ?? Promise.resolve(),
    );
    expect(isProjectPathRefusedError(listPolicy)).toBe(false);
    expect(listPolicy).toBeInstanceOf(ToolError);
    // a project_refused outcome refuses that directory with the code's fixed text
    failure = { kind: "project_refused", message: "<b>evil</b>", refusal: "other-connection" };
    const listed = await rejection(
      op?.list?.(ROOTS.workspace, { limit: 1, signal: signal() }) ?? Promise.resolve(),
    );
    expect(isProjectPathRefusedError(listed)).toBe(true);
    expect((listed as ProjectPathRefusedError).reason).toEqual(
      PROJECT_REFUSAL_TEXT["other-connection"],
    );
    const browse = await s.provider.browse?.(
      h,
      {
        operationId: "browse-1",
        admitBeforeMs: Date.now() + 30_000,
        deviceId: DEVICE,
        accountId: "owner",
        ceilingRevision: "c",
        readRoots: ["/home/me"],
        tag: "browse",
      },
      signal(),
    );
    expect(
      isProjectPathRefusedError(
        await rejection(browse?.scan("/home/me", { signal: signal() }) ?? Promise.resolve()),
      ),
    ).toBe(true);
  });
});

describe("operations", () => {
  it("prepare and browse relay their prefixed operations with their scope", async () => {
    const s = setup(
      machine({
        prepareReadFile: () => ({
          ok: true,
          result: { dataB64: Buffer.from("hi").toString("base64"), truncated: false },
        }),
        browseList: () => ({
          ok: true,
          result: { entries: [{ name: "src", isDir: true }], truncated: false },
        }),
      }),
    );
    const h = await created(s);
    const prepScope = {
      operationId: "prep-1",
      deviceId: DEVICE,
      purpose: "skills" as const,
      writeRoots: [ROOTS.skills],
      tag: "prep",
    };
    const prep = await s.provider.prepare?.(h, prepScope, signal());
    const read = await prep?.readFile(`${ROOTS.skills}/a`, { maxBytes: 10, signal: signal() });
    expect(Buffer.from(read?.data ?? []).toString()).toBe("hi");
    await prep?.writeFile(`${ROOTS.skills}/a`, new TextEncoder().encode("yo"), signal());
    const browseScope = {
      operationId: "browse-1",
      admitBeforeMs: Date.now() + 30_000,
      deviceId: DEVICE,
      accountId: "owner",
      ceilingRevision: "c",
      readRoots: ["/home/me"],
      tag: "browse",
    };
    const browse = await s.provider.browse?.(h, browseScope, signal());
    expect(await browse?.list("/home/me", { limit: 5, signal: signal() })).toEqual({
      entries: [{ name: "src", isDir: true }],
      truncated: false,
    });
    expect(s.dial.sent.map((r) => [r.op, r.timeoutMs])).toEqual([
      ["prepareReadFile", OP_DEADLINE_MS],
      ["prepareWriteFile", OP_DEADLINE_MS],
      ["browseList", OP_DEADLINE_MS],
    ]);
    expect(s.dial.sent[0]?.args).toEqual({
      scope: prepScope,
      path: `${ROOTS.skills}/a`,
      maxBytes: 10,
    });
    expect(s.dial.sent[1]?.args).toEqual({
      scope: prepScope,
      path: `${ROOTS.skills}/a`,
      dataB64: Buffer.from("yo").toString("base64"),
    });
    expect(s.dial.sent[2]?.args).toEqual({ scope: browseScope, path: "/home/me", limit: 5 });
  });

  it("a command carries the instance's resources and the network its scope admitted", async () => {
    const s = setup();
    const h = await created(s);
    const run = async (network: ReturnType<typeof scopeOf>["network"], device = false) => {
      const scope = scopeOf(device ? { network, filesystem: { kind: "device" } } : { network });
      const op = await s.provider.operation?.(h, scope, signal());
      await op?.exec({ command: "true", timeoutMs: 100, maxOutputBytes: 10, signal: signal() });
      return s.dial.sent.at(-1)?.args;
    };
    const resources = { cpu: 2, memoryMb: 1024, diskMb: 2048 };
    // hosts the kernel granted for the call travel in the network: the wire has no grants field
    const granted = await run({ kind: "allowlist", hosts: ["example.com", "granted.example.org"] });
    expect(granted?.limits).toEqual({
      ...resources,
      network: { kind: "allowlist", hosts: ["example.com", "granted.example.org"] },
    });
    expect(granted).not.toHaveProperty("grants");
    expect(Object.keys(granted?.limits as object)).not.toContain("mode");
    expect((await run({ kind: "none" }))?.limits).toEqual({
      ...resources,
      network: { kind: "allowlist", hosts: [] },
    });
    expect((await run({ kind: "open-public" }))?.limits).toEqual({
      ...resources,
      network: { kind: "open-public", hosts: [] },
    });
    // an escalated call runs outside the sandbox: the instance's network
    expect((await run({ kind: "environment" }, true))?.limits).toEqual(LIMITS);
  });

  it("exec keeps the machine's own refusals for the kernel to plan; only bad names become addresses", async () => {
    const s = setup(
      machine({
        exec: () => ({
          ok: true,
          result: {
            ...EXEC_RESULT,
            network: {
              blocked: [
                // in the carried network: the machine's owner refused it
                { host: "example.com", port: 443, layer: "device" },
                // outside the carried network: still the machine's word; whether it can be
                // granted for a call (and by whom) is the kernel's network-ask planning
                { host: "grantable.example.net", port: 443, layer: "device" },
                { host: "*.example.org", port: 443, layer: "device" },
                { host: "other.org", port: 80, layer: "org" },
              ],
            },
          },
        }),
      }),
    );
    const h = await created(s);
    const op = await s.provider.operation?.(h, scopeOf(), signal());
    const r = await op?.exec({
      command: "curl",
      timeoutMs: 100,
      maxOutputBytes: 100,
      signal: signal(),
    });
    expect(r?.network?.blocked).toEqual([
      { host: "example.com", port: 443, layer: "device" },
      { host: "grantable.example.net", port: 443, layer: "device" },
      { host: "*.example.org", port: 443, layer: "address" },
      { host: "other.org", port: 80, layer: "org" },
    ]);
  });

  it("relayer: a wildcard or a bad name the machine calls its own is an address; nothing becomes org", () => {
    expect(
      relayer([
        { host: "*.example.com", port: 443, layer: "device" },
        { host: "bad_host!", port: 443, layer: "device" },
        { host: "api.example.com.", port: 443, layer: "device" },
        { host: "anything.example.net", port: 443, layer: "device" },
        { host: "bad_host!", port: 80, layer: "address" },
        { host: "x.example", port: 80, layer: "unknown" },
      ]),
    ).toEqual([
      { host: "*.example.com", port: 443, layer: "address" },
      { host: "bad_host!", port: 443, layer: "address" },
      { host: "api.example.com.", port: 443, layer: "device" },
      { host: "anything.example.net", port: 443, layer: "device" },
      { host: "bad_host!", port: 80, layer: "address" },
      { host: "x.example", port: 80, layer: "unknown" },
    ]);
  });

  it("an exec result without a network report gains none", async () => {
    const s = setup();
    const h = await created(s);
    const op = await s.provider.operation?.(h, scopeOf(), signal());
    const r = await op?.exec({
      command: "true",
      timeoutMs: 100,
      maxOutputBytes: 10,
      signal: signal(),
    });
    expect(r?.network).toBeUndefined();
  });

  it("an aborted operation sends nothing", async () => {
    const s = setup();
    const h = await created(s);
    const ac = new AbortController();
    const op = await s.provider.operation?.(h, scopeOf(), ac.signal);
    ac.abort(new Error("run aborted"));
    await expect(
      op?.exec({ command: "true", timeoutMs: 100, maxOutputBytes: 10, signal: signal() }),
    ).rejects.toThrow("run aborted");
    expect(s.dial.sent).toEqual([]);
  });

  it("background: start keeps the kernel's generation off the wire; reads and tails are bounded", async () => {
    const ref = (generation: string): SandboxExecutionRef => ({
      executionId: "exec-1",
      operationId: "operation-1",
      instanceId: DEVICE,
      instanceGeneration: generation,
    });
    let readAnswer: Answer = null;
    const s = setup(
      machine({
        backgroundStart: (req) => ({
          ok: true,
          result: ref(String((req.args.scope as { operationId: string }) && "1000000")),
        }),
        backgroundReadOutput: () => readAnswer,
        backgroundTail: () => ({
          ok: true,
          result: { dataB64: Buffer.from("tail").toString("base64"), truncated: true },
        }),
        backgroundStop: () => ({ ok: true, result: { outcome: "stopped" } }),
        backgroundStatus: () => ({ ok: true, result: { state: "running" } }),
      }),
    );
    const h = await created(s);
    const scope = scopeOf();
    const started = await s.provider.background?.start(h, scope, {
      command: "sleep 100",
      timeoutMs: 60_000,
      maxOutputBytes: 1000,
      signal: signal(),
      taskId: "task-1",
      outputPath: `${ROOTS.workspace}/task.out`,
      retainUntilMs: scope.admitBeforeMs + 1000,
      instanceGeneration: "kernel-generation",
    });
    expect(started).toEqual(ref("1000000"));
    const start = s.dial.sent[0];
    expect(start?.timeoutMs).toBe(60_000 + EXEC_DEADLINE_MARGIN_MS);
    expect(start?.args).not.toHaveProperty("instanceGeneration");
    expect(start?.args).toMatchObject({ taskId: "task-1", limits: { cpu: 2 } });
    const r = ref("1000000");
    readAnswer = {
      ok: true,
      result: {
        dataB64: Buffer.from("abc").toString("base64"),
        offset: 10,
        nextOffset: 13,
        totalBytes: 13,
      },
    };
    const out = await s.provider.background?.readOutput(h, r, {
      offset: 10,
      maxBytes: 1_000_000,
      signal: signal(),
    });
    expect(out).toMatchObject({ offset: 10, nextOffset: 13, totalBytes: 13 });
    expect(Buffer.from((out as { data: Uint8Array }).data).toString()).toBe("abc");
    expect(s.dial.sent.at(-1)?.args).toEqual({ ref: r, offset: 10, maxBytes: 65_536 });
    // a range the request did not ask for is refused, never passed on
    readAnswer = {
      ok: true,
      result: {
        dataB64: Buffer.from("abc").toString("base64"),
        offset: 0,
        nextOffset: 3,
        totalBytes: 13,
      },
    };
    expect(
      await rejection(
        s.provider.background?.readOutput(h, r, {
          offset: 10,
          maxBytes: 100,
          signal: signal(),
        }) as Promise<unknown>,
      ),
    ).toBeInstanceOf(ToolError);
    readAnswer = { ok: true, result: { unavailable: "expired" } };
    expect(
      await s.provider.background?.readOutput(h, r, { offset: 0, maxBytes: 10, signal: signal() }),
    ).toEqual({ unavailable: "expired" });
    const tail = await s.provider.background?.tail(h, r, { maxBytes: 4, signal: signal() });
    expect(tail).toMatchObject({ truncated: true });
    expect(await s.provider.background?.status(h, r, signal())).toEqual({ state: "running" });
    expect(await s.provider.background?.stop(h, r, { graceMs: 100, signal: signal() })).toEqual({
      outcome: "stopped",
    });
  });

  it("revokeOperation relays the exact operation reference", async () => {
    const s = setup();
    const h = await created(s);
    const ref = { operationId: "operation-1", admitBeforeMs: Date.now() + 1000 };
    await s.provider.revokeOperation?.(h, ref, signal());
    expect(s.dial.sent).toMatchObject([{ op: "revokeOperation", args: { ref } }]);
  });

  it("the raw methods refuse before anything is sent and kill nothing", async () => {
    const s = setup();
    const h = await created(s);
    const refused = [
      s.provider.exec(h, {
        command: "ls",
        timeoutMs: 1000,
        maxOutputBytes: 10,
        tag: "t",
        actor: { accountId: "a", conversationId: "c" },
        signal: signal(),
      }),
      s.provider.readFile(h, `${ROOTS.workspace}/a`, { maxBytes: 10, signal: signal() }),
      s.provider.writeFile(h, `${ROOTS.workspace}/a`, new Uint8Array([1]), signal()),
      s.provider.stat(h, ROOTS.workspace, signal()),
      s.provider.list?.(h, ROOTS.workspace, { limit: 10, signal: signal() }),
      s.provider.scan?.(h, ROOTS.workspace, { signal: signal() }),
    ];
    for (const r of await Promise.allSettled(refused)) {
      expect(r.status).toBe("rejected");
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(SandboxPermissionUnsupportedError);
    }
    await s.provider.killAll(h, signal());
    await s.provider.killTagged(h, ["t"], signal());
    expect(s.dial.sent).toEqual([]);
  });
});

describe("lifecycle", () => {
  it("createFileSystem returns the device id without asking the machine (offline too)", async () => {
    const s = setup();
    s.dial.state.online = false;
    expect(
      await s.provider.createFileSystem({
        name: `cap-device-${DEVICE}`,
        limits: LIMITS,
        signal: signal(),
      }),
    ).toEqual({ id: DEVICE });
    await expect(
      s.provider.createFileSystem({ name: "cap-legacy", limits: LIMITS, signal: signal() }),
    ).rejects.toThrow("not a device name");
    expect(s.dial.sent).toEqual([]);
  });

  it("create binds the committed generation before returning", async () => {
    const s = setup();
    const h = (await s.provider.create({
      name: `cap-device-${DEVICE}`,
      limits: LIMITS,
      fileSystem: { id: DEVICE },
      signal: signal(),
    })) as LocalDeviceHandle;
    expect(s.dial.ops()).toEqual(["create", "bindInstance"]);
    expect(s.dial.sent[0]).toMatchObject({ args: { limits: LIMITS }, timeoutMs: OP_DEADLINE_MS });
    const binding = s.rows.get(DEVICE);
    expect(binding).toMatchObject({ status: "installed", generation: h.generation });
    expect(s.dial.sent[1]?.args).toEqual({
      instanceId: DEVICE,
      instanceGeneration: h.generation,
      bindingId: binding?.bindingId,
      expectedPreviousGeneration: null,
    });
    expect(h).toEqual({ id: DEVICE, roots: ROOTS, limits: LIMITS, generation: h.generation });
    // the next instance names this one as its previous
    const next = (await s.provider.create({
      name: `cap-device-${DEVICE}`,
      limits: LIMITS,
      fileSystem: { id: DEVICE },
      signal: signal(),
    })) as LocalDeviceHandle;
    expect(BigInt(next.generation)).toBeGreaterThan(BigInt(h.generation));
    expect(s.dial.sent.at(-1)?.args.expectedPreviousGeneration).toBe(h.generation);
  });

  it("create refuses an instance name of another file system and a machine that will not bind", async () => {
    const s = setup(
      machine({
        bindInstance: () => ({ ok: false, error: { kind: "unsupported", message: "old" } }),
      }),
    );
    await expect(
      s.provider.create({
        name: "cap-device-other",
        limits: LIMITS,
        fileSystem: { id: DEVICE },
        signal: signal(),
      }),
    ).rejects.toThrow("does not belong");
    const e = await rejection(
      s.provider.create({
        name: `cap-device-${DEVICE}`,
        limits: LIMITS,
        fileSystem: { id: DEVICE },
        signal: signal(),
      }),
    );
    expect(isSandboxPermissionUnsupportedError(e)).toBe(true);
    // committed, never installed: the generation attests nothing
    expect(s.rows.get(DEVICE)?.status).toBe("awaiting-device");
  });

  it("create and resume need the machine online", async () => {
    const offline = new DeviceOfflineError(DEVICE);
    const m = machine();
    const s = setup({
      ...m,
      answer: (req) => {
        if (!s.dial.state.online) throw offline;
        return m.answer(req);
      },
    });
    const h = await created(s);
    s.dial.state.online = false;
    expect(
      isDeviceOfflineError(
        await rejection(
          s.provider.create({
            name: `cap-device-${DEVICE}`,
            limits: LIMITS,
            fileSystem: { id: DEVICE },
            signal: signal(),
          }),
        ),
      ),
    ).toBe(true);
    expect(isDeviceOfflineError(await rejection(s.provider.resume(h, signal())))).toBe(true);
    s.dial.state.online = true;
    expect(await s.provider.resume(h, signal())).toBe("resumed");
  });

  it("resume ends the generation's background work, then re-verifies its identical binding", async () => {
    const s = setup();
    const h = await created(s);
    const binding = s.rows.get(DEVICE);
    expect(await s.provider.resume(h, signal())).toBe("resumed");
    expect(s.dial.ops()).toEqual(["create", "bindInstance"]);
    expect(s.dial.sent[1]?.args).toEqual({
      instanceId: DEVICE,
      instanceGeneration: h.generation,
      bindingId: binding?.bindingId,
      expectedPreviousGeneration: null,
    });
    expect(s.rows.get(DEVICE)).toEqual(binding);
  });

  it("resume answers gone when the instance can never be the machine's again", async () => {
    const s = setup();
    const h = await created(s);
    // a handle this provider did not make
    expect(await s.provider.resume({ id: DEVICE }, signal())).toBe("gone");
    // a new login into another directory or mode
    s.m.roots.current = { ...ROOTS, workspace: "/home/me/other/workspace" };
    expect(await s.provider.resume(h, signal())).toBe("gone");
    s.m.roots.current = ROOTS;
    // the program restarted with another runtime: the identical binding is refused
    s.m.binder.runtime = { ...s.m.binder.runtime, runtimeHash: "d".repeat(64) };
    expect(await s.provider.resume(h, signal())).toBe("gone");
    // the recreate binds a new generation, which then resumes
    const next = await created(s);
    expect(await s.provider.resume(next, signal())).toBe("resumed");
    // the old handle names a generation that is no longer the device's binding
    expect(await s.provider.resume(h, signal())).toBe("gone");
  });

  it("resume keeps transient binding failures as errors", async () => {
    let failure: unknown;
    const m = machine();
    const s = setup({
      ...m,
      answer: (req) => {
        if (req.op === "bindInstance" && failure !== undefined) {
          if (failure instanceof Error) throw failure;
          return failure;
        }
        return m.answer(req);
      },
    });
    const h = await created(s);
    failure = new DeviceRequestNotSentError("not sent");
    expect(isDeviceRequestNotSent(await rejection(s.provider.resume(h, signal())))).toBe(true);
    failure = { ok: false, error: { kind: "unsettled", message: "older work runs" } };
    expect(isSandboxWorkUnsettledError(await rejection(s.provider.resume(h, signal())))).toBe(true);
    failure = { ok: false, error: { kind: "denied", message: "chain refused" } };
    expect(await s.provider.resume(h, signal())).toBe("gone");
  });

  it("suspend and destroy end the generation's work on a connected machine", async () => {
    const s = setup();
    const h = await created(s);
    await s.provider.suspend(h, signal());
    await s.provider.destroy(h, signal());
    expect(s.dial.sent.map((r) => [r.op, r.args])).toEqual([
      ["create", { limits: LIMITS }],
      ["create", { limits: LIMITS }],
    ]);
  });

  it("an older handle's suspend or destroy leaves the live generation's work running", async () => {
    const s = setup();
    const old = await created(s);
    const live = await created(s);
    expect(live.generation).not.toBe(old.generation);
    await s.provider.suspend(old, signal());
    await s.provider.destroy(old, signal());
    // a handle with no stored binding at all reaches nothing either
    await s.provider.destroy({ ...live, id: "dev-other" }, signal());
    expect(s.dial.sent).toEqual([]);
    await s.provider.suspend(live, signal());
    expect(s.dial.ops()).toEqual(["create"]);
  });

  it("suspend, destroy and the file system cleanup never fail while offline or on a machine error", async () => {
    let refuse = false;
    const m = machine({
      create: () =>
        refuse
          ? { ok: false, error: { kind: "error", message: "x" } }
          : { ok: true, result: { roots: ROOTS } },
    });
    const s = setup(m);
    const h = await created(s);
    refuse = true;
    await s.provider.suspend(h, signal());
    await s.provider.destroy(h, signal());
    expect(s.warnings.map((w) => w.msg)).toEqual([
      "could not end the device's work on its machine at suspend",
      "could not end the device's work on its machine at destroy",
    ]);
    s.dial.sent.length = 0;
    s.dial.state.online = false;
    await s.provider.suspend(h, signal());
    await s.provider.destroy(h, signal());
    await s.provider.destroyByName(`cap-device-${DEVICE}`, signal());
    await s.provider.destroyFileSystem({ id: DEVICE }, signal());
    await s.provider.destroyFileSystemByName(`cap-device-${DEVICE}`, signal());
    await s.provider.destroyFileSystemByName("cap-legacy-conversation", signal());
    expect(s.dial.sent).toEqual([]);
  });

  it("the file system cleanup never reaches a connected machine; an abort still fails", async () => {
    const s = setup();
    await s.provider.destroyFileSystem({ id: DEVICE }, signal());
    await s.provider.destroyFileSystemByName(`cap-device-${DEVICE}`, signal());
    await s.provider.destroyByName(`cap-device-${DEVICE}`, signal());
    expect(s.dial.sent).toEqual([]);
    const h: LocalDeviceHandle = { id: DEVICE, roots: ROOTS, limits: LIMITS, generation: "1" };
    await expect(s.provider.suspend(h, AbortSignal.abort(new Error("lease lost")))).rejects.toThrow(
      "lease lost",
    );
  });
});
