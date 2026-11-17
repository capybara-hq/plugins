import { randomUUID } from "node:crypto";
import {
  isSandboxOperationOutcomeUnknownError,
  isSandboxPermissionUnsupportedError,
  isSandboxScopeDeniedError,
  isSandboxScopeValidationError,
  type SandboxFileScope,
  type SandboxHandle,
  type SandboxLimits,
  type SandboxNetworkScope,
  type SandboxOperationScope,
  type SandboxPermissionSupport,
  type SandboxProvider,
} from "@capybara-hq/plugin-sdk";
import {
  type NativeFixtureEntry,
  runSandboxNativeConformance,
  runSandboxPermissionConformance,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createE2BApi, type E2BApi, isE2BNotFound } from "../../src/e2b-api.js";
import { createE2BSandbox, DeploymentConfig, providerConfig } from "../../src/index.js";
import { OPERATION_AGENT, OPS_DIR, RUNTIME_DIR } from "../../src/runtime-source.js";

/**
 * Permission profiles on a real E2B template: `pnpm exec vitest run
 * plugins/sandbox-e2b/test/live/permission-scopes.live.test.ts`
 *
 * - Runs only when `CAPYBARA_TEST_E2B_API_KEY` is set (from the outer environment; nothing here
 *   reads a credential file or prints the key). `CAPYBARA_TEST_E2B_TEMPLATE` picks the template
 *   (unset: the alias built from this plugin's published image). Optional
 *   `CAPYBARA_TEST_E2B_API_URL` / `CAPYBARA_TEST_E2B_DOMAIN`.
 * - `CAPYBARA_TEST_REQUIRE_LINUX_RESTRICTED=1` (evidence mode) fails unless the template reports
 *   restricted support. The tested template does not (Linux 6.1, Landlock ABI 2 below the
 *   required 6), so that run fails by design: the support test names the template's facts.
 * - One VM for the whole file, owned by name and id; `afterAll` deletes it and asserts it absent
 *   (also after a failure).
 * - Covers: the template-specific probe (staged runtime root-owned and hash-checked), the SDK
 *   permission conformance's fail-closed branch on the actual provider, the SDK native
 *   conformance through Full access operations, Full access keeping the VM's OS rights and
 *   network (positive and negative) without restricted filters and without any VM-wide network
 *   update, consume-once, revocation before launch and of exactly the running operation, both
 *   overlap orders of a refused restricted grant and a Full operation, background executions
 *   (status, tail, positional reads, idempotent start, lost acknowledgement, natural exit, stop,
 *   revocation), records out of the device user's reach, trusted preparation, owner browsing, and
 *   status / stop / revocation that never resume a paused VM.
 */

const filled = (v: string | undefined): v is string =>
  v !== undefined && v.trim() !== "" && !v.startsWith("替换为");
const env = process.env;
const API_KEY = env.CAPYBARA_TEST_E2B_API_KEY;
const TEMPLATE = env.CAPYBARA_TEST_E2B_TEMPLATE;
const READY = filled(API_KEY);
const REQUIRED = env.CAPYBARA_TEST_REQUIRE_LINUX_RESTRICTED === "1";

if (!READY) console.info("[e2b-live] skipped: CAPYBARA_TEST_E2B_API_KEY not filled");

const enc = new TextEncoder();
const dec = new TextDecoder();
const sig = () => AbortSignal.timeout(180_000);
const limits: SandboxLimits = {
  cpu: 1,
  memoryMb: 2048,
  diskMb: 5120,
  mode: "sandbox",
  network: { kind: "allowlist", hosts: ["pypi.org"] },
};
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

