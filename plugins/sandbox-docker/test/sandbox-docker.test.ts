import { randomUUID } from "node:crypto";
import {
  isSandboxGoneError,
  type SandboxLimits,
  type SandboxProvider,
} from "@capybara-hq/plugin-sdk";
import {
  GenericContainer,
  Network,
  type StartedNetwork,
  type StartedTestContainer,
  Wait,
} from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDockerSandbox, type DockerSandboxConfig } from "../src/index.js";
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
  let net: StartedNetwork;
  let target: StartedTestContainer;
  let targetIp: string;
  let cfg: DockerSandboxConfig;
  let sbx: SandboxProvider;

  beforeAll(async () => {
    [images, proxy, net] = await Promise.all([
      buildTestImages(),
      startSocketProxy(),
      new Network().start(),
    ]);
    // 放行目标：与沙箱网络同一个网络上的本地 HTTP 服务（复用出站代理镜像里的 node）
    target = await new GenericContainer(images.egressImage)
      .withNetwork(net)
      .withUser("root")
      .withCommand([
        "node",
        "-e",
        "require('http').createServer((q,s)=>s.end('hello-egress')).listen(80,()=>console.log('ready'))",
      ])
      .withWaitStrategy(Wait.forLogMessage("ready"))
      .start();
    targetIp = target.getIpAddress(net.getName());
    cfg = {
      endpoint: proxy.endpoint,
      runtime: "runc",
      network: net.getName(),
      egressProxyImage: images.egressImage,
    };
    sbx = createDockerSandbox(cfg, {
      labels: { [TEST_LABEL]: RUN },
      // 仅测试：allowed.example.com / denied.example.com 都固定到本地目标（后者不在白名单里，照样被拒）
      egressTestHosts: { "allowed.example.com": targetIp, "denied.example.com": targetIp },
    });
  }, 600_000);

  afterAll(async () => {
    await cleanupTestResources(RUN);
    await target?.stop();
    await net?.stop();
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
      expect(big.stdout).toBe("a".repeat(100));
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
      expect(c.Config.User).toBe("1000:1000");
      expect((await sh(h.id, "id -u")).stdout).toBe("1000\n");
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
    expect(await exists("network", net.getName())).toBe(true);
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
