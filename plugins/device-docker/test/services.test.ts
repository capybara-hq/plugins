import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  DeviceProvider,
  DeviceServiceSpec,
  SandboxActor,
  SandboxHandle,
  SandboxLimits,
} from "@capybara-hq/plugin-sdk";
import { DEVICE_SERVICE_ECHO_SCRIPT, runDeviceServiceConformance } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDockerSandbox } from "../src/index.js";
import { SOCKET_RELAY_SOURCE, serviceStateDir } from "../src/services.js";
import {
  buildTestImages,
  cleanupTestResources,
  docker,
  dockerAvailable,
  type SocketProxy,
  startSocketProxy,
  TEST_LABEL,
  type TestImages,
} from "./docker-env.js";

/** The fence token every lifecycle call carries here (device update fencing). */
const FENCE = { token: 1 };

/**
 * Device services on real Docker (browser use spec §5–6): one long-lived named process per device
 * with its state directory on the workspace volume, requests and streams through the in-image
 * socket relay. Skipped without Docker.
 */

const RUN = randomUUID().slice(0, 8);
const sig = () => AbortSignal.timeout(120_000);
const actor: SandboxActor = { accountId: "acc-1", conversationId: "conv-1" };
const enc = new TextEncoder();
const dec = new TextDecoder();
const limits = (): SandboxLimits => ({
  cpu: 1,
  memoryMb: 512,
  diskMb: 1024,
  network: { kind: "allowlist", hosts: [] },
});

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

