import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  isSandboxPermissionUnsupportedError,
  type SandboxHandle,
  type SandboxOperationScope,
} from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  type AgentRun,
  type AgentRunOpts,
  createOperations,
  type OperationTransport,
} from "../src/operations.js";
import { RUNTIME_DIR, stagedRuntimeDigests } from "../src/runtime-source.js";

/**
 * The instance boundary (approval-only profiles design, decision 1), without Docker: the container
 * is the sandbox, so the provider reports support v2 with `boundary: "instance"` and no restricted
 * filters, runs the kernel's whole-instance scope on its ordinary exec and file paths, and refuses
 * before any effect a narrower filesystem grant (restricted filters it does not offer) and the
 * escalated pair (there is no outside of the instance).
 */

const h: SandboxHandle = { id: "cap-device-test" };
const sig = () => AbortSignal.timeout(10_000);

const frame = (kind: string, body: unknown) => {
  const data = Buffer.from(JSON.stringify(body));
  const head = Buffer.alloc(5);
  head.write(kind, 0, "ascii");
  head.writeUInt32BE(data.byteLength, 1);
  return Buffer.concat([head, data]);
};
const ok = (stdout: Buffer | string = ""): AgentRun => ({
  exitCode: 0,
  stdout: Buffer.from(stdout),
  stderr: Buffer.alloc(0),
  truncated: false,
  timedOut: false,
  aborted: false,
});

/** The staged-runtime probe's answer: owners, modes and digests as the image stages them. */
function stagedAnswer(tamper?: "digest" | "writable") {
  const digests = stagedRuntimeDigests();
  const names = Object.keys(digests).sort();
  const lines = [
    "0 755 directory .",
    "0 755 directory /opt",
    ...names.map((n) => `0 ${tamper === "writable" ? "666" : "644"} regular file ${n}`),
    ...names.map((n) => `${tamper === "digest" ? "0".repeat(64) : digests[n]}  ${n}`),
  ];
  return `${lines.join("\n")}\n`;
}

function fakeTransport(staged = stagedAnswer()) {
  const calls: { method: string; cmd: string[] }[] = [];
  const t: OperationTransport = {
    async run(_h, o: AgentRunOpts) {
      calls.push({ method: "run", cmd: o.cmd });
      if (o.cmd.includes("consume")) return ok(frame("R", { state: "new", generation: "g1" }));
      return ok(frame("R", { events: [] }));
    },
    async runIfRunning(_h, o: AgentRunOpts) {
      calls.push({ method: "runIfRunning", cmd: o.cmd });
      if (o.cmd[0] === "/bin/sh" && o.cmd.includes(RUNTIME_DIR)) return ok(staged);
      return ok(frame("R", {}));
    },
    async execFull(_h, args, _ctl, prefix) {
      calls.push({ method: "execFull", cmd: [...prefix, args.command] });
      return { exitCode: 0, stdout: "ran", stderr: "", truncated: false, timedOut: false };
    },
    async killOperation() {
      calls.push({ method: "killOperation", cmd: [] });
    },
  };
  return { t, calls };
}

const scope = (over: Partial<SandboxOperationScope> = {}): SandboxOperationScope => ({
  operationId: `op-${randomUUID()}`,
  admitBeforeMs: Date.now() + 60_000,
  deviceId: "dev-1",
  rootConversationId: "conv-1",
  profileRevision: 1,
  ceilingRevision: "c1",
  profile: "full-access",
  actor: { accountId: "acc-1", conversationId: "conv-1" },
  tag: "t-1",
  // the kernel's instance scope: the whole filesystem plus the working root
  filesystem: { kind: "scoped", readRoots: ["/", "/workspace"], writeRoots: ["/", "/workspace"] },
  network: { kind: "open-public" },
  ...over,
});

describe("support v2", () => {
  it("reports the instance boundary: no restricted filters, no outside, the instance network", async () => {
    const { t, calls } = fakeTransport();
    const ops = createOperations({ transport: t, network: { openPublic: true } });
    expect(await ops.permissionSupport(h, sig())).toEqual({
      version: 2,
      boundary: "instance",
      restricted: null,
      network: { openPublic: true, allowlist: true, perOperationHosts: false },
      outsideSandbox: false,
      background: true,
    });
    // probing never starts the instance, and needs no restricted-runtime probe any more
    expect(calls.every((c) => c.method === "runIfRunning")).toBe(true);
    expect(calls.some((c) => c.cmd.includes("probe"))).toBe(false);
  });

  it("reports no open network where the deployment refuses it", async () => {
    const { t } = fakeTransport();
    const ops = createOperations({ transport: t, network: { openPublic: false } });
    expect((await ops.permissionSupport(h, sig())).network).toEqual({
      openPublic: false,
      allowlist: true,
      perOperationHosts: false,
    });
  });

  it.each(["digest", "writable"] as const)(
    "a staged runtime with a bad %s offers nothing and says why",
    async (tamper) => {
      const { t } = fakeTransport(stagedAnswer(tamper));
      const ops = createOperations({ transport: t, network: { openPublic: true } });
      const support = await ops.permissionSupport(h, sig());
      expect(support).toMatchObject({
        version: 2,
        boundary: "instance",
        restricted: null,
        network: { openPublic: false, allowlist: false, perOperationHosts: false },
        outsideSandbox: false,
        background: false,
      });
      expect(support.unavailableReason).toMatch(/staged/);
    },
  );
});

