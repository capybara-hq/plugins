import { execFile, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
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
  type SandboxPermissionSupport,
} from "@capybara-hq/plugin-sdk";
import {
  type NativeFixtureEntry,
  runSandboxPermissionConformance,
  type SandboxPermissionFixture,
  type SandboxPermissionGrant,
} from "@capybara-hq/testing";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDockerSandbox, type DockerSandboxProvider } from "../src/index.js";
import { operationUuid } from "../src/operations.js";
import {
  OPERATION_AGENT_SHA256,
  RUNTIME_BUNDLE_VERSION,
  runtimeChecksums,
  SDK_RUNTIME_FILES,
  sdkRuntimeDigests,
} from "../src/runtime-source.js";
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

/**
 * The operation contract on the actual provider: the published SDK runtime staged in the real
 * sandbox image, driven through the socket proxy into a container with the provider's unchanged
 * hardening. The permission conformance suite of @capybara-hq/testing runs against it (positive
 * shell / Python / Node / curl controls, sibling, symlink and protected-path denials, both overlap
 * orders, component and root swaps, mutable syscall pointers, exact cancellation and narrowing),
 * plus the provider's own cases: Full against restricted, the per-operation allowlist forwarder
 * through the real egress proxy, durable consumption and revocation, preparation, browsing and
 * fail-closed images. Skipped without Docker; CAPYBARA_TEST_REQUIRE_LINUX_RESTRICTED=1 (evidence
 * mode) fails instead of skipping, and fails when the runtime reports restricted unavailable.
 */

const exec = promisify(execFile);
const required = process.env.CAPYBARA_TEST_REQUIRE_LINUX_RESTRICTED === "1";
const imageDir = fileURLToPath(new URL("../image/", import.meta.url));
const RUN = randomUUID().slice(0, 8);
const sig = () => AbortSignal.timeout(300_000);
const enc = new TextEncoder();
const dec = new TextDecoder();

