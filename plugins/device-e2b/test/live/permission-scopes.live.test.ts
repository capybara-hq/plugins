import { randomUUID } from "node:crypto";
import {
  type DeviceProvider,
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
} from "@capybara-hq/plugin-sdk";
import {
  type NativeFixtureEntry,
  runSandboxNativeConformance,
  runSandboxPermissionConformance,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createE2BApi,
  type E2BApi,
  type EnvdTarget,
  envdStart,
  isE2BNotFound,
} from "../../src/e2b-api.js";
import { createE2BSandbox, DeploymentConfig, providerConfig } from "../../src/index.js";
import {
  OPERATION_AGENT,
  OPERATION_AGENT_SHA256,
  OPS_DIR,
  RUNTIME_DIR,
} from "../../src/runtime-source.js";

/**
 * Permission profiles on a real E2B template: `pnpm exec vitest run
 * plugins/device-e2b/test/live/permission-scopes.live.test.ts`
 *
 * - Runs only when `CAPYBARA_TEST_E2B_API_KEY` is set (from the outer environment; nothing here
 *   reads a credential file or prints the key). `CAPYBARA_TEST_E2B_TEMPLATE` picks the template
 *   (unset: the alias built from this plugin's published image). Optional
 *   `CAPYBARA_TEST_E2B_API_URL` / `CAPYBARA_TEST_E2B_DOMAIN`.
 * - One VM for the whole file, owned by name and id; `afterAll` deletes it and asserts it absent
 *   (also after a failure).
 * - Covers: support v2 (the microVM is the sandbox: `boundary: "instance"`, no restricted
 *   filters, no outside; the staged runtime root-owned and hash-checked), the SDK permission
 *   conformance on the actual provider, the SDK native conformance through whole-instance
 *   operations, every profile running the whole instance with the VM's OS rights and network
 *   (positive and negative) without any VM-wide network update, the escalated pair refused,
 *   consume-once, revocation before launch and of exactly the running operation, both overlap
 *   orders of a refused narrower grant and a whole-instance operation, background executions
 *   (status, tail, positional reads, idempotent start, lost acknowledgement, natural exit, stop,
 *   revocation), records out of the device user's reach, trusted preparation, owner browsing, a
 *   planted runtime directory root never runs, concurrent first-time staging, an aborted native
 *   write killed in the VM, and
 *   status / stop / revocation that never resume a paused VM.
 */

const filled = (v: string | undefined): v is string =>
  v !== undefined && v.trim() !== "" && !v.startsWith("替换为");
const env = process.env;
const API_KEY = env.CAPYBARA_TEST_E2B_API_KEY;
const TEMPLATE = env.CAPYBARA_TEST_E2B_TEMPLATE;
const READY = filled(API_KEY);

if (!READY) console.info("[e2b-live] skipped: CAPYBARA_TEST_E2B_API_KEY not filled");

const enc = new TextEncoder();
const dec = new TextDecoder();
const sig = () => AbortSignal.timeout(180_000);
const limits: SandboxLimits = {
  cpu: 1,
  memoryMb: 2048,
  diskMb: 5120,
  network: { kind: "allowlist", hosts: ["pypi.org"] },
};
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

