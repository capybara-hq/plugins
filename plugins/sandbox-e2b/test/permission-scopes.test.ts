import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isSandboxOperationOutcomeUnknownError,
  isSandboxPermissionUnsupportedError,
  isSandboxScopeDeniedError,
  isSandboxScopeValidationError,
  SANDBOX_RUNTIME_SOURCE,
  type SandboxExecutionRef,
  type SandboxHandle,
  type SandboxLimits,
  type SandboxOperationScope,
  type SandboxProvider,
} from "@capybara-hq/plugin-sdk";
import { type FakeE2BServer, startFakeE2B } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { envdCloseStdin, envdSendInput, envdStart } from "../src/e2b-api.js";
import { createE2BSandbox, type E2BSandboxConfig, publishedImage } from "../src/index.js";
import { OPERATION_AGENT_SHA256, OPERATION_AGENT_SOURCE } from "../src/operation-agent-source.js";
import { ROOT_AGENT_PRECHECK, rootAgentArgs } from "../src/provider.js";
import {
  OPERATION_AGENT,
  OPS_DIR,
  RUNTIME_BASE,
  RUNTIME_DIR,
  runtimeChecksums,
  runtimeFiles,
} from "../src/runtime-source.js";

/**
 * Permission profiles on E2B (core spec 2026-11-16 permission operation contract), without a VM:
 * the staged runtime bytes, the envd stdin calls the agent requests travel on, and every
 * fail-closed path that must refuse before any E2B call (the escalated pair and grants narrower
 * than the instance, which is the sandbox; a stopped instance
 * that status / stop / revoke must never resume, foreign references, preparation roots). The
 * behaviour inside a VM (admission, records, background supervision, the template probe) is
 * proven on a real template by test/live/permission-scopes.live.test.ts.
 */

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const sig = () => AbortSignal.timeout(20_000);
const limits: SandboxLimits = {
  cpu: 1,
  memoryMb: 2048,
  diskMb: 5120,
  network: { kind: "allowlist", hosts: [] },
};

describe("staged runtime", () => {
  it("embeds runtime/capybara-operation.py unchanged, with its digest", () => {
    const file = readFileSync(new URL("../runtime/capybara-operation.py", import.meta.url), "utf8");
    // regenerate with: node plugins/sandbox-e2b/scripts/gen-agent-source.mjs
    expect(OPERATION_AGENT_SOURCE).toBe(file);
    expect(OPERATION_AGENT_SHA256).toBe(sha256(file));
  });

  it("stages the SDK runtime bytes unchanged next to the agent, in a directory named by their digests", () => {
    expect(SANDBOX_RUNTIME_SOURCE.version).toBe(2);
    expect(RUNTIME_BASE).toBe("/opt/capybara-e2b-runtime");
    // named after every staged file: new SDK bytes stage a fresh directory
    expect(RUNTIME_DIR).toBe(`${RUNTIME_BASE}/${sha256(runtimeChecksums()).slice(0, 16)}`);
    expect(OPERATION_AGENT).toBe(`${RUNTIME_DIR}/capybara-operation.py`);
    expect(OPS_DIR).toBe("/opt/capybara-e2b-ops");
    const files = runtimeFiles();
    expect(files.map((f) => f.name)).toEqual([
      "capybara-operation.py",
      "linux-sandbox.py",
      "native-files.py",
    ]);
    for (const name of ["native-files.py", "linux-sandbox.py"]) {
      const sdk = SANDBOX_RUNTIME_SOURCE.files.find((f) => f.name === name);
      const staged = files.find((f) => f.name === name);
      expect(Buffer.from(staged?.data ?? []).toString("utf8")).toBe(sdk?.source);
      expect(staged?.sha256).toBe(sdk?.sha256);
    }
    const agent = files.find((f) => f.name === "capybara-operation.py");
    expect(agent?.sha256).toBe(OPERATION_AGENT_SHA256);
    expect(runtimeChecksums()).toBe(files.map((f) => `${sha256(f.data)}  ${f.name}\n`).join(""));
  });

  it("carries no restricted launch path (the template kernel cannot run the SDK launcher)", () => {
    for (const absent of [
      "def restricted(",
      "class Forwarder",
      "def supervise(",
      '"exec", "native"',
    ]) {
      expect(OPERATION_AGENT_SOURCE).not.toContain(absent);
    }
    expect(OPERATION_AGENT_SOURCE).toContain('OPS_ROOT = "/opt/capybara-e2b-ops"');
    expect(OPERATION_AGENT_SOURCE).toContain('raise Refused("UNAVAILABLE"');
  });
});

