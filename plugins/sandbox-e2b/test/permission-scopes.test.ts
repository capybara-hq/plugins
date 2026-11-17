import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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
import { ROOT_AGENT_PRECHECK } from "../src/provider.js";
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
 * fail-closed path that must refuse before any E2B call (restricted grants, a stopped instance
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
  mode: "sandbox",
  network: { kind: "allowlist", hosts: [] },
};

describe("staged runtime", () => {
  it("embeds runtime/capybara-operation.py unchanged, with its digest", () => {
    const file = readFileSync(new URL("../runtime/capybara-operation.py", import.meta.url), "utf8");
    // regenerate with: node plugins/sandbox-e2b/scripts/gen-agent-source.mjs
    expect(OPERATION_AGENT_SOURCE).toBe(file);
    expect(OPERATION_AGENT_SHA256).toBe(sha256(file));
  });

  it("stages the SDK runtime bytes unchanged next to the agent, in a directory named by its digest", () => {
    expect(SANDBOX_RUNTIME_SOURCE.version).toBe(2);
    expect(RUNTIME_BASE).toBe("/opt/capybara-e2b-runtime");
    expect(RUNTIME_DIR).toBe(`${RUNTIME_BASE}/${OPERATION_AGENT_SHA256.slice(0, 16)}`);
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
    filesystem: { kind: "device" },
    network: { kind: "environment" },
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

  it("refuses restricted grants before any VM call: exec, native and background", async () => {
    const before = vmCalls(h.id);
    const e1 = await sbx.operation?.(h, restrictedScope(), sig()).catch((x: unknown) => x);
    expect(isSandboxPermissionUnsupportedError(e1)).toBe(true);
    const readOnly = scope({
      profile: "request-approval",
      filesystem: { kind: "scoped", readRoots: ["/workspace"], writeRoots: [] },
      network: { kind: "none" },
    });
    const e2 = await sbx.operation?.(h, readOnly, sig()).catch((x: unknown) => x);
    expect(isSandboxPermissionUnsupportedError(e2)).toBe(true);
    // device-wide work with a narrowed network would need restricted filters too
    const narrowed = scope({ network: { kind: "allowlist", hosts: ["example.com"] } });
    const e3 = await sbx.operation?.(h, narrowed, sig()).catch((x: unknown) => x);
    expect(isSandboxPermissionUnsupportedError(e3)).toBe(true);
    const e4 = await sbx.background
      ?.start(h, restrictedScope(), {
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
});

describe("root agent commands (fake E2B)", { timeout: 20_000 }, () => {
  /** A consume step held open by the envd proxy, with the pid it reported (if any yet). */
  interface Held {
    pid: number;
    started: boolean;
    start(): void;
    end(): void;
  }
  let fake: FakeE2BServer;
  let envd: { url: string; close(): Promise<void> };
  let sbx: SandboxProvider;
  let h: SandboxHandle;
  /** When set, the next root consume step is held open instead of running (see `Held`). */
  let hold: { deferStart: boolean; seen: (held: Held) => void } | undefined;
  const signalled: number[] = [];
  const held = new Map<number, Held>();
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
    // envd in front of the fake: forwards everything, except that it can hold one root consume
    // step open (a long-running agent command) and answers SendSignal for the held pid
    const server = createServer((req, res) => {
      void (async () => {
        const parts: Buffer[] = [];
        for await (const c of req) parts.push(c as Buffer);
        const raw = Buffer.concat(parts);
        const path = new URL(req.url ?? "/", "http://x").pathname;
        if (path === "/process.Process/Start" && hold && raw.includes("consume")) {
          const { deferStart, seen } = hold;
          hold = undefined;
          const pid = nextPid++;
          res.writeHead(200, { "content-type": "application/connect+json" });
          const entry: Held = {
            pid,
            started: false,
            start: () => {
              entry.started = true;
              res.write(frame({ event: { start: { pid } } }));
            },
            end: () => {
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
    envd = {
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      close: () => new Promise<void>((r) => server.close(() => r())),
    };
    sbx = createE2BSandbox(
      {
        apiKey: fake.apiKey,
        apiUrl: fake.url,
        domain: "e2b.app",
        template: "capybara-sandbox",
        defaultImage: publishedImage("0.0.0-test.1"),
        timeoutSeconds: 3600,
        domainAllowlist: true,
      },
      { log: { info: () => undefined, warn: () => undefined, error: () => undefined } },
      { envdUrl: envd.url },
    );
    const name = `cap-device-${randomUUID()}`;
    const fileSystem = await sbx.createFileSystem({ name, limits, signal: sig() });
    h = await sbx.create({ name, limits, fileSystem, signal: sig() });
  });
  afterAll(async () => {
    for (const entry of held.values()) entry.end();
    await envd?.close();
    await fake?.close();
  });

  const fullOp = () =>
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
        filesystem: { kind: "device" },
        network: { kind: "environment" },
      },
      sig(),
    );

  it("never starts the agent as root without the inline verification", async () => {
    const op = await fullOp();
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
      const op = await fullOp();
      const ac = new AbortController();
      let seen: (held: Held) => void = () => undefined;
      const heldStep = new Promise<Held>((resolve) => {
        seen = resolve;
      });
      hold = { deferStart, seen };
      const write = op?.writeFile("/workspace/never.txt", new Uint8Array([1]), ac.signal);
      const entry = await heldStep;
      ac.abort();
      if (deferStart) entry.start();
      await expect(write).rejects.toThrow();
      // the held step ends only through SendSignal for its pid
      expect(signalled).toContain(entry.pid);
      expect(held.has(entry.pid)).toBe(false);
    });
  }
});