describe.skipIf(!READY)("device-e2b permission scopes (live)", { timeout: 300_000 }, () => {
  let sbx: DeviceProvider;
  let api: E2BApi;
  let h: SandboxHandle;
  /** The owned VM: its name is fixed before anything is created, its id recorded on creation. */
  const name = `cap-device-perm-${randomUUID()}`;
  let ownedId: string | undefined;
  /** `PUT /sandboxes/{id}/network` calls seen while the tests ran (none may happen). */
  const networkUpdates: string[] = [];
  const realFetch = globalThis.fetch;
  const lostAck = new Set<string>();
  /** Further VMs a test made (destroyed by that test, and again here after a failure). */
  const extraNames: string[] = [];

  /** The kernel's scope on an instance-boundary device: the whole filesystem plus the root. */
  const INSTANCE: SandboxFileScope = {
    kind: "scoped",
    projectRoot: "/workspace",
    writeRoots: ["/", "/workspace"],
  };
  const scope = (
    filesystem: SandboxFileScope = INSTANCE,
    network: SandboxNetworkScope = { kind: "allowlist", hosts: ["pypi.org"] },
    over: Partial<SandboxOperationScope> = {},
  ): SandboxOperationScope => ({
    operationId: `op-${randomUUID()}`,
    admitBeforeMs: Date.now() + 120_000,
    deviceId: "dev-live",
    rootConversationId: "conv-live",
    profileRevision: 1,
    ceilingRevision: "c1",
    profile:
      filesystem === INSTANCE || filesystem.kind === "device" ? "full-access" : "approve-for-me",
    actor: { accountId: "live", conversationId: "conv-live" },
    tag: randomUUID(),
    filesystem,
    network,
    ...over,
  });
  const restricted = (writeRoots = ["/workspace/perm-root"]): SandboxFileScope => ({
    kind: "scoped",
    projectRoot: null,
    writeRoots,
  });
  /** Trusted out-of-band inspection: the provider's ordinary exec, never an operation. */
  const sh = async (command: string, timeoutMs = 60_000) => shOn(h, command, timeoutMs);
  const shOn = async (handle: SandboxHandle, command: string, timeoutMs = 60_000) =>
    sbx.exec(handle, {
      command,
      timeoutMs,
      maxOutputBytes: 1 << 20,
      signal: sig(),
      tag: randomUUID(),
      actor: { accountId: "live", conversationId: "inspect" },
    });
  const instanceOp = async (s: SandboxOperationScope = scope()) => {
    const op = await sbx.operation?.(h, s, sig());
    if (!op) throw new Error("no operation support");
    return op;
  };
  const instanceExec = async (command: string, timeoutMs = 60_000) =>
    (await instanceOp()).exec({ command, timeoutMs, maxOutputBytes: 1 << 20, signal: sig() });
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
    for (const extra of extraNames) await sbx.destroyFileSystemByName(extra, sig());
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

  it("reports support v2: the instance boundary, no restricted filters, no outside, background available", async () => {
    const support = (await sbx.permissionSupport?.(h, sig())) as SandboxPermissionSupport;
    console.info(`[e2b-live] permission support: ${JSON.stringify(support)}`);
    const facts = await sh(
      "uname -sr; uname -m; cat /sys/kernel/security/lsm; echo; cat /proc/sys/kernel/seccomp/actions_avail; " +
        "python3 -I -c 'import ctypes; l = ctypes.CDLL(None, use_errno=True); print(\"landlock_abi\", l.syscall(444, None, 0, 1))'; " +
        "test -e /proc/$$/task/$$/children && echo children=yes || echo children=no; " +
        `stat -c "%u %a %F %n" ${RUNTIME_DIR} ${RUNTIME_DIR}/* ${OPS_DIR}`,
    );
    console.info(`[e2b-live] template facts:\n${facts.stdout}${facts.stderr}`);
    expect(support).toEqual({
      version: 2,
      boundary: "instance",
      restricted: null,
      network: { openPublic: true, allowlist: true, perOperationHosts: false },
      outsideSandbox: false,
      background: true,
    });
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

  it("passes the SDK permission conformance on the actual provider (instance boundary)", async () => {
    // A VM of its own whose allowlist names exactly the granted name (the harness proves a scope
    // naming more hosts widens nothing; one naming fewer is refused as narrower than the VM's).
    const confName = `cap-device-perm-${randomUUID()}`;
    extraNames.push(confName);
    const confLimits: SandboxLimits = {
      ...limits,
      network: { kind: "allowlist", hosts: ["granted.permission.example"] },
    };
    const fileSystem = await sbx.createFileSystem({
      name: confName,
      limits: confLimits,
      signal: sig(),
    });
    console.info(`[e2b-live] conformance VM ${confName} id ${fileSystem.id}`);
    const ch = await sbx.create({ name: confName, limits: confLimits, fileSystem, signal: sig() });
    const run = (command: string, timeoutMs?: number) => shOn(ch, command, timeoutMs);
    try {
      await run("mkdir -p /workspace/perm-root /workspace/perm-sibling");
      await run("printf rc > /workspace/perm-sibling/protected");
      // E2B lets the fixture count no connection outside the VM, and the VM's own loopback is
      // inside the sandbox: the endpoints are public addresses the allowlist must refuse, with no
      // receipts of their own (every refusal is proved by the command's own failure).
      const none = async () => 0;
      await runSandboxPermissionConformance({
        root: "/workspace/perm-root",
        sibling: "/workspace/perm-sibling",
        protectedPaths: ["/workspace/perm-sibling/protected"],
        endpoints: {
          // A documentation address (TEST-NET-3): the name resolves nowhere, so no connection can
          // reach it; the positive allowlist reach is "the network allowlist" above (pypi.org).
          granted: {
            name: "granted.permission.example",
            address: "203.0.113.10",
            port: 18080,
            receipts: none,
          },
          // A public name on no allowlist, on a port E2B filters by IP only (by name the request
          // never gets an answer). Its raw address is the IPv6 one: E2B's egress accepts the TCP
          // handshake for a refused IPv4 destination and drops the data (README, "A rejected TCP
          // connection may look connected"), so a raw IPv4 connect cannot tell a refusal apart;
          // the VM has no IPv6 route, so this connect fails as a refusal must.
          ungranted: [
            {
              name: "one.one.one.one",
              address: "2606:4700:4700::1111",
              port: 8080,
              receipts: none,
            },
          ],
          // E2B has no egress proxy of its own and this provider no forwarder.
          access: "direct",
          namedReach: {
            unavailable:
              "E2B lets the fixture map no name to an endpoint it can count (no hosts entry the VM's " +
              "allowlist honours); the positive reach is this file's pypi.org allowlist test",
          },
          // A name the VM's resolver does not know, served at the metadata address in the
          // harness's sense: an allowlisted name never reaches a closed class (E2B's own metadata
          // service answers regardless of policy, a residual recorded in the README).
          closedGranted: [
            {
              label: "metadata",
              host: "metadata.permission.example",
              port: 80,
              address: "169.254.169.254",
            },
          ],
        },
        instanceNetwork: "allowlist",
        support: async () => (await sbx.permissionSupport?.(ch, sig())) as SandboxPermissionSupport,
        operation: async (grant) => {
          const op = await sbx.operation?.(ch, scope(grant.filesystem, grant.network), sig());
          if (!op) throw new Error("no operation support");
          return op;
        },
        seed: async (entries) => seedWith(run, entries),
        inspect: {
          readFile: async (path) =>
            (await sbx.readFile(ch, path, { maxBytes: 1 << 20, signal: sig() }))?.data ?? null,
          mode: async (path) => {
            const r = await run(`stat -c %a ${quote(path)} 2>/dev/null || true`);
            return r.stdout.trim() === "" ? null : Number.parseInt(r.stdout.trim(), 8);
          },
          alive: async (pids) => {
            const out: number[] = [];
            for (const p of pids) {
              const r = await run(`kill -0 ${p} 2>/dev/null && echo alive || echo gone`);
              if (r.stdout.trim() === "alive") out.push(p);
            }
            return out;
          },
        },
        dispose: async () => undefined,
      });
    } finally {
      await sbx.destroyFileSystemByName(confName, sig());
    }
  });

  /** Trusted setup in one ordinary exec (the native conformance seeds hundreds of entries). */
  const seed = async (entries: readonly NativeFixtureEntry[]) => seedWith(sh, entries);
  const seedWith = async (
    run: (command: string, timeoutMs?: number) => ReturnType<typeof sh>,
    entries: readonly NativeFixtureEntry[],
  ) => {
    const lines = entries.map((e) => {
      const dir = `mkdir -p "$(dirname ${quote(e.path)})"`;
      if (e.kind === "directory") return `mkdir -p ${quote(e.path)}`;
      if (e.kind === "symlink") return `${dir} && ln -sfn ${quote(e.target)} ${quote(e.path)}`;
      const b64 = Buffer.from(e.data).toString("base64");
      return `${dir} && printf %s ${quote(b64)} | base64 -d > ${quote(e.path)}`;
    });
    const r = await run(["set -e", ...lines].join("\n"), 120_000);
    if (r.exitCode !== 0) throw new Error(`seed failed: ${r.stderr}`);
  };

  it("passes the SDK native conformance through whole-instance operations", async () => {
    const root = `/workspace/native-${randomUUID()}`;
    await sh(`mkdir -p ${root}`);
    await runSandboxNativeConformance({
      root,
      operation: async () => instanceOp(),
      seed,
      dispose: async () => {
        await sh(`rm -rf ${root}`);
      },
    });
  });

  it("every profile runs the whole instance with the VM's OS rights and network, without a network update", async () => {
    const before = await api.json<{ network?: unknown }>("GET", `/sandboxes/${ownedId}`, {
      signal: sig(),
    });
    for (const profile of ["request-approval", "approve-for-me", "full-access"] as const) {
      const r = await (await instanceOp(scope(INSTANCE, undefined, { profile }))).exec({
        command:
          "id -u; grep -E '^(NoNewPrivs|Seccomp):' /proc/self/status; setsid true && echo setsid=ok; " +
          `touch /tmp/whole-${profile} && echo outside=ok; ` +
          "curl -sS -m 20 -o /dev/null -w 'pypi=%{http_code}\\n' https://pypi.org/simple/ || echo pypi=fail; " +
          "curl -sS -m 10 -o /dev/null https://example.com/ 2>/dev/null && echo example=reached || echo example=refused",
        timeoutMs: 90_000,
        maxOutputBytes: 1 << 20,
        signal: sig(),
      });
      console.info(`[e2b-live] whole instance (${profile}):\n${r.stdout}${r.stderr}`);
      expect(r.exitCode, profile).toBe(0);
      expect(r.stdout).toContain("1000\n");
      expect(r.stdout).toMatch(/NoNewPrivs:\s+0/);
      expect(r.stdout).toMatch(/Seccomp:\s+0/);
      expect(r.stdout).toContain("setsid=ok");
      expect(r.stdout).toContain("outside=ok");
      // the VM's own allowlist (pypi.org) decides: positive and negative
      expect(r.stdout, profile).toContain("pypi=200");
      expect(r.stdout, profile).toContain("example=refused");
    }
    // an instance has no outside: the escalated pair is refused, the VM network unchanged
    const e = await sbx
      .operation?.(h, scope({ kind: "device" }, { kind: "environment" }), sig())
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
    const op = await instanceOp(s);
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
      await instanceOp(scope(undefined, undefined, { admitBeforeMs: Date.now() - 1 }))
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
    const refused = await (await instanceOp(early))
      .exec({ command: `touch ${marker}`, timeoutMs: 30_000, maxOutputBytes: 100, signal: sig() })
      .catch((x: unknown) => x);
    expect(isSandboxScopeDeniedError(refused)).toBe(true);
    expect(await sbx.stat(h, marker, sig())).toBeNull();

    const a = scope();
    const pidA = `/workspace/rev-a-${randomUUID()}`;
    const pidB = `/workspace/rev-b-${randomUUID()}`;
    const siblingAbort = new AbortController();
    const runA = (await instanceOp(a)).exec({
      command: `echo $$ > ${pidA}; sleep 600`,
      timeoutMs: 600_000,
      maxOutputBytes: 100,
      signal: sig(),
    });
    const runB = (await instanceOp()).exec({
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

  it("refuses narrower grants in both overlap orders while whole-instance work runs unaffected", async () => {
    const marker = `/workspace/perm-root/overlap-${randomUUID()}`;
    const restrictedRun = async () =>
      (await sbx.operation?.(h, scope(restricted()), sig()))?.exec({
        command: `touch ${marker}`,
        timeoutMs: 30_000,
        maxOutputBytes: 100,
        signal: sig(),
      });
    // whole-instance work first, then a narrower grant while it runs
    const fullPid = `/workspace/overlap-full-${randomUUID()}`;
    const long = instanceExec(`echo $$ > ${fullPid}; sleep 3; echo full-done`);
    await waitForText(fullPid, long);
    expect(
      isSandboxPermissionUnsupportedError(await restrictedRun().catch((x: unknown) => x)),
    ).toBe(true);
    expect((await long).stdout.trim()).toBe("full-done");
    // narrower first (refused), then the whole instance
    expect(
      isSandboxPermissionUnsupportedError(await restrictedRun().catch((x: unknown) => x)),
    ).toBe(true);
    expect((await instanceExec("echo after")).stdout.trim()).toBe("after");
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

    it("supervises whole-instance work exactly: status, tail, positional reads, idempotent start and stop", async () => {
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

  it("keeps the records and the runtime out of the device user's reach, even on the whole instance", async () => {
    const r = await instanceExec(
      `ls ${OPS_DIR} 2>/dev/null && echo listed || echo unlisted; ` +
        `touch ${OPS_DIR}/forged 2>/dev/null && echo forged || echo refused; ` +
        `: >> ${OPERATION_AGENT} 2>/dev/null && echo agent-writable || echo agent-readonly`,
    );
    expect(r.stdout).toContain("unlisted");
    expect(r.stdout).toContain("refused");
    expect(r.stdout).toContain("agent-readonly");
    // a command cannot fake the admission refusal (no nonce): its own exit is reported
    const fake = await instanceExec(
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

  /** Test-only root setup straight through envd (never the provider). */
  const rootSh = async (command: string) => {
    const info = (
      await api.json<{ envdAccessToken: string; domain?: string | null }>(
        "GET",
        `/sandboxes/${ownedId}`,
        { signal: sig() },
      )
    ).data;
    const domain =
      info.domain ||
      (filled(env.CAPYBARA_TEST_E2B_DOMAIN) ? env.CAPYBARA_TEST_E2B_DOMAIN : "e2b.app");
    const t: EnvdTarget = {
      url: `https://49983-${ownedId}.${domain}`,
      sandboxId: ownedId as string,
      accessToken: info.envdAccessToken,
    };
    let out = "";
    let code: number | undefined;
    await envdStart(
      t,
      "root",
      { cmd: "/bin/sh", args: ["-c", command], cwd: "/" },
      (e) => {
        if ("data" in e)
          out += Buffer.from(e.data.stdout ?? e.data.stderr ?? "", "base64").toString();
        if ("end" in e) code = e.end.exitCode ?? 0;
      },
      sig(),
    );
    return { out, code };
  };

  it("root never runs a planted runtime directory: it is replaced and verified first", async () => {
    // plant: the runtime directory owned by the device user, world-writable, with an agent
    // that would leave a mark if root ran it
    const planted = await rootSh(
      `rm -rf ${RUNTIME_DIR} /tmp/pwned-root && mkdir -p ${RUNTIME_DIR} && ` +
        `printf '%s\\n' 'import os' 'open("/tmp/pwned-root", "w").write(str(os.getuid()))' > ${OPERATION_AGENT} && ` +
        `chown -R 1000:1000 ${RUNTIME_DIR} && chmod 0777 ${RUNTIME_DIR} && echo planted`,
    );
    expect(planted.out).toContain("planted");
    const r = await instanceExec("echo verified");
    expect(r.stdout.trim()).toBe("verified");
    expect(await sbx.stat(h, "/tmp/pwned-root", sig())).toBeNull();
    const after = await sh(
      `stat -c "%u %a" ${RUNTIME_DIR} ${OPERATION_AGENT}; sha256sum ${OPERATION_AGENT}`,
    );
    expect(after.stdout).toMatch(/^0 755\n0 644\n/);
    expect(after.stdout).toContain(OPERATION_AGENT_SHA256);
  });

  it("concurrent first-time staging: both calls run, one trusted runtime remains", async () => {
    const removed = await rootSh(`rm -rf ${RUNTIME_DIR} && echo removed`);
    expect(removed.out).toContain("removed");
    const [a, b] = await Promise.all([instanceExec("echo first"), instanceExec("echo second")]);
    expect(a.stdout.trim()).toBe("first");
    expect(b.stdout.trim()).toBe("second");
    const after = await sh(
      `stat -c "%u %a" ${RUNTIME_DIR} ${OPERATION_AGENT}; sha256sum ${OPERATION_AGENT}`,
    );
    expect(after.stdout).toMatch(/^0 755\n0 644\n/);
    expect(after.stdout).toContain(OPERATION_AGENT_SHA256);
  });

  it("an aborted native write is killed in the VM and never lands", async () => {
    const path = `/workspace/aborted-${randomUUID()}.bin`;
    const ac = new AbortController();
    const op = await instanceOp();
    // ~40 MB travels through envd stdin for tens of seconds: abort once the agent runs
    const write = op.writeFile(path, new Uint8Array(40 * 1024 * 1024).fill(7), ac.signal);
    const agentPids = async () =>
      (await sh("pgrep -f 'capybara-operation[.]py direct' || true")).stdout.trim();
    let settled = false;
    void write.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    while ((await agentPids()) === "") {
      if (settled) throw new Error("the write settled before its agent was seen");
    }
    ac.abort();
    await expect(write).rejects.toThrow();
    // readiness, not a fixed wait: the killed agent disappears (bounded by the live timeout)
    while ((await agentPids()) !== "") {
      /* poll */
    }
    expect(await sbx.stat(h, path, sig())).toBeNull();
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
    // pending while paused, even past its deadline (a paused VM cannot confirm the kill)
    await expect(
      sbx.revokeOperation?.(
        h,
        { operationId: s.operationId, admitBeforeMs: Date.now() - 1 },
        sig(),
      ),
    ).rejects.toThrow(/not running/);
    await expect(sbx.permissionSupport?.(h, sig())).rejects.toThrow(/not running/);
    expect(await vmState()).toBe("paused");
    // resumed later (a cold boot: new generation), the old reference stays lost
    await sbx.resume(h, sig());
    expect(await sbx.background?.status(h, ref, sig())).toEqual({ state: "lost" });
  });
});
