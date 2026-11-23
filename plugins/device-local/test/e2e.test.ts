import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ConversationEvent,
  createDb,
  createLocalAccount,
  createOrg,
  enableModelProviders,
  eventsOf,
  type KernelRequest,
  type KernelSchemaDb,
  kernelDb,
  login,
  postMessage,
  startTestKernel,
  startTestPostgres,
  startTestRedis,
  TEST_PASSWORD,
  type TestContainer,
  type TestKernel,
  testKernelConfig,
  waitFor,
  waitForTerminal,
} from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * End to end with the PUBLISHED `capybara-device` (installed from npm at {@link DEVICE_VERSION}): a kernel with this
 * plugin and model-fake listens on a real port; the program signs in through the kernel's code
 * flow into a device of `device-local`, connects and runs a `Bash` call of a conversation. Then the
 * cases only a real program can show: a restart keeps the binding (same runtime) or is re-probed
 * and rebound (changed runtime); another machine signing in replaces the first; revoking the
 * machine and deleting the device end the program with their messages; a revoked device connects
 * again after a new login; a project directory the owner listed for one connection that another
 * connection of the same computer also uses shows in the device report, and its change keeps the
 * report revision. Every program runs under a temporary HOME and XDG_CONFIG_HOME (never the
 * real `~/.config/capybara-device`). Runs only with `CAPYBARA_TEST_DEVICE_LOCAL_E2E` set (Docker for
 * the test containers; the program's own sandbox of the host OS).
 */

const PLUGIN_DIR = fileURLToPath(new URL("../", import.meta.url));
const DEVICE_LOCAL = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const MODEL_FAKE = "@capybara-hq/plugin-model-fake";
/**
 * The published program under test: `@capybara-hq/device` at this version (a plugin may not depend
 * on it, so the test installs it from npm into a temporary directory).
 */
const DEVICE_VERSION = process.env.CAPYBARA_TEST_DEVICE_LOCAL_E2E_VERSION ?? "0.1.0-rc.30";
let program: string;
let programDir: string;

/** What the published program prints when it ends for each reason (its `client.js`). */
const DISCONNECTED = "This machine was disconnected from the deployment";
const DELETED = "The device was deleted on the deployment";
const REPLACED = "This machine connected elsewhere";

type ToolResultEvent = Extract<ConversationEvent, { type: "tool_result" }>;

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let publicUrl: string;
const machines: Machine[] = [];

/** A free TCP port on loopback (the kernel's public URL must name it before it starts). */
async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const { port } = srv.address() as { port: number };
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

/** One computer: its own temporary HOME and config directory, and the program's runs. */
class Machine {
  output = "";
  proc: ChildProcess | undefined;
  exited: Promise<number | null> = Promise.resolve(null);

  private constructor(readonly home: string) {}

  static async create(): Promise<Machine> {
    // short: the program's control socket lives under it (a unix socket path is at most 103 bytes
    // on macOS, whose tmpdir alone is about 50)
    const base = process.platform === "darwin" ? "/tmp" : tmpdir();
    const m = new Machine(await realpath(await mkdtemp(join(base, "cdl-"))));
    machines.push(m);
    return m;
  }

  get configDir(): string {
    return join(this.home, ".config");
  }

  private env(): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: this.home,
      XDG_CONFIG_HOME: this.configDir,
      LANG: "en_US.UTF-8",
    };
  }

  /** Runs `capybara-device <args>` in the background, collecting stdout and stderr. */
  run(args: string[]): ChildProcess {
    const proc = spawn(process.execPath, [program, ...args], {
      env: this.env(),
      cwd: this.home,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.proc = proc;
    const take = (b: Buffer) => {
      this.output += b.toString("utf8");
    };
    proc.stdout?.on("data", take);
    proc.stderr?.on("data", take);
    this.exited = new Promise((resolve) => proc.on("exit", (code) => resolve(code)));
    return proc;
  }

  /**
   * `capybara-device login --url <kernel> --json`, confirmed over HTTP with the person's session:
   * into a new device named `name`, or into the existing `deviceId`. Resolves the device id.
   */
  async login(session: string, orgId: string, into: { name: string } | { deviceId: string }) {
    const from = this.output.length;
    const proc = this.run(["login", "--url", publicUrl, "--json", "--mode", "os"]);
    const events = () =>
      this.output
        .slice(from)
        .split("\n")
        .filter((l) => l.startsWith("{"))
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    const verification = await waitFor(
      async () => events().find((e) => e.event === "verification"),
      60_000,
      "the login's code",
    ).catch((e: unknown) => {
      throw new Error(`${String(e)}; program output: ${this.output}`);
    });
    const confirmed = await k.http.inject({
      method: "POST",
      url: "/api/v1/device/confirm",
      headers: { "x-capybara-csrf": "1", "content-type": "application/json", cookie: session },
      payload: JSON.stringify({
        userCode: verification.userCode,
        orgId,
        provider: "device-local",
        ...into,
      }),
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(await this.exited, this.output).toBe(0);
    const done = events().find((e) => e.event === "done");
    expect(done, this.output).toBeDefined();
    expect(proc.exitCode).toBe(0);
    return String(done?.deviceId);
  }

  /**
   * `capybara-device start` in the foreground (`-c <deviceId>` with `connection`: a computer with
   * several connections); resolves once the device reads online.
   */
  async start(orgId: string, deviceId: string, owner: KernelRequest, connection = false) {
    this.run(connection ? ["start", "-c", deviceId] : ["start"]);
    await waitFor(
      async () => ((await deviceView(owner, orgId, deviceId)).online ? true : undefined),
      60_000,
      "the device online",
    ).catch((e: unknown) => {
      throw new Error(`${String(e)}; program output: ${this.output}`);
    });
  }

  /** Waits for the running program to end; its exit code. */
  async ended(): Promise<number | null> {
    return await this.exited;
  }

  /** Stops the running program with SIGTERM (a deliberate stop) and waits for it. */
  async stop(): Promise<void> {
    if (this.proc && this.proc.exitCode === null && this.proc.signalCode === null) {
      this.proc.kill("SIGTERM");
      await this.exited;
    }
  }

  /** Runs one short `capybara-device` command to its end; fails with its output unless it exits 0. */
  async command(args: string[]): Promise<void> {
    const proc = spawn(process.execPath, [program, ...args], {
      env: this.env(),
      cwd: this.home,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    proc.stdout.on("data", (b: Buffer) => {
      out += b.toString("utf8");
    });
    proc.stderr.on("data", (b: Buffer) => {
      out += b.toString("utf8");
    });
    const code = await new Promise<number | null>((resolve) => proc.on("exit", resolve));
    expect(code, out).toBe(0);
  }

  /**
   * Records `roots` as the project directories connection `deviceId` used (its `projects.json`,
   * which the program writes for every admitted operation's project root).
   */
  async usedProjects(deviceId: string, roots: string[]): Promise<void> {
    const dir = join(this.configDir, "capybara-device", "connections", deviceId);
    await writeFile(join(dir, "projects.json"), `${JSON.stringify({ version: 1, roots })}\n`, {
      mode: 0o600,
    });
  }

  /** The program's stored instance binding files (one per device). */
  async bindingFiles(): Promise<string[]> {
    const found: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const p = join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else if (/^instance-binding-[0-9a-f]{64}\.json$/.test(e.name)) found.push(p);
      }
    };
    await walk(join(this.configDir, "capybara-device"));
    return found;
  }

  async dispose(): Promise<void> {
    if (this.proc && this.proc.exitCode === null && this.proc.signalCode === null) {
      this.proc.kill("SIGKILL");
      await this.exited;
    }
    await rm(this.home, { recursive: true, force: true });
  }
}

async function deviceView(owner: KernelRequest, orgId: string, deviceId: string) {
  const r = await owner({ method: "GET", url: `/api/v1/orgs/${orgId}/devices/${deviceId}` });
  expect(r.statusCode, r.body).toBe(200);
  return (r.json() as { device: { online: boolean | null } }).device;
}

/** Signs `name` in and returns the session's Cookie header value (the device confirm needs it). */
async function sessionCookie(name: string): Promise<string> {
  const res = await k.http.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { "x-capybara-csrf": "1", "content-type": "application/json" },
    payload: JSON.stringify({ login: name, password: TEST_PASSWORD }),
  });
  expect(res.statusCode, res.body).toBe(200);
  const set = res.headers["set-cookie"];
  return (Array.isArray(set) ? set : [String(set)]).map((c) => c.split(";")[0]).join("; ");
}

/** The plugin's binding row of `deviceId` (schema `plugin_device_local`). */
async function bindingRow(deviceId: string) {
  const r = await sql<{ generation: string; unattested: boolean; status: string }>`
    SELECT generation, unattested, status FROM plugin_device_local.bindings
    WHERE device_id = ${deviceId}`.execute(raw);
  return r.rows[0];
}

/** The kernel's stored report of `deviceId` (what people see on the device page). */
async function storedReport(deviceId: string) {
  const r = await sql<{
    report: { revision: string; limits: { label: { en: string }; value: string }[] } | null;
  }>`
    SELECT report FROM capybara.devices WHERE id = ${deviceId}`.execute(raw);
  return r.rows[0]?.report ?? null;
}

const SHARED = "Also used by another connection on this computer";

async function machineEpoch(deviceId: string): Promise<number | undefined> {
  const r = await sql<{ machine_epoch: number }>`
    SELECT machine_epoch FROM plugin_device_local.connections WHERE device_id = ${deviceId}`.execute(
    raw,
  );
  return r.rows[0]?.machine_epoch;
}

describe.skipIf(!process.env.CAPYBARA_TEST_DEVICE_LOCAL_E2E)(
  "device-local with the published capybara-device",
  { timeout: 180_000 },
  () => {
    let owner: KernelRequest;
    let session: string;
    let orgId: string;
    let agentId: string;
    let deviceId: string;
    let calls = 0;
    let conv: string;

    beforeAll(async () => {
      programDir = await realpath(await mkdtemp(join(tmpdir(), "cdl-program-")));
      const npm = spawn(
        "npm",
        [
          "install",
          "--prefix",
          programDir,
          "--no-audit",
          "--no-fund",
          "--ignore-scripts",
          `@capybara-hq/device@${DEVICE_VERSION}`,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let npmOut = "";
      npm.stdout.on("data", (b: Buffer) => {
        npmOut += b.toString("utf8");
      });
      npm.stderr.on("data", (b: Buffer) => {
        npmOut += b.toString("utf8");
      });
      const installed = await new Promise<number | null>((resolve) => npm.on("exit", resolve));
      expect(installed, npmOut).toBe(0);
      program = join(programDir, "node_modules/@capybara-hq/device/bin/capybara-device.mjs");
      [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
      raw = createDb(pgc.url, 3);
      db = kernelDb(raw);
      const port = await freePort();
      publicUrl = `http://127.0.0.1:${port}`;
      k = await startTestKernel(
        testKernelConfig(
          { pg: pgc.url, redis: rd.url },
          {
            extensions: [MODEL_FAKE, DEVICE_LOCAL],
            roles: ["api", "worker", "gateway"],
            http: { port, publicUrl: `${publicUrl}/` },
          },
        ),
        { resolveFrom: PLUGIN_DIR },
      );
      await createLocalAccount(db, "owner");
      owner = await login(k, "owner");
      session = await sessionCookie("owner");
      orgId = await createOrg(owner);
      await enableModelProviders(owner, orgId, ["model-fake"]);
      const on = await owner({
        method: "PUT",
        url: `/api/v1/orgs/${orgId}/extensions/device-local`,
        payload: { enabled: true },
      });
      expect(on.statusCode, on.body).toBe(200);
      const agent = await owner({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/agents`,
        payload: {
          definition: {
            name: "Coder",
            instructions: "Use the device.",
            model: { provider: "model-fake", model: "fake-1" },
            disabledTools: [],
          },
          visibility: "org",
        },
      });
      expect(agent.statusCode, agent.body).toBe(201);
      agentId = (agent.json() as { agent: { id: string } }).agent.id;
    }, 300_000);

    afterAll(async () => {
      for (const m of machines.splice(0)) await m.dispose();
      await k?.close();
      await raw?.destroy();
      await Promise.all([pgc?.stop(), rd?.stop()]);
      if (programDir) await rm(programDir, { recursive: true, force: true });
    }, 120_000);

    /** A conversation bound to the device. */
    async function conversationOn(device: string): Promise<string> {
      const r = await owner({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/conversations`,
        payload: { agentId, deviceId: device },
      });
      expect(r.statusCode, r.body).toBe(201);
      calls = 0;
      return (r.json() as { conversation: { id: string } }).conversation.id;
    }

    /** One `Bash` call through the conversation (model-fake's `tool:` script); its result. */
    async function bash(command: string) {
      await postMessage(
        owner,
        orgId,
        conv,
        `tool:Bash:${JSON.stringify({ description: "E2E step", command })}`,
      );
      calls += 1;
      await waitForTerminal(db, conv, calls, 120_000);
      const results = (await eventsOf(db, conv)).filter(
        (e): e is ToolResultEvent => e.type === "tool_result",
      );
      const r = results.at(-1) as ToolResultEvent;
      expect(r.payload.toolKey).toBe("Bash");
      return r.payload;
    }

    let first: Machine;

    it("signs in through the kernel's code flow, connects and runs a command", async () => {
      first = await Machine.create();
      deviceId = await first.login(session, orgId, { name: `laptop-${randomUUID().slice(0, 6)}` });
      await first.start(orgId, deviceId, owner);
      conv = await conversationOn(deviceId);
      const r = await bash("echo hi");
      expect(r.isError, `${r.content}\n${first.output}`).toBe(false);
      expect(r.content).toMatch(/(^|\n)hi\n?/);
      expect(await bindingRow(deviceId)).toMatchObject({ status: "installed", unattested: false });
    });

    it("a restart keeps the binding; a restart under a changed runtime is re-probed and rebound", async () => {
      const bound = await bindingRow(deviceId);
      // the same program again: it recovers its binding, the instance is kept
      await first.stop();
      await first.start(orgId, deviceId, owner);
      const again = await bash("echo again");
      expect(again.isError, `${again.content}\n${first.output}`).toBe(false);
      expect(again.content).toContain("again");
      expect((await bindingRow(deviceId))?.generation).toBe(bound?.generation);

      // a changed runtime: the stored binding no longer matches what the program verifies, so it
      // comes back unbound; the provider marks the binding unattested and the kernel rebinds
      await first.stop();
      const [file] = await first.bindingFiles();
      expect(file, "the program's stored binding").toBeDefined();
      const stored = JSON.parse(await readFile(String(file), "utf8")) as {
        runtimeIdentity: { runtimeHash: string };
      };
      stored.runtimeIdentity.runtimeHash = "0".repeat(64);
      await writeFile(String(file), JSON.stringify(stored), { mode: 0o600 });
      await first.start(orgId, deviceId, owner);
      await waitFor(
        async () => ((await bindingRow(deviceId))?.unattested ? true : undefined),
        30_000,
        "the binding unattested after the unbound hello",
      );
      // the next call finds the instance gone before anything reaches the machine; the kernel
      // keeps a dispatched call's outcome unknown (never retried under a new identity) and
      // rebuilds the instance on the kept files, which binds a new generation
      const dropped = await bash("echo dropped");
      expect(dropped.isError, dropped.content).toBe(true);
      const rebound = await bash("echo rebound");
      expect(rebound.isError, `${rebound.content}\n${first.output}`).toBe(false);
      expect(rebound.content).toContain("rebound");
      const now = await bindingRow(deviceId);
      expect(BigInt(String(now?.generation))).toBeGreaterThan(BigInt(String(bound?.generation)));
      expect(now).toMatchObject({ status: "installed", unattested: false });
    });

    let second: Machine;

    it("another machine signing in replaces the first", async () => {
      const epoch = await machineEpoch(deviceId);
      second = await Machine.create();
      await second.login(session, orgId, { deviceId });
      expect(await first.ended(), first.output).toBe(0);
      expect(first.output).toContain(REPLACED);
      await second.start(orgId, deviceId, owner);
      const r = await bash("echo second");
      expect(r.isError, `${r.content}\n${second.output}`).toBe(false);
      expect(r.content).toContain("second");
      expect(await machineEpoch(deviceId)).toBeGreaterThan(Number(epoch));
    });

    it("revoking the machine ends the program; a new login connects again", async () => {
      const revoked = await owner({
        method: "DELETE",
        url: `/api/v1/orgs/${orgId}/devices/${deviceId}/machine`,
      });
      expect(revoked.statusCode, revoked.body).toBeLessThan(300);
      expect(await second.ended(), second.output).toBe(0);
      expect(second.output).toContain(DISCONNECTED);
      expect((await deviceView(owner, orgId, deviceId)).online).not.toBe(true);

      // the same computer signs in again into the same device and serves it
      second.run(["logout"]);
      expect(await second.ended(), second.output).toBe(0);
      await second.login(session, orgId, { deviceId });
      await second.start(orgId, deviceId, owner);
      const r = await bash("echo back");
      expect(r.isError, `${r.content}\n${second.output}`).toBe(false);
      expect(r.content).toContain("back");
    });

    it("deleting the device ends the program with the deleted message", async () => {
      const deleted = await owner({
        method: "DELETE",
        url: `/api/v1/orgs/${orgId}/devices/${deviceId}`,
      });
      expect(deleted.statusCode, deleted.body).toBeLessThan(300);
      expect(await second.ended(), second.output).toBe(0);
      expect(second.output).toContain(DELETED);
      expect(await bindingRow(deviceId)).toBeUndefined();
    });

    it("a listed project directory another connection also uses shows in the report; its change keeps the revision", async () => {
      // one computer with two connections (two devices) that both used the same project directory
      const computer = await Machine.create();
      const a = await computer.login(session, orgId, { name: `a-${randomUUID().slice(0, 6)}` });
      const b = await computer.login(session, orgId, { name: `b-${randomUUID().slice(0, 6)}` });
      const project = join(computer.home, "shared-project");
      await mkdir(project);
      await computer.usedProjects(a, [project]);
      await computer.usedProjects(b, [project]);
      // the owner lists it for connection a: only then does a's deployment learn it is shared
      await computer.command(["policy", "add", "projectPaths", project, "-c", a]);
      await computer.start(orgId, a, owner, true);
      const shown = await waitFor(
        async () => {
          const r = await storedReport(a);
          return r?.limits.some((l) => l.label.en === SHARED) ? r : undefined;
        },
        30_000,
        "the shared directory in the report",
      ).catch((e: unknown) => {
        throw new Error(`${String(e)}; program output: ${computer.output}`);
      });
      const line = shown.limits.find((l) => l.label.en === SHARED);
      expect(line?.value).toBe(project);
      // the report never names the other connection
      expect(JSON.stringify(shown)).not.toContain(b);

      // the other connection stops using it while a is connected: a's next policy event carries the
      // same owner ceiling (other connections' project lists are not part of it) and no shared
      // directory; the line goes, the revision (the device authority epoch input) stays
      await computer.usedProjects(b, []);
      const gone = await waitFor(
        async () => {
          const r = await storedReport(a);
          return r && !r.limits.some((l) => l.label.en === SHARED) ? r : undefined;
        },
        30_000,
        "the shared directory gone from the report",
      ).catch((e: unknown) => {
        throw new Error(`${String(e)}; program output: ${computer.output}`);
      });
      expect(gone.revision).toBe(shown.revision);
      await computer.stop();
    });
  },
);
