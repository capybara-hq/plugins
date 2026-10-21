import { randomUUID } from "node:crypto";
import {
  isSandboxGoneError,
  type SandboxHandle,
  type SandboxProvider,
} from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createE2BSandbox, DeploymentConfig } from "../../src/index.js";

/**
 * 真实 E2B 验收：`pnpm vitest run plugins/sandbox-e2b/test/live`
 *
 * - 开关：只在 `CAPYBARA_TEST_E2B_API_KEY` 与 `CAPYBARA_TEST_E2B_TEMPLATE`（由 plugins/sandbox-docker/image/Dockerfile
 *   构建的模板，见 README）都填了时运行，否则整组跳过；可选 `CAPYBARA_TEST_E2B_API_URL`、`CAPYBARA_TEST_E2B_DOMAIN`
 *   （自托管）。凭据由外层环境注入，代码不读任何凭据文件，也不打印。
 * - 覆盖：沙箱用户与工作目录、文件读写、/skills 对沙箱用户只读（含经符号链接写入被拒）、出站白名单、
 *   输出截断、超时杀进程（含 nohup 子进程）、中止、长时间无输出（保活）、逃出会话的子进程触发重启兜底、
 *   同名替换（真实列表接口）、暂停 / 恢复后文件仍在、销毁后 gone、同名清理。
 *
 * 只能在真实 E2B 上确认的假设（第一次跑时逐条核对，失败时先看这里）：
 * - [ ] 模板里有 uid 1000 的 `sandbox` 用户（E2B 自带的是 `user`），envd 接受 `Authorization: Basic sandbox:`；
 * - [ ] `/opt/capybara` 归 root、0700（`fromDockerfile` 后属主与权限保留）；
 * - [ ] `/skills` 归 root、0755（同上）；
 * - [ ] 镜像里有 `runuser` / `setsid`（util-linux）、`pkill` / `pgrep`（procps），root 的 PATH 能找到 runuser；
 * - [ ] envd 接受 `Basic root:` 跑 Start、`username=root` 上传；
 * - [ ] create（带 `secure: true`）/ connect 总是返回 `envdAccessToken`；没有令牌时插件拒绝连接（fail closed）；
 * - [ ] 镜像里有 GNU `timeout`（coreutils）：exec 的命令在沙箱里也有时限，`timeout` 自成进程组、杀进程脚本先杀它；
 * - [ ] 暂停再恢复后，前任留下的 exec 命令还在（内存快照），`killAll` 能杀掉；
 * - [ ] connect：运行中 200、暂停的恢复 201、只延长超时；`memory: false` 冷启动（进程全部结束，文件保留）；
 * - [ ] 暂停 / 过期的沙箱上 envd 回 502（不是 404），插件靠先 connect 判断 gone；
 * - [ ] 长流：几分钟无输出的命令靠 `Keepalive-Ping-Interval` 不被中间代理断开；
 * - [ ] `autoPause: true`：超时后暂停而不删除，/workspace 保留；
 * - [ ] allowlist 请求体（`network.allowOut` 域名 + `denyOut: ["0.0.0.0/0"]`）被接受，`*.` 通配生效；
 * - [ ] 列表接口的 `metadata` 过滤（`k=v` 经 URL 编码后作为 query 值）与 `x-next-token` 分页；
 * - [ ] SendSignal 对不存在的 pid 回 404 `not_found`；
 * - [ ] pause 已暂停回 409，DELETE 不存在回 404（均为 `{code, message}` 格式）。
 */

const filled = (v: string | undefined): v is string =>
  v !== undefined && v.trim() !== "" && !v.startsWith("替换为");
const env = process.env;
const API_KEY = env.CAPYBARA_TEST_E2B_API_KEY;
const TEMPLATE = env.CAPYBARA_TEST_E2B_TEMPLATE;
const READY = filled(API_KEY) && filled(TEMPLATE);