/** Polls `cond` (a wait condition, not a fixed sleep). */
const waitFor = async (cond: () => Promise<boolean>, ms = 30_000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe("the socket relay", () => {
  it("ships in the image byte for byte as the providers run it", async () => {
    const file = await readFile(
      new URL("../image/capybara-socket-relay.mjs", import.meta.url),
      "utf8",
    );
    expect(file).toBe(SOCKET_RELAY_SOURCE);
  });
});

describe.skipIf(!dockerAvailable)("device-docker services", { timeout: 180_000 }, () => {
  let images: TestImages;
  let proxy: SocketProxy;
  const netName = `capybara-sandbox-test-${RUN}`;
  let sbx: DeviceProvider;

  const create = async (name = `cap-${randomUUID()}`) => {
    const fileSystem = await sbx.createFileSystem({ name, limits: limits(), signal: sig() });
    const h = await sbx.create({
      fence: FENCE,
      name,
      image: images.sandboxImage,
      limits: limits(),
      fileSystem,
      signal: sig(),
    });
    return { name, fileSystem, h };
  };
  const sh = async (h: SandboxHandle, command: string) => {
    const r = await sbx.exec(h, {
      command,
      timeoutMs: 30_000,
      maxOutputBytes: 64_000,
      signal: sig(),
      tag: "svc-test",
      actor,
    });
    return r;
  };
  const relays = async (h: SandboxHandle) =>
    (await sh(h, "pgrep -fc '[c]apybara-socket-relay' || true")).stdout.trim();

  beforeAll(async () => {
    [images, proxy] = await Promise.all([
      buildTestImages(),
      startSocketProxy(),
      docker("network", "create", "--label", `${TEST_LABEL}=${RUN}`, netName),
    ]);
    sbx = createDockerSandbox(
      {
        endpoint: proxy.endpoint,
        runtime: "runc",
        network: netName,
        egressProxyImage: images.egressImage,
      },
      { labels: { [TEST_LABEL]: RUN } },
    );
    // a cold run builds the sandbox image (about 1.5 GB) once, shared by the files
  }, 1_200_000);

  afterAll(async () => {
    await cleanupTestResources(RUN);
    await proxy?.stop();
    await images?.remove();
  }, 120_000);

  it("passes the device service conformance", async () => {
    const { h, fileSystem } = await create();
    await runDeviceServiceConformance({
      provider: sbx,
      handle: h,
      dispose: () => sbx.destroyFileSystem(fileSystem, sig()),
    });
  });

  it("service survives across exec calls and stops on suspend", async () => {
    const { h } = await create();
    const started = await sbx.ensureService?.(h, echo("keep"), sig());
    expect(started?.state).toBe("running");
    // ordinary commands, a killAll and a killTagged leave the service alone
    expect((await sh(h, "echo hi")).stdout).toBe("hi\n");
    await sbx.killAll(h, sig());
    await sbx.killTagged(h, ["svc-test"], sig());
    expect(await sbx.serviceStatus?.(h, "keep", sig())).toEqual(started);
    const answer = await sbx.serviceRequest?.(h, "keep", enc.encode("still here"), {
      timeoutMs: 10_000,
      signal: sig(),
    });
    expect(dec.decode(answer)).toBe("still here");

    await sbx.suspend(h, sig());
    expect(await sbx.resume(h, sig())).toBe("resumed");
    // the process died with the instance; no pid file claims otherwise
    const after = await sbx.serviceStatus?.(h, "keep", sig());
    expect(after).toEqual({ ...started, state: "stopped", startedAt: null });
    await expect(
      sbx.serviceRequest?.(h, "keep", enc.encode("x"), { timeoutMs: 5_000, signal: sig() }),
    ).rejects.toThrow(/not running/);
    // a normal ensure starts it again
    const again = await sbx.ensureService?.(h, echo("keep"), sig());
    expect(again?.state).toBe("running");
  });

  it("serviceRequest round-trips an echo service", async () => {
    const { h } = await create();
    await sbx.ensureService?.(h, echo("echo"), sig());
    const big = new Uint8Array(3 * 1024 * 1024).map((_, i) => i % 251);
    const answer = await sbx.serviceRequest?.(h, "echo", big, { timeoutMs: 30_000, signal: sig() });
    expect(answer?.byteLength).toBe(big.byteLength);
    expect(Buffer.from(answer ?? []).equals(Buffer.from(big))).toBe(true);
    // requests run concurrently on their own connections
    const many = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        sbx.serviceRequest?.(h, "echo", enc.encode(`r${i}`), { timeoutMs: 10_000, signal: sig() }),
      ),
    );
    expect(many.map((m) => dec.decode(m))).toEqual(["r0", "r1", "r2", "r3", "r4"]);
    // every relay is gone once its request answered
    await waitFor(async () => (await relays(h)) === "0");
  });

  it("openStream relays 50 messages", async () => {
    const { h } = await create();
    await sbx.ensureService?.(h, echo("stream"), sig());
    const open = sbx.openStream;
    if (open === undefined) throw new Error("device-docker offers no openStream");
    const s = await open.call(sbx, h, { service: "stream" }, sig());
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
    s.close("done");
    expect(await s.closed).toEqual({ reason: "done" });
    // closing our side ends the relay in the container
    await waitFor(async () => (await relays(h)) === "0");
    await expect(open.call(sbx, h, { service: "nothing-here" }, sig())).rejects.toThrow(
      /not running/,
    );
  });

  it("relay exits when the socket closes", async () => {
    const { h } = await create();
    await sbx.ensureService?.(
      h,
      { ...echo("oneshot"), entry: "one.mjs", files: { "one.mjs": enc.encode(ONE_SHOT) } },
      sig(),
    );
    const s = await sbx.openStream?.(h, { service: "oneshot" }, sig());
    if (s === undefined) throw new Error("no stream");
    await s.send(enc.encode("only"));
    const got: string[] = [];
    for await (const m of s.messages) got.push(dec.decode(m));
    expect(got).toEqual(["only"]);
    const { reason } = await s.closed;
    expect(reason).toMatch(/closed/);
    await waitFor(async () => (await relays(h)) === "0");
  });

  it("service files land on the persistent volume", async () => {
    const { name, fileSystem, h } = await create();
    const status = await sbx.ensureService?.(
      h,
      echo("files", { "data/note.txt": enc.encode("kept") }),
      sig(),
    );
    expect(status?.stateDir).toBe(serviceStateDir("files"));
    expect(status?.stateDir.startsWith("/workspace/")).toBe(true);
    // the service writes its state directory, and only the files it was given land there
    expect((await sh(h, `cd ${status?.stateDir} && ls -A && id -u`)).stdout).toBe(
      "data\necho.mjs\n1000\n",
    );
    // a new instance on the same files sees them
    await sbx.destroy(h, sig(), FENCE);
    const h2 = await sbx.create({
      fence: FENCE,
      name,
      image: images.sandboxImage,
      limits: limits(),
      fileSystem,
      signal: sig(),
    });
    const r = await sbx.readFile(h2, `${status?.stateDir}/data/note.txt`, {
      maxBytes: 100,
      signal: sig(),
    });
    expect(dec.decode(r?.data)).toBe("kept");
    expect((await sbx.serviceStatus?.(h2, "files", sig()))?.state).toBe("stopped");
  });

  it("never writes service files through a link planted in the state directory", async () => {
    const { h } = await create();
    const dir = serviceStateDir("planted");
    expect(
      (await sh(h, `mkdir -p ${dir} /tmp/elsewhere && ln -s /tmp/elsewhere ${dir}/data`)).exitCode,
    ).toBe(0);
    await expect(
      sbx.ensureService?.(h, echo("planted", { "data/x.txt": enc.encode("no") }), sig()),
    ).rejects.toThrow(/link|not a directory/i);
    expect((await sh(h, "ls -A /tmp/elsewhere")).stdout).toBe("");
    expect((await sbx.serviceStatus?.(h, "planted", sig()))?.state).toBe("stopped");
  });

  it("gives the service the device's egress proxy in its environment", async () => {
    const fileSystem = await sbx.createFileSystem({
      name: `cap-${randomUUID()}`,
      limits: limits(),
      signal: sig(),
    });
    const open: SandboxLimits = { ...limits(), network: { kind: "allowlist", hosts: ["a.test"] } };
    const h = await sbx.create({
      fence: FENCE,
      name: fileSystem.id,
      image: images.sandboxImage,
      limits: open,
      fileSystem,
      signal: sig(),
    });
    const ENV = `import { createServer } from "node:net";
import { writeFileSync } from "node:fs";
writeFileSync("env.json", JSON.stringify(process.env));
createServer(() => {}).listen(process.env.CAPYBARA_SERVICE_SOCKET);
`;
    const s = await sbx.ensureService?.(
      h,
      {
        name: "env",
        runtime: "node",
        entry: "env.mjs",
        args: ["--flag"],
        files: { "env.mjs": enc.encode(ENV) },
        env: { FOO: "bar" },
      },
      sig(),
    );
    const raw = await sbx.readFile(h, `${s?.stateDir}/env.json`, {
      maxBytes: 64_000,
      signal: sig(),
    });
    const env = JSON.parse(dec.decode(raw?.data)) as Record<string, string>;
    expect(env.HTTPS_PROXY).toMatch(/^http:\/\/.+-egress:3128$/);
    expect(env.HTTP_PROXY).toBe(env.HTTPS_PROXY);
    expect(env.FOO).toBe("bar");
    expect(env.CAPYBARA_SERVICE_STATE).toBe(s?.stateDir);
    expect(env.CAPYBARA_SERVICE_SOCKET).toMatch(/^\/tmp\//);
    expect(env.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
  });
});