describe("operation scopes", () => {
  const ops = () => {
    const f = fakeTransport();
    return {
      ...f,
      ops: createOperations({ transport: f.t, network: { openPublic: true } }),
    };
  };

  it("refuses the escalated pair before any effect: an instance has no outside", async () => {
    const { ops: o, calls } = ops();
    const escalated = scope({ filesystem: { kind: "device" }, network: { kind: "environment" } });
    const e = await o.operation(h, escalated, sig()).catch((x: unknown) => x);
    expect(isSandboxPermissionUnsupportedError(e)).toBe(true);
    const b = await o.background
      .start(h, escalated, {
        command: "true",
        timeoutMs: 1000,
        maxOutputBytes: 100,
        signal: sig(),
        taskId: "t1",
        outputPath: "/workspace/.capybara/tasks/t1.out",
        retainUntilMs: Date.now() + 60_000,
      })
      .catch((x: unknown) => x);
    expect(isSandboxPermissionUnsupportedError(b)).toBe(true);
    expect(calls).toEqual([]);
  });

  it("refuses a narrower filesystem grant before any effect: no restricted filters here", async () => {
    const { ops: o, calls } = ops();
    for (const filesystem of [
      { kind: "scoped" as const, readRoots: [], writeRoots: ["/workspace"] },
      { kind: "scoped" as const, readRoots: ["/workspace"], writeRoots: [] },
      { kind: "scoped" as const, readRoots: ["/"], writeRoots: ["/workspace"] },
    ]) {
      const e = await o
        .operation(h, scope({ profile: "approve-for-me", filesystem }), sig())
        .catch((x: unknown) => x);
      expect(isSandboxPermissionUnsupportedError(e), JSON.stringify(filesystem)).toBe(true);
    }
    expect(calls).toEqual([]);
  });

  it.each([
    { kind: "open-public" as const },
    { kind: "allowlist" as const, hosts: ["example.com"] },
    { kind: "none" as const },
  ])(
    "runs the whole-instance scope on the instance's own exec ($kind network)",
    async (network) => {
      const { ops: o, calls } = ops();
      for (const profile of ["request-approval", "approve-for-me", "full-access"] as const) {
        const op = await o.operation(h, scope({ profile, network }), sig());
        const r = await op.exec({
          command: "echo hi",
          timeoutMs: 1000,
          maxOutputBytes: 100,
          signal: sig(),
        });
        expect(r.stdout).toBe("ran");
      }
      // consumed once each, then the ordinary exec behind the admission prefix; never the launcher
      expect(calls.filter((c) => c.cmd.includes("consume"))).toHaveLength(3);
      expect(calls.filter((c) => c.method === "execFull")).toHaveLength(3);
      expect(calls.some((c) => c.cmd.includes("exec") && c.method === "run")).toBe(false);
    },
  );

  it("never runs the SDK's Linux launcher: native work uses the helper on / (the device kind)", async () => {
    const { ops: o, calls } = ops();
    const stdins: string[] = [];
    const op = await o.operation(h, scope(), sig());
    // the fake records the agent command; native work is "direct" with the device kind
    await op.writeFile("/workspace/a", new TextEncoder().encode("x"), sig()).catch(() => undefined);
    for (const c of calls) stdins.push(c.cmd.join(" "));
    expect(stdins.some((c) => / direct$/.test(c))).toBe(true);
    expect(stdins.some((c) => / (exec|native) capybara-exec /.test(c))).toBe(false);
    // and no code path hands a scope to the launcher (its files lock, filesLockFd, is therefore
    // never needed: the container is the sandbox, no restricted command runs here)
    const source = readFileSync(new URL("../src/operations.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/OPERATION_AGENT, "(exec|native)"/);
    expect(source).not.toMatch(/linux-sandbox|filesLockFd/);
  });
});