if (!READY) {
  console.info(
    "[e2b-live] skipped: CAPYBARA_TEST_E2B_API_KEY / CAPYBARA_TEST_E2B_TEMPLATE not both filled",
  );
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const sig = () => AbortSignal.timeout(120_000);

describe.skipIf(!READY)("sandbox-e2b live", { timeout: 180_000 }, () => {
  // describe 体在跳过时也会执行：配置放到 beforeAll 里解析
  let sbx: SandboxProvider;
  beforeAll(() => {
    const cfg = DeploymentConfig.parse({
      apiKey: API_KEY,
      template: TEMPLATE,
      ...(filled(env.CAPYBARA_TEST_E2B_API_URL) && { apiUrl: env.CAPYBARA_TEST_E2B_API_URL }),
      ...(filled(env.CAPYBARA_TEST_E2B_DOMAIN) && { domain: env.CAPYBARA_TEST_E2B_DOMAIN }),
      timeoutSeconds: 600,
    });
    const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
    sbx = createE2BSandbox(cfg, { log });
  });
  const name = `cap-live-${randomUUID()}`;
  let h: SandboxHandle;

  afterAll(async () => {
    await sbx?.destroyByName?.(name, sig());
  });

  const run = (command: string, timeoutMs = 30_000) =>
    sbx.exec(h, { command, timeoutMs, maxOutputBytes: 64 * 1024, signal: sig() });

  it("creates with an egress allowlist and runs as the sandbox user in /workspace", async () => {
    h = await sbx.create({
      name,
      image: "unused",
      limits: {
        cpu: 1,
        memoryMb: 2048,
        diskMb: 5120,
        egress: "allowlist",
        allowHosts: ["pypi.org"],
      },
      signal: sig(),
    });
    const r = await run("id -un; pwd; echo $HOME");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("sandbox\n/workspace\n/workspace\n");
  });

  it("files: write / read / stat, /skills read-only for the sandbox user", async () => {
    await sbx.writeFile(h, "/workspace/d/a.txt", enc.encode("hi 中文"), sig());
    const r = await sbx.readFile(h, "/workspace/d/a.txt", { maxBytes: 100, signal: sig() });
    expect(r && dec.decode(r.data)).toBe("hi 中文");
    expect(await sbx.stat(h, "/workspace/d", sig())).toMatchObject({ isDir: true });
    expect((await run("stat -c %U /workspace/d/a.txt")).stdout.trim()).toBe("sandbox");

    await sbx.writeFile(h, "/skills/demo/SKILL.md", enc.encode("# demo"), sig());
    expect((await run("cat /skills/demo/SKILL.md")).stdout).toBe("# demo");
    expect((await run("echo x > /skills/demo/SKILL.md")).exitCode).not.toBe(0);
    expect((await run("touch /skills/new")).exitCode).not.toBe(0);
    // 经符号链接写进 /skills 或 root 才能写的地方：按沙箱用户解析，失败
    await run("ln -s /skills/demo /workspace/l; ln -s /etc /workspace/e");
    await expect(sbx.writeFile(h, "/workspace/l/evil", enc.encode("x"), sig())).rejects.toThrow();
    await expect(sbx.writeFile(h, "/workspace/e/evil", enc.encode("x"), sig())).rejects.toThrow();
    expect((await run("test -e /skills/demo/evil || echo absent")).stdout).toBe("absent\n");
  });

  it("egress allowlist: allowed host reachable, others not", async () => {
    const ok = await run(
      "curl -sS -o /dev/null -w '%{http_code}' --max-time 20 https://pypi.org/simple/",
    );
    expect(ok.stdout).toMatch(/^[23]\d\d$/);
    const blocked = await run("curl -sS -o /dev/null --max-time 10 https://example.com/");
    expect(blocked.exitCode).not.toBe(0);
  });

  it("output is capped at maxOutputBytes", async () => {
    const r = await sbx.exec(h, {
      command: "head -c 100000 /dev/zero | tr '\\0' x",
      timeoutMs: 30_000,
      maxOutputBytes: 1000,
      signal: sig(),
    });
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBe(1000);
    expect(r.exitCode).toBe(0);
  });

  it("timeout kills the command and nohup children; the sandbox stays usable", async () => {
    const r = await run("nohup sleep 300 >/dev/null 2>&1 & sleep 300 & sleep 300", 2000);
    expect(r.timedOut).toBe(true);
    expect((await run("pgrep -x sleep || echo none")).stdout).toBe("none\n");
  });

  it("abort mid-run kills the command", async () => {
    const ac = new AbortController();
    const p = sbx.exec(h, {
      command: "echo begin; sleep 300",
      timeoutMs: 60_000,
      maxOutputBytes: 1024,
      signal: ac.signal,
    });
    await new Promise((r) => setTimeout(r, 3000));
    ac.abort(new Error("cancelled"));
    expect(await p).toMatchObject({ exitCode: null, timedOut: false, stdout: "begin\n" });
    expect((await run("pgrep -x sleep || echo none")).stdout).toBe("none\n");
  });

  it("a long silent command survives (keepalive)", { timeout: 240_000 }, async () => {
    const r = await run("sleep 150; echo done", 200_000);
    expect(r).toMatchObject({ exitCode: 0, stdout: "done\n", timedOut: false });
  });

  it("a child that escapes the session triggers the reboot fallback; files survive", async () => {
    // setsid 出新会话、继承 stdout：杀进程脚本按会话杀不到它，宽限期后插件 pause + connect(memory:false)
    const r = await run("setsid sleep 300 & sleep 300", 2000);
    expect(r.timedOut).toBe(true);
    expect((await run("pgrep -x sleep || echo none")).stdout).toBe("none\n");
    expect((await run("cat /workspace/d/a.txt")).stdout).toBe("hi 中文");
  });

  it("same-name create replaces the instance via the real list API", async () => {
    const other = `cap-live-${randomUUID()}`;
    const lim = { cpu: 1, memoryMb: 2048, diskMb: 5120, egress: "none" as const, allowHosts: [] };
    try {
      const a = await sbx.create({ name: other, image: "unused", limits: lim, signal: sig() });
      const b = await sbx.create({ name: other, image: "unused", limits: lim, signal: sig() });
      expect(b.id).not.toBe(a.id);
      expect(await sbx.resume(a, sig())).toBe("gone");
      expect(await sbx.resume(b, sig())).toBe("resumed");
    } finally {
      await sbx.destroyByName?.(other, sig());
    }
  });

  it("suspend / resume keeps files; destroy → gone", async () => {
    await sbx.suspend(h, sig());
    expect(await sbx.resume(h, sig())).toBe("resumed");
    expect((await run("cat /workspace/d/a.txt")).stdout).toBe("hi 中文");
    await sbx.destroy(h, sig());
    expect(await sbx.resume(h, sig())).toBe("gone");
    const e = await sbx.stat(h, "/workspace", sig()).catch((x: unknown) => x);
    expect(isSandboxGoneError(e)).toBe(true);
  });
});
