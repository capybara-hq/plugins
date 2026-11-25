import { randomUUID } from "node:crypto";
import type {
  DeviceProvider,
  DeviceServiceSpec,
  FileSystemHandle,
  SandboxHandle,
  SandboxLimits,
} from "@capybara-hq/plugin-sdk";
import { DEVICE_SERVICE_ECHO_SCRIPT, runDeviceServiceConformance } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createE2BSandbox, DeploymentConfig, providerConfig } from "../src/index.js";
import { serviceStateDir } from "../src/services.js";

/**
 * Device services on E2B (browser use spec §5–6). The shared part (`src/services.ts`: the
 * manager, the relay, the relay stream) is device-docker's file byte for byte and is exercised on
 * real Docker there; this file checks that, and runs the E2B transport (envd processes, stdin by
 * `SendInput`) on real E2B only when `CAPYBARA_TEST_E2B_API_KEY` is filled (the fake E2B has no
 * `SendInput` and no Linux `/proc`). Optional `CAPYBARA_TEST_E2B_TEMPLATE`,
 * `CAPYBARA_TEST_E2B_API_URL`, `CAPYBARA_TEST_E2B_DOMAIN` as in test/live.
 *
 * Assumptions only real E2B confirms (checked on the first run):
 * - [ ] a process the manager forks into its own session keeps running after the manager's
 *   process stream ended (envd does not end a command's descendants);
 * - [ ] `process.Start` with `stdin: true` plus `SendInput` per message delivers the bytes in
 *   order to the relay, and `SendSignal` SIGKILL of the relay ends it (its stream then ends);
 * - [ ] the template's /usr/local/bin/node runs `--input-type=module -e` (Node 22);
 * - [ ] pausing without memory ends the service; after the resume the pid record reads as stopped.
 */

const filled = (v: string | undefined): v is string =>
  v !== undefined && v.trim() !== "" && !v.startsWith("替换为");
const env = process.env;
const READY = filled(env.CAPYBARA_TEST_E2B_API_KEY);
const FENCE = { token: 1 };
const sig = () => AbortSignal.timeout(120_000);
const BUILD_MS = 35 * 60_000;
const enc = new TextEncoder();
const dec = new TextDecoder();
const actor = { accountId: "live", conversationId: "live" };
const limits: SandboxLimits = {
  cpu: 1,
  memoryMb: 2048,
  diskMb: 5120,
  network: { kind: "allowlist", hosts: [] },
};
const echo = (name: string, extra: Record<string, Uint8Array> = {}): DeviceServiceSpec => ({
  name,
  runtime: "node",
  entry: "echo.mjs",
  args: [],
  files: { "echo.mjs": enc.encode(DEVICE_SERVICE_ECHO_SCRIPT), ...extra },
});
/** A service that answers a stream's first message and then closes the connection. */
const ONE_SHOT = `import { createServer } from "node:net";
createServer((conn) => {
  let buf = Buffer.alloc(0);
  let seen = 0;
  conn.on("data", (c) => {
    buf = Buffer.concat([buf, c]);
    while (buf.byteLength >= 4 && buf.byteLength >= 4 + buf.readUInt32BE(0)) {
      const len = buf.readUInt32BE(0);
      const msg = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      if (++seen === 2) {
        const out = Buffer.alloc(4 + len);
        out.writeUInt32BE(len, 0);
        msg.copy(out, 4);
        conn.end(out);
      }
    }
  });
  conn.on("error", () => {});
}).listen(process.env.CAPYBARA_SERVICE_SOCKET);
`;

/**
 * A service that answers every request with what only it can see: its uid, its environment and
 * `data/note.txt` in its state directory (agent commands cannot read either since plugins#210).
 */