describe("staged runtime", () => {
  it("stages the SDK runtime bytes unchanged", async () => {
    expect(SANDBOX_RUNTIME_SOURCE.version).toBe(RUNTIME_BUNDLE_VERSION);
    for (const name of SDK_RUNTIME_FILES) {
      const file = SANDBOX_RUNTIME_SOURCE.files.find((f) => f.name === name);
      const staged = await readFile(`${imageDir}runtime/${name}`, "utf8");
      expect(staged === file?.source, `${name} differs from the SDK bundle`).toBe(true);
      expect(createHash("sha256").update(staged).digest("hex")).toBe(file?.sha256);
    }
  });

  it("pins the agent digest and the image checksums", async () => {
    const agent = await readFile(`${imageDir}runtime/capybara-operation.py`);
    expect(createHash("sha256").update(agent).digest("hex")).toBe(OPERATION_AGENT_SHA256);
    expect(await readFile(`${imageDir}runtime/SHA256SUMS`, "utf8")).toBe(runtimeChecksums());
  });

  it("copies the runtime root-owned and checks it while building the image", async () => {
    const dockerfile = await readFile(`${imageDir}Dockerfile`, "utf8");
    expect(dockerfile).toMatch(/COPY --chown=0:0 runtime\/ \/opt\/capybara-runtime\//);
    expect(dockerfile).toMatch(/sha256sum -c SHA256SUMS/);
  });
});

describe.runIf(required && !dockerAvailable)("Linux restricted runtime is required", () => {
  it("has Docker", () => {
    throw new Error("CAPYBARA_TEST_REQUIRE_LINUX_RESTRICTED=1 but Docker is not available");
  });
});

const limits = (network: SandboxLimits["network"]): SandboxLimits => ({
  cpu: 1,
  memoryMb: 1024,
  diskMb: 2048,
  mode: "auto",
  network,
});

/**
 * The granted endpoint is a service outside the device, reached only by its allowlisted name
 * through the operation's forwarder and the instance's real egress proxy (which pins the name to
 * the service's address, exempt from its private-address check). The ungranted endpoints listen
 * on the device's loopback, where Full access reaches them directly.
 */
const GRANTED_NAME = "granted.permission.example";
const GRANTED_PORT = 18080;
const ENDPOINTS = { u4: ["127.0.0.1", 18081], u6: ["::1", 18082] };
const UNGRANTED_NAMES = {
  u4: "ungranted4.permission.example",
  u6: "ungranted6.permission.example",
};
const RECEIPTS = "/tmp/capybara-receipts";

/** Controlled endpoints, run as root so the device user cannot forge their receipt counts. */
const LISTEN = `
import json, os, socket, sys, threading
directory, endpoints = sys.argv[1], json.loads(sys.argv[2])
os.makedirs(directory, mode=0o755, exist_ok=True)
def serve(name, host, port):
    server = socket.socket(socket.AF_INET6 if ":" in host else socket.AF_INET)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((host, port))
    server.listen(128)
    count = 0
    while True:
        conn, _ = server.accept()
        count += 1
        path = os.path.join(directory, name)
        with open(path + ".tmp", "w") as handle:
            handle.write(str(count))
        os.chmod(path + ".tmp", 0o644)
        os.rename(path + ".tmp", path)
        try:
            conn.sendall(b"HTTP/1.0 200 OK\\r\\nContent-Length: 2\\r\\n\\r\\nok")
        except OSError:
            pass
        conn.close()
for name, (host, port) in endpoints.items():
    threading.Thread(target=serve, args=(name, host, port), daemon=True).start()
threading.Event().wait()
`;
const WAIT_READY = `
import socket
for host, port in ((${JSON.stringify(ENDPOINTS.u4[0])}, ${ENDPOINTS.u4[1]}), (${JSON.stringify(ENDPOINTS.u6[0])}, ${ENDPOINTS.u6[1]})):
    while True:
        try:
            socket.create_connection((host, port)).close()
            break
        except OSError:
            pass
`;
const SEED = `
import base64, json, os, sys
for e in json.load(sys.stdin):
    os.makedirs(os.path.dirname(e["path"]), exist_ok=True)
    if e["kind"] == "directory":
        os.makedirs(e["path"], exist_ok=True)
    elif e["kind"] == "file":
        open(e["path"], "wb").write(base64.b64decode(e["dataB64"]))
    else:
        os.symlink(e["target"], e["path"])
`;
const INSPECT = `
import base64, json, os, sys
kind, arg = sys.argv[1], sys.argv[2]
if kind == "read":
    try:
        print(json.dumps(base64.b64encode(open(arg, "rb").read()).decode()))
    except (FileNotFoundError, IsADirectoryError, NotADirectoryError):
        print("null")
elif kind == "mode":
    try:
        print(os.stat(arg).st_mode & 0o7777)
    except FileNotFoundError:
        print("null")
else:
    alive = []
    for pid in json.loads(arg):
        try:
            state = open("/proc/%d/stat" % pid).read().rsplit(")", 1)[1].split()[0]
            if state not in ("Z", "X"):
                alive.append(pid)
        except OSError:
            pass
    print(json.dumps(alive))
`;

describe.skipIf(!dockerAvailable)(
  "operation permission scopes on the actual provider",
  { timeout: 1_800_000 },
  () => {
    let images: TestImages;
    let proxy: SocketProxy;
    let sbx: DockerSandboxProvider;
    let device: SandboxHandle;
    let support: SandboxPermissionSupport;
    const netName = `capybara-sandbox-perm-${RUN}`;
    let target: StartedTestContainer;
    let grantedService: StartedTestContainer;
    const made: string[] = [];
    /** Test hooks: a file a background supervisor waits for before admission; revoke steps. */
    const barriers = new Map<string, string>();
    const afterKill = new Map<string, () => Promise<void>>();
    const spoolCaps = new Map<string, number>();
    const beforeLaunch = new Map<
      string,
      (taskId: string, leaked: Readonly<Record<string, unknown>>) => Promise<void>
    >();

    /** One device (file system plus instance) under a fresh name. */
    const newDevice = async (
      provider: DockerSandboxProvider,
      network: SandboxLimits["network"],
      image?: string,
    ): Promise<SandboxHandle> => {
      const name = `cap-device-perm-${randomUUID().slice(0, 8)}`;
      made.push(name);
      const fileSystem = await provider.createFileSystem({
        name,
        limits: limits(network),
        signal: sig(),
      });
      return provider.create({
        name,
        limits: limits(network),
        fileSystem,
        signal: sig(),
        ...(image !== undefined && { image }),
      });
    };

    const dexec = (container: string, user: string, args: string[], input?: string) =>
      new Promise<string>((resolve, reject) => {
        const r = spawnSync("docker", ["exec", "-i", "-u", user, container, ...args], {
          input,
          encoding: "utf8",
        });
        if (r.status !== 0) reject(new Error(`docker exec failed: ${r.stderr}`));
        else resolve(r.stdout);
      });

    const scopeFor = (
      grant: SandboxPermissionGrant,
      overrides: Partial<SandboxOperationScope> = {},
    ): SandboxOperationScope => ({
      operationId: randomUUID(),
      admitBeforeMs: Date.now() + 600_000,
      deviceId: "device-perm",
      rootConversationId: "conv-perm",
      profileRevision: 1,
      ceilingRevision: "ceiling-1",
      profile: grant.profile,
      actor: { accountId: "acc-perm", conversationId: "conv-perm" },
      tag: "perm-test",
      filesystem: grant.filesystem,
      network: grant.network,
      ...overrides,
    });

    const restricted = (
      writeRoots: string[],
      network: SandboxPermissionGrant["network"] = { kind: "none" },
      readRoots: string[] = [],
    ): SandboxPermissionGrant => ({
      profile: "approve-for-me",
      filesystem: { kind: "scoped", readRoots, writeRoots },
      network,
    });
    const full: SandboxPermissionGrant = {
      profile: "full-access",
      filesystem: { kind: "device" },
      network: { kind: "environment" },
    };

    const run = async (
      h: SandboxHandle,
      grant: SandboxPermissionGrant,
      command: string,
      o: {
        cwd?: string;
        signal?: AbortSignal;
        timeoutMs?: number;
        scope?: Partial<SandboxOperationScope>;
      } = {},
    ) =>
      (await sbx.operation(h, scopeFor(grant, o.scope), sig())).exec({
        command,
        ...(o.cwd !== undefined && { cwd: o.cwd }),
        timeoutMs: o.timeoutMs ?? 120_000,
        maxOutputBytes: 1 << 20,
        signal: o.signal ?? sig(),
      });

    const inspectRead = async (h: SandboxHandle, path: string) =>
      JSON.parse(await dexec(h.id, "1000", ["python3", "-I", "-c", INSPECT, "read", path])) as
        | string
        | null;
    const alive = async (h: SandboxHandle, pids: number[]) =>
      JSON.parse(
        await dexec(h.id, "1000", ["python3", "-I", "-c", INSPECT, "alive", JSON.stringify(pids)]),
      ) as number[];
    const waitFor = async (h: SandboxHandle, path: string) => {
      while ((await inspectRead(h, path)) === null) {
        await new Promise((r) => setImmediate(r));
      }
    };
    const text = (b64: string | null) =>
      b64 === null ? null : Buffer.from(b64, "base64").toString();

    beforeAll(async () => {
      [images, proxy] = await Promise.all([
        buildTestImages(),
        startSocketProxy(),
        docker("network", "create", "--label", `${TEST_LABEL}=${RUN}`, netName),
      ]);
      // An HTTP service the egress proxy reaches (pinned by egressTestHosts) for the forwarder.
      target = await new GenericContainer(images.egressImage)
        .withNetworkMode(netName)
        .withUser("root")
        .withCommand([
          "node",
          "-e",
          "require('http').createServer((q,s)=>s.end('hello-'+q.headers.host)).listen(80,()=>console.log('ready'))",
        ])
        .withWaitStrategy(Wait.forLogMessage("ready"))
        .start();
      const targetIp = target.getIpAddress(netName);
      // The conformance suite's granted endpoint: counts every accepted connection itself.
      grantedService = await new GenericContainer(images.egressImage)
        .withNetworkMode(netName)
        .withUser("root")
        .withCommand([
          "node",
          "-e",
          `let n = 0; const fs = require("fs"); require("net").createServer((c) => { n++; fs.writeFileSync("/tmp/count.tmp", String(n)); fs.renameSync("/tmp/count.tmp", "/tmp/count"); c.end("HTTP/1.0 200 OK\\r\\nContent-Length: 2\\r\\n\\r\\nok"); }).listen(${GRANTED_PORT}, () => console.log("ready"))`,
        ])
        .withWaitStrategy(Wait.forLogMessage("ready"))
        .start();
      sbx = createDockerSandbox(
        {
          endpoint: proxy.endpoint,
          runtime: "runc",
          network: netName,
          egressProxyImage: images.egressImage,
          defaultImage: images.sandboxImage,
        },
        {
          labels: { [TEST_LABEL]: RUN },
          egressTestHosts: {
            "allowed.example.com": targetIp,
            "denied.example.com": targetIp,
            [GRANTED_NAME]: grantedService.getIpAddress(netName),
          },
          backgroundLaunchBarrier: (taskId) => barriers.get(taskId),
          afterRevokeKill: (operationId) => afterKill.get(operationId)?.() ?? Promise.resolve(),
          backgroundSpoolCapBytes: (taskId) => spoolCaps.get(taskId),
          beforeBackgroundLaunch: (taskId, leaked) =>
            beforeLaunch.get(taskId)?.(taskId, leaked) ?? Promise.resolve(),
        },
      );
      device = await newDevice(sbx, { kind: "allowlist", hosts: [] });
      support = await sbx.permissionSupport(device, sig());
      const host = (...args: string[]) =>
        spawnSync(args[0] as string, args.slice(1), { encoding: "utf8" }).stdout?.trim() ?? "";
      // The real runtime this evidence ran on.
      console.info(
        `[sandbox-docker permission] ${JSON.stringify({
          support,
          kernel: (await dexec(device.id, "1000", ["uname", "-srm"])).trim(),
          landlockAbi: (
            await dexec(device.id, "1000", [
              "python3",
              "-I",
              "-c",
              "import ctypes; print(ctypes.CDLL(None).syscall(444, None, 0, 1))",
            ])
          ).trim(),
          docker: host(
            "docker",
            "version",
            "--format",
            "{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}",
          ),
          dockerSecurity: host("docker", "info", "--format", "{{json .SecurityOptions}}"),
          image: host(
            "docker",
            "image",
            "inspect",
            images.sandboxImage,
            "--format",
            "{{.Id}} {{.Architecture}}",
          ),
        })}`,
      );
      if (required && support.restricted === null) {
        throw new Error(
          `CAPYBARA_TEST_REQUIRE_LINUX_RESTRICTED=1 but: ${support.unavailableReason ?? "unsupported"}`,
        );
      }
    }, 1_800_000);

    afterAll(async () => {
      await target?.stop();
      await grantedService?.stop();
      await cleanupTestResources(RUN);
      await proxy?.stop();
    }, 300_000);

    /** Skips a mechanism case where restricted mode is unavailable, or fails in evidence mode. */
    const requireRestricted = (context: { skip: (note?: string) => void }) => {
      if (support.restricted !== null) return;
      if (required) throw new Error(`restricted unavailable: ${support.unavailableReason}`);
      context.skip(`restricted unavailable: ${support.unavailableReason}`);
    };

    it("keeps the container hardening unchanged", async () => {
      const inspect = JSON.parse(await docker("inspect", device.id))[0].HostConfig;
      expect(inspect.CapDrop).toEqual(["ALL"]);
      expect(inspect.CapAdd ?? []).toEqual([]);
      expect(inspect.SecurityOpt).toEqual(["no-new-privileges:true"]);
      expect(inspect.ReadonlyRootfs).toBe(true);
      expect(inspect.Privileged).toBe(false);
      expect(inspect.NetworkMode).toBe("none");
      expect(inspect.PidsLimit).toBe(1024);
      // Docker's default seccomp profile is active (mode 2) for the device user.
      expect(
        await dexec(device.id, "1000", ["sh", "-c", "id -u; grep '^Seccomp:' /proc/self/status"]),
      ).toMatch(/^1000\nSeccomp:\s+2/);
      // The staged runtime is root-owned and the device user cannot change it.
      expect(
        await dexec(device.id, "1000", [
          "sh",
          "-c",
          "stat -c '%u %a' /opt/capybara-runtime /opt/capybara-runtime/*; touch /opt/capybara-runtime/x 2>/dev/null || echo refused",
        ]),
      ).toMatch(/^0 755\n(0 644\n){4}refused\n$/);
    });

    it("reports support from the launcher's own probe, never from a fixture", async () => {
      const arch = (await dexec(device.id, "1000", ["uname", "-m"])).trim();
      const probe = JSON.parse(
        await dexec(device.id, "1000", [
          "python3",
          "-I",
          "/opt/capybara-runtime/linux-sandbox.py",
          "probe",
        ]),
      ) as { restricted: object | null; landlockAbi?: number };
      expect(support.version).toBe(1);
      expect(support.fullAccess).toBe(true);
      expect(support.background).toBe(true);
      if (probe.restricted === null) {
        expect(support.restricted).toBeNull();
        expect(support.unavailableReason).toBeTruthy();
      } else {
        expect(["aarch64", "x86_64"]).toContain(arch);
        expect(probe.landlockAbi).toBeGreaterThanOrEqual(6);
        expect(support.restricted).toEqual({
          filesystem: true,
          network: true,
          native: true,
          concurrentScopes: true,
        });
      }
    });

    it("passes the permission conformance on the actual provider", async () => {
      // A device whose instance network allowlists the granted name: its allowlist operations
      // reach it only through their own forwarder and the instance's egress proxy.
      const net = await newDevice(sbx, { kind: "allowlist", hosts: [GRANTED_NAME] });
      spawnSync("docker", [
        "exec",
        "-d",
        "-u",
        "0",
        net.id,
        "python3",
        "-I",
        "-c",
        LISTEN,
        RECEIPTS,
        JSON.stringify(ENDPOINTS),
      ]);
      await dexec(net.id, "1000", ["python3", "-I", "-c", WAIT_READY]);
      const id = randomUUID().slice(0, 8);
      const root = `/workspace/project-${id}`;
      const sibling = `/workspace/sibling-${id}`;
      const protectedPath = `/workspace/.profile-${id}`;
      await dexec(net.id, "1000", [
        "sh",
        "-c",
        `mkdir ${root} ${sibling} && printf rc > ${protectedPath}`,
      ]);
      const loopback = (name: keyof typeof ENDPOINTS) => ({
        name: UNGRANTED_NAMES[name],
        address: ENDPOINTS[name][0] as string,
        port: ENDPOINTS[name][1] as number,
        receipts: async () => Number(text(await inspectRead(net, `${RECEIPTS}/${name}`)) ?? 0),
      });
      const fixture: SandboxPermissionFixture = {
        root,
        sibling,
        protectedPaths: [protectedPath],
        endpoints: {
          granted: {
            name: GRANTED_NAME,
            address: grantedService.getIpAddress(netName),
            port: GRANTED_PORT,
            receipts: async () => {
              const r = await grantedService.exec(["cat", "/tmp/count"]);
              return r.exitCode === 0 ? Number(r.output.trim()) : 0;
            },
          },
          ungranted: [loopback("u4"), loopback("u6")],
          // The provider's production path: allowlisted names only through the operation's
          // forwarder and the real egress proxy; no direct endpoint mapping exists.
          access: "proxy",
        },
        support: () => sbx.permissionSupport(net, sig()),
        operation: (grant) => sbx.operation(net, scopeFor(grant), sig()),
        async seed(entries: readonly NativeFixtureEntry[]) {
          await dexec(
            net.id,
            "1000",
            ["python3", "-I", "-c", SEED],
            JSON.stringify(
              entries.map((e) =>
                e.kind === "file"
                  ? { ...e, data: undefined, dataB64: Buffer.from(e.data).toString("base64") }
                  : e,
              ),
            ),
          );
        },
        inspect: {
          readFile: async (path) => {
            const v = await inspectRead(net, path);
            return v === null ? null : new Uint8Array(Buffer.from(v, "base64"));
          },
          mode: async (path) =>
            JSON.parse(
              await dexec(net.id, "1000", ["python3", "-I", "-c", INSPECT, "mode", path]),
            ) as number | null,
          alive: (pids) => alive(net, [...pids]),
        },
        dispose: async () => undefined,
      };
      await runSandboxPermissionConformance(fixture);
    });

    it("runs Full access without the restricted filters that restricted work gets", async (context) => {
      requireRestricted(context);
      const root = `/workspace/compare-${randomUUID().slice(0, 8)}`;
      await dexec(device.id, "1000", ["mkdir", root]);
      const probe =
        "grep -E '^(Seccomp_filters|NoNewPrivs):' /proc/self/status | tr '\\n' ' '; " +
        "python3 -c 'import os; os.setsid(); print(\"setsid-ok\")' 2>/dev/null || echo setsid-denied; " +
        "cat /etc/hostname > /dev/null && echo etc-read; " +
        "printf x > /workspace/outside-compare 2>/dev/null && echo outside-write || echo outside-denied";
      const f = await run(device, full, probe, { cwd: root });
      const r = await run(device, restricted([root]), probe, { cwd: root });
      expect(f.exitCode).toBe(0);
      expect(r.exitCode).toBe(0);
      const filters = (out: string) => Number(out.match(/Seccomp_filters:\s+(\d+)/)?.[1]);
      console.info(
        `[sandbox-docker permission] full: ${f.stdout.trim()} | restricted: ${r.stdout.trim()}`,
      );
      // Full keeps only the container's own filter; restricted adds the launcher's.
      expect(filters(r.stdout)).toBeGreaterThan(filters(f.stdout));
      expect(f.stdout).toMatch(/setsid-ok/);
      expect(f.stdout).toMatch(/outside-write/);
      expect(r.stdout).toMatch(/setsid-denied/);
      expect(r.stdout).toMatch(/etc-read/);
      expect(r.stdout).toMatch(/outside-denied/);
    });

    it("reaches allowlisted hosts only through the operation's forwarder and the real egress proxy", async (context) => {
      requireRestricted(context);
      const h = await newDevice(sbx, {
        kind: "allowlist",
        hosts: ["allowed.example.com", "denied.example.com"],
      });
      const root = "/workspace/net";
      await dexec(h.id, "1000", ["mkdir", root]);
      const curl = (host: string) => `curl -fsS -m 20 http://${host}/; true`;
      const exec = async (grant: SandboxPermissionGrant, command: string) =>
        (await sbx.operation(h, scopeFor(grant), sig())).exec({
          command,
          cwd: root,
          timeoutMs: 120_000,
          maxOutputBytes: 1 << 20,
          signal: sig(),
        });
      const allowed = await exec(
        restricted([root], { kind: "allowlist", hosts: ["allowed.example.com"] }),
        `curl -fsS -m 20 http://allowed.example.com/; echo; curl -sS -m 20 http://denied.example.com/ -o /dev/null -w 'denied=%{http_code}\\n'; ` +
          `python3 -c 'import os,socket; h=os.environ["HTTP_PROXY"]; print("proxy", h.startswith("http://127.0.0.1:"))'; ` +
          // The instance's egress proxy itself is not an endpoint of this operation.
          `python3 -c 'import socket, sys; socket.create_connection((sys.argv[1], 3128), 5)' ${h.id}-egress 2>/dev/null && echo egress-direct || echo egress-refused`,
      );
      expect(allowed.stdout).toContain("hello-allowed.example.com");
      expect(allowed.stdout).toContain("denied=403");
      expect(allowed.stdout).toContain("proxy True");
      expect(allowed.stdout).toContain("egress-refused");
      const none = await exec(restricted([root]), curl("allowed.example.com"));
      expect(none.stdout).not.toContain("hello-");
      // Environment lifts only the operation filter: the instance network still applies.
      const environment = await exec(
        restricted([root], { kind: "environment" }),
        "curl -fsS -m 20 http://denied.example.com/; echo; curl -sS -m 10 http://other.example.org/ -o /dev/null -w 'other=%{http_code}\\n'",
      );
      expect(environment.stdout).toContain("hello-denied.example.com");
      expect(environment.stdout).not.toContain("other=200");
    });

    it("consumes an operation ID once and never repeats its effect", async (context) => {
      requireRestricted(context);
      const root = `/workspace/once-${randomUUID().slice(0, 8)}`;
      await dexec(device.id, "1000", ["mkdir", root]);
      const scope = scopeFor(restricted([root]));
      const first = await sbx.operation(device, scope, sig());
      await first.writeFile(`${root}/a`, enc.encode("first"), sig());
      // A retry with the same input is an unknown outcome; other input under the ID is invalid.
      const again = await sbx.operation(device, scope, sig());
      const error = await again.writeFile(`${root}/a`, enc.encode("first"), sig()).catch((e) => e);
      expect(isSandboxOperationOutcomeUnknownError(error)).toBe(true);
      const other = await (await sbx.operation(device, scope, sig()))
        .writeFile(`${root}/a`, enc.encode("second"), sig())
        .catch((e) => e);
      expect(isSandboxScopeValidationError(other)).toBe(true);
      expect(text(await inspectRead(device, `${root}/a`))).toBe("first");
      // An exec retried with its ID never runs twice.
      const execScope = scopeFor(restricted([root]));
      const args = {
        command: "echo run >> runs",
        cwd: root,
        timeoutMs: 30_000,
        maxOutputBytes: 1024,
      };
      expect(
        (await (await sbx.operation(device, execScope, sig())).exec({ ...args, signal: sig() }))
          .exitCode,
      ).toBe(0);
      const repeated = await (await sbx.operation(device, execScope, sig()))
        .exec({ ...args, signal: sig() })
        .catch((e) => e);
      expect(isSandboxOperationOutcomeUnknownError(repeated)).toBe(true);
      expect(text(await inspectRead(device, `${root}/runs`))).toBe("run\n");
      // A passed admission deadline admits nothing.
      const late = await run(device, restricted([root]), "echo late > late", {
        cwd: root,
        scope: { admitBeforeMs: Date.now() - 1 },
      }).catch((e) => e);
      expect(isSandboxScopeDeniedError(late)).toBe(true);
      expect(await inspectRead(device, `${root}/late`)).toBeNull();
    });

    it("revokes before launch and cancels exactly the revoked running work", async (context) => {
      requireRestricted(context);
      const root = `/workspace/revoke-${randomUUID().slice(0, 8)}`;
      await dexec(device.id, "1000", ["mkdir", root]);
      // Revoked before it starts: refused, nothing runs.
      const early = scopeFor(restricted([root]));
      await sbx.revokeOperation(
        device,
        { operationId: early.operationId, admitBeforeMs: early.admitBeforeMs },
        sig(),
      );
      const refused = await (await sbx.operation(device, early, sig()))
        .exec({
          command: "echo ran > early",
          cwd: root,
          timeoutMs: 30_000,
          maxOutputBytes: 1024,
          signal: sig(),
        })
        .catch((e) => e);
      expect(isSandboxScopeDeniedError(refused)).toBe(true);
      expect(await inspectRead(device, `${root}/early`)).toBeNull();
      // Running restricted and Full work with a sibling each: only the revoked ones end.
      for (const grant of [restricted([root]), full]) {
        const tag = grant === full ? "full" : "restricted";
        const victim = scopeFor(grant);
        const sibling = run(
          device,
          grant,
          `printf r > ${root}/${tag}-sib-ready; until [ -e ${root}/${tag}-release ]; do sleep 0.01; done; printf done > ${root}/${tag}-kept`,
          { cwd: root },
        );
        const running = (await sbx.operation(device, victim, sig())).exec({
          command: `(sleep 1200 & echo $! > ${root}/${tag}-child); printf r > ${root}/${tag}-ready; sleep 1201`,
          cwd: root,
          timeoutMs: 120_000,
          maxOutputBytes: 1024,
          signal: sig(),
        });
        await waitFor(device, `${root}/${tag}-ready`);
        await waitFor(device, `${root}/${tag}-sib-ready`);
        const child = Number(text(await inspectRead(device, `${root}/${tag}-child`)));
        expect(await alive(device, [child])).toEqual([child]);
        await sbx.revokeOperation(
          device,
          { operationId: victim.operationId, admitBeforeMs: victim.admitBeforeMs },
          sig(),
        );
        const ended = await running;
        expect(ended.exitCode === null || ended.exitCode >= 128, tag).toBe(true);
        expect(await alive(device, [child]), tag).toEqual([]);
        await dexec(device.id, "1000", ["touch", `${root}/${tag}-release`]);
        expect((await sibling).exitCode, tag).toBe(0);
        expect(text(await inspectRead(device, `${root}/${tag}-kept`)), tag).toBe("done");
      }
    });

    it("killTagged ends a restricted operation's whole tree and nothing else", async (context) => {
      requireRestricted(context);
      const root = `/workspace/tagged-${randomUUID().slice(0, 8)}`;
      await dexec(device.id, "1000", ["mkdir", root]);
      const other = run(
        device,
        restricted([root]),
        `printf r > other-ready; until [ -e release ]; do sleep 0.01; done; printf kept > kept`,
        { cwd: root, scope: { tag: "keep-me" } },
      );
      const victim = run(
        device,
        restricted([root]),
        `(sleep 1300 & echo $! > child); nohup sleep 1301 > /dev/null 2>&1 & echo $! > nohup; printf r > ready; sleep 1302`,
        { cwd: root, scope: { tag: "kill-me" } },
      );
      await waitFor(device, `${root}/ready`);
      await waitFor(device, `${root}/other-ready`);
      const pids = await Promise.all(
        ["child", "nohup"].map(async (n) =>
          Number(text(await inspectRead(device, `${root}/${n}`))),
        ),
      );
      expect(await alive(device, pids)).toEqual(pids);
      await sbx.killTagged(device, ["kill-me"], sig());
      expect((await victim).exitCode).not.toBe(0);
      expect(await alive(device, pids)).toEqual([]);
      await dexec(device.id, "1000", ["touch", `${root}/release`]);
      expect((await other).exitCode).toBe(0);
      expect(text(await inspectRead(device, `${root}/kept`))).toBe("kept");
    });

    it("prepares skills as root through pinned roots and attachments as the device user", async () => {
      const name = `skill-${randomUUID().slice(0, 8)}`;
      const skills = await sbx.prepare(
        device,
        {
          operationId: randomUUID(),
          deviceId: "device-perm",
          purpose: "skills",
          writeRoots: [`/skills/${name}`],
          tag: "prep",
        },
        sig(),
      );
      await skills.writeFile(`/skills/${name}/SKILL.md`, enc.encode("# skill"), sig());
      expect(await skills.stat(`/skills/${name}/SKILL.md`, sig())).toEqual({
        size: 7,
        isDir: false,
      });
      expect(
        dec.decode(
          (await skills.readFile(`/skills/${name}/SKILL.md`, { maxBytes: 100, signal: sig() }))
            ?.data,
        ),
      ).toBe("# skill");
      expect(
        await dexec(device.id, "1000", [
          "sh",
          "-c",
          `cat /skills/${name}/SKILL.md; touch /skills/${name}/x 2>/dev/null || echo ro`,
        ]),
      ).toBe("# skillro\n");
      const outside = await skills
        .writeFile(`/skills/other/x`, enc.encode("x"), sig())
        .catch((e) => e);
      expect(isSandboxScopeDeniedError(outside)).toBe(true);
      await expect(
        sbx.prepare(
          device,
          {
            operationId: randomUUID(),
            deviceId: "device-perm",
            purpose: "skills",
            writeRoots: ["/workspace"],
            tag: "prep",
          },
          sig(),
        ),
      ).rejects.toSatisfy(isSandboxScopeDeniedError);
      // Attachments: a symlink planted inside the conversation subtree never redirects a write.
      const conv = `/workspace/attachments/conv-${randomUUID().slice(0, 8)}`;
      await dexec(device.id, "1000", [
        "sh",
        "-c",
        `mkdir -p ${conv} && ln -s /workspace ${conv}/escape`,
      ]);
      const attachments = await sbx.prepare(
        device,
        {
          operationId: randomUUID(),
          deviceId: "device-perm",
          purpose: "attachments",
          writeRoots: [conv],
          tag: "prep",
        },
        sig(),
      );
      await attachments.writeFile(`${conv}/a/b.txt`, enc.encode("att"), sig());
      expect(text(await inspectRead(device, `${conv}/a/b.txt`))).toBe("att");
      const escaped = await attachments
        .writeFile(`${conv}/escape/pwn`, enc.encode("x"), sig())
        .catch((e) => e);
      expect(escaped).toBeInstanceOf(Error);
      expect(await inspectRead(device, "/workspace/pwn")).toBeNull();
    });

    it("browses metadata inside the owner's roots only", async () => {
      const base = `/workspace/browse-${randomUUID().slice(0, 8)}`;
      await dexec(device.id, "1000", [
        "sh",
        "-c",
        `mkdir -p ${base}/proj/.git ${base}/other && printf s > ${base}/secret && ln -s /workspace ${base}/out`,
      ]);
      const browse = await sbx.browse(
        device,
        {
          operationId: randomUUID(),
          admitBeforeMs: Date.now() + 60_000,
          deviceId: "device-perm",
          accountId: "acc-perm",
          ceilingRevision: "ceiling-1",
          readRoots: [base],
          tag: "browse",
        },
        sig(),
      );
      expect(await browse.list(base, { limit: 10, signal: sig() })).toEqual({
        entries: [
          { name: "other", isDir: true },
          { name: "out", isDir: false },
          { name: "proj", isDir: true },
          { name: "secret", isDir: false },
        ],
        truncated: false,
      });
      const fresh = () =>
        sbx.browse(
          device,
          {
            operationId: randomUUID(),
            admitBeforeMs: Date.now() + 60_000,
            deviceId: "device-perm",
            accountId: "acc-perm",
            ceilingRevision: "ceiling-1",
            readRoots: [base],
            tag: "browse",
          },
          sig(),
        );
      expect(await (await fresh()).scan(base, { signal: sig() })).toEqual([
        { path: `${base}/proj`, suggestedName: "proj" },
      ]);
      await expect(
        (await fresh()).list("/workspace", { limit: 10, signal: sig() }),
      ).rejects.toSatisfy(isSandboxScopeDeniedError);
      await expect((await fresh()).stat(`${base}/out/x`, sig())).rejects.toSatisfy(
        isSandboxScopeDeniedError,
      );
      expect("readFile" in (await fresh())).toBe(false);
    });

    describe("background executions", () => {
      const bgArgs = (
        root: string,
        command: string,
        extra: Partial<{ outputPath: string; timeoutMs: number }> = {},
      ) => ({
        command,
        cwd: root,
        timeoutMs: extra.timeoutMs ?? 600_000,
        maxOutputBytes: 1 << 20,
        signal: sig(),
        taskId: `task-${randomUUID().slice(0, 8)}`,
        outputPath: extra.outputPath ?? `${root}/out.log`,
        retainUntilMs: Date.now() + 3_600_000,
      });
      const newRoot = async (prefix: string) => {
        const root = `/workspace/${prefix}-${randomUUID().slice(0, 8)}`;
        await dexec(device.id, "1000", ["mkdir", root]);
        return root;
      };

      it("supervises restricted work exactly: status, tail, positional reads, idempotent start and stop", async (context) => {
        requireRestricted(context);
        const root = await newRoot("bg");
        const scope = scopeFor(restricted([root]));
        const args = bgArgs(
          root,
          `echo started >> starts; printf 'line-1\\n'; printf 'line-2\\n' >&2; (sleep 1400 & echo $! > child); ` +
            `printf r > ready; until [ -e release ]; do sleep 0.01; done; { printf pwn > ${root}-outside; } 2>/dev/null; echo done; sleep 1401`,
        );
        const ref = await sbx.background.start(device, scope, args);
        await waitFor(device, `${root}/ready`);
        // A retry after a lost acknowledgement returns the same reference and launches nothing.
        expect(await sbx.background.start(device, scope, { ...args, signal: sig() })).toEqual(ref);
        expect(text(await inspectRead(device, `${root}/starts`))).toBe("started\n");
        expect(await sbx.background.status(device, ref, sig())).toEqual({ state: "running" });
        await dexec(device.id, "1000", ["touch", `${root}/release`]);
        const until = async (want: string) => {
          for (;;) {
            const r = await sbx.background.readOutput(device, ref, {
              offset: 0,
              maxBytes: 65_536,
              signal: sig(),
            });
            if ("data" in r && dec.decode(r.data).includes(want)) return r;
            await new Promise((resolve) => setImmediate(resolve));
          }
        };
        const all = await until("done");
        // stdout and stderr are both retained; their relative order in the merged spool is not fixed
        const merged = "data" in all ? dec.decode(all.data) : "";
        expect(merged).toContain("line-1\n");
        expect(merged).toContain("line-2\n");
        expect(merged).toMatch(/done\n$/);
        if (!("data" in all)) throw new Error("output unavailable");
        expect(all.nextOffset).toBe(all.data.byteLength);
        const part = await sbx.background.readOutput(device, ref, {
          offset: 2,
          maxBytes: 3,
          signal: sig(),
        });
        expect("data" in part && { text: dec.decode(part.data), next: part.nextOffset }).toEqual({
          text: "ne-",
          next: 5,
        });
        const past = await sbx.background.readOutput(device, ref, {
          offset: 1_000_000,
          maxBytes: 10,
          signal: sig(),
        });
        expect("data" in past && past.data.byteLength).toBe(0);
        const tail = await sbx.background.tail(device, ref, { maxBytes: 5, signal: sig() });
        expect(
          "data" in tail && { text: dec.decode(tail.data), truncated: tail.truncated },
        ).toEqual({
          text: "done\n",
          truncated: true,
        });
        // The starting grant stays restricted for the whole lifetime.
        expect(await inspectRead(device, `${root}-outside`)).toBeNull();
        expect(text(await inspectRead(device, `${root}/out.log`))).toContain("done");
        await expect(
          sbx.background.readOutput(device, ref, { offset: 0, maxBytes: 65_537, signal: sig() }),
        ).rejects.toSatisfy(isSandboxScopeDeniedError);
        await expect(
          sbx.background.status(device, { ...ref, instanceId: "cap-other" }, sig()),
        ).rejects.toSatisfy(isSandboxScopeDeniedError);
        const child = Number(text(await inspectRead(device, `${root}/child`)));
        expect(await alive(device, [child])).toEqual([child]);
        const stopped = await sbx.background.stop(device, ref, { graceMs: 0, signal: sig() });
        expect(stopped).toEqual({ outcome: "stopped" });
        expect(await alive(device, [child])).toEqual([]);
        expect(await sbx.background.stop(device, ref, { graceMs: 0, signal: sig() })).toEqual(
          stopped,
        );
        expect(await sbx.background.status(device, ref, sig())).toEqual({
          state: "exited",
          exitCode: null,
          timedOut: false,
        });
      });

      it("reports a natural exit, keeps siblings alive and refuses an output path outside the scope", async (context) => {
        requireRestricted(context);
        const root = await newRoot("bg-exit");
        const keep = await sbx.background.start(
          device,
          scopeFor(restricted([root])),
          bgArgs(root, "printf r > keep-ready; sleep 1500", { outputPath: `${root}/keep.log` }),
        );
        const ref = await sbx.background.start(
          device,
          scopeFor(restricted([root])),
          bgArgs(root, "echo bye; exit 3", { outputPath: `${root}/exit.log` }),
        );
        await waitFor(device, `${root}/keep-ready`);
        for (;;) {
          const s = await sbx.background.status(device, ref, sig());
          if (s.state === "exited") {
            expect(s).toEqual({ state: "exited", exitCode: 3, timedOut: false });
            break;
          }
          await new Promise((resolve) => setImmediate(resolve));
        }
        expect(await sbx.background.stop(device, ref, { graceMs: 0, signal: sig() })).toEqual({
          outcome: "already-exited",
          exitCode: 3,
          timedOut: false,
        });
        expect(await sbx.background.status(device, keep, sig())).toEqual({ state: "running" });
        expect(await sbx.background.stop(device, keep, { graceMs: 0, signal: sig() })).toEqual({
          outcome: "stopped",
        });
        const outside = await sbx.background
          .start(
            device,
            scopeFor(restricted([root])),
            bgArgs(root, "echo ran > ran", { outputPath: "/workspace/escape.log" }),
          )
          .catch((e) => e);
        expect(isSandboxScopeDeniedError(outside)).toBe(true);
        expect(await inspectRead(device, `${root}/ran`)).toBeNull();
        expect(await inspectRead(device, "/workspace/escape.log")).toBeNull();
      });

      it("runs Full access in the background and revocation stops exactly that execution", async () => {
        const root = await newRoot("bg-full");
        const scope = scopeFor(full);
        const ref = await sbx.background.start(
          device,
          scope,
          bgArgs(
            root,
            `printf full > /workspace/bg-full-${scope.operationId}; (sleep 1600 & echo $! > child); printf r > ready; sleep 1601`,
          ),
        );
        await waitFor(device, `${root}/ready`);
        expect(text(await inspectRead(device, `/workspace/bg-full-${scope.operationId}`))).toBe(
          "full",
        );
        const child = Number(text(await inspectRead(device, `${root}/child`)));
        expect(await alive(device, [child])).toEqual([child]);
        await sbx.revokeOperation(
          device,
          { operationId: scope.operationId, admitBeforeMs: scope.admitBeforeMs },
          sig(),
        );
        expect(await alive(device, [child])).toEqual([]);
        expect(await sbx.background.stop(device, ref, { graceMs: 0, signal: sig() })).toEqual({
          outcome: "stopped",
        });
      });

      it("never starts a stopped instance to answer status, output or stop", async () => {
        const h = await newDevice(sbx, { kind: "allowlist", hosts: [] });
        await dexec(h.id, "1000", ["mkdir", "/workspace/p"]);
        const ref = await sbx.background.start(
          h,
          scopeFor(full),
          bgArgs("/workspace/p", "sleep 1700"),
        );
        await sbx.suspend(h, sig());
        expect(await sbx.background.status(h, ref, sig())).toEqual({ state: "lost" });
        expect(await sbx.background.tail(h, ref, { maxBytes: 10, signal: sig() })).toEqual({
          unavailable: "lost",
        });
        expect(await sbx.background.stop(h, ref, { graceMs: 0, signal: sig() })).toEqual({
          outcome: "lost",
        });
        expect((await docker("inspect", "--format", "{{.State.Running}}", h.id)).trim()).toBe(
          "false",
        );
      });
    });

    describe("review fix round 1", () => {
      const newRoot = async (h: SandboxHandle, prefix: string) => {
        const root = `/workspace/${prefix}-${randomUUID().slice(0, 8)}`;
        await dexec(h.id, "1000", ["mkdir", "-p", root]);
        return root;
      };
      const bg = (root: string, command: string, taskId = `task-${randomUUID().slice(0, 8)}`) => ({
        command,
        cwd: root,
        timeoutMs: 600_000,
        maxOutputBytes: 1 << 20,
        signal: sig(),
        taskId,
        outputPath: `${root}/out-${taskId}.log`,
        retainUntilMs: Date.now() + 3_600_000,
      });
      const pidOf = async (h: SandboxHandle, path: string) => {
        await waitFor(h, path);
        return Number(text(await inspectRead(h, path)));
      };

      it("I1: refuses restricted roots that contain the provider's records or control files", async (context) => {
        requireRestricted(context);
        for (const writeRoots of [["/tmp"], ["/"], ["/opt"], ["/skills"]]) {
          const fg = await run(device, restricted(writeRoots), "true", {
            cwd: writeRoots[0] as string,
          }).catch((e) => e);
          expect(isSandboxScopeDeniedError(fg), `exec ${writeRoots}`).toBe(true);
          const started = await sbx.background
            .start(device, scopeFor(restricted(writeRoots)), bg(writeRoots[0] as string, "true"))
            .catch((e) => e);
          expect(isSandboxScopeDeniedError(started), `background ${writeRoots}`).toBe(true);
        }
      });

      it("I1: file writes (even with Full access) cannot change the root-owned records; revocation stops the task", async () => {
        const root = await newRoot(device, "forge");
        // Full access shares the device uid: the strongest in-device writer short of root.
        const scope = scopeFor(full);
        const id = operationUuid(scope.operationId);
        const forged = JSON.stringify({
          state: "exited",
          exitCode: 0,
          pid: 1,
          start: 1,
          retainUntilMs: 0,
        });
        await sbx.background.start(
          device,
          scope,
          bg(
            root,
            `echo $$ > ${root}/pid; for d in /tmp/.capybara-bg/${id} /skills/.capybara-ops/bg/${id} /opt/capybara/skills/.capybara-ops/bg/${id}; do ` +
              `printf '%s' '${forged}' > $d/status.json 2>/dev/null; printf '%s' '${forged}' > $d/record.json 2>/dev/null; done; ` +
              `printf done > ${root}/forged; exec sleep 1800`,
          ),
        );
        await waitFor(device, `${root}/forged`);
        const pid = await pidOf(device, `${root}/pid`);
        expect(await alive(device, [pid])).toEqual([pid]);
        await sbx.revokeOperation(
          device,
          { operationId: scope.operationId, admitBeforeMs: scope.admitBeforeMs },
          sig(),
        );
        expect(await alive(device, [pid])).toEqual([]);
      });

      it("I2: a Full background start revoked before its launch never runs", async () => {
        const root = await newRoot(device, "i2a");
        const taskId = `task-${randomUUID().slice(0, 8)}`;
        barriers.set(taskId, `${root}/barrier`);
        const scope = scopeFor(full);
        const ref = await sbx.background.start(
          device,
          scope,
          bg(root, `printf ran > ${root}/ran; sleep 1800`, taskId),
        );
        await sbx.revokeOperation(
          device,
          { operationId: scope.operationId, admitBeforeMs: scope.admitBeforeMs },
          sig(),
        );
        await dexec(device.id, "1000", ["touch", `${root}/barrier`]);
        for (;;) {
          const s = await sbx.background.status(device, ref, sig());
          if (s.state !== "running") break;
          await new Promise((r) => setImmediate(r));
        }
        expect(await inspectRead(device, `${root}/ran`)).toBeNull();
      });

      it("I2: a stop that arrives before the supervisor's handler still ends the Full child", async () => {
        const root = await newRoot(device, "i2b");
        const taskId = `task-${randomUUID().slice(0, 8)}`;
        barriers.set(taskId, `${root}/barrier`);
        const ref = await sbx.background.start(
          device,
          scopeFor(full),
          bg(root, `echo $$ > ${root}/child; exec sleep 1800`, taskId),
        );
        let settled = false;
        const stopping = sbx.background
          .stop(device, ref, { graceMs: 0, signal: sig() })
          .finally(() => {
            settled = true;
          });
        // Readiness: the supervisor holds a pending SIGTERM while it waits at the barrier.
        for (;;) {
          const pending = await dexec(device.id, "1000", [
            "sh",
            "-c",
            `for p in $(pgrep -f 'capybara-operation[.]py bg-start'); do grep -E '^(SigPnd|ShdPnd):' /proc/$p/status; done`,
          ]).catch(() => "");
          const sigterm = [...pending.matchAll(/Pnd:\s+([0-9a-f]+)/g)].some(
            (m) => (BigInt(`0x${m[1]}`) & 0x4000n) !== 0n,
          );
          if (sigterm || settled) break;
          await new Promise((r) => setImmediate(r));
        }
        await dexec(device.id, "1000", ["touch", `${root}/barrier`]);
        expect(await stopping).toEqual({ outcome: "stopped" });
        const child = await inspectRead(device, `${root}/child`);
        if (child !== null) expect(await alive(device, [Number(text(child))])).toEqual([]);
      });

      it("I3: a revocation survives an instance restart, and a restart during revocation is not reported as success", async (context) => {
        requireRestricted(context);
        const h = await newDevice(sbx, { kind: "allowlist", hosts: [] });
        const root = await newRoot(h, "i3");
        const early = scopeFor(restricted([root]));
        await sbx.revokeOperation(
          h,
          { operationId: early.operationId, admitBeforeMs: early.admitBeforeMs },
          sig(),
        );
        await docker("restart", "-t", "0", h.id);
        const late = await (await sbx.operation(h, early, sig()))
          .exec({
            command: `printf ran > ${root}/late`,
            cwd: root,
            timeoutMs: 30_000,
            maxOutputBytes: 1024,
            signal: sig(),
          })
          .catch((e) => e);
        expect(isSandboxScopeDeniedError(late)).toBe(true);
        expect(await inspectRead(h, `${root}/late`)).toBeNull();
        // The provider's own restart fallback between the kill and the final tombstone.
        const mid = scopeFor(restricted([root]));
        afterKill.set(mid.operationId, async () => {
          afterKill.delete(mid.operationId);
          await docker("restart", "-t", "0", h.id);
        });
        const revoked = await sbx
          .revokeOperation(
            h,
            { operationId: mid.operationId, admitBeforeMs: mid.admitBeforeMs },
            sig(),
          )
          .catch((e) => e);
        expect(revoked).toBeInstanceOf(Error);
        await sbx.revokeOperation(
          h,
          { operationId: mid.operationId, admitBeforeMs: mid.admitBeforeMs },
          sig(),
        );
        const after = await (await sbx.operation(h, mid, sig()))
          .exec({
            command: `printf ran > ${root}/mid`,
            cwd: root,
            timeoutMs: 30_000,
            maxOutputBytes: 1024,
            signal: sig(),
          })
          .catch((e) => e);
        expect(isSandboxScopeDeniedError(after)).toBe(true);
      });

      it("M1: a Full command cannot fake the admission refusal", async () => {
        const json = Buffer.from(
          JSON.stringify({ events: [{ event: "refused", code: "REVOKED" }] }),
        );
        const frame = Buffer.concat([Buffer.from("R"), Buffer.alloc(4), json]);
        frame.writeUInt32BE(json.byteLength, 1);
        const r = await run(device, full, `echo ${frame.toString("base64")} | base64 -d; exit 125`);
        expect(r.exitCode).toBe(125);
      });

      it("M3: a record directory planted by the device user does not disable operations", async (context) => {
        requireRestricted(context);
        const h = await newDevice(sbx, { kind: "allowlist", hosts: [] });
        await dexec(h.id, "1000", [
          "sh",
          "-c",
          "mkdir -p /tmp/.capybara-ops /tmp/.capybara-bg && chmod 777 /tmp/.capybara-ops",
        ]);
        const root = await newRoot(h, "m3");
        const r = await (await sbx.operation(h, scopeFor(restricted([root])), sig())).exec({
          command: "echo ok",
          cwd: root,
          timeoutMs: 30_000,
          maxOutputBytes: 1024,
          signal: sig(),
        });
        expect(r.stdout.trim()).toBe("ok");
      });

      it("M2: the forwarder tunnels CONNECT and wildcards, the instance network still applies, and no other operation reaches it", async (context) => {
        requireRestricted(context);
        const h = await newDevice(sbx, {
          kind: "allowlist",
          hosts: ["allowed.example.com", "denied.example.com"],
        });
        const root = await newRoot(h, "m2");
        const exec = async (grant: SandboxPermissionGrant, command: string) =>
          (await sbx.operation(h, scopeFor(grant), sig())).exec({
            command,
            cwd: root,
            timeoutMs: 120_000,
            maxOutputBytes: 1 << 20,
            signal: sig(),
          });
        const connect = await exec(
          restricted([root], { kind: "allowlist", hosts: ["*.example.com"] }),
          "curl -fsS -m 20 --proxytunnel http://allowed.example.com/; echo",
        );
        expect(connect.stdout).toContain("hello-allowed.example.com");
        const blocked = await exec(
          restricted([root], { kind: "allowlist", hosts: ["other.example.org"] }),
          "curl -sS -m 20 -o /dev/null -w 'code=%{http_code}\\n' http://other.example.org/; true",
        );
        expect(blocked.stdout).not.toContain("code=200");
        // A long-running operation publishes its forwarder port; another one cannot use it.
        const holder = (
          await sbx.operation(
            h,
            scopeFor(restricted([root], { kind: "allowlist", hosts: ["allowed.example.com"] })),
            sig(),
          )
        ).exec({
          command: `printf '%s' "\${HTTP_PROXY##*:}" > ${root}/port; until [ -e ${root}/release ]; do sleep 0.01; done`,
          cwd: root,
          timeoutMs: 120_000,
          maxOutputBytes: 1024,
          signal: sig(),
        });
        const port = Number(
          await (async () => {
            await waitFor(h, `${root}/port`);
            return text(await inspectRead(h, `${root}/port`));
          })(),
        );
        for (const network of [
          { kind: "none" } as const,
          { kind: "allowlist", hosts: ["allowed.example.com"] } as const,
        ]) {
          const r = await exec(
            restricted([root], network),
            `python3 -c 'import socket; socket.create_connection(("127.0.0.1", ${port}), 5)' 2>/dev/null && echo borrowed || echo refused`,
          );
          expect(r.stdout.trim(), network.kind).toBe("refused");
        }
        await dexec(h.id, "1000", ["touch", `${root}/release`]);
        expect((await holder).exitCode).toBe(0);
      });
    });

    describe("review fix round 2", () => {
      const AGENT = "/opt/capybara-runtime/capybara-operation.py";
      const newRoot = async (h: SandboxHandle, prefix: string) => {
        const root = `/workspace/${prefix}-${randomUUID().slice(0, 8)}`;
        await dexec(h.id, "1000", ["mkdir", "-p", root]);
        return root;
      };
      const bg = (root: string, command: string, taskId = `task-${randomUUID().slice(0, 8)}`) => ({
        command,
        cwd: root,
        timeoutMs: 600_000,
        maxOutputBytes: 1 << 20,
        signal: sig(),
        taskId,
        outputPath: `${root}/out-${taskId}.log`,
        retainUntilMs: Date.now() + 3_600_000,
      });
      const agentCall = (
        h: SandboxHandle,
        user: string,
        args: string[],
        body: unknown,
        env: string[] = [],
      ) => {
        const json = JSON.stringify(body);
        const r = spawnSync(
          "docker",
          [
            "exec",
            "-i",
            "-u",
            user,
            ...env.flatMap((e) => ["-e", e]),
            h.id,
            "/usr/bin/python3",
            "-I",
            AGENT,
            ...args,
          ],
          { input: `${Buffer.byteLength(json)}\n${json}`, maxBuffer: 1 << 24 },
        );
        return { status: r.status, stdout: r.stdout as Buffer };
      };
      const resultOf = (raw: Buffer) => {
        let at = 0;
        let result: Record<string, unknown> | null = null;
        while (at + 5 <= raw.byteLength) {
          const size = raw.readUInt32BE(at + 1);
          if (String.fromCharCode(raw[at] as number) === "R") {
            result = JSON.parse(raw.subarray(at + 5, at + 5 + size).toString());
          }
          at += 5 + size;
        }
        return result;
      };

      it("R1: a same-uid writer cannot inject frames into a supervisor's channel", async (context) => {
        requireRestricted(context);
        const root = await newRoot(device, "r1");
        const scope = scopeFor(restricted([root]));
        const ref = await sbx.background.start(
          device,
          scope,
          bg(root, `echo $$ > ${root}/pid; exec sleep 1800`),
        );
        await waitFor(device, `${root}/pid`);
        const pid = Number(text(await inspectRead(device, `${root}/pid`)));
        // The reviewer's attack: reopen the supervisor's channel through /proc and send an exit.
        const attack = String.raw`
import json, os
frame = json.dumps({"exitCode": 0, "timedOut": False, "cancelled": False}).encode()
frame = b"X" + len(frame).to_bytes(4, "big") + frame
wrote = 0
for pid in os.listdir("/proc"):
    if not pid.isdigit():
        continue
    try:
        args = open("/proc/%s/cmdline" % pid, "rb").read().split(b"\0")
        fds = os.listdir("/proc/%s/fd" % pid)
    except OSError:
        continue
    if b"bg-start" not in args:
        continue
    for fd in fds:
        try:
            out = os.open("/proc/%s/fd/%s" % (pid, fd), os.O_WRONLY)
            os.write(out, frame)
            wrote += 1
        except OSError:
            pass
print("wrote=%d" % wrote)
`;
        await dexec(device.id, "1000", ["python3", "-I", "-c", attack]);
        expect(await sbx.background.status(device, ref, sig())).toEqual({ state: "running" });
        expect(await alive(device, [pid])).toEqual([pid]);
        expect(await sbx.background.stop(device, ref, { graceMs: 0, signal: sig() })).toEqual({
          outcome: "stopped",
        });
        expect(await alive(device, [pid])).toEqual([]);
      });

      it("R2: a stop that finds the record still starting cancels the late launch", async () => {
        const root = await newRoot(device, "r2");
        const scope = scopeFor(full);
        const executionId = operationUuid(scope.operationId);
        const opKey = createHash("sha256").update(scope.operationId).digest("hex");
        const secret = randomUUID().replaceAll("-", "");
        const token = randomUUID().replaceAll("-", "");
        const retainUntilMs = Date.now() + 3_600_000;
        const launch = {
          opKey,
          admitBeforeMs: scope.admitBeforeMs,
          expect: sdkRuntimeDigests(),
          executionId,
          kind: "device",
          writeRoots: [],
          readRoots: [],
          network: { kind: "environment" },
          command: `printf ran > ${root}/ran`,
          cwd: root,
          env: {},
          timeoutMs: 60_000,
          maxOutputBytes: 1024,
          taskId: "late",
          outputPath: `${root}/late.log`,
          retainUntilMs,
        };
        const prepared = agentCall(device, "0", ["bg-prepare"], {
          executionId,
          secret,
          token,
          start: launch,
          opKey,
          taskId: "late",
          retainUntilMs,
        });
        expect(resultOf(prepared.stdout)?.prepared).toBe(true);
        const generation = resultOf(
          agentCall(device, "0", ["consume"], {
            opKey,
            method: "backgroundStart",
            inputHash: "x",
            admitBeforeMs: scope.admitBeforeMs,
            expiresAtMs: retainUntilMs,
          }).stdout,
        )?.generation as string;
        const ref = {
          executionId,
          operationId: scope.operationId,
          instanceId: device.id,
          instanceGeneration: generation,
        };
        expect(
          (await sbx.background.stop(device, ref, { graceMs: 0, signal: sig() })).outcome,
        ).toBe("lost");
        // The supervisor arrives after the stop claimed its outcome: it must not launch.
        agentCall(device, "1000", ["bg-start"], { secret, token, ...launch });
        for (;;) {
          const s = await sbx.background.status(device, ref, sig());
          if (s.state !== "running") break;
          await new Promise((r) => setImmediate(r));
        }
        expect(await inspectRead(device, `${root}/ran`)).toBeNull();
        // The late identity never turns the cancelled record back into a running one.
        expect(await sbx.background.status(device, ref, sig())).toEqual({ state: "lost" });
      });

      it("R3: the provider's own file methods refuse the record directory", async () => {
        for (const path of ["/skills/.capybara-ops/x", "/skills/.capybara-ops"]) {
          await expect(sbx.writeFile(device, path, enc.encode("x"), sig()), path).rejects.toThrow();
          await expect(
            sbx.readFile(device, path, { maxBytes: 10, signal: sig() }),
            path,
          ).rejects.toThrow();
          await expect(sbx.stat(device, path, sig()), path).rejects.toThrow();
        }
        expect(
          await dexec(device.id, "0", [
            "sh",
            "-c",
            "test -e /opt/capybara/skills/.capybara-ops/x && echo exists || echo absent",
          ]),
        ).toBe("absent\n");
      });

      it("R4: caps a background spool and prunes expired records when the instance starts", async () => {
        const h = await newDevice(sbx, { kind: "allowlist", hosts: [] });
        const root = await newRoot(h, "r4");
        const taskId = `task-${randomUUID().slice(0, 8)}`;
        spoolCaps.set(taskId, 1000);
        const ref = await sbx.background.start(
          h,
          scopeFor(full),
          bg(root, "head -c 5000 /dev/zero | tr '\\0' a; echo; printf done > done", taskId),
        );
        for (;;) {
          const s = await sbx.background.status(h, ref, sig());
          if (s.state === "exited") break;
          await new Promise((r) => setImmediate(r));
        }
        const out = await sbx.background.readOutput(h, ref, {
          offset: 0,
          maxBytes: 65_536,
          signal: sig(),
        });
        expect("totalBytes" in out && out.totalBytes).toBe(1000);
        // Expired records of any state are pruned on the next instance start.
        const stale = randomUUID();
        await dexec(h.id, "0", [
          "sh",
          "-c",
          `d=/opt/capybara/skills/.capybara-ops/bg/${stale}; mkdir -m 711 $d && printf '%s' '{"state":"running","generation":"old","expiresAtMs":1}' > $d/record.json && head -c 100 /dev/zero > $d/output`,
        ]);
        await sbx.suspend(h, sig());
        expect(await sbx.resume(h, sig())).toBe("resumed");
        expect(
          await dexec(h.id, "0", [
            "sh",
            "-c",
            `test -e /opt/capybara/skills/.capybara-ops/bg/${stale} && echo kept || echo pruned`,
          ]),
        ).toBe("pruned\n");
      });

      it("R5: a same-input retry after a generation change is an unknown outcome", async () => {
        const h = await newDevice(sbx, { kind: "allowlist", hosts: [] });
        const scope = scopeFor(full);
        const args = {
          command: "echo run >> /workspace/r5",
          timeoutMs: 30_000,
          maxOutputBytes: 1024,
        };
        expect(
          (await (await sbx.operation(h, scope, sig())).exec({ ...args, signal: sig() })).exitCode,
        ).toBe(0);
        await docker("restart", "-t", "0", h.id);
        const retry = await (await sbx.operation(h, scope, sig()))
          .exec({ ...args, signal: sig() })
          .catch((e) => e);
        expect(isSandboxOperationOutcomeUnknownError(retry)).toBe(true);
        expect(text(await inspectRead(h, "/workspace/r5"))).toBe("run\n");
      });

      it("R7: a same-uid process that connects first never captures the record", async () => {
        const root = await newRoot(device, "r7");
        const scope = scopeFor(full);
        const executionId = operationUuid(scope.operationId);
        const taskId = `task-${randomUUID().slice(0, 8)}`;
        // The attacker reads every bound socket name from /proc/net/unix and runs the real agent's
        // bg-start with a forged request for this execution before the real supervisor connects.
        const forge = String.raw`
import json, os, re, subprocess, sys
execution, root, expect, deadline = sys.argv[1], sys.argv[2], json.loads(sys.argv[3]), int(sys.argv[4])
names = set()
for line in open("/proc/net/unix").read().splitlines()[1:]:
    parts = line.split()
    if len(parts) >= 8 and re.fullmatch(r"[0-9a-f]{32}", parts[-1]):
        names.add(parts[-1])
tried = 0
for secret in names:
    if not os.path.exists("/skills/.capybara-ops/bg/%s/%s" % (execution, secret)):
        continue
    tried += 1
    body = json.dumps({"secret": secret, "opKey": "attacker", "admitBeforeMs": deadline,
        "expect": expect, "executionId": execution, "kind": "device", "writeRoots": [],
        "readRoots": [], "network": {"kind": "environment"},
        "command": "echo $$ > %s/attacker; exec sleep 1801" % root, "cwd": root, "env": {},
        "timeoutMs": 600000, "maxOutputBytes": 1024, "taskId": "attacker",
        "outputPath": "%s/attacker.log" % root, "retainUntilMs": deadline}).encode()
    subprocess.run(["/usr/bin/python3", "-I", "/opt/capybara-runtime/capybara-operation.py",
        "bg-start"], input=str(len(body)).encode() + b"\n" + body, capture_output=True)
print("tried=%d" % tried)
`;
        beforeLaunch.set(taskId, async () => {
          beforeLaunch.delete(taskId);
          const out = await dexec(device.id, "1000", [
            "python3",
            "-I",
            "-c",
            forge,
            executionId,
            root,
            JSON.stringify(sdkRuntimeDigests()),
            String(Date.now() + 600_000),
          ]);
          expect(out.trim()).toBe("tried=1");
        });
        const started = await sbx.background
          .start(device, scope, bg(root, `echo $$ > ${root}/real; exec sleep 1802`, taskId))
          .catch((e) => e);
        // The attacker's work never launches under this record.
        expect(await inspectRead(device, `${root}/attacker`)).toBeNull();
        if (started instanceof Error) {
          // Failing closed is acceptable: then the real task never ran either.
          expect(await inspectRead(device, `${root}/real`)).toBeNull();
          return;
        }
        await waitFor(device, `${root}/real`);
        const real = Number(text(await inspectRead(device, `${root}/real`)));
        expect(await sbx.background.stop(device, started, { graceMs: 0, signal: sig() })).toEqual({
          outcome: "stopped",
        });
        expect(await alive(device, [real])).toEqual([]);
      });

      /**
       * R8: a same-uid process that learns the channel token (from bg-start's stdin before it
       * turns undumpable, simulated here by the test hook) runs the real agent's bg-start with a
       * request of its own. Prints the forged start's result.
       */
      const FORGE_WITH = String.raw`
import json, subprocess, sys
body = json.loads(sys.argv[1])
data = json.dumps(body).encode()
done = subprocess.run(["/usr/bin/python3", "-I", "/opt/capybara-runtime/capybara-operation.py",
    "bg-start"], input=str(len(data)).encode() + b"\n" + data, capture_output=True)
raw, at, result = done.stdout, 0, None
while at + 5 <= len(raw):
    size = int.from_bytes(raw[at + 1:at + 5], "big")
    if raw[at:at + 1] == b"R":
        result = json.loads(raw[at + 5:at + 5 + size])
    at += 5 + size
print(json.dumps(result))
`;
      const forgeWith = async (h: SandboxHandle, body: Record<string, unknown>) =>
        JSON.parse(
          await dexec(h.id, "1000", ["python3", "-I", "-c", FORGE_WITH, JSON.stringify(body)]),
        ) as Record<string, unknown> | null;
      const attackerCommand = (root: string) => `echo $$ > ${root}/attacker; exec sleep 1801`;
      /** Processes of the device whose command line contains `needle` (argv joined by spaces). */
      const processes = async (h: SandboxHandle, needle: string) =>
        Number(
          await dexec(h.id, "0", [
            "python3",
            "-I",
            "-c",
            String.raw`
import os, sys
n = 0
for pid in os.listdir("/proc"):
    if pid.isdigit() and int(pid) != os.getpid():
        try:
            args = open("/proc/%s/cmdline" % pid, "rb").read().replace(b"\\0", b" ")
            state = open("/proc/%s/stat" % pid).read().rsplit(")", 1)[1].split()[0]
        except OSError:
            continue
        if sys.argv[1].encode() in args and state not in ("Z", "X"):
            n += 1
print(n)
`,
            needle,
          ]),
        );

      it("R8: a forged identity with a wrong token is refused and the real start proceeds", async () => {
        const root = await newRoot(device, "r8w");
        const scope = scopeFor(full);
        const taskId = `task-${randomUUID().slice(0, 8)}`;
        let forged: Record<string, unknown> | null = null;
        beforeLaunch.set(taskId, async (_task, leaked) => {
          beforeLaunch.delete(taskId);
          const wrong = String(leaked.token).replace(/./, (c) => (c === "0" ? "1" : "0"));
          forged = await forgeWith(device, {
            ...leaked,
            token: wrong,
            command: attackerCommand(root),
          });
        });
        const ref = await sbx.background.start(
          device,
          scope,
          bg(root, `echo $$ > ${root}/real; exec sleep 1802`, taskId),
        );
        expect(forged).not.toBeNull();
        expect((forged as unknown as Record<string, unknown>).started).toBeUndefined();
        await waitFor(device, `${root}/real`);
        const real = Number(text(await inspectRead(device, `${root}/real`)));
        expect(await sbx.background.status(device, ref, sig())).toEqual({ state: "running" });
        expect(await sbx.background.stop(device, ref, { graceMs: 0, signal: sig() })).toEqual({
          outcome: "stopped",
        });
        expect(await alive(device, [real])).toEqual([]);
        expect(await inspectRead(device, `${root}/attacker`)).toBeNull();
      });

      it("R8: the right token with a different command binds nothing and runs nothing", async () => {
        const root = await newRoot(device, "r8d");
        const scope = scopeFor(full);
        const taskId = `task-${randomUUID().slice(0, 8)}`;
        let forged: Record<string, unknown> | null = null;
        beforeLaunch.set(taskId, async (_task, leaked) => {
          beforeLaunch.delete(taskId);
          forged = await forgeWith(device, { ...leaked, command: attackerCommand(root) });
        });
        const started = await sbx.background
          .start(device, scope, bg(root, `echo $$ > ${root}/real; exec sleep 1802`, taskId))
          .catch((e: unknown) => e);
        // The forged start was refused: its supervisor never acknowledged, never launched.
        expect(forged).not.toBeNull();
        expect((forged as unknown as Record<string, unknown>).started).toBeUndefined();
        if (started instanceof Error) {
          // Failing closed: no record is running, and nothing reports the attacker's output.
          expect(await inspectRead(device, `${root}/real`)).toBeNull();
        } else {
          await waitFor(device, `${root}/real`);
          const real = Number(text(await inspectRead(device, `${root}/real`)));
          expect(
            await sbx.background.status(device, started as SandboxExecutionRef, sig()),
          ).toEqual({
            state: "running",
          });
          expect(
            await sbx.background.stop(device, started as SandboxExecutionRef, {
              graceMs: 0,
              signal: sig(),
            }),
          ).toEqual({ outcome: "stopped" });
          expect(await alive(device, [real])).toEqual([]);
        }
        expect(await inspectRead(device, `${root}/attacker`)).toBeNull();
      });

      it("R8: a start that is not acknowledged is stopped by its recorded identity", async () => {
        const root = await newRoot(device, "r8b");
        const scope = scopeFor(full);
        const taskId = `task-${randomUUID().slice(0, 8)}`;
        let forged: Record<string, unknown> | null = null;
        // The worst case of a leak: the whole request, so the forged identity matches the grant.
        beforeLaunch.set(taskId, async (_task, leaked) => {
          beforeLaunch.delete(taskId);
          forged = await forgeWith(device, { ...leaked });
        });
        const started = await sbx.background
          .start(device, scope, bg(root, `echo $$ > ${root}/real; exec sleep 1803`, taskId))
          .catch((e: unknown) => e);
        expect((forged as unknown as Record<string, unknown>)?.started).toBe(true);
        // The real supervisor got no acceptance: the start fails, and the provider stopped what
        // the record names (here the granted command under the other supervisor).
        expect(started).toBeInstanceOf(Error);
        expect(await processes(device, "sleep 1803")).toBe(0);
        const record = JSON.parse(
          await dexec(device.id, "0", [
            "cat",
            `/opt/capybara/skills/.capybara-ops/bg/${operationUuid(scope.operationId)}/record.json`,
          ]),
        ) as { state: string; generation: string };
        const ref = {
          executionId: operationUuid(scope.operationId),
          operationId: scope.operationId,
          instanceId: device.id,
          instanceGeneration: record.generation,
        };
        expect(await sbx.background.status(device, ref, sig())).toEqual({ state: "lost" });
        expect(await sbx.background.tail(device, ref, { maxBytes: 100, signal: sig() })).toEqual({
          unavailable: "lost",
        });
      });

      it("R8: stealing bg-start's stdin, forging a supervisor and writing the request back binds nothing", async () => {
        const root = await newRoot(device, "r8s");
        const scope = scopeFor(full);
        const taskId = `task-${randomUUID().slice(0, 8)}`;
        // The reviewer's watcher: catches the real bg-start during interpreter start-up (stopped
        // on sight), reads the framed request from its stdin through /proc, runs a forged
        // supervisor with the stolen token and its own command, then puts the bytes back.
        const watch = String.raw`
import json, os, select, signal, subprocess, sys, time
agent, root = b"/opt/capybara-runtime/capybara-operation.py", sys.argv[1]
# Processes that exist already (earlier supervisors keep the same argv) are not the target.
seen = set(os.listdir("/proc"))
print("watching", flush=True)
target, deadline = None, time.monotonic() + 120
while target is None and time.monotonic() < deadline:
    for pid in os.listdir("/proc"):
        if not pid.isdigit() or pid in seen:
            continue
        try:
            args = open("/proc/%s/cmdline" % pid, "rb").read().split(b"\0")
        except OSError:
            continue
        if len(args) >= 4 and args[2] == agent and args[3] == b"bg-start":
            target = int(pid)
            break
os.kill(target, signal.SIGSTOP)
try:
    r = os.open("/proc/%d/fd/0" % target, os.O_RDONLY | os.O_NONBLOCK)
    w = os.open("/proc/%d/fd/0" % target, os.O_WRONLY | os.O_NONBLOCK)
except OSError as error:
    os.kill(target, signal.SIGCONT)
    print(json.dumps({"stolen": False, "error": str(error)}))
    sys.exit(0)
data = b""
while True:
    if b"\n" in data:
        line, rest = data.split(b"\n", 1)
        if len(rest) >= int(line):
            break
    select.select([r], [], [], 10)
    try:
        data += os.read(r, 1 << 20)
    except BlockingIOError:
        pass
line, rest = data.split(b"\n", 1)
body = json.loads(rest[:int(line)])
body["command"] = "echo $$ > %s/attacker; exec sleep 1801" % root
forged = json.dumps(body).encode()
done = subprocess.run(["/usr/bin/python3", "-I", agent.decode(), "bg-start"],
    input=str(len(forged)).encode() + b"\n" + forged, capture_output=True)
os.write(w, data)
os.close(w)
os.close(r)
os.kill(target, signal.SIGCONT)
out, at, result = done.stdout, 0, None
while at + 5 <= len(out):
    size = int.from_bytes(out[at + 1:at + 5], "big")
    if out[at:at + 1] == b"R":
        result = json.loads(out[at + 5:at + 5 + size])
    at += 5 + size
print(json.dumps({"stolen": True, "forged": result}))
`;
        let watcher: Promise<string> | undefined;
        beforeLaunch.set(taskId, async () => {
          beforeLaunch.delete(taskId);
          const child = spawn("docker", [
            "exec",
            "-u",
            "1000",
            device.id,
            "python3",
            "-I",
            "-c",
            watch,
            root,
          ]);
          let output = "";
          watcher = new Promise<string>((resolve) => {
            child.on("close", () => resolve(output));
          });
          await new Promise<void>((resolve) => {
            child.stdout.on("data", (chunk: Buffer) => {
              output += chunk.toString();
              if (output.includes("watching\n")) resolve();
            });
          });
        });
        const started = await sbx.background
          .start(device, scope, bg(root, `echo $$ > ${root}/real; exec sleep 1802`, taskId))
          .catch((e: unknown) => e);
        const report = JSON.parse((await watcher)?.split("watching\n")[1] ?? "null") as {
          stolen: boolean;
          forged?: Record<string, unknown> | null;
        };
        expect(report, JSON.stringify(report)).toMatchObject({ stolen: true });
        expect(report.forged?.started).toBeUndefined();
        expect(started).not.toBeInstanceOf(Error);
        await waitFor(device, `${root}/real`);
        const real = Number(text(await inspectRead(device, `${root}/real`)));
        expect(
          await sbx.background.stop(device, started as SandboxExecutionRef, {
            graceMs: 0,
            signal: sig(),
          }),
        ).toEqual({ outcome: "stopped" });
        expect(await alive(device, [real])).toEqual([]);
        expect(await inspectRead(device, `${root}/attacker`)).toBeNull();
      });

      it("R6: an unexpected Full admission failure is never read as success", () => {
        const r = agentCall(
          device,
          "1000",
          ["full", "k", String(Date.now() + 60_000), "/tmp/.capybara-exec-x-y", "--", "not-setsid"],
          {},
          ["CAPYBARA_ADMISSION_NONCE=nonce-r6"],
        );
        expect(r.status).toBe(125);
        expect(resultOf(r.stdout)?.nonce).toBe("nonce-r6");
      });
    });

    it("fails closed on an image whose staged runtime does not match the SDK digests", async () => {
      const tag = `capybara-sandbox:perm-mutant-${RUN}`;
      const context = images.sandboxImage;
      const build = spawnSync("docker", ["build", "-q", "-t", tag, "-"], {
        input:
          `FROM ${context}\nUSER 0:0\n` +
          "RUN sed -i 's/^LANDLOCK_ABI_REQUIRED = 6/LANDLOCK_ABI_REQUIRED = 5/' /opt/capybara-runtime/linux-sandbox.py\nUSER 1000:1000\n",
        encoding: "utf8",
      });
      expect(build.status, build.stderr).toBe(0);
      try {
        const h = await newDevice(sbx, { kind: "allowlist", hosts: [] }, tag);
        const report = await sbx.permissionSupport(h, sig());
        expect(report.restricted).toBeNull();
        expect(report.fullAccess).toBe(false);
        expect(report.unavailableReason).toMatch(/digest/);
        await dexec(h.id, "1000", ["mkdir", "/workspace/p"]);
        const error = await run(h, restricted(["/workspace/p"]), "echo ran > ran", {
          cwd: "/workspace/p",
        }).catch((e) => e);
        expect(isSandboxPermissionUnsupportedError(error)).toBe(true);
        expect(await inspectRead(h, "/workspace/p/ran")).toBeNull();
      } finally {
        await exec("docker", ["rmi", "-f", tag]).catch(() => undefined);
      }
    });
  },
);
