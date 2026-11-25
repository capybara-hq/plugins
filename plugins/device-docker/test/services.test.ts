import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import {
  managerArgv,
  managerRequest,
  SERVICE_BROWSERS_PATH,
  SERVICE_IMAGE_TOO_OLD,
  SERVICE_USER,
  serviceSocketPath,
  serviceStateDir,
} from "../src/services.js";
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
 * with its state directory on its service state volume, requests and streams through the in-image
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

/** A build context for an image like the published ones before device services. */
let oldImageDir = "";

/** Polls `cond` (a wait condition, not a fixed sleep). */
const waitFor = async (cond: () => Promise<boolean>, ms = 30_000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe.skipIf(!dockerAvailable)("device-docker services", { timeout: 120_000 }, () => {
  let images: TestImages;
  let proxy: SocketProxy;
  const netName = `capybara-sandbox-test-${RUN}`;
  let sbx: DeviceProvider;
  /** Every request written to the service manager's stdin (name, size). */
  const sent: { name: string; bytes: number }[] = [];
  const sentFor = (name: string) => sent.filter((x) => x.name === name).map((x) => x.bytes);

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
  /**
   * A command as the service user (what a service itself, compromised or not, can do): through
   * the docker CLI, outside the provider, which never runs commands as that user.
   */
  const svcSh = async (h: SandboxHandle, command: string) => {
    try {
      const stdout = await docker("exec", "-u", SERVICE_USER, h.id, "sh", "-c", command);
      return { stdout, exitCode: 0 };
    } catch (e) {
      return { stdout: "", exitCode: 1, stderr: String((e as { stderr?: unknown }).stderr ?? e) };
    }
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
      {
        labels: { [TEST_LABEL]: RUN },
        onServiceManagerStdin: (name, bytes) => sent.push({ name, bytes }),
      },
    );
    oldImageDir = await mkdtemp(join(tmpdir(), "capybara-nosvc-"));
    await writeFile(
      join(oldImageDir, "Dockerfile"),
      "ARG BASE\nFROM $BASE\nUSER 0:0\nRUN rm -rf /var/lib/capybara && userdel capybara-svc\nUSER 1000:1000\n",
    );
    // a cold run builds the sandbox image (about 1.5 GB) once, shared by the files
  }, 1_200_000);

  afterAll(async () => {
    await cleanupTestResources(RUN);
    if (oldImageDir !== "") await rm(oldImageDir, { recursive: true, force: true });
    if (images !== undefined) {
      await docker("rmi", "-f", `${images.sandboxImage}-nosvc`).catch(() => undefined);
    }
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
    const started = await sbx.ensureService?.(h, echo("tx.keep"), sig());
    expect(started?.state).toBe("running");
    // ordinary commands, a killAll and a killTagged leave the service alone
    expect((await sh(h, "echo hi")).stdout).toBe("hi\n");
    await sbx.killAll(h, sig());
    await sbx.killTagged(h, ["svc-test"], sig());
    expect(await sbx.serviceStatus?.(h, "tx.keep", sig())).toEqual(started);
    const answer = await sbx.serviceRequest?.(h, "tx.keep", enc.encode("still here"), {
      timeoutMs: 10_000,
      signal: sig(),
    });
    expect(dec.decode(answer)).toBe("still here");

    await sbx.suspend(h, sig());
    expect(await sbx.resume(h, sig())).toBe("resumed");
    // the process died with the instance; no pid file claims otherwise
    const after = await sbx.serviceStatus?.(h, "tx.keep", sig());
    // a stopped service names no files
    const { filesDigest: _running, ...stopped } = (started ?? {}) as { filesDigest?: string };
    expect(after).toEqual({ ...stopped, state: "stopped", startedAt: null });
    await expect(
      sbx.serviceRequest?.(h, "tx.keep", enc.encode("x"), { timeoutMs: 5_000, signal: sig() }),
    ).rejects.toThrow(/not running/);
    // a normal ensure starts it again
    const again = await sbx.ensureService?.(h, echo("tx.keep"), sig());
    expect(again?.state).toBe("running");
  });

  it("serviceRequest round-trips an echo service", async () => {
    const { h } = await create();
    await sbx.ensureService?.(h, echo("tx.echo"), sig());
    const big = new Uint8Array(3 * 1024 * 1024).map((_, i) => i % 251);
    const answer = await sbx.serviceRequest?.(h, "tx.echo", big, {
      timeoutMs: 30_000,
      signal: sig(),
    });
    expect(answer?.byteLength).toBe(big.byteLength);
    expect(Buffer.from(answer ?? []).equals(Buffer.from(big))).toBe(true);
    // requests run concurrently on their own connections
    const many = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        sbx.serviceRequest?.(h, "tx.echo", enc.encode(`r${i}`), {
          timeoutMs: 10_000,
          signal: sig(),
        }),
      ),
    );
    expect(many.map((m) => dec.decode(m))).toEqual(["r0", "r1", "r2", "r3", "r4"]);
    // every relay is gone once its request answered
    await waitFor(async () => (await relays(h)) === "0");
  });

  it("openStream relays 50 messages", async () => {
    const { h } = await create();
    await sbx.ensureService?.(h, echo("tx.stream"), sig());
    const open = sbx.openStream;
    if (open === undefined) throw new Error("device-docker offers no openStream");
    const s = await open.call(sbx, h, { service: "tx.stream" }, sig());
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
    // closing our side ends the relay in the container
    await waitFor(async () => (await relays(h)) === "0");
    await expect(open.call(sbx, h, { service: "tx.nothing-here" }, sig())).rejects.toThrow(
      /not running/,
    );
  });

  it("relay exits when the socket closes", async () => {
    const { h } = await create();
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
    const { reason } = await s.closed;
    expect(reason).toMatch(/closed/);
    await waitFor(async () => (await relays(h)) === "0");
  });

  it("sends the files only when the state directory does not hold them (digest first)", async () => {
    const { h } = await create();
    const MIB = 1024 * 1024;
    const filler = (seed: number) => new Uint8Array(2 * MIB).map((_, i) => (i * seed) % 251);
    const spec = (seed: number) => echo("tx.digest", { "lib/filler.bin": filler(seed) });
    const started = await sbx.ensureService?.(h, spec(7), sig());
    expect(started?.state).toBe("running");
    // the first start: a digest-only ask, then the files (the 2 MiB filler as base64)
    const [ask, files, ...rest] = sentFor("tx.digest");
    expect(rest).toEqual([]);
    expect(ask).toBeLessThan(4096);
    expect(files).toBeGreaterThan(2 * MIB);
    // a second start after a stop: the digest alone, no file crosses
    await sbx.stopService?.(h, "tx.digest", sig());
    sent.length = 0;
    expect((await sbx.ensureService?.(h, spec(7), sig()))?.state).toBe("running");
    expect(sentFor("tx.digest")).toHaveLength(1);
    expect(sentFor("tx.digest")[0]).toBeLessThan(4096);
    // a running service is found without any files either
    expect((await sbx.ensureService?.(h, spec(7), sig()))?.state).toBe("running");
    expect(sentFor("tx.digest")).toHaveLength(2);
    expect(sentFor("tx.digest")[1]).toBeLessThan(4096);
    // changed files: files_needed, then the new files, written
    await sbx.stopService?.(h, "tx.digest", sig());
    sent.length = 0;
    expect((await sbx.ensureService?.(h, spec(11), sig()))?.state).toBe("running");
    expect(sentFor("tx.digest")).toHaveLength(2);
    expect(sentFor("tx.digest")[1]).toBeGreaterThan(2 * MIB);
    const dir = serviceStateDir("tx.digest");
    const sum = async () =>
      (await svcSh(h, `sha256sum ${dir}/lib/filler.bin | cut -d' ' -f1`)).stdout.trim();
    expect(await sum()).toBe(createHash("sha256").update(filler(11)).digest("hex"));
    // a file changed in the state directory since is a miss as well: the files are sent again
    await sbx.stopService?.(h, "tx.digest", sig());
    expect((await svcSh(h, `printf x >> ${dir}/lib/filler.bin`)).exitCode).toBe(0);
    sent.length = 0;
    expect((await sbx.ensureService?.(h, spec(11), sig()))?.state).toBe("running");
    expect(sentFor("tx.digest")).toHaveLength(2);
    expect(await sum()).toBe(createHash("sha256").update(filler(11)).digest("hex"));
  });

  it("a running service on other files (an upgraded extension) is restarted on them", async () => {
    const { h } = await create();
    const v1 = echo("tx.roll");
    const v2 = echo("tx.roll", { "lib/v2.txt": enc.encode("v2") });
    const digestOf = (spec: DeviceServiceSpec) => {
      const hash = createHash("sha256");
      for (const p of Object.keys(spec.files).sort()) {
        const data = spec.files[p] as Uint8Array;
        hash.update(`${p}\0${String(data.byteLength)}\0`);
        hash.update(data);
      }
      return `sha256:${hash.digest("hex")}`;
    };
    const first = await sbx.ensureService?.(h, v1, sig());
    expect(first).toMatchObject({ state: "running", filesDigest: digestOf(v1) });
    // the status and an ifRunning look name the files it runs
    expect(await sbx.serviceStatus?.(h, "tx.roll", sig())).toMatchObject({
      filesDigest: digestOf(v1),
    });
    // the same files: kept
    expect(await sbx.ensureService?.(h, v1, sig())).toEqual(first);
    // other files: the old process stops, the new files start
    const second = await sbx.ensureService?.(h, v2, sig());
    expect(second).toMatchObject({ state: "running", filesDigest: digestOf(v2) });
    expect(second?.startedAt).not.toBe(first?.startedAt);
    const dir = serviceStateDir("tx.roll");
    expect((await svcSh(h, `cat ${dir}/lib/v2.txt`)).stdout).toBe("v2");
    const answer = await sbx.serviceRequest?.(h, "tx.roll", enc.encode("ping"), {
      timeoutMs: 10_000,
      signal: sig(),
    });
    expect(dec.decode(answer)).toBe("ping");
  });

  it("service files land on the persistent volume", async () => {
    const { name, fileSystem, h } = await create();
    const status = await sbx.ensureService?.(
      h,
      echo("tx.files", { "data/note.txt": enc.encode("kept") }),
      sig(),
    );
    expect(status?.stateDir).toBe(serviceStateDir("tx.files"));
    // outside the workspace: no project root, Glob / Grep, share or delivery reaches it
    expect(status?.stateDir.startsWith("/var/lib/capybara/svc/")).toBe(true);
    expect((await sh(h, "ls -A /workspace")).stdout).not.toMatch(/capybara/);
    // only the files it was given land there, with their digest record, the service user's
    expect((await svcSh(h, `cd ${status?.stateDir} && ls -A && stat -c %u .`)).stdout).toBe(
      ".files-digest\ndata\necho.mjs\n1100\n",
    );
    const note = async (on: SandboxHandle) =>
      (await svcSh(on, `cat ${status?.stateDir}/data/note.txt`)).stdout;
    // a suspension keeps them
    await sbx.suspend(h, sig());
    expect(await sbx.resume(h, sig())).toBe("resumed");
    expect(await note(h)).toBe("kept");
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
    expect(await note(h2)).toBe("kept");
    expect((await sbx.serviceStatus?.(h2, "tx.files", sig()))?.state).toBe("stopped");
    // the device's files go with their state volume
    expect(await docker("volume", "ls", "-q", "--filter", `name=^${name}-services$`)).toBe(
      `${name}-services\n`,
    );
    await sbx.destroyFileSystem(fileSystem, sig());
    expect(await docker("volume", "ls", "-q", "--filter", `name=^${name}-services$`)).toBe("");
  });

  it("never blocks on a FIFO planted in the state directory", async () => {
    const { h } = await create();
    const dir = serviceStateDir("tx.fifo");
    // planted by the service itself (agent commands cannot enter its state directory)
    expect((await svcSh(h, `mkdir -p ${dir}/data && mkfifo ${dir}/data/x.txt`)).exitCode).toBe(0);
    const t0 = Date.now();
    await expect(
      sbx.ensureService?.(h, echo("tx.fifo", { "data/x.txt": enc.encode("no") }), sig()),
    ).rejects.toThrow(/special file|regular file|No such device/i);
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect((await sbx.serviceStatus?.(h, "tx.fifo", sig()))?.state).toBe("stopped");
  });

  it("refuses services on an instance whose image predates them", async () => {
    // the published images before isolated device services have no capybara-svc user
    const old = `${images.sandboxImage}-nosvc`;
    await docker(
      "build",
      "-q",
      "-t",
      old,
      "--build-arg",
      `BASE=${images.sandboxImage}`,
      oldImageDir,
    );
    const name = `cap-${randomUUID()}`;
    const fileSystem = await sbx.createFileSystem({ name, limits: limits(), signal: sig() });
    const h = await sbx.create({
      fence: FENCE,
      name,
      image: old,
      limits: limits(),
      fileSystem,
      signal: sig(),
    });
    await expect(sbx.ensureService?.(h, echo("tx.old"), sig())).rejects.toThrow(
      SERVICE_IMAGE_TOO_OLD,
    );
    expect((await sbx.serviceStatus?.(h, "tx.old", sig()))?.state).toBe("stopped");
    // recreated on the current image over the same files, the instance runs services again (the
    // state volume, still empty, takes the image directory's owner)
    await sbx.destroy(h, sig(), FENCE);
    const h2 = await sbx.create({
      fence: FENCE,
      name,
      image: images.sandboxImage,
      limits: limits(),
      fileSystem,
      signal: sig(),
    });
    expect((await sbx.ensureService?.(h2, echo("tx.old"), sig()))?.state).toBe("running");
    expect((await sh(h2, "stat -c '%u:%g %a' /var/lib/capybara/svc")).stdout).toBe(
      "1100:1100 700\n",
    );
  });

  it("never writes service files through a link planted in the state directory", async () => {
    const { h } = await create();
    const dir = serviceStateDir("tx.planted");
    // planted by the service itself (agent commands cannot enter its state directory)
    expect(
      (await svcSh(h, `mkdir -p ${dir} /tmp/elsewhere && ln -s /tmp/elsewhere ${dir}/data`))
        .exitCode,
    ).toBe(0);
    await expect(
      sbx.ensureService?.(h, echo("tx.planted", { "data/x.txt": enc.encode("no") }), sig()),
    ).rejects.toThrow(/link|not a directory/i);
    expect((await svcSh(h, "ls -A /tmp/elsewhere")).stdout).toBe("");
    expect((await sbx.serviceStatus?.(h, "tx.planted", sig()))?.state).toBe("stopped");
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
        name: "tx.env",
        runtime: "node",
        entry: "env.mjs",
        args: ["--flag"],
        files: { "env.mjs": enc.encode(ENV) },
        env: { FOO: "bar" },
      },
      sig(),
    );
    const env = JSON.parse((await svcSh(h, `cat ${s?.stateDir}/env.json`)).stdout) as Record<
      string,
      string
    >;
    expect(env.HTTPS_PROXY).toMatch(/^http:\/\/.+-egress:3128$/);
    expect(env.HTTP_PROXY).toBe(env.HTTPS_PROXY);
    expect(env.FOO).toBe("bar");
    expect(env.CAPYBARA_SERVICE_STATE).toBe(s?.stateDir);
    expect(env.CAPYBARA_SERVICE_SOCKET).toBe(serviceSocketPath("tx.env"));
    expect(env.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
    expect(env.CAPYBARA_SERVICE_WORKSPACE).toBe("/workspace");
    // its own home, caches and temporary files; the image's read-only browsers
    expect(env.HOME).toBe(s?.stateDir);
    expect(env.XDG_CACHE_HOME).toBe(`${s?.stateDir}/.cache`);
    expect(env.TMPDIR).toBe("/run/capybara-svc/tx.env/tmp");
    expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe(SERVICE_BROWSERS_PATH);
    // nothing names a path the agent can write (its caches in the workspace)
    for (const [k, v] of Object.entries(env))
      if (k !== "CAPYBARA_SERVICE_WORKSPACE")
        expect(`${k}=${v}`).not.toMatch(/(^|[=:])\/workspace(\/|:|$)/);
  });

  it("an agent command can neither read a service's state nor reach its socket or process", async () => {
    const { h } = await create();
    const id = "browser.browser";
    const status = await sbx.ensureService?.(
      h,
      echo(id, { "profile/Cookies": enc.encode("session=secret") }),
      sig(),
    );
    expect(status?.state).toBe("running");
    const dir = serviceStateDir(id);
    // the service runs as its own user
    const pid = (
      await svcSh(h, `pgrep -u ${SERVICE_USER} -f '${dir}/echo.mjs' | head -n1`)
    ).stdout.trim();
    expect(pid).toMatch(/^\d+$/);
    expect((await sh(h, `stat -c %u /proc/${pid}`)).stdout).toBe("1100\n");
    // the agent (the sandbox user) is refused the state, the run root, the socket and the process
    const agent = await sh(
      h,
      [
        `cat ${dir}/profile/Cookies`,
        `ls ${dir}`,
        "ls /var/lib/capybara/svc",
        `ls /run/capybara-svc`,
        `node -e 'require("net").connect(process.argv[1]).on("connect",()=>process.exit(0)).on("error",(e)=>{console.log(e.code);process.exit(1)})' ${serviceSocketPath(id)}`,
        `kill -0 ${pid}`,
        `cat /proc/${pid}/environ`,
        `ls /proc/${pid}/cwd/`,
      ]
        .map(
          (c) =>
            `if ${c} >/dev/null 2>&1; then echo "OPEN: ${c.slice(0, 40)}"; else echo refused; fi`,
        )
        .join("; "),
    );
    expect(agent.stdout.trim().split("\n")).toEqual(Array(8).fill("refused"));
    // nor can it plant anything in the service's areas
    expect((await sh(h, `mkdir /run/capybara-svc/x || touch ${dir}/x`)).exitCode).not.toBe(0);
    // the service itself still answers
    const answer = await sbx.serviceRequest?.(h, id, enc.encode("ok"), {
      timeoutMs: 10_000,
      signal: sig(),
    });
    expect(dec.decode(answer)).toBe("ok");
  });

  it("the image ships the pinned Chromium read only for services", async () => {
    const { h } = await create();
    const ls = await svcSh(
      h,
      `ls ${SERVICE_BROWSERS_PATH} && test ! -w ${SERVICE_BROWSERS_PATH} && stat -c %u ${SERVICE_BROWSERS_PATH}`,
    );
    expect(ls.exitCode).toBe(0);
    expect(ls.stdout).toMatch(/^chromium-\d+\n/m);
    expect(ls.stdout.trim().split("\n").at(-1)).toBe("0");
    // the downloads directory a service saves into is made for it, the agent's group kept
    await sbx.ensureService?.(h, echo("tx.downloads"), sig());
    expect((await sh(h, "stat -c '%u %a' /workspace/downloads")).stdout).toBe("1000 2777\n");
    expect(
      (await svcSh(h, "touch /workspace/downloads/f && stat -c %g /workspace/downloads/f")).stdout,
    ).toBe("1000\n");
  });

  it("an ifRunning ensure on a VM without the run root yet answers stopped (E2B's fresh /run)", async () => {
    // the shared manager as device-e2b runs it on a new VM: /run is an empty tmpfs (the image's
    // /run/capybara-svc hidden), made only by the provider's setup before a start
    const req = managerRequest(echo("tx.fresh"), { ifRunning: true });
    const out = await new Promise<string>((resolve, reject) => {
      const p = spawn(
        "docker",
        [
          "run",
          "--rm",
          "-i",
          "--tmpfs",
          "/run",
          "--user",
          SERVICE_USER,
          "--entrypoint",
          "",
          images.sandboxImage,
          ...managerArgv("ensure", "tx.fresh"),
        ],
        { stdio: ["pipe", "pipe", "inherit"] },
      );
      let buf = "";
      p.stdout.on("data", (c: Buffer) => {
        buf += c.toString();
      });
      p.on("error", reject);
      p.on("close", () => resolve(buf));
      p.stdin.end(Buffer.from(req));
    });
    expect(JSON.parse(out.trim())).toMatchObject({ name: "tx.fresh", state: "stopped" });
  });
});
