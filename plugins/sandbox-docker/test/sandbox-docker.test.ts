import { randomUUID } from "node:crypto";
import {
  isSandboxGoneError,
  type SandboxLimits,
  type SandboxProvider,
} from "@capybara-hq/plugin-sdk";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDockerSandbox,
  type DockerSandboxConfig,
  execArgv,
  IN_SANDBOX_GRACE_SECONDS,
} from "../src/index.js";
import {
  buildTestImages,
  cleanupTestResources,
  docker,
  dockerAvailable,
  runscAvailable,
  type SocketProxy,
  startSocketProxy,
  TEST_LABEL,
  type TestImages,
} from "./docker-env.js";

/**
 * 真实 Docker（经 docker/sandbox-proxy 的 socket 代理）上的 sandbox@1：生命周期、exec 超时与中止、文件读写、
 * /skills 只读、同名重建、gone 语义、三种出站（none / allowlist / open）、安全设置；runsc 只在装了时跑。
 * 没有 Docker 时整组跳过。
 */

const RUN = randomUUID().slice(0, 8);
const enc = new TextEncoder();
const dec = new TextDecoder();
const sig = () => AbortSignal.timeout(120_000);
const sbxName = () => `cap-${randomUUID()}`;
const limits = (egress: SandboxLimits["egress"], allowHosts: string[] = []): SandboxLimits => ({
  cpu: 1,
  memoryMb: 512,
  diskMb: 1024,
  egress,
  allowHosts,
});

