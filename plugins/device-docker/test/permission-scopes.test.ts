import { execFile, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  isProjectPathRefusedError,
  isSandboxOperationOutcomeUnknownError,
  isSandboxPermissionUnsupportedError,
  isSandboxScopeDeniedError,
  isSandboxScopeValidationError,
  type ProjectPathRefusedError,
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
import { OUTSIDE_WORKSPACE_REASON } from "../src/listing.js";
import { operationUuid } from "../src/operations.js";
import {
  OPERATION_AGENT_SHA256,
  RUNTIME_BUNDLE_VERSION,
  runtimeChecksums,
  SDK_RUNTIME_FILES,
  STAGED_SDK_DIGESTS,
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
 * The operation contract on the actual provider, an instance-boundary device (core approval-only
 * profiles design, decision 1): the real sandbox image, driven through the socket proxy into a
 * container with the provider's unchanged hardening. The container is the sandbox: support v2
 * reports `boundary: "instance"` with no restricted filters and no outside; the kernel's
 * whole-instance scope runs under every profile on the provider's ordinary exec and file paths,
 * under the instance's own egress proxy; a narrower grant and the escalated pair are refused
 * before any effect. Plus durable consumption and revocation, exact background supervision,
 * preparation, browsing and fail-closed images. The permission conformance suite of
 * @capybara-hq/testing runs against it. Skipped without Docker.
 */

/** The fence token every lifecycle call carries here (device update fencing). */
const FENCE = { token: 1 };
const exec = promisify(execFile);
const imageDir = fileURLToPath(new URL("../image/", import.meta.url));
const RUN = randomUUID().slice(0, 8);
const sig = () => AbortSignal.timeout(300_000);
const enc = new TextEncoder();
const dec = new TextDecoder();

describe("staged runtime", () => {
  it("stages the SDK's current runtime bytes unchanged, each digest one the SDK accepts", async () => {
    expect(SANDBOX_RUNTIME_SOURCE.version).toBe(RUNTIME_BUNDLE_VERSION);
    for (const name of SDK_RUNTIME_FILES) {
      const file = SANDBOX_RUNTIME_SOURCE.current.find((f) => f.name === name);
      const staged = await readFile(`${imageDir}runtime/${name}`, "utf8");
      expect(staged === file?.source, `${name} differs from the SDK's current bytes`).toBe(true);
      const digest = createHash("sha256").update(staged).digest("hex");
      expect(digest).toBe(file?.sha256);
      expect(digest).toBe(STAGED_SDK_DIGESTS[name]);
      expect(SANDBOX_RUNTIME_SOURCE.accepted[name]).toContain(digest);
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

const limits = (network: SandboxLimits["network"]): SandboxLimits => ({
  cpu: 1,
  memoryMb: 1024,
  diskMb: 2048,
  network,
});

/**
 * The endpoints are services outside the device, on the instance's outer network: the granted one
 * is reached only by its allowlisted name through the operation's forwarder and the instance's real
 * egress proxy (which pins the name to the service's address, exempt from its private-address
 * check); the ungranted one is on no list, so neither its name nor its address is reachable (the
 * container is the sandbox: its own loopback is inside it, so no endpoint may listen there).
 */
const GRANTED_NAME = "granted.permission.example";
const GRANTED_PORT = 18080;
const UNGRANTED_NAME = "ungranted.permission.example";
const UNGRANTED_PORT = 18081;
/**
 * A name the egress proxy's resolver answers with the cloud metadata address, with no exemption
 * (egressTestResolve): an allowlisted name that resolves into a closed class must still be refused.
 */
const METADATA_NAME = "metadata.permission.example";
const METADATA_ADDRESS = "169.254.169.254";

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
    let ungrantedService: StartedTestContainer;
    const made: string[] = [];
    /** Test hooks: a file a background supervisor waits for before admission; revoke steps. */
    const barriers = new Map<string, string>();
    const afterKill = new Map<string, () => Promise<void>>();
    const spoolCaps = new Map<string, number>();
    const beforeLaunch = new Map<
      string,
      (taskId: string, leaked: Readonly<Record<string, unknown>>) => Promise<void>
    >();
    const loseAck = new Set<string>();
    const startCommands = new Map<string, string[]>();
    const stdinSteal = new Map<string, (bytes: Uint8Array) => Promise<Uint8Array>>();

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
        fence: FENCE,
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

    /** The kernel's scope on an instance-boundary device: the whole filesystem plus the root. */
    const INSTANCE_ROOTS = ["/", "/workspace"];
    const instance = (
      network: SandboxPermissionGrant["network"] = { kind: "none" },
      profile: SandboxPermissionGrant["profile"] = "full-access",
    ): SandboxPermissionGrant => ({
      profile,
      filesystem: { kind: "scoped", projectRoot: "/workspace", writeRoots: INSTANCE_ROOTS },
      network,
    });
    /** Running outside the sandbox: an instance has no outside. */
    const escalated: SandboxPermissionGrant = {
      profile: "full-access",
      filesystem: { kind: "device" },
      network: { kind: "environment" },
    };
    /** A grant narrower than the instance would need restricted filters. */
    const narrower = (writeRoots: string[]): SandboxPermissionGrant => ({
      profile: "approve-for-me",
      filesystem: { kind: "scoped", projectRoot: null, writeRoots },
      network: { kind: "none" },
    });

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

    /** A Python program run inside the sandbox without shell quoting (base64 on the command line). */
    const py = (program: string, args: string[] = []) =>
      `printf %s ${Buffer.from(program).toString("base64")} | base64 -d | python3 - ${args.join(" ")}`;
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
      // The conformance suite's endpoints: each counts every accepted connection itself.
      const countingService = (port: number) =>
        new GenericContainer(images.egressImage)
          .withNetworkMode(netName)
          .withUser("root")
          .withCommand([
            "node",
            "-e",
            `let n = 0; const fs = require("fs"); require("net").createServer((c) => { n++; fs.writeFileSync("/tmp/count.tmp", String(n)); fs.renameSync("/tmp/count.tmp", "/tmp/count"); c.end("HTTP/1.0 200 OK\\r\\nContent-Length: 2\\r\\n\\r\\nok"); }).listen(${port}, () => console.log("ready"))`,
          ])
          .withWaitStrategy(Wait.forLogMessage("ready"))
          .start();
      [grantedService, ungrantedService] = await Promise.all([
        countingService(GRANTED_PORT),
        countingService(UNGRANTED_PORT),
      ]);
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
          egressTestResolve: { [METADATA_NAME]: METADATA_ADDRESS },
          backgroundLaunchBarrier: (taskId) => barriers.get(taskId),
          afterRevokeKill: (operationId) => afterKill.get(operationId)?.() ?? Promise.resolve(),
          backgroundSpoolCapBytes: (taskId) => spoolCaps.get(taskId),
          beforeBackgroundLaunch: (taskId, leaked) =>
            beforeLaunch.get(taskId)?.(taskId, leaked) ?? Promise.resolve(),
          loseBackgroundAck: (taskId) => loseAck.has(taskId),
          backgroundStartCommand: (taskId, cmd) => startCommands.get(taskId) ?? cmd,
          interceptBackgroundStdin: (taskId, bytes) =>
            stdinSteal.get(taskId)?.(bytes) ?? Promise.resolve(bytes),
        },
      );
      device = await newDevice(sbx, { kind: "allowlist", hosts: [] });
      support = await sbx.permissionSupport(device, sig());
      const host = (...args: string[]) =>
        spawnSync(args[0] as string, args.slice(1), { encoding: "utf8" }).stdout?.trim() ?? "";
      // The real runtime this evidence ran on.
      console.info(
        `[device-docker permission] ${JSON.stringify({
          support,
          kernel: (await dexec(device.id, "1000", ["uname", "-srm"])).trim(),
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
    }, 1_800_000);

    afterAll(async () => {
      await target?.stop();
      await grantedService?.stop();
      await ungrantedService?.stop();
      await cleanupTestResources(RUN);
      await proxy?.stop();
    }, 300_000);

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

    it("reports support v2: the instance boundary, no restricted filters, no outside", async () => {
      expect(support).toEqual({
        version: 2,
        boundary: "instance",
        restricted: null,
        network: { openPublic: true, allowlist: true, perOperationHosts: false },
        outsideSandbox: false,
        background: true,
      });
      // a deployment that refuses the open network reports it
      const closed = createDockerSandbox(
        {
          endpoint: proxy.endpoint,
          runtime: "runc",
          network: netName,
          egressProxyImage: images.egressImage,
          defaultImage: images.sandboxImage,
          refuseOpenNetwork: true,
        },
        { labels: { [TEST_LABEL]: RUN } },
      );
      expect((await closed.permissionSupport(device, sig())).network.openPublic).toBe(false);
    });

    it("refuses the escalated pair and narrower grants before any effect", async () => {
      const root = `/workspace/refuse-${randomUUID().slice(0, 8)}`;
      await dexec(device.id, "1000", ["mkdir", root]);
      for (const grant of [escalated, narrower([root])]) {
        const e = await run(device, grant, `printf ran > ${root}/ran`, { cwd: root }).catch(
          (x) => x,
        );
        expect(isSandboxPermissionUnsupportedError(e), grant.filesystem.kind).toBe(true);
        const b = await sbx.background
          .start(device, scopeFor(grant), {
            command: `printf ran > ${root}/bg-ran`,
            cwd: root,
            timeoutMs: 30_000,
            maxOutputBytes: 1024,
            signal: sig(),
            taskId: `task-${randomUUID().slice(0, 8)}`,
            outputPath: `${root}/out.log`,
            retainUntilMs: Date.now() + 600_000,
          })
          .catch((x) => x);
        expect(isSandboxPermissionUnsupportedError(b), grant.filesystem.kind).toBe(true);
      }
      expect(await inspectRead(device, `${root}/ran`)).toBeNull();
      expect(await inspectRead(device, `${root}/bg-ran`)).toBeNull();
    });

    it("passes the permission conformance on the actual provider", async () => {
      // A device whose instance network allowlists the granted name: its allowlist operations
      // reach it only through their own forwarder and the instance's egress proxy.
      const net = await newDevice(sbx, { kind: "allowlist", hosts: [GRANTED_NAME] });
      const id = randomUUID().slice(0, 8);
      const root = `/workspace/project-${id}`;
      const sibling = `/workspace/sibling-${id}`;
      const protectedPath = `/workspace/.profile-${id}`;
      await dexec(net.id, "1000", [
        "sh",
        "-c",
        `mkdir ${root} ${sibling} && printf rc > ${protectedPath}`,
      ]);
      const counted = (service: StartedTestContainer) => async () => {
        const r = await service.exec(["cat", "/tmp/count"]);
        return r.exitCode === 0 ? Number(r.output.trim()) : 0;
      };
      const fixture: SandboxPermissionFixture = {
        root,
        sibling,
        protectedPaths: [protectedPath],
        endpoints: {
          granted: {
            name: GRANTED_NAME,
            address: grantedService.getIpAddress(netName),
            port: GRANTED_PORT,
            receipts: counted(grantedService),
          },
          ungranted: [
            {
              name: UNGRANTED_NAME,
              address: ungrantedService.getIpAddress(netName),
              port: UNGRANTED_PORT,
              receipts: counted(ungrantedService),
            },
          ],
          // The provider's production path: allowlisted names only through the operation's
          // forwarder and the real egress proxy; no direct endpoint mapping exists.
          access: "proxy",
          // A name served at the cloud metadata address: the harness asks for it by name with it
          // on the operation's hosts. The instance list holds the granted name only (the harness
          // also proves a scope naming more hosts widens nothing, and a scope narrower than the
          // instance list is refused), so the proxy refuses it by its list; the closed-class
          // refusal of an allowlisted metadata name is proved right after, on a device whose own
          // list names it.
          closedGranted: [
            { label: "metadata", host: METADATA_NAME, port: 80, address: METADATA_ADDRESS },
          ],
        },
        instanceNetwork: "allowlist",
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
          // Another session's Full access work: a fresh `docker exec` as the device user, outside
          // every operation and restricted domain.
          outside: (program, args) => dexec(net.id, "1000", ["python3", "-", ...args], program),
        },
        dispose: async () => undefined,
      };
      await runSandboxPermissionConformance(fixture);

      // An allowlisted name that resolves to the metadata address is refused by its class.
      const meta = await newDevice(sbx, { kind: "allowlist", hosts: [METADATA_NAME] });
      const probe = await run(
        meta,
        instance({ kind: "allowlist", hosts: [METADATA_NAME] }),
        `curl -sS -m 10 -w ' %{http_code}' http://${METADATA_NAME}/`,
      );
      expect(probe.stdout).toMatch(/resolves to a private or reserved address/);
      expect(probe.stdout).toMatch(/ 403$/);
    });

    it("runs the whole instance under every profile with the container's own hardening", async () => {
      const root = `/workspace/whole-${randomUUID().slice(0, 8)}`;
      await dexec(device.id, "1000", ["mkdir", root]);
      const probe = (profile: string) =>
        "grep -E '^(Seccomp_filters|NoNewPrivs):' /proc/self/status | tr '\\n' ' '; " +
        "cat /etc/hostname > /dev/null && echo etc-read; " +
        `printf x > /workspace/outside-${profile} && echo outside-write; ` +
        `printf x > /tmp/tmp-${profile} && echo tmp-write`;
      const seen: string[] = [];
      for (const profile of ["request-approval", "approve-for-me", "full-access"] as const) {
        const r = await run(device, instance({ kind: "none" }, profile), probe(profile), {
          cwd: root,
        });
        expect(r.exitCode, r.stderr).toBe(0);
        expect(r.stdout).toMatch(/etc-read/);
        expect(r.stdout).toMatch(/outside-write/);
        expect(r.stdout).toMatch(/tmp-write/);
        expect(r.stdout).toMatch(/NoNewPrivs:\s+1/);
        seen.push(r.stdout.replace(/(outside|tmp)-write/g, ""));
        expect(text(await inspectRead(device, `/workspace/outside-${profile}`))).toBe("x");
      }
      // the same sandbox under every profile: only the container's own seccomp filter applies
      expect(new Set(seen).size).toBe(1);
      console.info(`[device-docker permission] whole instance: ${seen[0]?.trim()}`);
    });

    it("the instance's egress proxy is the sandbox network of every operation", async () => {
      // an allowlist instance: only its hosts, whatever network kind the operation names
      const h = await newDevice(sbx, { kind: "allowlist", hosts: ["allowed.example.com"] });
      const curl =
        "curl -sS -m 20 http://allowed.example.com/; echo; " +
        "curl -sS -m 20 http://denied.example.com/ -o /dev/null -w 'denied=%{http_code}\\n'; " +
        `curl -sS -m 5 --noproxy '*' http://${target.getIpAddress(netName)}/ -o /dev/null 2>/dev/null && echo direct || echo no-direct`;
      const r0 = await run(
        h,
        instance({ kind: "allowlist", hosts: ["allowed.example.com"] }),
        curl,
        {
          cwd: "/workspace",
        },
      );
      expect(r0.stdout).toContain("hello-allowed.example.com");
      expect(r0.stdout).toContain("denied=403");
      expect(r0.stdout).toContain("no-direct");
      // an operation narrower than the instance's network would be silently widened: refused
      for (const network of [
        { kind: "none" } as const,
        { kind: "allowlist", hosts: ["other.example.com"] } as const,
      ]) {
        const refused = await run(h, instance(network), "printf ran > /workspace/narrow-ran", {
          cwd: "/workspace",
        }).catch((e) => e);
        expect(isSandboxScopeDeniedError(refused), network.kind).toBe(true);
      }
      expect(await inspectRead(h, "/workspace/narrow-ran")).toBeNull();
      // an open-public instance: public names on any port, the SDK's closed classes refused
      const open = await newDevice(sbx, { kind: "open-public", hosts: [] });
      const r = await run(
        open,
        instance({ kind: "open-public" }),
        "curl -sS -m 20 http://allowed.example.com:80/; echo; " +
          "for ip in 10.0.0.1 169.254.169.254 100.64.0.1 127.0.0.1 198.18.0.1; do " +
          // through the proxy even for loopback (the image's NO_PROXY keeps the VM's own loopback
          // local: that is the instance itself, inside the sandbox)
          "curl -sS -m 10 --noproxy '' http://$ip/ -o /dev/null -w \"$ip=%{http_code}\\n\"; done",
        { cwd: "/workspace" },
      );
      expect(r.stdout).toContain("hello-allowed.example.com");
      for (const ip of ["10.0.0.1", "169.254.169.254", "100.64.0.1", "127.0.0.1", "198.18.0.1"]) {
        expect(r.stdout).toContain(`${ip}=403`);
      }
    });

    it("a failed command reports the hosts its egress proxy refused, with the SDK's layers", async () => {
      const hosts = ["allowed.example.com", METADATA_NAME];
      const h = await newDevice(sbx, { kind: "allowlist", hosts });
      // an off-list name (device), a listed name resolving to the metadata address (address), a
      // reachable host; then a failure
      const r = await run(
        h,
        instance({ kind: "allowlist", hosts }),
        "curl -sS -m 20 https://denied.example.com/ -o /dev/null; " +
          `curl -sS -m 20 http://${METADATA_NAME}/ -o /dev/null -w '%{http_code}\\n'; ` +
          "curl -sS -m 20 http://allowed.example.com/ -o /dev/null; exit 7",
        { cwd: "/workspace" },
      );
      expect(r.exitCode, r.stderr).toBe(7);
      expect(r.network?.blocked).toEqual([
        { host: "denied.example.com", port: 443, layer: "device" },
        { host: METADATA_NAME, port: 80, layer: "address" },
      ]);
      // taken once: the next failure of another operation reports only its own refusals
      const quiet = await run(h, instance({ kind: "allowlist", hosts }), "exit 3", {
        cwd: "/workspace",
      });
      expect(quiet.exitCode).toBe(3);
      expect(quiet.network).toBeUndefined();
      // a command that succeeds asks nothing (its refusals are not reported)
      const ok = await run(
        h,
        instance({ kind: "allowlist", hosts }),
        "curl -sS -m 20 https://denied.example.com/ -o /dev/null || true",
        { cwd: "/workspace" },
      );
      expect(ok.exitCode).toBe(0);
      expect(ok.network).toBeUndefined();
    });

    it("the sandbox reaches neither its internal network's gateway nor the Docker host directly", async () => {
      const port = 18900 + Math.floor(Math.random() * 90);
      const listener = `cap-perm-hostsvc-${RUN}`;
      // a service on the Docker host itself (host network), counting TCP and UDP receipts
      await docker(
        "run",
        "-d",
        "--name",
        listener,
        "--label",
        `${TEST_LABEL}=${RUN}`,
        "--network",
        "host",
        "--user",
        "root",
        images.egressImage,
        "node",
        "-e",
        // counts by kind: TCP connections, and UDP datagrams by payload ("c" control, "x" sandbox)
        `const fs=require("fs");const n={};const bump=(k)=>{n[k]=(n[k]||0)+1;fs.writeFileSync("/tmp/n.tmp",JSON.stringify(n));fs.renameSync("/tmp/n.tmp","/tmp/n")};` +
          `require("net").createServer((c)=>{c.on("error",()=>{});bump("tcp");c.end("hi")}).listen(${port},"0.0.0.0");` +
          `require("dgram").createSocket("udp4").on("message",(m)=>bump("udp-"+m)).bind(${port},"0.0.0.0");`,
      );
      try {
        const counts = (): Record<string, number> =>
          JSON.parse(
            spawnSync("docker", ["exec", listener, "cat", "/tmp/n"], { encoding: "utf8" }).stdout ||
              "{}",
          );
        const hostIp = (
          await docker(
            "run",
            "--rm",
            "--network",
            "host",
            images.egressImage,
            "node",
            "-e",
            `const i=Object.values(require("os").networkInterfaces()).flat().find((a)=>a.family==="IPv4"&&!a.internal);console.log(i.address)`,
          )
        ).trim();
        // control: the service answers on the host's address from the host network (retried
        // until the listener is up)
        const fromHost = (script: string) =>
          spawnSync(
            "docker",
            ["run", "--rm", "--network", "host", images.egressImage, "node", "-e", script],
            { encoding: "utf8" },
          ).status;
        for (let i = 0; (counts().tcp ?? 0) < 1; i++) {
          if (i >= 30) {
            const state = spawnSync(
              "docker",
              ["inspect", "-f", "{{.State.Status}} {{.State.ExitCode}}", listener],
              { encoding: "utf8" },
            );
            const logs = spawnSync("docker", ["logs", listener], { encoding: "utf8" });
            throw new Error(
              `the host service never answered: ${JSON.stringify(counts())} state=${state.stdout}${state.stderr} logs=${logs.stdout}${logs.stderr} host=${hostIp} port=${port}`,
            );
          }
          fromHost(
            `require("net").connect(${port},${JSON.stringify(hostIp)},function(){this.end();process.exit(0)}).on("error",()=>process.exit(1))`,
          );
        }
        expect(counts().tcp).toBe(1);
        const h = await newDevice(sbx, { kind: "open-public", hosts: [] });
        const inspectNet = (name: string) =>
          JSON.parse(
            spawnSync("docker", ["network", "inspect", name], { encoding: "utf8" }).stdout,
          )[0];
        const internal = inspectNet(`${h.id}-net`);
        expect(internal.Options["com.docker.network.bridge.inhibit_ipv4"]).toBe("true");
        expect(internal.EnableIPv6).toBe(false);
        const subnet = String(internal.IPAM.Config[0].Subnet).split("/")[0] as string;
        const firstHost = subnet.replace(/\.0$/, ".1");
        const shared = inspectNet(netName);
        const sharedGateway = String(shared.IPAM.Config[0].Gateway ?? "");
        const targets = [firstHost, hostIp, sharedGateway].filter((x) => x !== "");
        const probe = py(
          "import socket,sys\nfor ip in sys.argv[2:]:\n" +
            " try:\n  socket.create_connection((ip,int(sys.argv[1])),3).close(); print('tcp-reached',ip)\n" +
            " except OSError: print('tcp-failed',ip)\n" +
            " try:\n  s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.sendto(b'x',(ip,int(sys.argv[1]))); print('udp-sent',ip)\n" +
            " except OSError: print('udp-failed',ip)",
          [String(port), ...targets],
        );
        const r = await run(h, instance({ kind: "open-public" }), probe, { cwd: "/workspace" });
        expect(r.exitCode, r.stderr).toBe(0);
        expect(r.stdout).toContain(`tcp-failed ${hostIp}`);
        console.info(
          `[device-docker permission] direct host probe: ${r.stdout.trim().replaceAll("\n", "; ")}`,
        );
        expect(r.stdout).not.toContain("tcp-reached");
        // a datagram may leave the socket, but it never arrives at the host's service: control
        // datagrams from the host network (sent after the sandbox's, until one arrives) are counted
        // apart from the sandbox's
        for (let i = 0; (counts()["udp-c"] ?? 0) < 1; i++) {
          if (i >= 30) throw new Error(`no control datagram arrived: ${JSON.stringify(counts())}`);
          fromHost(
            `const s=require("dgram").createSocket("udp4");s.send("c",${port},${JSON.stringify(hostIp)},()=>s.close())`,
          );
        }
        expect(counts()["udp-x"] ?? 0).toBe(0);
        expect(counts().tcp).toBe(1);
        // the egress proxy (the internal network's only other member) still works
        const viaProxy = await run(
          h,
          instance({ kind: "open-public" }),
          "curl -sS -m 20 http://allowed.example.com/",
          {
            cwd: "/workspace",
          },
        );
        expect(viaProxy.stdout).toContain("hello-allowed.example.com");
      } finally {
        spawnSync("docker", ["rm", "-f", listener]);
      }
    });

    it("an external DNS query from the sandbox never resolves (no DNS side channel)", async () => {
      const h = await newDevice(sbx, { kind: "allowlist", hosts: ["allowed.example.com"] });
      const probe = py(
        "import random,socket,struct\n" +
          "name='capy-%d.example.com'%random.randrange(1<<30)\n" +
          "for n in (name,'example.com'):\n" +
          " try:\n  socket.getaddrinfo(n,80); print('resolved',n)\n except OSError: print('unresolved',n)\n" +
          "q=struct.pack('>HHHHHH',1,0x0100,1,0,0,0)+b''.join(bytes([len(l)])+l.encode() for l in name.split('.'))+b'\\0'+struct.pack('>HH',1,1)\n" +
          "servers=[l.split()[1] for l in open('/etc/resolv.conf') if l.startswith('nameserver')]+['8.8.8.8','1.1.1.1']\n" +
          "for s in servers:\n" +
          " u=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); u.settimeout(3)\n" +
          " try:\n  u.sendto(q,(s,53)); d=u.recv(512); print('answer',s,d[3]&15,struct.unpack('>H',d[6:8])[0])\n" +
          " except OSError: print('noanswer',s)",
      );
      const r = await run(
        h,
        instance({ kind: "allowlist", hosts: ["allowed.example.com"] }),
        probe,
        {
          cwd: "/workspace",
        },
      );
      expect(r.exitCode, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/^unresolved example\.com$/m);
      console.info(
        `[device-docker permission] DNS probe: ${r.stdout.trim().replaceAll("\n", "; ")}`,
      );
      expect(r.stdout).not.toMatch(/^resolved /m);
      // a reply from Docker's embedded resolver may come back, but never with an answer record
      for (const m of r.stdout.matchAll(/^answer \S+ (\d+) (\d+)$/gm)) expect(m[2]).toBe("0");
    });

    it("consumes an operation ID once and never repeats its effect", async () => {
      const root = `/workspace/once-${randomUUID().slice(0, 8)}`;
      await dexec(device.id, "1000", ["mkdir", root]);
      const scope = scopeFor(instance());
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
      const execScope = scopeFor(instance());
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
      const late = await run(device, instance(), "echo late > late", {
        cwd: root,
        scope: { admitBeforeMs: Date.now() - 1 },
      }).catch((e) => e);
      expect(isSandboxScopeDeniedError(late)).toBe(true);
      expect(await inspectRead(device, `${root}/late`)).toBeNull();
    });

    it("revokes before launch and cancels exactly the revoked running work", async () => {
      const root = `/workspace/revoke-${randomUUID().slice(0, 8)}`;
      await dexec(device.id, "1000", ["mkdir", root]);
      // Revoked before it starts: refused, nothing runs.
      const early = scopeFor(instance());
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
      // Running work with a sibling: only the revoked one ends.
      for (const [tag, grant] of [["instance", instance()]] as const) {
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

    it("killTagged ends a tagged operation's whole tree and nothing else", async () => {
      const root = `/workspace/tagged-${randomUUID().slice(0, 8)}`;
      await dexec(device.id, "1000", ["mkdir", root]);
      const other = run(
        device,
        instance(),
        `printf r > other-ready; until [ -e release ]; do sleep 0.01; done; printf kept > kept`,
        { cwd: root, scope: { tag: "keep-me" } },
      );
      const victim = run(
        device,
        instance(),
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

    it("refuses a browsed project path outside the workspace with its reason before it runs", async () => {
      const browse = await sbx.browse(
        device,
        {
          operationId: randomUUID(),
          admitBeforeMs: Date.now() + 60_000,
          deviceId: "device-perm",
          accountId: "acc-perm",
          ceilingRevision: "ceiling-1",
          readRoots: ["/workspace"],
          tag: "browse",
        },
        sig(),
      );
      for (const path of ["/etc", "/skills", "/opt/capybara", "/", "/workspace-other"]) {
        for (const call of [
          browse.list(path, { limit: 1, signal: sig() }),
          browse.stat(path, sig()),
          browse.scan(path, { signal: sig() }),
        ]) {
          const e = await call.catch((x: unknown) => x);
          expect(isProjectPathRefusedError(e), path).toBe(true);
          expect((e as ProjectPathRefusedError).reason).toEqual(OUTSIDE_WORKSPACE_REASON);
        }
      }
      // nothing was consumed: the same scope still answers inside the workspace
      expect(await browse.stat("/workspace", sig())).toMatchObject({ isDir: true });
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

      it("supervises work exactly: status, tail, positional reads, idempotent start and stop", async () => {
        const root = await newRoot("bg");
        const scope = scopeFor(instance());
        const args = bgArgs(
          root,
          `echo started >> starts; printf 'line-1\\n'; printf 'line-2\\n' >&2; (sleep 1400 & echo $! > child); ` +
            `printf r > ready; until [ -e release ]; do sleep 0.01; done; echo done; sleep 1401`,
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

      it("reports a natural exit and keeps siblings alive", async () => {
        const root = await newRoot("bg-exit");
        const keep = await sbx.background.start(
          device,
          scopeFor(instance()),
          bgArgs(root, "printf r > keep-ready; sleep 1500", { outputPath: `${root}/keep.log` }),
        );
        const ref = await sbx.background.start(
          device,
          scopeFor(instance()),
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
      });

      it("runs the whole instance in the background and revocation stops exactly that execution", async () => {
        const root = await newRoot("bg-full");
        const scope = scopeFor(instance());
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
          scopeFor(instance()),
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

      it("I1: file writes cannot change the root-owned records; revocation stops the task", async () => {
        const root = await newRoot(device, "forge");
        // Full access shares the device uid: the strongest in-device writer short of root.
        const scope = scopeFor(instance());
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
        const scope = scopeFor(instance());
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
          scopeFor(instance()),
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

      it("I3: a revocation survives an instance restart, and a restart during revocation is not reported as success", async () => {
        const h = await newDevice(sbx, { kind: "allowlist", hosts: [] });
        const root = await newRoot(h, "i3");
        const early = scopeFor(instance());
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
        const mid = scopeFor(instance());
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

      it("M1: a command cannot fake the admission refusal", async () => {
        const json = Buffer.from(
          JSON.stringify({ events: [{ event: "refused", code: "REVOKED" }] }),
        );
        const frame = Buffer.concat([Buffer.from("R"), Buffer.alloc(4), json]);
        frame.writeUInt32BE(json.byteLength, 1);
        const r = await run(
          device,
          instance(),
          `echo ${frame.toString("base64")} | base64 -d; exit 125`,
        );
        expect(r.exitCode).toBe(125);
      });

      it("M3: a record directory planted by the device user does not disable operations", async () => {
        const h = await newDevice(sbx, { kind: "allowlist", hosts: [] });
        await dexec(h.id, "1000", [
          "sh",
          "-c",
          "mkdir -p /tmp/.capybara-ops /tmp/.capybara-bg && chmod 777 /tmp/.capybara-ops",
        ]);
        const root = await newRoot(h, "m3");
        const r = await (await sbx.operation(h, scopeFor(instance()), sig())).exec({
          command: "echo ok",
          cwd: root,
          timeoutMs: 30_000,
          maxOutputBytes: 1024,
          signal: sig(),
        });
        expect(r.stdout.trim()).toBe("ok");
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

      it("the agent refuses every restricted request (exec, native, probe, writable scoped roots)", async () => {
        const root = await newRoot(device, "agent-refuse");
        const uuid = randomUUID();
        const ctl = `/tmp/.capybara-exec-agent-${uuid}`;
        const body = {
          opKey: "0".repeat(64),
          admitBeforeMs: Date.now() + 60_000,
          ctl,
          expect: sdkRuntimeDigests(),
          writeRoots: [root],
          readRoots: [],
          network: { kind: "none" },
          command: `printf ran > ${root}/ran`,
          cwd: root,
          env: {},
          timeoutMs: 10_000,
          maxOutputBytes: 1024,
          native: { method: "writeFile", path: `${root}/native`, dataB64: "eA==" },
        };
        const refusal = (r: { stdout: Buffer }) =>
          (
            (resultOf(r.stdout)?.events as { event: string; code?: string }[] | undefined) ?? []
          ).find((e) => e.event === "refused")?.code;
        for (const args of [
          ["exec", "capybara-exec", ctl],
          ["native", "capybara-exec", ctl],
          ["probe"],
        ]) {
          const r = agentCall(device, "1000", args, body);
          expect(refusal(r), args[0]).toBe("INVALID_REQUEST");
        }
        for (const extra of [
          { kind: "scoped" },
          { kind: "scoped", requireRestricted: true, writeRoots: [] },
        ]) {
          const r = agentCall(device, "1000", ["direct"], { ...body, ...extra });
          expect(refusal(r), JSON.stringify(extra)).toBe("UNAVAILABLE");
        }
        expect(await inspectRead(device, `${root}/ran`)).toBeNull();
        expect(await inspectRead(device, `${root}/native`)).toBeNull();
        // the agent carries no launcher path at all
        const source = await readFile(`${imageDir}runtime/capybara-operation.py`, "utf8");
        expect(source).not.toMatch(/def restricted\(|LAUNCHER|class Forwarder/);
      });

      it("R1: a same-uid writer cannot inject frames into a supervisor's channel", async () => {
        const root = await newRoot(device, "r1");
        const scope = scopeFor(instance());
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
        const scope = scopeFor(instance());
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
          scopeFor(instance()),
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
        const scope = scopeFor(instance());
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
        const scope = scopeFor(instance());
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

      /** The reference of a scope's background execution, from its root record's generation. */
      const refOf = async (h: SandboxHandle, scope: SandboxOperationScope) => {
        const record = JSON.parse(
          await dexec(h.id, "0", [
            "cat",
            `/opt/capybara/skills/.capybara-ops/bg/${operationUuid(scope.operationId)}/record.json`,
          ]),
        ) as { generation: string };
        return {
          executionId: operationUuid(scope.operationId),
          operationId: scope.operationId,
          instanceId: h.id,
          instanceGeneration: record.generation,
        };
      };

      it("R8: a forged identity with a wrong token is refused and the real start proceeds", async () => {
        const root = await newRoot(device, "r8w");
        const scope = scopeFor(instance());
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
        const scope = scopeFor(instance());
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

      it("R8: a start refused because another supervisor bound the record stops that supervisor", async () => {
        const root = await newRoot(device, "r8b");
        const scope = scopeFor(instance());
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
        // The real supervisor got no acceptance: the start is refused, and the provider stopped
        // what the record names (here the granted command under the other supervisor).
        expect(started).toBeInstanceOf(Error);
        expect(isSandboxOperationOutcomeUnknownError(started)).toBe(false);
        expect(await processes(device, "sleep 1803")).toBe(0);
        const ref = await refOf(device, scope);
        expect(await sbx.background.status(device, ref, sig())).toEqual({ state: "lost" });
        expect(await sbx.background.tail(device, ref, { maxBytes: 100, signal: sig() })).toEqual({
          unavailable: "lost",
        });
      });

      it("R8: a lost acknowledgement after a genuine bind keeps the task; the same-id retry returns its ref", async () => {
        const root = await newRoot(device, "r8g");
        const scope = scopeFor(instance());
        const taskId = `task-${randomUUID().slice(0, 8)}`;
        loseAck.add(taskId);
        const args = bg(root, `echo $$ >> ${root}/launches; exec sleep 1804`, taskId);
        const first = await sbx.background.start(device, scope, args).catch((e: unknown) => e);
        expect(isSandboxOperationOutcomeUnknownError(first)).toBe(true);
        loseAck.delete(taskId);
        // The kernel reconciles by retrying the same operation: it gets the existing reference.
        const ref = await sbx.background.start(device, scope, { ...args, signal: sig() });
        expect(ref.executionId).toBe(operationUuid(scope.operationId));
        await waitFor(device, `${root}/launches`);
        expect(await sbx.background.status(device, ref, sig())).toEqual({ state: "running" });
        const launches = (text(await inspectRead(device, `${root}/launches`)) ?? "")
          .trim()
          .split("\n");
        expect(launches).toHaveLength(1);
        expect(await processes(device, "sleep 1804")).toBe(1);
        expect(await sbx.background.stop(device, ref, { graceMs: 0, signal: sig() })).toEqual({
          outcome: "stopped",
        });
        expect(await processes(device, "sleep 1804")).toBe(0);
      });

      it("R8: a forged bind whose refusal reply was lost is stopped, lost and serves no output", async () => {
        const root = await newRoot(device, "r8f");
        const scope = scopeFor(instance());
        const taskId = `task-${randomUUID().slice(0, 8)}`;
        let forged: Record<string, unknown> | null = null;
        beforeLaunch.set(taskId, async (_task, leaked) => {
          beforeLaunch.delete(taskId);
          forged = await forgeWith(device, { ...leaked });
        });
        loseAck.add(taskId);
        const started = await sbx.background
          .start(device, scope, bg(root, `echo forged-output; exec sleep 1805`, taskId))
          .catch((e: unknown) => e);
        loseAck.delete(taskId);
        expect((forged as unknown as Record<string, unknown>)?.started).toBe(true);
        expect(isSandboxOperationOutcomeUnknownError(started)).toBe(true);
        // The real supervisor contested the record: the bound one is not the provider's own.
        expect(await processes(device, "sleep 1805")).toBe(0);
        const ref = await refOf(device, scope);
        expect(await sbx.background.status(device, ref, sig())).toEqual({ state: "lost" });
        expect(await sbx.background.tail(device, ref, { maxBytes: 100, signal: sig() })).toEqual({
          unavailable: "lost",
        });
        expect(
          await sbx.background.readOutput(device, ref, { offset: 0, maxBytes: 100, signal: sig() }),
        ).toEqual({ unavailable: "lost" });
      });

      // R9: the genuine bg-start is killed or stopped before it forks its supervisor, while a
      // forgery holding the intercepted request (here the real agent run with the whole leaked
      // request, so its digest matches) is bound. The exec ends without exit 0: never kept.
      // "acked" also writes a forged acknowledgement into the start's stdout before the kill
      // (same-uid processes can write there during start-up): only exit 0 counts.
      for (const variant of ["killed", "stopped", "acked"] as const) {
        it(`R9: a forged bind whose real bg-start was ${variant} before forking is never kept`, async () => {
          const root = await newRoot(device, `r9${variant[0]}`);
          const scope = scopeFor(instance());
          const taskId = `task-${randomUUID().slice(0, 8)}`;
          const marker = `capybara-r9-${randomUUID().slice(0, 8)}`;
          let forged: Record<string, unknown> | null = null;
          beforeLaunch.set(taskId, async (_task, leaked) => {
            beforeLaunch.delete(taskId);
            forged = await forgeWith(device, { ...leaked });
          });
          // The real bg-start: SIGKILL (exit 137) or SIGSTOP (the exec never returns; the
          // provider ends it on its own signal), in both cases before any supervisor exists.
          const fakeAck = `import json, os, signal, sys
d = json.dumps({"started": True}).encode()
sys.stdout.buffer.write(b"R" + len(d).to_bytes(4, "big") + d)
sys.stdout.flush()
os.kill(os.getpid(), signal.SIGKILL)  # ${marker}`;
          startCommands.set(
            taskId,
            variant === "acked"
              ? ["/usr/bin/python3", "-I", "-c", fakeAck]
              : [
                  "/bin/sh",
                  "-c",
                  variant === "killed" ? `kill -KILL $$ # ${marker}` : `kill -STOP $$ # ${marker}`,
                ],
          );
          const args = {
            ...bg(root, `echo forged-output; exec sleep 1806`, taskId),
            ...(variant === "stopped" && { signal: AbortSignal.timeout(5_000) }),
          };
          const started = await sbx.background.start(device, scope, args).catch((e: unknown) => e);
          startCommands.delete(taskId);
          expect((forged as unknown as Record<string, unknown>)?.started).toBe(true);
          expect(started).toBeInstanceOf(Error);
          expect(await processes(device, "sleep 1806")).toBe(0);
          const ref = await refOf(device, scope);
          expect(await sbx.background.status(device, ref, sig())).toEqual({ state: "lost" });
          expect(await sbx.background.tail(device, ref, { maxBytes: 100, signal: sig() })).toEqual({
            unavailable: "lost",
          });
          // The kernel's same-id retry gets the reference, which still reports nothing forged.
          const retried = await sbx.background.start(device, scope, { ...args, signal: sig() });
          expect(retried.executionId).toBe(ref.executionId);
          expect(await sbx.background.status(device, retried, sig())).toEqual({ state: "lost" });
          expect(
            await sbx.background.readOutput(device, retried, {
              offset: 0,
              maxBytes: 100,
              signal: sig(),
            }),
          ).toEqual({ unavailable: "lost" });
          // A stopped stand-in left by the transport is removed.
          await dexec(device.id, "0", ["pkill", "-KILL", "-f", marker]).catch(() => undefined);
        });
      }

      it("R8: stealing bg-start's stdin, forging a supervisor and writing the request back binds nothing", async () => {
        const root = await newRoot(device, "r8s");
        const scope = scopeFor(instance());
        const taskId = `task-${randomUUID().slice(0, 8)}`;
        // Deterministic stand-in for the reviewer's /proc watcher: the hook gets the exact bytes
        // written to bg-start's stdin, runs a forged supervisor with the stolen token and its own
        // command, and writes the same bytes back before the real bg-start reads them.
        let stolen: { token: unknown; forged: Record<string, unknown> | null } | undefined;
        stdinSteal.set(taskId, async (bytes) => {
          stdinSteal.delete(taskId);
          const raw = Buffer.from(bytes).toString();
          const newline = raw.indexOf("\n");
          const body = JSON.parse(
            raw.slice(newline + 1, newline + 1 + Number(raw.slice(0, newline))),
          );
          stolen = {
            token: body.token,
            forged: await forgeWith(device, { ...body, command: attackerCommand(root) }),
          };
          return bytes;
        });
        const started = await sbx.background
          .start(device, scope, bg(root, `echo $$ > ${root}/real; exec sleep 1802`, taskId))
          .catch((e: unknown) => e);
        expect(stolen?.token).toMatch(/^[0-9a-f]{32}$/);
        expect(stolen?.forged).not.toBeNull();
        expect(stolen?.forged?.started).toBeUndefined();
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
          // the native helper the agent runs: the launcher is never run, so operations check only
          // this one (a launcher digest the SDK does not accept fails the probe alone; unit tests)
          "RUN printf '\\n# mutant\\n' >> /opt/capybara-runtime/native-files.py\nUSER 1000:1000\n",
        encoding: "utf8",
      });
      expect(build.status, build.stderr).toBe(0);
      try {
        const h = await newDevice(sbx, { kind: "allowlist", hosts: [] }, tag);
        const report = await sbx.permissionSupport(h, sig());
        expect(report).toMatchObject({
          version: 2,
          boundary: "instance",
          restricted: null,
          network: { openPublic: false, allowlist: false, perOperationHosts: false },
          outsideSandbox: false,
          background: false,
        });
        expect(report.unavailableReason).toMatch(/digest/);
        await dexec(h.id, "1000", ["mkdir", "/workspace/p"]);
        // the agent verifies the staged bytes before native work: nothing is written
        const error = await (await sbx.operation(h, scopeFor(instance()), sig()))
          .writeFile("/workspace/p/ran", enc.encode("ran"), sig())
          .catch((e) => e);
        expect(isSandboxPermissionUnsupportedError(error)).toBe(true);
        expect(await inspectRead(h, "/workspace/p/ran")).toBeNull();
      } finally {
        await exec("docker", ["rmi", "-f", tag]).catch(() => undefined);
      }
    });
  },
);