const INFO = `import { createServer } from "node:net";
import { readFileSync } from "node:fs";
const frame = (b) => { const o = Buffer.alloc(4 + b.length); o.writeUInt32BE(b.length, 0); b.copy(o, 4); return o; };
createServer((conn) => {
  let buf = Buffer.alloc(0);
  let seen = 0;
  conn.on("data", (c) => {
    buf = Buffer.concat([buf, c]);
    while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
      buf = buf.subarray(4 + buf.readUInt32BE(0));
      if (++seen === 2) {
        let note = null;
        try { note = readFileSync("data/note.txt", "utf8"); } catch {}
        conn.end(frame(Buffer.from(JSON.stringify({ uid: process.getuid(), env: process.env, note }))));
      }
    }
  });
  conn.on("error", () => {});
}).listen(process.env.CAPYBARA_SERVICE_SOCKET);
`;

const waitFor = async (cond: () => Promise<boolean>, ms = 30_000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 200));
  }
};

describe.skipIf(!READY)("device-e2b services (live)", { timeout: 240_000 }, () => {
  let sbx: DeviceProvider;
  const name = `cap-device-live-svc-${randomUUID()}`;
  let fs: FileSystemHandle;
  let h: SandboxHandle;
  /** Every request written to the service manager's stdin (name, size). */
  const sent: { name: string; bytes: number }[] = [];
  const sentFor = (svc: string) => sent.filter((x) => x.name === svc).map((x) => x.bytes);

  beforeAll(async () => {
    const cfg = DeploymentConfig.parse({
      apiKey: env.CAPYBARA_TEST_E2B_API_KEY,
      ...(filled(env.CAPYBARA_TEST_E2B_TEMPLATE) && { template: env.CAPYBARA_TEST_E2B_TEMPLATE }),
      ...(filled(env.CAPYBARA_TEST_E2B_API_URL) && { apiUrl: env.CAPYBARA_TEST_E2B_API_URL }),
      ...(filled(env.CAPYBARA_TEST_E2B_DOMAIN) && { domain: env.CAPYBARA_TEST_E2B_DOMAIN }),
      timeoutSeconds: 600,
    });
    const log = { info: console.info, warn: console.warn, error: console.error };
    sbx = createE2BSandbox(
      providerConfig(cfg),
      { log },
      { onServiceManagerStdin: (svc, bytes) => sent.push({ name: svc, bytes }) },
    );
    fs = await sbx.createFileSystem({ name, limits, signal: AbortSignal.timeout(BUILD_MS) });
    h = await sbx.create({ fence: FENCE, name, limits, fileSystem: fs, signal: sig() });
  }, BUILD_MS + 60_000);

  afterAll(async () => {
    await sbx?.destroyFileSystemByName(name, sig());
  }, 120_000);

  const sh = (command: string) =>
    sbx.exec(h, {
      command,
      timeoutMs: 30_000,
      maxOutputBytes: 64_000,
      signal: sig(),
      tag: "svc-live",
      actor,
    });
  /** What the service `id` (running INFO) sees. */
  const info = async (id: string) =>
    JSON.parse(
      dec.decode(
        await sbx.serviceRequest?.(h, id, enc.encode("?"), { timeoutMs: 30_000, signal: sig() }),
      ),
    ) as { uid: number; env: Record<string, string>; note: string | null };
  const relays = async () =>
    (await sh("pgrep -fc '[c]apybara-socket-relay' || true")).stdout.trim();

  it("passes the device service conformance", async () => {
    await runDeviceServiceConformance({ provider: sbx, handle: h, dispose: async () => {} });
  });

  it("serviceRequest round-trips an echo service", async () => {
    await sbx.ensureService?.(h, echo("tx.echo"), sig());
    const big = new Uint8Array(1024 * 1024).map((_, i) => i % 251);
    const answer = await sbx.serviceRequest?.(h, "tx.echo", big, {
      timeoutMs: 60_000,
      signal: sig(),
    });
    expect(Buffer.from(answer ?? []).equals(Buffer.from(big))).toBe(true);
    await waitFor(async () => (await relays()) === "0");
  });

  it("openStream relays 50 messages", async () => {
    const s = await sbx.openStream?.(h, { service: "tx.echo" }, sig());
    if (s === undefined) throw new Error("no stream");
    const got: string[] = [];
    const reading = (async () => {
      for await (const m of s.messages) {
        got.push(dec.decode(m));
        if (got.length === 50) break;
      }
    })();
    for (let i = 0; i < 50; i++) await s.send(enc.encode(`m${i}`));
    await reading;
    expect(got).toEqual(Array.from({ length: 50 }, (_, i) => `m${i}`));
    // leaving the for-await loop (the iterator's return()) closes the stream
    s.close("done");
    expect(await s.closed).toEqual({ reason: "the reader stopped reading" });
    await waitFor(async () => (await relays()) === "0");
  });

  it("relay exits when the socket closes", async () => {
    await sbx.ensureService?.(
      h,
      { ...echo("tx.oneshot"), entry: "one.mjs", files: { "one.mjs": enc.encode(ONE_SHOT) } },
      sig(),
    );
    const s = await sbx.openStream?.(h, { service: "tx.oneshot" }, sig());
    if (s === undefined) throw new Error("no stream");
    await s.send(enc.encode("only"));
    const got: string[] = [];
    for await (const m of s.messages) got.push(dec.decode(m));
    expect(got).toEqual(["only"]);
    expect((await s.closed).reason).toMatch(/closed/);
    await waitFor(async () => (await relays()) === "0");
  });

  it("service survives across exec calls and stops on suspend", async () => {
    const started = await sbx.ensureService?.(h, echo("tx.keep"), sig());
    expect(started?.state).toBe("running");
    expect((await sh("echo hi")).stdout).toBe("hi\n");
    await sbx.killAll(h, sig());
    await sbx.killTagged(h, ["svc-live"], sig());
    expect(await sbx.serviceStatus?.(h, "tx.keep", sig())).toEqual(started);
    await sbx.suspend(h, sig());
    // a stopped service names no files
    const { filesDigest: _running, ...stopped } = (started ?? {}) as { filesDigest?: string };
    expect(await sbx.serviceStatus?.(h, "tx.keep", sig())).toEqual({
      ...stopped,
      state: "stopped",
      startedAt: null,
    });
    expect(await sbx.resume(h, sig())).toBe("resumed");
    expect((await sbx.serviceStatus?.(h, "tx.keep", sig()))?.state).toBe("stopped");
  });

  it("sends the files only when the state directory does not hold them (digest first)", async () => {
    const MIB = 1024 * 1024;
    const filler = (seed: number) => new Uint8Array(MIB).map((_, i) => (i * seed) % 251);
    const spec = (seed: number): DeviceServiceSpec => ({
      name: "tx.digest",
      runtime: "node",
      entry: "info.mjs",
      args: [],
      files: { "info.mjs": enc.encode(INFO), "lib/filler.bin": filler(seed) },
    });
    const s = await sbx.ensureService?.(h, spec(7), sig());
    expect(sentFor("tx.digest")).toHaveLength(2);
    expect(s?.state).toBe("running");
    const { env: svcEnv } = await info("tx.digest");
    expect(svcEnv.CAPYBARA_SERVICE_WORKSPACE).toBe("/workspace");
    expect(svcEnv.HOME).toBe(s?.stateDir);
    for (const [k, v] of Object.entries(svcEnv))
      if (k !== "CAPYBARA_SERVICE_WORKSPACE")
        expect(`${k}=${v}`).not.toMatch(/(^|[=:])\/workspace(\/|:|$)/);
    await sbx.stopService?.(h, "tx.digest", sig());
    sent.length = 0;
    expect((await sbx.ensureService?.(h, spec(7), sig()))?.state).toBe("running");
    expect(sentFor("tx.digest")).toHaveLength(1);
    expect(sentFor("tx.digest")[0]).toBeLessThan(4096);
    await sbx.stopService?.(h, "tx.digest", sig());
    sent.length = 0;
    expect((await sbx.ensureService?.(h, spec(11), sig()))?.state).toBe("running");
    expect(sentFor("tx.digest")).toHaveLength(2);
    expect(sentFor("tx.digest")[1]).toBeGreaterThan(MIB);
  });

  it("a running service on other files (an upgraded extension) is restarted on them", async () => {
    const v1 = echo("tx.roll");
    const v2 = echo("tx.roll", { "lib/v2.txt": enc.encode("v2") });
    // the SDK in this package's range does not type filesDigest yet (capybara-hq/core#875)
    type Status = { filesDigest?: string; startedAt?: string | null; state?: string };
    const first = (await sbx.ensureService?.(h, v1, sig())) as Status | undefined;
    expect(first?.filesDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await sbx.ensureService?.(h, v1, sig())).toEqual(first);
    const second = (await sbx.ensureService?.(h, v2, sig())) as Status | undefined;
    expect(second?.state).toBe("running");
    expect(second?.filesDigest).not.toBe(first?.filesDigest);
    expect(second?.startedAt).not.toBe(first?.startedAt);
    await sbx.stopService?.(h, "tx.roll", sig());
  });

  it("an agent command can neither read a service's state nor reach its socket or process", async () => {
    const id = "browser.browser";
    const status = await sbx.ensureService?.(
      h,
      {
        ...echo(id),
        entry: "info.mjs",
        files: { "info.mjs": enc.encode(INFO), "data/note.txt": enc.encode("session=secret") },
      },
      sig(),
    );
    expect(status?.state).toBe("running");
    const seen = await info(id);
    expect(seen.uid).toBe(1100);
    expect(seen.note).toBe("session=secret");
    const dir = serviceStateDir(id);
    const pid = (await sh(`pgrep -u capybara-svc -f '${dir}/info.mjs' | head -n1`)).stdout.trim();
    expect(pid).toMatch(/^\d+$/);
    // refused (or read as missing): never the contents
    const leaked = await sbx
      .readFile(h, `${dir}/data/note.txt`, { maxBytes: 100, signal: sig() })
      .catch(() => null);
    expect(leaked).toBeNull();
    const agent = await sh(
      [
        `cat ${dir}/data/note.txt`,
        "ls /var/lib/capybara/svc",
        "ls /run/capybara-svc",
        `node -e 'require("net").connect(process.argv[1]).on("connect",()=>process.exit(0)).on("error",()=>process.exit(1))' /run/capybara-svc/${id}/sock`,
        `kill -0 ${pid}`,
        `cat /proc/${pid}/environ`,
      ]
        .map((c) => `if ${c} >/dev/null 2>&1; then echo OPEN; else echo refused; fi`)
        .join("; "),
    );
    expect(agent.stdout.trim().split("\n")).toEqual(Array(6).fill("refused"));
  });

  it("service files land on the persistent volume", async () => {
    const status = await sbx.ensureService?.(
      h,
      {
        ...echo("tx.files"),
        entry: "info.mjs",
        files: { "info.mjs": enc.encode(INFO), "data/note.txt": enc.encode("kept") },
      },
      sig(),
    );
    expect(status?.stateDir).toBe(serviceStateDir("tx.files"));
    await sbx.destroy(h, sig(), FENCE);
    h = await sbx.create({ fence: FENCE, name, limits, fileSystem: fs, signal: sig() });
    expect((await sbx.serviceStatus?.(h, "tx.files", sig()))?.state).toBe("stopped");
    // started again from the kept state directory, it still reads its file
    await sbx.ensureService?.(
      h,
      {
        ...echo("tx.files"),
        entry: "info.mjs",
        files: { "info.mjs": enc.encode(INFO), "data/note.txt": enc.encode("kept") },
      },
      sig(),
    );
    expect((await info("tx.files")).note).toBe("kept");
  });
});