describe.skipIf(!READY)("sandbox-e2b permission scopes (live)", { timeout: 300_000 }, () => {
  let sbx: SandboxProvider;
  let api: E2BApi;
  let h: SandboxHandle;
  /** The owned VM: its name is fixed before anything is created, its id recorded on creation. */
  const name = `cap-device-perm-${randomUUID()}`;
  let ownedId: string | undefined;
  /** `PUT /sandboxes/{id}/network` calls seen while the tests ran (none may happen). */
  const networkUpdates: string[] = [];
  const realFetch = globalThis.fetch;
  const lostAck = new Set<string>();

  const scope = (
    filesystem: SandboxFileScope = { kind: "device" },
    network: SandboxNetworkScope = { kind: "environment" },
    over: Partial<SandboxOperationScope> = {},
  ): SandboxOperationScope => ({
    operationId: `op-${randomUUID()}`,
    admitBeforeMs: Date.now() + 120_000,
    deviceId: "dev-live",
    rootConversationId: "conv-live",
    profileRevision: 1,
    ceilingRevision: "c1",
    profile: filesystem.kind === "device" ? "full-access" : "approve-for-me",
    actor: { accountId: "live", conversationId: "conv-live" },
    tag: randomUUID(),
    filesystem,
    network,
    ...over,
  });
  const restricted = (writeRoots = ["/workspace/perm-root"]): SandboxFileScope => ({
    kind: "scoped",
    readRoots: [],
    writeRoots,
  });
  /** Trusted out-of-band inspection: the provider's ordinary exec, never an operation. */
  const sh = async (command: string, timeoutMs = 60_000) =>
    sbx.exec(h, {
      command,
      timeoutMs,
      maxOutputBytes: 1 << 20,
      signal: sig(),
      tag: randomUUID(),
      actor: { accountId: "live", conversationId: "inspect" },
    });
  const full = async (s: SandboxOperationScope = scope()) => {
    const op = await sbx.operation?.(h, s, sig());
    if (!op) throw new Error("no operation support");
    return op;
  };
  const fullExec = async (command: string, timeoutMs = 60_000) =>
    (await full()).exec({ command, timeoutMs, maxOutputBytes: 1 << 20, signal: sig() });
  const waitForText = async (path: string, pending?: Promise<unknown>) => {
    let settled = false;
    void pending?.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    for (;;) {
      const r = await sbx.readFile(h, path, { maxBytes: 4096, signal: sig() });
      if (r && r.data.byteLength > 0) return dec.decode(r.data).trim();
      if (settled) throw new Error(`${path} never appeared before its operation settled`);
    }
  };
  const alive = async (pid: string) =>
    (await sh(`kill -0 ${pid} 2>/dev/null && echo alive || echo gone`)).stdout.trim() === "alive";
  const vmState = async () =>
    (await api.json<{ state?: string }>("GET", `/sandboxes/${ownedId}`, { signal: sig() })).data
      .state;

  beforeAll(async () => {
    const cfg = DeploymentConfig.parse({
      apiKey: API_KEY,
      ...(filled(TEMPLATE) && { template: TEMPLATE }),
      ...(filled(env.CAPYBARA_TEST_E2B_API_URL) && { apiUrl: env.CAPYBARA_TEST_E2B_API_URL }),
      ...(filled(env.CAPYBARA_TEST_E2B_DOMAIN) && { domain: env.CAPYBARA_TEST_E2B_DOMAIN }),
      timeoutSeconds: 900,
    });
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if ((init?.method ?? "GET") === "PUT" && /\/sandboxes\/[^/]+\/network$/.test(url)) {
        networkUpdates.push(new URL(url).pathname);
      }
      return realFetch(input, init);
    }) as typeof fetch;
    const log = { info: () => undefined, warn: console.warn, error: console.error };
    sbx = createE2BSandbox(
      providerConfig(cfg),
      { log },
      { loseBackgroundAck: (taskId) => lostAck.has(taskId) },
    );
    api = createE2BApi(cfg.apiUrl ?? `https://api.${cfg.domain}`, cfg.apiKey);
    console.info(`[e2b-live] owned VM name ${name}; template ${cfg.template ?? "(alias)"}`);
    const fileSystem = await sbx.createFileSystem({ name, limits, signal: sig() });
    ownedId = fileSystem.id;
    console.info(`[e2b-live] owned VM id ${ownedId}`);
    h = await sbx.create({ name, limits, fileSystem, signal: sig() });
    expect(h.id).toBe(ownedId);
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    if (!sbx || !api) return;
    await sbx.destroyFileSystemByName(name, sig());
    if (ownedId !== undefined) {
      const gone = await api
        .json("GET", `/sandboxes/${ownedId}`, { signal: sig() })
        .then(() => false)
        .catch((e: unknown) => isE2BNotFound(e));
      console.info(`[e2b-live] owned VM ${ownedId} deleted and absent: ${gone}`);
      expect(gone).toBe(true);
    }
    // The list endpoint lags the deletion (seen live: the detail answers 404 while the list still
    // shows the VM): poll it, bounded, until no VM of this name is listed.
    const deadline = Date.now() + 120_000;
    let listed: { sandboxID: string }[] = [];
    do {
      listed =
        (
          await api.json<{ sandboxID: string }[]>("GET", "/v2/sandboxes", {
            query: {
              metadata: new URLSearchParams({ "capybara-sandbox-name": name }).toString(),
              state: "running,paused",
            },
            signal: sig(),
          })
        ).data ?? [];
    } while (listed.length > 0 && Date.now() < deadline);
    console.info(`[e2b-live] VMs still listed under ${name}: ${listed.length}`);
    expect(listed).toEqual([]);
  });

  it("reports the template's own facts: restricted unavailable, Full access and background available", async () => {
    const support = (await sbx.permissionSupport?.(h, sig())) as SandboxPermissionSupport;
    console.info(`[e2b-live] permission support: ${JSON.stringify(support)}`);
    const facts = await sh(
      "uname -sr; uname -m; cat /sys/kernel/security/lsm; echo; cat /proc/sys/kernel/seccomp/actions_avail; " +
        "python3 -I -c 'import ctypes; l = ctypes.CDLL(None, use_errno=True); print(\"landlock_abi\", l.syscall(444, None, 0, 1))'; " +
        "test -e /proc/$$/task/$$/children && echo children=yes || echo children=no; " +
        `stat -c "%u %a %F %n" ${RUNTIME_DIR} ${RUNTIME_DIR}/* ${OPS_DIR}`,
    );
    console.info(`[e2b-live] template facts:\n${facts.stdout}${facts.stderr}`);
    if (REQUIRED) {
      expect(
        support.restricted,
        `CAPYBARA_TEST_REQUIRE_LINUX_RESTRICTED=1 but: ${support.unavailableReason ?? "unsupported"}`,
      ).not.toBeNull();
    }
    expect(support).toMatchObject({
      version: 1,
      restricted: null,
      fullAccess: true,
      background: true,
    });
    expect(support.unavailableReason).toMatch(/template kernel \S+/);
    // the staged runtime and the records are root-owned and not writable by the device user
    for (const line of facts.stdout
      .split("\n")
      .filter((l) => l.startsWith("0 ") || /^\d+ /.test(l))) {
      if (!line.includes("/opt/capybara-e2b")) continue;
      const [uid, mode] = line.split(" ");
      expect(uid, line).toBe("0");
      expect(Number.parseInt(mode as string, 8) & 0o022, line).toBe(0);
    }
  });

  it("passes the SDK permission conformance on the actual provider (fail-closed branch)", async () => {
    await sh("mkdir -p /workspace/perm-root /workspace/perm-sibling");
    // Counting endpoints inside the VM (loopback): each accepted connection appends a line.
    const server = (port: number, log: string) =>
      `nohup python3 -c ${quote(
        "import socket,sys\ns=socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)\n" +
          "s.bind(('127.0.0.1', int(sys.argv[1]))); s.listen(16)\n" +
          "while True:\n c,_=s.accept(); open(sys.argv[2],'a').write('x\\n'); c.close()",
      )} ${port} ${log} >/dev/null 2>&1 &`;
    // readiness: both ports listening (/proc/net/tcp, state 0A), without connecting to them
    await sh(
      `${server(18080, "/tmp/perm-granted.log")} ${server(18081, "/tmp/perm-ungranted.log")} ` +
        "until grep -q ':46A0 00000000:0000 0A' /proc/net/tcp && grep -q ':46A1 00000000:0000 0A' /proc/net/tcp; do :; done",
    );
    const receipts = (log: string) => async () => {
      const r = await sh(`cat ${log} 2>/dev/null | wc -l`);
      return Number(r.stdout.trim());
    };
    await runSandboxPermissionConformance({
      root: "/workspace/perm-root",
      sibling: "/workspace/perm-sibling",
      protectedPaths: ["/workspace/perm-sibling/protected"],
      endpoints: {
        granted: {
          name: "granted.permission.example",
          address: "127.0.0.1",
          port: 18080,
          receipts: receipts("/tmp/perm-granted.log"),
        },
        ungranted: [
          {
            name: "ungranted.permission.example",
            address: "127.0.0.1",
            port: 18081,
            receipts: receipts("/tmp/perm-ungranted.log"),
          },
        ],
        // E2B has no egress proxy of its own and this provider no forwarder: "direct" is the only
        // honest description (moot here: restricted grants are refused before any effect).
        access: "direct",
      },
      support: async () => (await sbx.permissionSupport?.(h, sig())) as SandboxPermissionSupport,
      operation: async (grant) => {
        const op = await sbx.operation?.(h, scope(grant.filesystem, grant.network), sig());
        if (!op) throw new Error("no operation support");
        return op;
      },
      seed: async (entries) => seed(entries),
      inspect: {
        readFile: async (path) =>
          (await sbx.readFile(h, path, { maxBytes: 1 << 20, signal: sig() }))?.data ?? null,
        mode: async (path) => {
          const r = await sh(`stat -c %a ${quote(path)} 2>/dev/null || true`);
          return r.stdout.trim() === "" ? null : Number.parseInt(r.stdout.trim(), 8);
        },
        alive: async (pids) => {
          const out: number[] = [];
          for (const p of pids) if (await alive(String(p))) out.push(p);
          return out;
        },
      },
      dispose: async () => {
        await sh("pkill -f 'perm-granted.log|perm-ungranted.log' || true");
      },
    });
    // the refused restricted exec left nothing behind
    expect((await sh("ls -A /workspace/perm-root")).stdout.trim()).toBe("");
  });

  /** Trusted setup in one ordinary exec (the native conformance seeds hundreds of entries). */
  const seed = async (entries: readonly NativeFixtureEntry[]) => {
    const lines = entries.map((e) => {
      const dir = `mkdir -p "$(dirname ${quote(e.path)})"`;
      if (e.kind === "directory") return `mkdir -p ${quote(e.path)}`;
      if (e.kind === "symlink") return `${dir} && ln -sfn ${quote(e.target)} ${quote(e.path)}`;
      const b64 = Buffer.from(e.data).toString("base64");
      return `${dir} && printf %s ${quote(b64)} | base64 -d > ${quote(e.path)}`;
    });
    const r = await sh(["set -e", ...lines].join("\n"), 120_000);
    if (r.exitCode !== 0) throw new Error(`seed failed: ${r.stderr}`);
  };

  it("passes the SDK native conformance through Full access operations", async () => {
    const root = `/workspace/native-${randomUUID()}`;
    await sh(`mkdir -p ${root}`);
    await runSandboxNativeConformance({
      root,
      operation: async () => full(),
      seed,
      dispose: async () => {
        await sh(`rm -rf ${root}`);
      },
    });
  });

  it("Full access keeps the VM's OS rights and network, without restricted filters or a network update", async () => {
    const before = await api.json<{ network?: unknown }>("GET", `/sandboxes/${ownedId}`, {
      signal: sig(),
    });
    const r = await fullExec(
      "id -u; grep -E '^(NoNewPrivs|Seccomp):' /proc/self/status; setsid true && echo setsid=ok; " +
        "touch /tmp/full-outside && echo outside=ok; " +
        "curl -sS -m 20 -o /dev/null -w 'pypi=%{http_code}\\n' https://pypi.org/simple/ || echo pypi=fail; " +
        "curl -sS -m 10 -o /dev/null https://example.com/ 2>/dev/null && echo example=reached || echo example=refused",
      90_000,
    );
    console.info(`[e2b-live] Full access controls:\n${r.stdout}${r.stderr}`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("1000\n");
    expect(r.stdout).toMatch(/NoNewPrivs:\s+0/);
    expect(r.stdout).toMatch(/Seccomp:\s+0/);
    expect(r.stdout).toContain("setsid=ok");
    expect(r.stdout).toContain("outside=ok");
    // the VM's own allowlist (pypi.org) decides: positive and negative
    expect(r.stdout).toContain("pypi=200");
    expect(r.stdout).toContain("example=refused");
    // a conversation's narrower or wider grant never changes the VM network: refused, unchanged
    const e = await sbx
      .operation?.(
        h,
        scope({ kind: "device" }, { kind: "allowlist", hosts: ["example.com"] }),
        sig(),
      )
      .catch((x: unknown) => x);
    expect(isSandboxPermissionUnsupportedError(e)).toBe(true);
    const after = await api.json<{ network?: unknown }>("GET", `/sandboxes/${ownedId}`, {
      signal: sig(),
    });
    expect(after.data.network).toEqual(before.data.network);
    expect(networkUpdates).toEqual([]);
  });

  it("consumes an operation ID once and never repeats its effect", async () => {
    const s = scope();
    const op = await full(s);
    const path = `/workspace/once-${randomUUID()}`;
    const first = await op.exec({
      command: `echo x >> ${path}; echo ran`,
      timeoutMs: 30_000,
      maxOutputBytes: 1000,
      signal: sig(),
    });
    expect(first.stdout.trim()).toBe("ran");
    const again = await op
      .exec({
        command: `echo x >> ${path}; echo ran`,
        timeoutMs: 30_000,
        maxOutputBytes: 1000,
        signal: sig(),
      })
      .catch((x: unknown) => x);
    expect(isSandboxOperationOutcomeUnknownError(again)).toBe(true);
    const other = await op.readFile(path, { maxBytes: 10, signal: sig() }).catch((x: unknown) => x);
    expect(isSandboxScopeValidationError(other)).toBe(true);
    expect((await sh(`wc -l < ${path}`)).stdout.trim()).toBe("1");
    const expired = await (
      await full(scope(undefined, undefined, { admitBeforeMs: Date.now() - 1 }))
    )
      .exec({ command: `echo x >> ${path}`, timeoutMs: 30_000, maxOutputBytes: 100, signal: sig() })
      .catch((x: unknown) => x);
    expect(isSandboxScopeDeniedError(expired)).toBe(true);
    expect((await sh(`wc -l < ${path}`)).stdout.trim()).toBe("1");
  });

  it("revokes before launch, and cancels exactly the revoked running operation", async () => {
    const early = scope();
    const refOf = (x: SandboxOperationScope) => ({
      operationId: x.operationId,
      admitBeforeMs: x.admitBeforeMs,
    });
    await sbx.revokeOperation?.(h, refOf(early), sig());
    const marker = `/workspace/revoked-${randomUUID()}`;
    const refused = await (await full(early))
      .exec({ command: `touch ${marker}`, timeoutMs: 30_000, maxOutputBytes: 100, signal: sig() })
      .catch((x: unknown) => x);
    expect(isSandboxScopeDeniedError(refused)).toBe(true);
    expect(await sbx.stat(h, marker, sig())).toBeNull();

    const a = scope();
    const pidA = `/workspace/rev-a-${randomUUID()}`;
    const pidB = `/workspace/rev-b-${randomUUID()}`;
    const siblingAbort = new AbortController();
    const runA = (await full(a)).exec({
      command: `echo $$ > ${pidA}; sleep 600`,
      timeoutMs: 600_000,
      maxOutputBytes: 100,
      signal: sig(),
    });
    const runB = (await full()).exec({
      command: `echo $$ > ${pidB}; sleep 600`,
      timeoutMs: 600_000,
      maxOutputBytes: 100,
      signal: siblingAbort.signal,
    });
    const [pa, pb] = [await waitForText(pidA, runA), await waitForText(pidB, runB)];
    await sbx.revokeOperation?.(h, refOf(a), sig());
    const settled = await runA.catch((x: unknown) => x);
    console.info(`[e2b-live] revoked running operation settled: ${JSON.stringify(settled)}`);
    expect(await alive(pa)).toBe(false);
    expect(await alive(pb)).toBe(true);
    siblingAbort.abort();
    expect((await runB).exitCode).toBeNull();
    expect(await alive(pb)).toBe(false);
  });

  it("refuses restricted grants in both overlap orders while Full access runs unaffected", async () => {
    const marker = `/workspace/perm-root/overlap-${randomUUID()}`;
    const restrictedRun = async () =>
      (await sbx.operation?.(h, scope(restricted()), sig()))?.exec({
        command: `touch ${marker}`,
        timeoutMs: 30_000,
        maxOutputBytes: 100,
        signal: sig(),
      });
    // Full first, then a restricted grant while it runs
    const fullPid = `/workspace/overlap-full-${randomUUID()}`;
    const long = fullExec(`echo $$ > ${fullPid}; sleep 3; echo full-done`);
    await waitForText(fullPid, long);
    expect(
      isSandboxPermissionUnsupportedError(await restrictedRun().catch((x: unknown) => x)),
    ).toBe(true);
    expect((await long).stdout.trim()).toBe("full-done");
    // restricted first (refused), then Full
    expect(
      isSandboxPermissionUnsupportedError(await restrictedRun().catch((x: unknown) => x)),
    ).toBe(true);
    expect((await fullExec("echo after")).stdout.trim()).toBe("after");
    expect(await sbx.stat(h, marker, sig())).toBeNull();
  });

  describe("background executions", () => {
    /** One retention for every start here: a same-ID retry must carry identical input. */
    const retainUntilMs = Date.now() + 3_600_000;
    const start = async (
      s: SandboxOperationScope,
      command: string,
      taskId = `task-${randomUUID()}`,
      outputPath = `/workspace/bg-${randomUUID()}.log`,
    ) => {
      const bg = sbx.background;
      if (!bg) throw new Error("no background support");
      return {
        outputPath,
        ref: await bg.start(h, s, {
          command,
          timeoutMs: 600_000,
          maxOutputBytes: 1 << 20,
          signal: sig(),
          taskId,
          outputPath,
          retainUntilMs,
        }),
      };
    };

    it("supervises Full access work exactly: status, tail, positional reads, idempotent start and stop", async () => {
      const s = scope();
      const taskId = `task-${randomUUID()}`;
      const outputPath = `/workspace/bg-${randomUUID()}.log`;
      const command =
        "for i in 1 2 3; do echo line $i; done; echo $$ > /workspace/bg-main.pid; sleep 600";
      const { ref } = await start(s, command, taskId, outputPath);
      expect(ref).toMatchObject({ operationId: s.operationId, instanceId: h.id });
      const pid = await waitForText("/workspace/bg-main.pid");
      expect(await sbx.background?.status(h, ref, sig())).toEqual({ state: "running" });
      // the same generation / operation / input returns the same reference and launches nothing
      expect((await start(s, command, taskId, outputPath)).ref).toEqual(ref);
      const tail = await sbx.background?.tail(h, ref, { maxBytes: 100, signal: sig() });
      expect(tail && "data" in tail && dec.decode(tail.data)).toContain("line 3");
      const part = await sbx.background?.readOutput(h, ref, {
        offset: 5,
        maxBytes: 6,
        signal: sig(),
      });
      expect(part).toMatchObject({ offset: 5, nextOffset: 11 });
      expect(part && "data" in part && dec.decode(part.data)).toBe("1\nline");
      const file = await sbx.readFile(h, outputPath, { maxBytes: 1000, signal: sig() });
      expect(file && dec.decode(file.data)).toContain("line 1\nline 2\nline 3\n");
      expect(await sbx.background?.stop(h, ref, { graceMs: 0, signal: sig() })).toEqual({
        outcome: "stopped",
      });
      expect(await alive(pid)).toBe(false);
      // a retried stop keeps the claimed outcome
      expect(await sbx.background?.stop(h, ref, { graceMs: 0, signal: sig() })).toEqual({
        outcome: "stopped",
      });
    });

    it("reports a natural exit and refuses an output path in the provider's records", async () => {
      const { ref } = await start(scope(), "echo done; exit 3");
      for (;;) {
        const st = await sbx.background?.status(h, ref, sig());
        if (st?.state !== "running") {
          expect(st).toEqual({ state: "exited", exitCode: 3, timedOut: false });
          break;
        }
      }
      expect(await sbx.background?.stop(h, ref, { graceMs: 0, signal: sig() })).toEqual({
        outcome: "already-exited",
        exitCode: 3,
        timedOut: false,
      });
      const e = await start(scope(), "true", undefined, `${OPS_DIR}/x.log`).catch(
        (x: unknown) => x,
      );
      expect(isSandboxScopeDeniedError(e)).toBe(true);
    });

    it("a lost acknowledgement keeps the one genuine start; the same-id retry returns its reference", async () => {
      const s = scope();
      const taskId = `lost-${randomUUID()}`;
      const outputPath = `/workspace/bg-${randomUUID()}.log`;
      const launches = `/workspace/launches-${randomUUID()}`;
      const command = `echo once >> ${launches}; sleep 600`;
      lostAck.add(taskId);
      const first = await start(s, command, taskId, outputPath).catch((x: unknown) => x);
      expect(isSandboxOperationOutcomeUnknownError(first)).toBe(true);
      lostAck.delete(taskId);
      const { ref } = await start(s, command, taskId, outputPath);
      expect(await sbx.background?.status(h, ref, sig())).toEqual({ state: "running" });
      expect((await sh(`wc -l < ${launches}`)).stdout.trim()).toBe("1");
      expect(await sbx.background?.stop(h, ref, { graceMs: 0, signal: sig() })).toEqual({
        outcome: "stopped",
      });
    });

    it("revocation stops exactly the revoked background execution", async () => {
      const a = scope();
      const pidA = `/workspace/bgrev-a-${randomUUID()}`;
      const pidB = `/workspace/bgrev-b-${randomUUID()}`;
      const { ref: refA } = await start(a, `echo $$ > ${pidA}; sleep 600`);
      const { ref: refB } = await start(scope(), `echo $$ > ${pidB}; sleep 600`);
      const [pa, pb] = [await waitForText(pidA), await waitForText(pidB)];
      await sbx.revokeOperation?.(
        h,
        { operationId: a.operationId, admitBeforeMs: a.admitBeforeMs },
        sig(),
      );
      expect(await alive(pa)).toBe(false);
      expect((await sbx.background?.status(h, refA, sig()))?.state).not.toBe("running");
      expect(await alive(pb)).toBe(true);
      expect(await sbx.background?.status(h, refB, sig())).toEqual({ state: "running" });
      await sbx.background?.stop(h, refB, { graceMs: 0, signal: sig() });
      expect(await alive(pb)).toBe(false);
    });
  });

  it("keeps the records and the runtime out of the device user's reach, even with Full access", async () => {
    const r = await fullExec(
      `ls ${OPS_DIR} 2>/dev/null && echo listed || echo unlisted; ` +
        `touch ${OPS_DIR}/forged 2>/dev/null && echo forged || echo refused; ` +
        `: >> ${OPERATION_AGENT} 2>/dev/null && echo agent-writable || echo agent-readonly`,
    );
    expect(r.stdout).toContain("unlisted");
    expect(r.stdout).toContain("refused");
    expect(r.stdout).toContain("agent-readonly");
    // a Full command cannot fake the admission refusal (no nonce): its own exit is reported
    const fake = await fullExec(
      `printf 'R\\000\\000\\000\\101{"events":[{"event":"refused","code":"REVOKED"}],"nonce":"x"}'; exit 125`,
    );
    expect(fake.exitCode).toBe(125);
  });

  it("prepares skills as root and attachments as the device user; browses metadata only", async () => {
    const skillDir = `/skills/perm-${randomUUID()}`;
    const prep = await sbx.prepare?.(
      h,
      {
        operationId: `p-${randomUUID()}`,
        deviceId: "dev-live",
        purpose: "skills",
        writeRoots: [skillDir],
        tag: "t",
      },
      sig(),
    );
    await prep?.writeFile(`${skillDir}/SKILL.md`, enc.encode("# skill"), sig());
    expect((await sh(`stat -c "%u %a" ${skillDir}/SKILL.md`)).stdout.trim()).toBe("0 644");
    const att = `/workspace/attachments/conv-${randomUUID()}`;
    const attPrep = await sbx.prepare?.(
      h,
      {
        operationId: `p-${randomUUID()}`,
        deviceId: "dev-live",
        purpose: "attachments",
        writeRoots: [att],
        tag: "t",
      },
      sig(),
    );
    await attPrep?.writeFile(`${att}/a.txt`, enc.encode("att"), sig());
    expect((await sh(`stat -c %u ${att}/a.txt`)).stdout.trim()).toBe("1000");
    const browse = await sbx.browse?.(
      h,
      {
        operationId: `b-${randomUUID()}`,
        admitBeforeMs: Date.now() + 60_000,
        deviceId: "dev-live",
        accountId: "live",
        ceilingRevision: "c1",
        readRoots: [att],
        tag: "t",
      },
      sig(),
    );
    expect(await browse?.list(att, { limit: 10, signal: sig() })).toEqual({
      entries: [{ name: "a.txt", isDir: false }],
      truncated: false,
    });
  });

  it("status, output, stop and revocation never resume a paused VM", async () => {
    const s = scope();
    const { ref } = await (async () => {
      const bg = sbx.background;
      if (!bg) throw new Error("no background support");
      return {
        ref: await bg.start(h, s, {
          command: "sleep 600",
          timeoutMs: 600_000,
          maxOutputBytes: 100,
          signal: sig(),
          taskId: `pause-${randomUUID()}`,
          outputPath: `/workspace/bg-${randomUUID()}.log`,
          retainUntilMs: Date.now() + 3_600_000,
        }),
      };
    })();
    await sbx.suspend(h, sig());
    expect(await vmState()).toBe("paused");
    expect(await sbx.background?.status(h, ref, sig())).toEqual({ state: "lost" });
    expect(await sbx.background?.tail(h, ref, { maxBytes: 10, signal: sig() })).toEqual({
      unavailable: "lost",
    });
    expect(await sbx.background?.stop(h, ref, { graceMs: 0, signal: sig() })).toEqual({
      outcome: "lost",
    });
    await sbx.revokeOperation?.(
      h,
      { operationId: s.operationId, admitBeforeMs: Date.now() - 1 },
      sig(),
    );
    await expect(sbx.permissionSupport?.(h, sig())).rejects.toThrow(/not running/);
    expect(await vmState()).toBe("paused");
    // resumed later (a cold boot: new generation), the old reference stays lost
    await sbx.resume(h, sig());
    expect(await sbx.background?.status(h, ref, sig())).toEqual({ state: "lost" });
  });
});