describe("envd stdin", () => {
  it("starts with stdin open, writes it in ordered base64 chunks and closes it", async () => {
    const seen: { path: string; body: string }[] = [];
    const read = async (req: IncomingMessage) => {
      const parts: Buffer[] = [];
      for await (const c of req) parts.push(c as Buffer);
      return Buffer.concat(parts);
    };
    const server = createServer((req, res) => {
      void read(req).then((raw) => {
        const path = req.url ?? "";
        if (path === "/process.Process/Start") {
          seen.push({ path, body: raw.subarray(5).toString("utf8") });
          const msg = (m: unknown, flags = 0) => {
            const j = Buffer.from(JSON.stringify(m));
            const head = Buffer.alloc(5);
            head.writeUInt8(flags, 0);
            head.writeUInt32BE(j.byteLength, 1);
            return Buffer.concat([head, j]);
          };
          res.writeHead(200, { "content-type": "application/connect+json" });
          res.end(
            Buffer.concat([
              msg({ event: { start: { pid: 7 } } }),
              msg({ event: { end: { exited: true, status: "exit status 0" } } }),
              msg({}, 2),
            ]),
          );
          return;
        }
        seen.push({ path, body: raw.toString("utf8") });
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const t = {
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      sandboxId: "i1",
      accessToken: "tok",
    };
    try {
      await envdStart(t, "sandbox", { cmd: "/bin/cat", args: [] }, () => undefined, sig(), true);
      const data = new Uint8Array(600 * 1024).map((_, i) => i % 251);
      await envdSendInput(t, 7, data, sig());
      await envdCloseStdin(t, 7, sig());
      expect(JSON.parse(seen[0]?.body ?? "{}")).toMatchObject({ stdin: true });
      const inputs = seen.filter((s) => s.path === "/process.Process/SendInput");
      expect(inputs.length).toBe(3);
      const joined = Buffer.concat(
        inputs.map((s) => {
          const b = JSON.parse(s.body) as { process: { pid: number }; input: { stdin: string } };
          expect(b.process.pid).toBe(7);
          return Buffer.from(b.input.stdin, "base64");
        }),
      );
      expect(joined.equals(Buffer.from(data))).toBe(true);
      expect(seen.at(-1)).toEqual({
        path: "/process.Process/CloseStdin",
        body: JSON.stringify({ process: { pid: 7 } }),
      });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("operation factory fails closed (fake E2B)", { timeout: 20_000 }, () => {
  let fake: FakeE2BServer;
  let api: { url: string; close(): Promise<void> };
  let sbx: SandboxProvider;
  let h: SandboxHandle;
  const scope = (over: Partial<SandboxOperationScope> = {}): SandboxOperationScope => ({
    operationId: `op-${randomUUID()}`,
    admitBeforeMs: Date.now() + 60_000,
    deviceId: "dev-1",
    rootConversationId: "conv-1",
    profileRevision: 1,
    ceilingRevision: "c1",
    profile: "full-access",
    actor: { accountId: "acc-1", conversationId: "conv-1" },
    tag: randomUUID(),
    // the kernel's instance scope: the whole filesystem plus the working root
    filesystem: { kind: "scoped", readRoots: ["/", "/workspace"], writeRoots: ["/", "/workspace"] },
    network: { kind: "open-public" },
    ...over,
  });
  const restrictedScope = () =>
    scope({
      profile: "approve-for-me",
      filesystem: { kind: "scoped", readRoots: [], writeRoots: ["/workspace"] },
      network: { kind: "none" },
    });
  /** Calls that reach a VM (connect resumes; envd runs commands). */
  const vmCalls = (id: string) =>
    fake.calls.filter((c) => c.path === `/v2/sandboxes/${id}/connect` || c.sandboxId === id).length;

  beforeAll(async () => {
    fake = await startFakeE2B();
    // The fake has no `GET /sandboxes/{id}`: serve it from the fake's own state (the real API
    // answers state and envdAccessToken for running and paused sandboxes, verified live).
    api = await (async () => {
      const server = createServer((req, res) => {
        void (async () => {
          const parts: Buffer[] = [];
          for await (const c of req) parts.push(c as Buffer);
          const path = new URL(req.url ?? "/", "http://x").pathname;
          const m = /^\/sandboxes\/([^/]+)$/.exec(path);
          if (req.method === "GET" && m) {
            const s = fake.sandboxes.get(m[1] as string);
            res.writeHead(s ? 200 : 404, { "content-type": "application/json" });
            res.end(
              JSON.stringify(
                s
                  ? { sandboxID: s.id, state: s.state, envdAccessToken: s.envdAccessToken }
                  : { code: 404, message: "not found" },
              ),
            );
            return;
          }
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(req.headers)) {
            if (typeof v === "string" && k !== "host" && k !== "content-length") headers[k] = v;
          }
          const body = Buffer.concat(parts);
          const r = await fetch(fake.url + (req.url ?? "/"), {
            method: req.method ?? "GET",
            headers,
            ...(body.byteLength > 0 && { body }),
          });
          const out = Buffer.from(await r.arrayBuffer());
          const resHeaders: Record<string, string> = {};
          r.headers.forEach((v, k) => {
            if (k !== "content-length" && k !== "transfer-encoding") resHeaders[k] = v;
          });
          res.writeHead(r.status, resHeaders).end(out);
        })().catch(() => res.destroy());
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      return {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      };
    })();
    const cfg: E2BSandboxConfig = {
      apiKey: fake.apiKey,
      apiUrl: api.url,
      domain: "e2b.app",
      template: "capybara-sandbox",
      defaultImage: publishedImage("0.0.0-test.1"),
      timeoutSeconds: 3600,
      domainAllowlist: true,
    };
    sbx = createE2BSandbox(
      cfg,
      { log: { info: () => undefined, warn: () => undefined, error: () => undefined } },
      { envdUrl: fake.url },
    );
    const name = `cap-device-${randomUUID()}`;
    const fileSystem = await sbx.createFileSystem({ name, limits, signal: sig() });
    h = await sbx.create({ name, limits, fileSystem, signal: sig() });
  });
  afterAll(async () => {
    await api?.close();
    await fake?.close();
  });

  it("declares the operation-capable methods", () => {
    expect(typeof sbx.permissionSupport).toBe("function");
    expect(typeof sbx.operation).toBe("function");
    expect(typeof sbx.prepare).toBe("function");
    expect(typeof sbx.browse).toBe("function");
    expect(typeof sbx.revokeOperation).toBe("function");
    expect(sbx.background).toBeDefined();
  });

  it("refuses the escalated pair and narrower grants before any VM call: exec, native and background", async () => {
    const before = vmCalls(h.id);
    // an instance has no outside
    const escalated = scope({ filesystem: { kind: "device" }, network: { kind: "environment" } });
    const e1 = await sbx.operation?.(h, escalated, sig()).catch((x: unknown) => x);
    expect(isSandboxPermissionUnsupportedError(e1)).toBe(true);
    // a grant narrower than the instance would need restricted filters
    const e2 = await sbx.operation?.(h, restrictedScope(), sig()).catch((x: unknown) => x);
    expect(isSandboxPermissionUnsupportedError(e2)).toBe(true);
    const readOnly = scope({
      profile: "request-approval",
      filesystem: { kind: "scoped", readRoots: ["/workspace"], writeRoots: [] },
      network: { kind: "none" },
    });
    const e3 = await sbx.operation?.(h, readOnly, sig()).catch((x: unknown) => x);
    expect(isSandboxPermissionUnsupportedError(e3)).toBe(true);
    for (const refused of [restrictedScope(), escalated]) {
      const e4 = await sbx.background
        ?.start(h, refused, {
          command: "true",
          timeoutMs: 1000,
          maxOutputBytes: 100,
          signal: sig(),
          taskId: "t1",
          outputPath: "/workspace/out.log",
          retainUntilMs: Date.now() + 60_000,
        })
        .catch((x: unknown) => x);
      expect(isSandboxPermissionUnsupportedError(e4)).toBe(true);
    }
    expect(vmCalls(h.id)).toBe(before);
  });

  it("builds an operation for the whole instance under every profile and network kind, without a VM call", async () => {
    const before = vmCalls(h.id);
    for (const profile of ["request-approval", "approve-for-me", "full-access"] as const) {
      for (const network of [
        { kind: "open-public" as const },
        { kind: "allowlist" as const, hosts: ["example.com"] },
        { kind: "none" as const },
      ]) {
        const op = await sbx.operation?.(h, scope({ profile, network }), sig());
        expect(typeof op?.exec).toBe("function");
      }
    }
    expect(vmCalls(h.id)).toBe(before);
  });

  it("validates the scope before anything else", async () => {
    const bad = { ...scope(), extra: true } as unknown as SandboxOperationScope;
    const e = await sbx.operation?.(h, bad, sig()).catch((x: unknown) => x);
    expect(isSandboxScopeValidationError(e)).toBe(true);
  });

  it("refuses preparation roots outside their purpose and browsing inside the provider's records", async () => {
    const before = vmCalls(h.id);
    const prep = (purpose: "skills" | "attachments", root: string) =>
      sbx
        .prepare?.(
          h,
          {
            operationId: `p-${randomUUID()}`,
            deviceId: "dev-1",
            purpose,
            writeRoots: [root],
            tag: "t",
          },
          sig(),
        )
        .catch((x: unknown) => x);
    expect(isSandboxScopeDeniedError(await prep("skills", "/workspace/x"))).toBe(true);
    expect(isSandboxScopeDeniedError(await prep("attachments", "/workspace/other"))).toBe(true);
    // the parser refuses ".." itself (a validation error); either way nothing runs
    const dotdot = await prep("skills", "/skills/../opt");
    expect(isSandboxScopeDeniedError(dotdot) || isSandboxScopeValidationError(dotdot)).toBe(true);
    for (const root of [OPS_DIR, `${OPS_DIR}/bg`, RUNTIME_BASE, "/opt/capybara"]) {
      const e = await sbx
        .browse?.(
          h,
          {
            operationId: `b-${randomUUID()}`,
            admitBeforeMs: Date.now() + 60_000,
            deviceId: "dev-1",
            accountId: "acc-1",
            ceilingRevision: "c1",
            readRoots: [root],
            tag: "t",
          },
          sig(),
        )
        .catch((x: unknown) => x);
      expect(isSandboxScopeDeniedError(e)).toBe(true);
    }
    expect(vmCalls(h.id)).toBe(before);
  });

  it("a reference for another instance is scope-denied without any call", async () => {
    const before = vmCalls(h.id);
    const operationId = `op-${randomUUID()}`;
    const ref: SandboxExecutionRef = {
      executionId: "00000000-0000-0000-0000-000000000000",
      operationId,
      instanceId: h.id,
      instanceGeneration: "g",
    };
    for (const bad of [{ ...ref }, { ...ref, instanceId: "iother" }]) {
      const e = await sbx.background?.status(h, bad, sig()).catch((x: unknown) => x);
      expect(isSandboxScopeDeniedError(e)).toBe(true);
    }
    expect(vmCalls(h.id)).toBe(before);
  });

  it("status, output, stop, support and revocation never resume a stopped instance", async () => {
    // a reference whose execution id matches its operation (operations.ts derives it)
    const { operationUuid } = await import("../src/operations.js");
    const operationId = `op-${randomUUID()}`;
    const ref: SandboxExecutionRef = {
      executionId: operationUuid(operationId),
      operationId,
      instanceId: h.id,
      instanceGeneration: "g",
    };
    await sbx.suspend(h, sig());
    const before = vmCalls(h.id);
    expect(await sbx.background?.status(h, ref, sig())).toEqual({ state: "lost" });
    expect(await sbx.background?.tail(h, ref, { maxBytes: 10, signal: sig() })).toEqual({
      unavailable: "lost",
    });
    expect(
      await sbx.background?.readOutput(h, ref, { offset: 0, maxBytes: 10, signal: sig() }),
    ).toEqual({ unavailable: "lost" });
    expect(await sbx.background?.stop(h, ref, { graceMs: 0, signal: sig() })).toEqual({
      outcome: "lost",
    });
    await expect(sbx.permissionSupport?.(h, sig())).rejects.toThrow(/not running/);
    // a paused VM cannot confirm that nothing of the operation survives (a control plane may
    // restore a memory snapshot): the revocation stays pending, deadline passed or not
    for (const admitBeforeMs of [Date.now() - 1, Date.now() + 60_000]) {
      await expect(sbx.revokeOperation?.(h, { operationId, admitBeforeMs }, sig())).rejects.toThrow(
        /not running/,
      );
    }
    expect(vmCalls(h.id)).toBe(before);
    expect(fake.sandboxes.get(h.id)?.state).toBe("paused");
  });

  it("bounds output reads before any call", async () => {
    const { operationUuid } = await import("../src/operations.js");
    const operationId = `op-${randomUUID()}`;
    const ref: SandboxExecutionRef = {
      executionId: operationUuid(operationId),
      operationId,
      instanceId: h.id,
      instanceGeneration: "g",
    };
    for (const opts of [
      { offset: -1, maxBytes: 1 },
      { offset: 0, maxBytes: 65_537 },
      { offset: 0.5, maxBytes: 1 },
    ]) {
      const e = await sbx.background
        ?.readOutput(h, ref, { ...opts, signal: sig() })
        .catch((x: unknown) => x);
      expect(isSandboxScopeDeniedError(e)).toBe(true);
    }
  });
});

describe("root runs only a verified agent", () => {
  const run = (dir: string, digest: string) =>
    spawnSync(
      "python3",
      ["-I", "-c", ROOT_AGENT_PRECHECK, `${dir}/capybara-operation.py`, digest, "--probe-only"],
      { encoding: "utf8" },
    );
  /**
   * The precheck with `os.lstat` reporting uid 0 (nothing on the test machine is root-owned), so
   * the mode, type and digest branches are reached; modes and types stay real.
   */
  const asRoot = (dir: string, digest: string) =>
    spawnSync(
      "python3",
      [
        "-I",
        "-c",
        [
          "import os, sys",
          "real = os.lstat",
          "def lstat(p):",
          "    r = real(p)",
          "    return os.stat_result((r.st_mode, r.st_ino, r.st_dev, r.st_nlink, 0, r.st_gid,",
          "                           r.st_size, r.st_atime, r.st_mtime, r.st_ctime))",
          "os.lstat = lstat",
          "code = sys.argv[1]",
          "sys.argv = ['-c'] + sys.argv[2:]",
          "exec(compile(code, '<precheck>', 'exec'))",
        ].join("\n"),
        ROOT_AGENT_PRECHECK,
        `${dir}/capybara-operation.py`,
        digest,
        "--probe-only",
      ],
      { encoding: "utf8" },
    );

  it("refuses a runtime directory it cannot trust and reports a missing one apart", () => {
    const base = mkdtempSync(join(tmpdir(), "e2b-precheck-"));
    try {
      const dir = join(base, "rt");
      // missing: exit 3 (the provider stages); nothing is executed
      expect(run(dir, "0".repeat(64)).status).toBe(3);
      mkdirSync(dir);
      const agent = join(dir, "capybara-operation.py");
      writeFileSync(agent, "open('/dev/null')\n");
      const digest = createHash("sha256").update(readFileSync(agent)).digest("hex");
      // present but owned by this (non-root) user, or world-writable: exit 4 (untrusted)
      chmodSync(dir, 0o777);
      const planted = run(dir, digest);
      expect(planted.status).toBe(4);
      expect(planted.stderr).toMatch(/untrusted/);
      chmodSync(dir, 0o755);
      expect(run(dir, digest).status).toBe(4); // not root-owned
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("with root ownership stubbed: checks modes, types and the agent's digest", () => {
    // a 0700 parent of its own, so a world-writable temp directory is not part of the chain
    const top = mkdtempSync(join(tmpdir(), "e2b-precheck-"));
    try {
      chmodSync(top, 0o755);
      const base = join(top, "base");
      const dir = join(base, "rt");
      mkdirSync(dir, { recursive: true });
      chmodSync(base, 0o755);
      chmodSync(dir, 0o755);
      const agent = join(dir, "capybara-operation.py");
      writeFileSync(agent, "open('/dev/null')\n");
      chmodSync(agent, 0o644);
      const digest = createHash("sha256").update(readFileSync(agent)).digest("hex");
      // only "/" and the chain below the parent count; the parent itself must pass too
      const ok = asRoot(dir, digest);
      expect(ok.stderr).toBe("");
      expect(ok.status).toBe(0);
      const mismatch = asRoot(dir, "0".repeat(64));
      expect(mismatch.status).toBe(4);
      expect(mismatch.stderr).toMatch(/untrusted runtime digest/);
      chmodSync(agent, 0o666);
      expect(asRoot(dir, digest).status).toBe(4);
      chmodSync(agent, 0o644);
      chmodSync(dir, 0o775);
      expect(asRoot(dir, digest).stderr).toContain(`untrusted runtime ${dir}`);
      chmodSync(dir, 0o755);
      rmSync(agent);
      mkdirSync(agent); // the agent must be a regular file
      expect(asRoot(dir, digest).status).toBe(4);
    } finally {
      rmSync(top, { recursive: true, force: true });
    }
  });

  it("root runs only the exact agent command shape, through the precheck", () => {
    expect(rootAgentArgs(["/usr/bin/python3", "-I", OPERATION_AGENT, "consume"])).toEqual([
      "-I",
      "-c",
      ROOT_AGENT_PRECHECK,
      OPERATION_AGENT,
      OPERATION_AGENT_SHA256,
      "consume",
    ]);
    for (const bad of [
      ["/bin/sh", "-c", "id"],
      ["/usr/bin/python3", OPERATION_AGENT, "consume"],
      ["/usr/bin/python3", "-I", "/tmp/capybara-operation.py", "consume"],
      ["python3", "-I", OPERATION_AGENT, "consume"],
      ["/usr/bin/python3", "-I", OPERATION_AGENT],
    ]) {
      expect(() => rootAgentArgs(bad)).toThrow(/root/);
    }
  });
});

describe("root agent commands (fake E2B)", { timeout: 20_000 }, () => {
  /** An agent command held open by the envd proxy, with the pid it reported (if any yet). */
  interface Held {
    pid: number;
    /** Resolves when the provider closed the command's stream (it disconnected). */
    closed: Promise<void>;
    start(): void;
    end(): void;
  }
  interface Hold {
    /** Held when the Start body contains this text. */
    match: string;
    deferStart: boolean;
    /** SendSignal for the held pid fails (envd unreachable or the kill refused). */
    failKill: boolean;
    seen: (held: Held) => void;
  }
  let fake: FakeE2BServer;
  let proxy: { url: string; close(): Promise<void> };
  let sbx: SandboxProvider;
  let h: SandboxHandle;
  let hold: Hold | undefined;
  const signalled: number[] = [];
  const held = new Map<number, Held & { failKill: boolean }>();
  let nextPid = 900_000;

  const frame = (m: unknown, flags = 0) => {
    const j = Buffer.from(JSON.stringify(m));
    const head = Buffer.alloc(5);
    head.writeUInt8(flags, 0);
    head.writeUInt32BE(j.byteLength, 1);
    return Buffer.concat([head, j]);
  };

  beforeAll(async () => {
    fake = await startFakeE2B();
    // API and envd in front of the fake: forwards everything, serves `GET /sandboxes/{id}` from
    // the fake's state (the fake has no such route), can hold one agent command open (a
    // long-running command) and answers SendSignal for the held pid
    const server = createServer((req, res) => {
      void (async () => {
        const parts: Buffer[] = [];
        for await (const c of req) parts.push(c as Buffer);
        const raw = Buffer.concat(parts);
        const path = new URL(req.url ?? "/", "http://x").pathname;
        const info = /^\/sandboxes\/([^/]+)$/.exec(path);
        if (req.method === "GET" && info) {
          const sb = fake.sandboxes.get(info[1] as string);
          res.writeHead(sb ? 200 : 404, { "content-type": "application/json" });
          res.end(
            JSON.stringify(
              sb
                ? { sandboxID: sb.id, state: sb.state, envdAccessToken: sb.envdAccessToken }
                : { code: 404, message: "not found" },
            ),
          );
          return;
        }
        if (path === "/process.Process/Start" && hold && raw.includes(hold.match)) {
          const { deferStart, failKill, seen } = hold;
          hold = undefined;
          const pid = nextPid++;
          res.writeHead(200, { "content-type": "application/connect+json" });
          const closed = new Promise<void>((r) => res.on("close", () => r()));
          const entry = {
            pid,
            closed,
            failKill,
            start: () => {
              if (!res.writableEnded) res.write(frame({ event: { start: { pid } } }));
            },
            end: () => {
              if (res.writableEnded) return;
              res.write(frame({ event: { end: { exitCode: -1, status: "signal: killed" } } }));
              res.end(frame({}, 2));
            },
          };
          held.set(pid, entry);
          if (!deferStart) entry.start();
          seen(entry);
          return;
        }
        if (path === "/process.Process/SendSignal") {
          const pid = (JSON.parse(raw.toString("utf8")) as { process: { pid: number } }).process
            .pid;
          const entry = held.get(pid);
          if (entry) {
            signalled.push(pid);
            if (entry.failKill) {
              res.writeHead(503, { "content-type": "application/json" });
              res.end(JSON.stringify({ code: "unavailable", message: "envd unavailable" }));
              return;
            }
            held.delete(pid);
            entry.end();
            res.writeHead(200, { "content-type": "application/json" }).end("{}");
            return;
          }
        }
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (typeof v === "string" && k !== "host" && k !== "content-length") headers[k] = v;
        }
        const r = await fetch(fake.url + (req.url ?? "/"), {
          method: req.method ?? "GET",
          headers,
          ...(raw.byteLength > 0 && { body: raw }),
        });
        const resHeaders: Record<string, string> = {};
        r.headers.forEach((v, k) => {
          if (k !== "content-length" && k !== "transfer-encoding") resHeaders[k] = v;
        });
        res.writeHead(r.status, resHeaders);
        if (r.body) for await (const c of r.body) res.write(c);
        res.end();
      })().catch(() => res.destroy());
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    proxy = {
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      close: () => new Promise<void>((r) => server.close(() => r())),
    };
    sbx = createE2BSandbox(
      {
        apiKey: fake.apiKey,
        apiUrl: proxy.url,
        domain: "e2b.app",
        template: "capybara-sandbox",
        defaultImage: publishedImage("0.0.0-test.1"),
        timeoutSeconds: 3600,
        domainAllowlist: true,
      },
      { log: { info: () => undefined, warn: () => undefined, error: () => undefined } },
      { envdUrl: proxy.url },
    );
    const name = `cap-device-${randomUUID()}`;
    const fileSystem = await sbx.createFileSystem({ name, limits, signal: sig() });
    h = await sbx.create({ name, limits, fileSystem, signal: sig() });
  });
  afterAll(async () => {
    for (const entry of held.values()) entry.end();
    await proxy?.close();
    await fake?.close();
  });

  const instanceOp = () =>
    sbx.operation?.(
      h,
      {
        operationId: `op-${randomUUID()}`,
        admitBeforeMs: Date.now() + 60_000,
        deviceId: "d",
        rootConversationId: "c",
        profileRevision: 1,
        ceilingRevision: "c1",
        profile: "full-access",
        actor: { accountId: "a", conversationId: "c" },
        tag: randomUUID(),
        filesystem: {
          kind: "scoped",
          readRoots: ["/", "/workspace"],
          writeRoots: ["/", "/workspace"],
        },
        network: { kind: "none" },
      },
      sig(),
    );
  /** Arms the proxy to hold the next matching agent command; resolves once it is held. */
  const holdNext = (over: Partial<Omit<Hold, "seen">> = {}) =>
    new Promise<Held>((resolve) => {
      hold = { match: "consume", deferStart: false, failKill: false, ...over, seen: resolve };
    });
  /** Reboots of this VM: a pause without memory followed by a connect with `memory: false`. */
  const reboots = () =>
    fake.calls.filter(
      (c) =>
        c.method === "POST" &&
        c.path === `/v2/sandboxes/${h.id}/connect` &&
        (c.body as { memory?: boolean } | null)?.memory === false,
    ).length;
  const connects = () =>
    fake.calls.filter((c) => c.method === "POST" && c.path === `/v2/sandboxes/${h.id}/connect`)
      .length;
  const running = async () => {
    if (fake.sandboxes.get(h.id)?.state !== "running") await sbx.resume?.(h, sig());
  };

  it("never starts the agent as root without the inline verification", async () => {
    const op = await instanceOp();
    // on the test machine nothing is root-owned: the consume step refuses or fails, either way
    await op?.stat("/workspace", sig()).catch(() => undefined);
    const rootAgent = fake.calls.filter((c) => {
      const p = (c.body as { process?: { cmd?: string; args?: string[] } } | undefined)?.process;
      return c.user === "root" && (p?.args ?? []).some((a) => a.includes("capybara-operation.py"));
    });
    expect(rootAgent.length).toBeGreaterThan(0);
    for (const c of rootAgent) {
      const p = (c.body as { process: { args: string[] } }).process;
      expect(p.args.slice(0, 3)).toEqual(["-I", "-c", ROOT_AGENT_PRECHECK]);
    }
  });

  for (const deferStart of [false, true]) {
    it(`an aborted agent command is killed in the VM${deferStart ? " (aborted before its pid was known)" : ""}`, async () => {
      await running();
      const op = await instanceOp();
      const ac = new AbortController();
      const step = holdNext({ deferStart });
      const write = op?.writeFile("/workspace/never.txt", new Uint8Array([1]), ac.signal);
      const entry = await step;
      const before = reboots();
      ac.abort();
      if (deferStart) entry.start();
      await expect(write).rejects.toThrow();
      // the held step ends only through SendSignal for its pid; a confirmed kill needs no reboot
      expect(signalled).toContain(entry.pid);
      expect(held.has(entry.pid)).toBe(false);
      expect(reboots()).toBe(before);
    });
  }

  for (const deferStart of [false, true]) {
    it(`a kill that fails reboots the VM${deferStart ? " (pid reported after the abort)" : ""}`, async () => {
      await running();
      const op = await instanceOp();
      const ac = new AbortController();
      const step = holdNext({ deferStart, failKill: true });
      const write = op?.writeFile("/workspace/never.txt", new Uint8Array([1]), ac.signal);
      const entry = await step;
      const before = reboots();
      ac.abort();
      if (deferStart) entry.start();
      await expect(write).rejects.toThrow();
      expect(signalled).toContain(entry.pid);
      expect(reboots()).toBe(before + 1);
      held.delete(entry.pid);
    });
  }

  it("a start event after the kill grace period reboots the VM", async () => {
    await running();
    const op = await instanceOp();
    const ac = new AbortController();
    const step = holdNext({ deferStart: true });
    const write = op?.writeFile("/workspace/never.txt", new Uint8Array([1]), ac.signal);
    const entry = await step;
    const before = reboots();
    ac.abort();
    // readiness, not a fixed wait: the provider gives up on the stream after its grace period
    await entry.closed;
    entry.start();
    await expect(write).rejects.toThrow();
    expect(reboots()).toBe(before + 1);
    held.delete(entry.pid);
  });

  it("on the never-resume path an unconfirmed kill leaves a paused VM paused: outcome unknown", async () => {
    await running();
    const { operationUuid } = await import("../src/operations.js");
    const operationId = `op-${randomUUID()}`;
    const ref: SandboxExecutionRef = {
      executionId: operationUuid(operationId),
      operationId,
      instanceId: h.id,
      instanceGeneration: "g",
    };
    const ac = new AbortController();
    const step = holdNext({ match: "bg-status", failKill: true });
    const status = sbx.background?.status(h, ref, ac.signal);
    const entry = await step;
    // paused meanwhile: the kill cannot be confirmed, and resuming to reboot is not allowed here
    await sbx.suspend(h, sig());
    const before = connects();
    ac.abort();
    const e = await status?.then(
      () => undefined,
      (x: unknown) => x,
    );
    expect(isSandboxOperationOutcomeUnknownError(e)).toBe(true);
    expect(connects()).toBe(before);
    expect(fake.sandboxes.get(h.id)?.state).toBe("paused");
    held.delete(entry.pid);
  });
});