describe.skipIf(!dockerAvailable)("sandbox-docker", { timeout: 120_000 }, () => {
  let images: TestImages;
  let proxy: SocketProxy;
  // 共用沙箱网络（socket 代理只放行 cap 开头的网络名）；放行目标也接在上面
  const netName = `capybara-sandbox-test-${RUN}`;
  let target: StartedTestContainer;
  let targetIp: string;
  let cfg: DockerSandboxConfig;
  let sbx: SandboxProvider;

  beforeAll(async () => {
    [images, proxy] = await Promise.all([
      buildTestImages(),
      startSocketProxy(),
      docker("network", "create", "--label", `${TEST_LABEL}=${RUN}`, netName),
    ]);
    // 放行目标：与沙箱网络同一个网络上的本地 HTTP 服务（复用出站代理镜像里的 node）
    target = await new GenericContainer(images.egressImage)
      .withNetworkMode(netName)
      .withUser("root")
      .withCommand([
        "node",
        "-e",
        "require('http').createServer((q,s)=>s.end('hello-egress')).listen(80,()=>console.log('ready'))",
      ])
      .withWaitStrategy(Wait.forLogMessage("ready"))
      .start();
    targetIp = target.getIpAddress(netName);
    cfg = {
      endpoint: proxy.endpoint,
      runtime: "runc",
      network: netName,
      egressProxyImage: images.egressImage,
      allowOpenEgress: true,
    };
    sbx = createDockerSandbox(cfg, {
      labels: { [TEST_LABEL]: RUN },
      // 仅测试：allowed.example.com / denied.example.com 都固定到本地目标（后者不在白名单里，照样被拒）
      egressTestHosts: { "allowed.example.com": targetIp, "denied.example.com": targetIp },
    });
  }, 600_000);

  afterAll(async () => {
    await target?.stop();
    await cleanupTestResources(RUN);
    await proxy?.stop();
    await images?.remove();
  }, 120_000);

  const sh = async (id: string, command: string, timeoutMs = 30_000) =>
    sbx.exec({ id }, { command, timeoutMs, maxOutputBytes: 1_000_000, signal: sig() });

  const inspect = async (name: string) =>
    JSON.parse(await docker("inspect", name))[0] as {
      State: { Running: boolean };
      Config: { User: string; Env: string[] };
      HostConfig: {
        ReadonlyRootfs: boolean;
        CapDrop: string[];
        SecurityOpt: string[];
        NanoCpus: number;
        Memory: number;
        PidsLimit: number;
        Runtime: string;
        NetworkMode: string;
      };
    };

  const exists = async (kind: "container" | "volume" | "network", name: string) =>
    docker(kind, "inspect", name).then(
      () => true,
      () => false,
    );

  it("full lifecycle: create → exec → write / read → suspend → resume (files kept) → destroy", async () => {
    const name = sbxName();
    const h = await sbx.create({
      name,
      image: images.sandboxImage,
      limits: limits("none"),
      signal: sig(),
    });
    const r = await sh(h.id, "echo hi; id -un; pwd");
    expect(r).toEqual({
      exitCode: 0,
      stdout: "hi\nsandbox\n/workspace\n",
      stderr: "",
      truncated: false,
      timedOut: false,
    });

    await sbx.writeFile(h, "/workspace/deep/dir/a.txt", enc.encode("hello file"), sig());
    const f = await sbx.readFile(h, "/workspace/deep/dir/a.txt", { maxBytes: 100, signal: sig() });
    expect(f && dec.decode(f.data)).toBe("hello file");
    expect(f?.truncated).toBe(false);
    const part = await sbx.readFile(h, "/workspace/deep/dir/a.txt", { maxBytes: 5, signal: sig() });
    expect(part && dec.decode(part.data)).toBe("hello");
    expect(part?.truncated).toBe(true);
    expect(
      await sbx.readFile(h, "/workspace/missing.txt", { maxBytes: 5, signal: sig() }),
    ).toBeNull();
    expect(await sbx.stat(h, "/workspace/deep/dir/a.txt", sig())).toEqual({
      size: 10,
      isDir: false,
    });
    expect(await sbx.stat(h, "/workspace/deep", sig())).toEqual({
      size: expect.any(Number),
      isDir: true,
    });
    expect(await sbx.stat(h, "/workspace/nope", sig())).toBeNull();
    // 命令写的文件归沙箱用户，writeFile 写的也是
    expect((await sh(h.id, "stat -c %U /workspace/deep/dir/a.txt")).stdout).toBe("sandbox\n");

    await sbx.suspend(h, sig());
    expect((await inspect(name)).State.Running).toBe(false);
    expect(await sbx.resume(h, sig())).toBe("resumed");
    expect((await inspect(name)).State.Running).toBe(true);
    const kept = await sbx.readFile(h, "/workspace/deep/dir/a.txt", {
      maxBytes: 100,
      signal: sig(),
    });
    expect(kept && dec.decode(kept.data)).toBe("hello file");
    // resume 已在运行的实例也算成功
    expect(await sbx.resume(h, sig())).toBe("resumed");

    await sbx.destroy(h, sig());
    expect(await exists("container", name)).toBe(false);
    expect(await exists("volume", `${name}-workspace`)).toBe(false);
    expect(await exists("volume", `${name}-skills`)).toBe(false);
  });

  it("a missing instance: resume is gone, file and exec calls throw SandboxGoneError, cleanup succeeds", async () => {
    const h = { id: sbxName() };
    expect(await sbx.resume(h, sig())).toBe("gone");
    const gone = async (p: Promise<unknown>) => {
      const e = await p.then(
        () => null,
        (err: unknown) => err,
      );
      expect(isSandboxGoneError(e), String(e)).toBe(true);
    };
    await gone(sh(h.id, "true"));
    await gone(sbx.readFile(h, "/workspace/a", { maxBytes: 1, signal: sig() }));
    await gone(sbx.writeFile(h, "/workspace/a", enc.encode("x"), sig()));
    await gone(sbx.stat(h, "/workspace/a", sig()));
    await sbx.suspend(h, sig());
    await sbx.destroy(h, sig());
    await sbx.destroyByName?.(h.id, sig());
  });

  it("exec: exit code, stderr, env, cwd and the output cap", async () => {
    const h = await sbx.create({
      name: sbxName(),
      image: images.sandboxImage,
      limits: limits("none"),
      signal: sig(),
    });
    try {
      const r = await sh(h.id, "echo out; echo err >&2; exit 3");
      expect(r.exitCode).toBe(3);
      expect(r.stdout).toBe("out\n");
      expect(r.stderr).toBe("err\n");
      // 命令与输出里的中文照常通过（exec 只拒绝键名里的非 ASCII）
      expect(
        (await sh(h.id, "echo \u4e2d\u6587 > /tmp/\u6587.txt; cat /tmp/\u6587.txt")).stdout,
      ).toBe("\u4e2d\u6587\n");
      // 建容器的值里有非 ASCII：插件自己先拒绝（不转义）
      await expect(
        sbx.create({
          name: sbxName(),
          image: "capybara-sandbox:\u955c\u50cf",
          limits: limits("none"),
          signal: sig(),
        }),
      ).rejects.toThrow(/non-ASCII/);
      const e = await sbx.exec(h, {
        command: 'echo "$FOO"; pwd',
        cwd: "/tmp",
        env: { FOO: "bar baz" },
        timeoutMs: 10_000,
        maxOutputBytes: 1000,
        signal: sig(),
      });
      expect(e.stdout).toBe("bar baz\n/tmp\n");
      const big = await sbx.exec(h, {
        command: "head -c 100000 /dev/zero | tr '\\0' a; echo done >&2",
        timeoutMs: 10_000,
        maxOutputBytes: 100,
        signal: sig(),
      });
      // 上限是 stdout + stderr 合计；Docker 分别转发两路，stderr 的 "done" 可能先到
      expect(big.stdout).toMatch(/^a+$/);
      expect(big.stdout.length + big.stderr.length).toBe(100);
      expect(big.truncated).toBe(true);
      expect(big.exitCode).toBe(0);
      // bash 语法可用
      expect((await sh(h.id, "a=(x y); [[ $a == x ]] && echo bash")).stdout).toBe("bash\n");
    } finally {
      await sbx.destroy(h, sig());
    }
  });

  it("exec: timeout and abort kill the command with its children; the sandbox stays usable", async () => {
    const h = await sbx.create({
      name: sbxName(),
      image: images.sandboxImage,
      limits: limits("none"),
      signal: sig(),
    });
    try {
      const t0 = Date.now();
      const r = await sbx.exec(h, {
        command: "echo started; sleep 301 & (sleep 302 &); sleep 303; echo never",
        timeoutMs: 1500,
        maxOutputBytes: 1000,
        signal: sig(),
      });
      expect(Date.now() - t0).toBeLessThan(10_000);
      expect(r).toMatchObject({ exitCode: null, timedOut: true, stdout: "started\n" });
      expect((await sh(h.id, "ps -eo args")).stdout).not.toMatch(/sleep 30[123]/);

      const ac = new AbortController();
      setTimeout(() => ac.abort(new Error("stop")), 1500);
      const t1 = Date.now();
      const a = await sbx.exec(h, {
        command: "echo begun; sleep 304 & sleep 305",
        timeoutMs: 60_000,
        maxOutputBytes: 1000,
        signal: ac.signal,
      });
      expect(Date.now() - t1).toBeLessThan(10_000);
      expect(a).toMatchObject({ exitCode: null, timedOut: false, stdout: "begun\n" });
      expect((await sh(h.id, "ps -eo args")).stdout).not.toMatch(/sleep 30[45]/);

      // 调用时已中止：立即 reject
      const dead = AbortSignal.abort(new Error("already"));
      await expect(
        sbx.exec(h, { command: "true", timeoutMs: 1000, maxOutputBytes: 10, signal: dead }),
      ).rejects.toThrow("already");
      await expect(
        sbx.readFile(h, "/workspace/x", { maxBytes: 1, signal: dead }),
      ).rejects.toThrow();
      await expect(sbx.resume(h, dead)).rejects.toThrow();

      expect((await sh(h.id, "echo alive")).stdout).toBe("alive\n");
      // 杀掉命令后 /tmp 里不留 .kill 标记
      expect((await sh(h.id, "ls -a /tmp | grep -c 'kill$' || true")).stdout).toBe("0\n");
    } finally {
      await sbx.destroy(h, sig());
    }
  });

  it("binary files round-trip, including empty files", async () => {
    const h = await sbx.create({
      name: sbxName(),
      image: images.sandboxImage,
      limits: limits("none"),
      signal: sig(),
    });
    try {
      const bytes = new Uint8Array(300_000).map((_, i) => (i * 7) % 256);
      await sbx.writeFile(h, "/workspace/bin.dat", bytes, sig());
      const back = await sbx.readFile(h, "/workspace/bin.dat", {
        maxBytes: 1_000_000,
        signal: sig(),
      });
      expect(back?.data).toEqual(bytes);
      expect((await sh(h.id, "wc -c < /workspace/bin.dat")).stdout.trim()).toBe("300000");
      await sbx.writeFile(h, "/tmp/empty", new Uint8Array(0), sig());
      expect(await sbx.stat(h, "/tmp/empty", sig())).toEqual({ size: 0, isDir: false });
      // 覆盖写
      await sbx.writeFile(h, "/workspace/bin.dat", enc.encode("short"), sig());
      const over = await sbx.readFile(h, "/workspace/bin.dat", { maxBytes: 100, signal: sig() });
      expect(over && dec.decode(over.data)).toBe("short");
    } finally {
      await sbx.destroy(h, sig());
    }
  });

  it("/skills is read-only inside the sandbox but writable through writeFile; no symlink bypass", async () => {
    const h = await sbx.create({
      name: sbxName(),
      image: images.sandboxImage,
      limits: limits("none"),
      signal: sig(),
    });
    try {
      await sbx.writeFile(h, "/skills/demo/run.sh", enc.encode("echo from-skill\n"), sig());
      expect((await sh(h.id, "sh /skills/demo/run.sh")).stdout).toBe("from-skill\n");
      const f = await sbx.readFile(h, "/skills/demo/run.sh", { maxBytes: 100, signal: sig() });
      expect(f && dec.decode(f.data)).toBe("echo from-skill\n");
      const w = await sh(
        h.id,
        "touch /skills/demo/x; rm -f /skills/demo/run.sh; echo; ls /skills/demo",
      );
      expect(w.stderr).toMatch(/Read-only file system/);
      expect(w.stdout).toBe("\nrun.sh\n");
      // 经符号链接绕到可写挂载也不行：沙箱用户进不了 /opt/capybara
      const l = await sh(h.id, "ln -s /opt/capybara/skills /workspace/l && ls /workspace/l/");
      expect(l.exitCode).not.toBe(0);
      await expect(
        sbx.writeFile(h, "/workspace/l/demo/run.sh", enc.encode("evil"), sig()),
      ).rejects.toThrow();
      const still = await sbx.readFile(h, "/skills/demo/run.sh", { maxBytes: 100, signal: sig() });
      expect(still && dec.decode(still.data)).toBe("echo from-skill\n");
      // 根文件系统只读
      expect((await sh(h.id, "touch /etc/x")).exitCode).not.toBe(0);
    } finally {
      await sbx.destroy(h, sig());
    }
  });

  it("applies resource limits and hardening", async () => {
    const name = sbxName();
    const h = await sbx.create({
      name,
      image: images.sandboxImage,
      limits: limits("none"),
      signal: sig(),
    });
    try {
      const c = await inspect(name);
      expect(c.HostConfig.ReadonlyRootfs).toBe(true);
      expect(c.HostConfig.CapDrop).toEqual(["ALL"]);
      expect(c.HostConfig.SecurityOpt).toContain("no-new-privileges:true");
      expect(c.HostConfig.NanoCpus).toBe(1_000_000_000);
      expect(c.HostConfig.Memory).toBe(512 * 1024 * 1024);
      expect(c.HostConfig.PidsLimit).toBeGreaterThan(0);
      expect(c.HostConfig.Runtime).toBe("runc");
      expect(c.HostConfig.NetworkMode).toBe("none");
      // 容器主进程（init 与 sleep）以 root 运行（能力全部去掉）：沙箱用户发不了信号给它们
      expect(c.Config.User).toBe("0:0");
      expect((await sh(h.id, "id -u")).stdout).toBe("1000\n");
      expect((await sh(h.id, "ps -o user= -p 1")).stdout.trim()).toBe("root");
      // 内核工具依赖 GNU find / grep
      expect((await sh(h.id, "find --version | head -1; grep --version | head -1")).stdout).toMatch(
        /GNU findutils[\s\S]*GNU grep/,
      );
    } finally {
      await sbx.destroy(h, sig());
    }
  });

  it("create with an existing name replaces the old instance instead of failing", async () => {
    const name = sbxName();
    const h1 = await sbx.create({
      name,
      image: images.sandboxImage,
      limits: limits("allowlist", ["allowed.example.com"]),
      signal: sig(),
    });
    await sbx.writeFile(h1, "/workspace/old.txt", enc.encode("old"), sig());
    const h2 = await sbx.create({
      name,
      image: images.sandboxImage,
      limits: limits("none"),
      signal: sig(),
    });
    try {
      expect(h2.id).toBe(h1.id);
      expect(await sbx.stat(h2, "/workspace/old.txt", sig())).toBeNull();
      expect((await inspect(name)).HostConfig.NetworkMode).toBe("none");
      // 旧的出站代理与内部网络也清掉了
      expect(await exists("container", `${name}-egress`)).toBe(false);
      expect(await exists("network", `${name}-net`)).toBe(false);
    } finally {
      await sbx.destroy(h2, sig());
    }
  });

  it("destroyByName removes the container, egress proxy, internal network and volumes", async () => {
    const name = sbxName();
    await sbx.create({
      name,
      image: images.sandboxImage,
      limits: limits("allowlist", ["allowed.example.com"]),
      signal: sig(),
    });
    expect(await exists("container", `${name}-egress`)).toBe(true);
    expect(await exists("network", `${name}-net`)).toBe(true);
    await sbx.destroyByName?.(name, sig());
    for (const [kind, n] of [
      ["container", name],
      ["container", `${name}-egress`],
      ["network", `${name}-net`],
      ["volume", `${name}-workspace`],
      ["volume", `${name}-skills`],
    ] as const) {
      expect(await exists(kind, n), `${kind} ${n}`).toBe(false);
    }
    // 共用的沙箱网络不删
    expect(await exists("network", netName)).toBe(true);
  });

  it("egress none: no network at all", async () => {
    const h = await sbx.create({
      name: sbxName(),
      image: images.sandboxImage,
      limits: limits("none"),
      signal: sig(),
    });
    try {
      // 没有任何路由（只有回环），也连不到同一台机器上的服务
      expect((await sh(h.id, "tail -n +2 /proc/net/route | wc -l")).stdout).toBe("0\n");
      const r = await sh(h.id, `curl -sS --max-time 3 http://${targetIp}/`);
      expect(r.exitCode).not.toBe(0);
    } finally {
      await sbx.destroy(h, sig());
    }
  });

  it("egress allowlist: allowed hosts through the proxy (HTTP and CONNECT), others refused, no direct route", async () => {
    const name = sbxName();
    const h = await sbx.create({
      name,
      image: images.sandboxImage,
      limits: limits("allowlist", ["allowed.example.com"]),
      signal: sig(),
    });
    try {
      const env = (await sh(h.id, "echo $HTTP_PROXY $HTTPS_PROXY")).stdout;
      expect(env).toMatch(/^http:\/\/\S+:3128 http:\/\/\S+:3128\n$/);
      expect((await sh(h.id, "curl -sS --max-time 10 http://allowed.example.com/")).stdout).toBe(
        "hello-egress",
      );
      // CONNECT 隧道（-p）
      expect((await sh(h.id, "curl -sS -p --max-time 10 http://allowed.example.com/")).stdout).toBe(
        "hello-egress",
      );
      const denied = await sh(
        h.id,
        "curl -sS -o /dev/null -w '%{http_code}' --max-time 10 http://denied.example.com/",
      );
      expect(denied.stdout).toBe("403");
      const deniedTunnel = await sh(h.id, "curl -sS -p --max-time 10 http://denied.example.com/");
      expect(deniedTunnel.exitCode).not.toBe(0);
      // 绕过代理直连不通（内部网络）
      const direct = await sh(h.id, `curl -sS --noproxy '*' --max-time 3 http://${targetIp}/`);
      expect(direct.exitCode).not.toBe(0);

      // 出站代理容器丢了：resume 时按记下的白名单重建
      await sbx.suspend(h, sig());
      await docker("rm", "-f", `${name}-egress`);
      expect(await sbx.resume(h, sig())).toBe("resumed");
      expect((await sh(h.id, "curl -sS --max-time 10 http://allowed.example.com/")).stdout).toBe(
        "hello-egress",
      );
    } finally {
      await sbx.destroy(h, sig());
    }
  });

  it("egress open: a plain bridge network", async () => {
    const h = await sbx.create({
      name: sbxName(),
      image: images.sandboxImage,
      limits: limits("open"),
      signal: sig(),
    });
    try {
      expect((await sh(h.id, `curl -sS --max-time 10 http://${targetIp}/`)).stdout).toBe(
        "hello-egress",
      );
    } finally {
      await sbx.destroy(h, sig());
    }
  });

  it("the socket proxy refuses Engine API calls the plugin does not need", async () => {
    const base = proxy.endpoint.replace(/^tcp:/, "http:");
    expect((await fetch(`${base}/_ping`)).status).toBe(200);
    expect((await fetch(`${base}/v1.44/info`)).status).toBe(403);
    expect((await fetch(`${base}/v1.44/containers/json`)).status).toBe(403);
    expect((await fetch(`${base}/v1.44/images/json`)).status).toBe(403);
    expect(
      (await fetch(`${base}/v1.44/containers/x/archive?path=/`, { method: "PUT" })).status,
    ).toBe(403);
  });

  describe("socket proxy body and name checks (real HAProxy)", () => {
    const post = async (path: string, body: unknown) => {
      const base = proxy.endpoint.replace(/^tcp:/, "http:");
      const r = await fetch(`${base}/v1.44${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
      return r.status;
    };
    // 镜像不存在：通过代理检查的请求由 Docker 返回 404，不会真的建出容器
    const NO_IMAGE = "capybara-no-such-image:none";
    const base = { Image: NO_IMAGE, HostConfig: { NetworkMode: "none" } };
    const create = (body: unknown, name = `cap-${RUN}-probe`) =>
      post(`/containers/create?name=${encodeURIComponent(name)}`, body);

    it("lets an ordinary cap- container create through (Docker answers)", async () => {
      expect(await create(base)).toBe(404);
    });

    it.each([
      ["privileged", { ...base, HostConfig: { NetworkMode: "none", Privileged: true } }],
      [
        "privileged (other case)",
        { ...base, hostconfig: { networkmode: "none", PRIVILEGED: true } },
      ],
      [
        "bind mount via Binds",
        { ...base, HostConfig: { NetworkMode: "none", Binds: ["/:/host"] } },
      ],
      [
        "bind mount via Mounts",
        {
          ...base,
          HostConfig: {
            NetworkMode: "none",
            Mounts: [{ Type: "bind", Source: "/", Target: "/h" }],
          },
        },
      ],
      [
        "a volume mount of a non-cap volume",
        {
          ...base,
          HostConfig: {
            NetworkMode: "none",
            Mounts: [{ Type: "volume", Source: "kernel-data", Target: "/h" }],
          },
        },
      ],
      [
        "a volume mount with a cap- source and a foreign one",
        {
          ...base,
          HostConfig: {
            NetworkMode: "none",
            Mounts: [
              { Type: "volume", Source: `cap-${RUN}-w`, Target: "/w" },
              { Type: "volume", source: "pgdata", Target: "/h" },
            ],
          },
        },
      ],
      ["CapAdd", { ...base, HostConfig: { NetworkMode: "none", CapAdd: ["SYS_ADMIN"] } }],
      ["Devices", { ...base, HostConfig: { NetworkMode: "none", Devices: [] } }],
      ["host pid namespace", { ...base, HostConfig: { NetworkMode: "none", PidMode: "host" } }],
      ["host network", { ...base, HostConfig: { NetworkMode: "host" } }],
      ["foreign network", { ...base, HostConfig: { NetworkMode: "bridge" } }],
      ["no network mode", { Image: NO_IMAGE, HostConfig: {} }],
      [
        "seccomp unconfined",
        { ...base, HostConfig: { NetworkMode: "none", SecurityOpt: ["seccomp=unconfined"] } },
      ],
      [
        "extra security opt",
        {
          ...base,
          HostConfig: {
            NetworkMode: "none",
            SecurityOpt: ["no-new-privileges:true", "label=disable"],
          },
        },
      ],
      ["unknown runtime", { ...base, HostConfig: { NetworkMode: "none", Runtime: "evil" } }],
      [
        "foreign network endpoint",
        { ...base, NetworkingConfig: { EndpointsConfig: { "kernel-net": {} } } },
      ],
    ])("refuses container create with %s", async (_label, body) => {
      expect(await create(body)).toBe(403);
    });

    it("refuses unicode escapes, duplicate keys, oversized bodies and non-cap names", async () => {
      expect(
        await create('{"Image":"x","HostConfig":{"NetworkMode":"none","Privil\\u0065ged":true}}'),
      ).toBe(403);
      expect(
        await create('{"Image":"x","HostConfig":{"NetworkMode":"none","NetworkMode":"host"}}'),
      ).toBe(403);
      expect(await create({ ...base, Env: [`X=${"a".repeat(40_000)}`] })).toBe(403);
      expect(await create(base, "kernel")).toBe(403);
      expect(await post("/containers/create", base)).toBe(403);
    });

    it("refuses exec and lifecycle calls on containers outside the cap- prefix", async () => {
      expect(await post("/containers/some-kernel/exec", { Cmd: ["id"] })).toBe(403);
      expect(await post("/containers/0123456789ab/start", {})).toBe(403);
      // cap- 容器上的特权 exec 也不行
      expect(
        await post(`/containers/cap-${RUN}-none/exec`, { Cmd: ["id"], Privileged: true }),
      ).toBe(403);
    });

    it("refuses non-ASCII keys that Go case-folds onto forbidden ones (ſ U+017F, K U+212A)", async () => {
      // Go 的 encoding/json 按 Unicode 简单大小写折叠匹配键名："Bindſ" → Binds，"Mas\u212AedPaths" → MaskedPaths
      expect(
        await create('{"Image":"x","HostConfig":{"NetworkMode":"none","Bind\u017f":["/:/host"]}}'),
      ).toBe(403);
      expect(
        await create('{"Image":"x","HostConfig":{"NetworkMode":"none","Mas\u212aedPaths":[]}}'),
      ).toBe(403);
      expect(
        await create('{"Image":"x","HostConfig":{"NetworkMode":"none","Device\u017f":[]}}'),
      ).toBe(403);
    });

    it("refuses non-ASCII values in create bodies", async () => {
      expect(await create({ ...base, Env: ["X=\u4e2d\u6587"] })).toBe(403);
      expect(await post("/volumes/create", { Name: `cap-${RUN}-v`, Labels: { a: "\u00e9" } })).toBe(
        403,
      );
      expect(
        await post("/networks/create", { Name: `cap-${RUN}-n`, Labels: { a: "\u00e9" } }),
      ).toBe(403);
    });

    it("exec: refuses non-ASCII keys but lets a command with Chinese text through", async () => {
      expect(await post(`/containers/cap-${RUN}-none/exec`, '{"Cmd":["id"],"U\u017fer":"0"}')).toBe(
        403,
      );
      // 通过代理检查，由 Docker 回答（容器不存在 → 404）
      expect(
        await post(`/containers/cap-${RUN}-none/exec`, { Cmd: ["echo", "\u4e2d\u6587.txt"] }),
      ).toBe(404);
    });

    it("lets a create with cap- volume mounts through (Docker answers)", async () => {
      expect(
        await create({
          ...base,
          HostConfig: {
            NetworkMode: "none",
            Mounts: [{ Type: "volume", Source: `cap-${RUN}-w`, Target: "/w" }],
          },
        }),
      ).toBe(404);
    });

    it("image pull: only fromImage is allowed (no import from a URL or stdin, no tagging)", async () => {
      const pull = async (query: string) => {
        const b = proxy.endpoint.replace(/^tcp:/, "http:");
        return (await fetch(`${b}/v1.44/images/create?${query}`, { method: "POST" })).status;
      };
      // 通过代理检查，由 Docker 回答（拉一个连不上的仓库：失败但不是 403）
      expect(await pull("fromImage=127.0.0.1%3A1%2Fnone%3Alatest")).not.toBe(403);
      for (const q of [
        "fromSrc=-",
        "fromSrc=http%3A%2F%2F127.0.0.1%2Fx.tar",
        "fromImage=x&fromSrc=-",
        "fromImage=x&repo=cap-evil",
        "fromImage=x&message=m",
        "fromImage=x&changes=CMD%20id",
        "fromImage=x&fromImage=y",
        "",
      ]) {
        expect(await pull(q), q).toBe(403);
      }
    });

    it("refuses bind-like volumes and non-bridge or non-cap networks", async () => {
      expect(
        await post("/volumes/create", {
          Name: `cap-${RUN}-v`,
          DriverOpts: { type: "none", o: "bind", device: "/" },
        }),
      ).toBe(403);
      expect(await post("/volumes/create", { Name: "kernel-data" })).toBe(403);
      expect(await post("/networks/create", { Name: `cap-${RUN}-n`, Driver: "macvlan" })).toBe(403);
      expect(await post("/networks/create", { Name: "kernel-net", Driver: "bridge" })).toBe(403);
    });
  });

  it("egress open is refused unless allowOpenEgress is set", async () => {
    const strict = createDockerSandbox(
      { ...cfg, allowOpenEgress: false },
      { labels: { [TEST_LABEL]: RUN } },
    );
    await expect(
      strict.create({
        name: sbxName(),
        image: images.sandboxImage,
        limits: limits("open"),
        signal: sig(),
      }),
    ).rejects.toThrow(/allowOpenEgress/);
  });

  it("when the kill exec itself cannot start (pid limit), the container is restarted", async () => {
    const h = await sbx.create({
      name: sbxName(),
      image: images.sandboxImage,
      limits: limits("none"),
      signal: sig(),
    });
    try {
      await sbx.writeFile(h, "/workspace/keep.txt", enc.encode("kept"), sig());
      const r = await sbx.exec(h, {
        command: "for i in $(seq 1100); do sleep 1000 & done 2>/dev/null; wait",
        timeoutMs: 4000,
        maxOutputBytes: 10_000,
        signal: sig(),
      });
      expect(r).toMatchObject({ exitCode: null, timedOut: true });
      expect((await sh(h.id, "ps -eo args | grep -c '^sleep 1000' || true")).stdout).toBe("0\n");
      const kept = await sbx.readFile(h, "/workspace/keep.txt", { maxBytes: 10, signal: sig() });
      expect(kept && dec.decode(kept.data)).toBe("kept");
    } finally {
      await sbx.destroy(h, sig());
    }
  });

  it("truncated output is cut at a UTF-8 character boundary", async () => {
    const h = await sbx.create({
      name: sbxName(),
      image: images.sandboxImage,
      limits: limits("none"),
      signal: sig(),
    });
    try {
      const r = await sbx.exec(h, {
        command: "printf 'a\\344\\270\\255b'",
        timeoutMs: 10_000,
        maxOutputBytes: 3,
        signal: sig(),
      });
      expect(r.truncated).toBe(true);
      expect(r.stdout).toBe("a");
    } finally {
      await sbx.destroy(h, sig());
    }
  });

  describe("stopped behind the kernel's back (fix wave S2 I1)", () => {
    it("exec / readFile / writeFile / stat start a stopped container again, files and egress intact", async () => {
      const name = sbxName();
      const h = await sbx.create({
        name,
        image: images.sandboxImage,
        limits: limits("allowlist", ["allowed.example.com"]),
        signal: sig(),
      });
      try {
        await sbx.writeFile(h, "/workspace/keep.txt", enc.encode("kept"), sig());
        // 守护进程重启 / 宿主机重启 / 休眠扫描停了容器却没记下 suspended：内核仍以为它在运行
        await docker("stop", "-t", "1", name, `${name}-egress`);
        const r = await sh(h.id, "cat /workspace/keep.txt");
        expect(r).toMatchObject({ exitCode: 0, stdout: "kept" });
        expect((await inspect(name)).State.Running).toBe(true);
        // 出站代理也一起起来了
        expect((await sh(h.id, "curl -sS --max-time 10 http://allowed.example.com/")).stdout).toBe(
          "hello-egress",
        );

        await docker("stop", "-t", "1", name);
        const f = await sbx.readFile(h, "/workspace/keep.txt", { maxBytes: 10, signal: sig() });
        expect(f && dec.decode(f.data)).toBe("kept");
        await docker("stop", "-t", "1", name);
        await sbx.writeFile(h, "/workspace/b.txt", enc.encode("b"), sig());
        await docker("stop", "-t", "1", name);
        expect(await sbx.stat(h, "/workspace/b.txt", sig())).toEqual({ size: 1, isDir: false });
      } finally {
        await sbx.destroy(h, sig());
      }
    });

    it("the sandbox user cannot stop the container (kill 1, pkill sleep, kill -9 -1)", async () => {
      const name = sbxName();
      const h = await sbx.create({
        name,
        image: images.sandboxImage,
        limits: limits("none"),
        signal: sig(),
      });
      try {
        await sh(h.id, "kill 1; kill -TERM 1; pkill sleep; pkill -9 sleep; true");
        await sh(h.id, "kill -9 -1; true");
        // 给 init 一点时间：若它被停掉，容器会在这期间退出
        await new Promise((r) => setTimeout(r, 1000));
        expect((await inspect(name)).State.Running).toBe(true);
        expect((await sh(h.id, "echo alive")).stdout).toBe("alive\n");
      } finally {
        await sbx.destroy(h, sig());
      }
    });
  });

  describe("commands left behind by a crashed kernel replica (fix wave S2 I2)", () => {
    /** 以 exec 的命令行在容器里启动一条命令、不等它（模拟发起它的内核副本崩溃：没有人再按 timeoutMs 杀它）。 */
    const orphan = async (id: string, command: string, timeoutMs: number) => {
      const ctl = `/tmp/.capybara-exec-${randomUUID()}`;
      await docker("exec", "-d", "-u", "1000:1000", id, ...execArgv(ctl, command, timeoutMs));
    };
    const count = async (id: string, pattern: string) =>
      Number((await sh(id, `pgrep -fc -- ${JSON.stringify(pattern)} || true`)).stdout.trim());
    const waitUntil = async (cond: () => Promise<boolean>, ms: number) => {
      const end = Date.now() + ms;
      while (!(await cond())) {
        if (Date.now() > end) throw new Error("condition not met in time");
        await new Promise((r) => setTimeout(r, 250));
      }
    };

    it("the command is killed inside the sandbox at its deadline even with nobody watching", async () => {
      const h = await sbx.create({
        name: sbxName(),
        image: images.sandboxImage,
        limits: limits("none"),
        signal: sig(),
      });
      try {
        const started = Date.now();
        await orphan(h.id, "sleep 101 & sleep 102; echo never > /workspace/never", 1000);
        await waitUntil(async () => (await count(h.id, "^sleep 10[12]")) === 2, 10_000);
        await waitUntil(async () => (await count(h.id, "^sleep 10[12]")) === 0, 20_000);
        const elapsed = Date.now() - started;
        expect(elapsed).toBeGreaterThanOrEqual(1000);
        expect(elapsed).toBeLessThan((1 + IN_SANDBOX_GRACE_SECONDS + 5) * 1000);
        expect(await sbx.stat(h, "/workspace/never", sig())).toBeNull();
      } finally {
        await sbx.destroy(h, sig());
      }
    });

    it("killAll stops every leftover exec command; the sandbox stays usable", async () => {
      const h = await sbx.create({
        name: sbxName(),
        image: images.sandboxImage,
        limits: limits("none"),
        signal: sig(),
      });
      try {
        await sbx.writeFile(h, "/workspace/keep.txt", enc.encode("kept"), sig());
        await orphan(h.id, "sleep 201 & sleep 202", 600_000);
        await orphan(h.id, "sleep 203", 600_000);
        await waitUntil(async () => (await count(h.id, "^sleep 20[123]")) === 3, 10_000);
        await sbx.killAll?.(h, sig());
        expect(await count(h.id, "^sleep 20[123]")).toBe(0);
        expect((await sh(h.id, "cat /workspace/keep.txt")).stdout).toBe("kept");
        // 停着的容器：killAll 先把它启动
        await docker("stop", "-t", "1", h.id);
        await sbx.killAll?.(h, sig());
        expect((await inspect(h.id)).State.Running).toBe(true);
      } finally {
        await sbx.destroy(h, sig());
      }
      await expect(sbx.killAll?.(h, sig())).rejects.toSatisfy(isSandboxGoneError);
    });
  });

  it.skipIf(!runscAvailable)("runsc: lifecycle under gVisor", async () => {
    const runsc = createDockerSandbox(
      { ...cfg, runtime: "runsc" },
      { labels: { [TEST_LABEL]: RUN } },
    );
    const name = sbxName();
    const h = await runsc.create({
      name,
      image: images.sandboxImage,
      limits: limits("none"),
      signal: sig(),
    });
    try {
      expect((await inspect(name)).HostConfig.Runtime).toBe("runsc");
      await runsc.writeFile(h, "/workspace/a.txt", enc.encode("gvisor"), sig());
      const r = await runsc.exec(h, {
        command: "cat /workspace/a.txt; sleep 300",
        timeoutMs: 2000,
        maxOutputBytes: 100,
        signal: sig(),
      });
      expect(r).toMatchObject({ stdout: "gvisor", timedOut: true });
      await runsc.suspend(h, sig());
      expect(await runsc.resume(h, sig())).toBe("resumed");
      expect(await runsc.stat(h, "/workspace/a.txt", sig())).toEqual({ size: 6, isDir: false });
    } finally {
      await runsc.destroy(h, sig());
    }
  });
});
