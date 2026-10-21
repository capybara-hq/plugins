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
 *   超时杀进程、暂停 / 恢复后文件仍在、销毁后 gone、同名清理。
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

  it("timeout kills the command; the sandbox stays usable", async () => {
    const r = await run("sleep 300 & sleep 300", 2000);
    expect(r.timedOut).toBe(true);
    expect((await run("pgrep -x sleep || echo none")).stdout).toBe("none\n");
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
