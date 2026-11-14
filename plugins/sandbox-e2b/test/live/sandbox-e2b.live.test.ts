import { randomUUID } from "node:crypto";
import {
  type FileSystemHandle,
  isFileSystemGoneError,
  type SandboxHandle,
  type SandboxLimits,
  type SandboxProvider,
} from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createE2BApi, type E2BApi } from "../../src/e2b-api.js";
import {
  createE2BSandbox,
  DeploymentConfig,
  providerConfig,
  templateAlias,
} from "../../src/index.js";

/**
 * 真实 E2B 验收：`pnpm vitest run plugins/sandbox-e2b/test/live`
 *
 * - Switch: runs only when `CAPYBARA_TEST_E2B_API_KEY` is filled, otherwise the whole group is
 *   skipped. `CAPYBARA_TEST_E2B_TEMPLATE` (a template built from
 *   plugins/sandbox-docker/image/Dockerfile, see README) is optional: unset, the first
 *   `createFileSystem` builds the template `capybara-sandbox-<this plugin's version>` from the
 *   published image (that image
 *   must exist on ghcr.io, i.e. sandbox-docker's version must have been released). Optional
 *   `CAPYBARA_TEST_E2B_API_URL`, `CAPYBARA_TEST_E2B_DOMAIN` (self-hosted). Credentials come from
 *   the outer environment; the code reads no credential file and prints none.
 * - Covers: the template auto-build (template unset), a file system created paused and an instance
 *   connecting it, the sandbox user and working directory, file reads and writes, /skills read-only
 *   for the sandbox user (a write through a symlink refused too), the network allowlist and the
 *   open-public refusal, output truncation, timeout kills (nohup children too), abort, long silence
 *   (keepalive), a child that escaped the session killed by its environment marker, files surviving
 *   instance destroy (processes gone), createFileSystem by name, whether a paused sandbox's network
 *   rules can change (logged as `[e2b-live] paused network update: …`, recorded in README "Network
 *   policy"), destroyFileSystem → FileSystemGoneError.
 *
 * 只能在真实 E2B 上确认的假设（第一次跑时逐条核对，失败时先看这里）：
 * - [ ] 模板里有 uid 1000 的 `sandbox` 用户（E2B 自带的是 `user`），envd 接受 `Authorization: Basic sandbox:`；
 * - [ ] `/opt/capybara` 归 root、0700（`fromDockerfile` 后属主与权限保留）；
 * - [ ] `/skills` 归 root、0755（同上）；
 * - [ ] 镜像里有 `runuser` / `setsid`（util-linux）、`pkill` / `pgrep`（procps），root 的 PATH 能找到 runuser；
 * - [ ] envd 接受 `Basic root:` 跑 Start、`username=root` 上传；
 * - [ ] create（带 `secure: true`）/ connect 总是返回 `envdAccessToken`；没有令牌时插件拒绝连接（fail closed）；
 * - [ ] 镜像里有 GNU `timeout`（coreutils）：exec 的命令在沙箱里也有时限，`timeout` 自成进程组、杀进程脚本先杀它；
 * - [ ] pause `{memory: false}` ends every process and keeps the files; a sandbox created and paused
 *   at once resumes through connect; `autoPauseMemory: false` is accepted on create;
 * - [ ] the alias lookup (`GET /templates/aliases/{alias}`) answers `public: false` for our own
 *   template, 403 for an alias of another team, and `public: true` for a public one (both refused
 *   with "owned by another E2B team or is public"); whether aliases resolve across teams at all
 *   (namespaced names `team/alias` in v3?), and that `POST /v3/templates` answers `public: false`
 *   (templates are created private; the plugin refuses otherwise);
 * - [ ] a template built with `fromImage` of the published image (POST /v3/templates, trigger,
 *   poll status) keeps the image's user `sandbox`, its owners and modes; an alias whose build is
 *   not ready answers 404 on create (the plugin then builds and retries once);
 * - [ ] paused sandboxes stay (E2B documents no time to live; an older page said 30 days): resume
 *   one paused for more than 30 days by hand and record it here;
 * - [ ] connect：运行中 200、暂停的恢复 201、只延长超时；`memory: false` 冷启动（进程全部结束，文件保留）；
 * - [ ] 暂停 / 过期的沙箱上 envd 回 502（不是 404），插件靠先 connect 判断 gone；
 * - [ ] 长流：几分钟无输出的命令靠 `Keepalive-Ping-Interval` 不被中间代理断开；
 * - [ ] `autoPause: true`：超时后暂停而不删除，/workspace 保留；
 * - [x] The metadata endpoint stays reachable whatever the network policy: with an allowlist
 *   (everything denied) it still answers 401 on `GET /latest/meta-data/`, and
 *   `PUT /latest/api/token` answers 200 (verified 2026-11-14). The same holds with
 *   `denyOut: ["169.254.169.254/32"]` and with `denyOut` of every private range, so E2B cannot
 *   block it: the plugin refuses `open-public` (fail closed). Re-check this item before ever
 *   mapping `open-public` to internet access.
 * - [ ] The allowlist body (`network.allowOut` domains + `denyOut: ["0.0.0.0/0"]`) is accepted and
 *   a `*.` wildcard takes effect; `denyOut` of private CIDRs blocks resolved destination IPs
 *   (verified 2026-11-14 with `--resolve`);
 * - [ ] 列表接口的 `metadata` 过滤（`k=v` 经 URL 编码后作为 query 值）与 `x-next-token` 分页；
 * - [ ] SendSignal 对不存在的 pid 回 404 `not_found`；
 * - [ ] the image's ENV (cache variables such as `npm_config_cache`, `NODE_USE_ENV_PROXY`) reaches
 *   envd processes in a template built with `fromImage` (logged as `[e2b-live] image env: …`);
 * - [ ] pause 已暂停回 409，DELETE 不存在回 404（均为 `{code, message}` 格式）。
 * - [ ] concurrent processes (phase C): envd runs several `process.Start` streams of one sandbox
 *   side by side; `killTagged` (pgrep on `/tmp/.capybara-exec-<tag>-`) kills only that holder's;
 * - [ ] concurrent `connect` calls on a paused sandbox all succeed (or a 409 while one resume is in
 *   flight, which the plugin retries briefly), and concurrent uploads to the staging directory
 *   (UUID names) do not interfere.
 */

const filled = (v: string | undefined): v is string =>
  v !== undefined && v.trim() !== "" && !v.startsWith("替换为");
const env = process.env;
const API_KEY = env.CAPYBARA_TEST_E2B_API_KEY;
const TEMPLATE = env.CAPYBARA_TEST_E2B_TEMPLATE;
const READY = filled(API_KEY);

if (!READY) console.info("[e2b-live] skipped: CAPYBARA_TEST_E2B_API_KEY not filled");

const enc = new TextEncoder();
const dec = new TextDecoder();
const sig = () => AbortSignal.timeout(120_000);
/** A template build from the image takes minutes. */
const BUILD_MS = 35 * 60_000;
const actor = { accountId: "live", conversationId: "live" };
const who = () => ({ tag: randomUUID(), actor });
const allowlist: SandboxLimits = {
  cpu: 1,
  memoryMb: 2048,
  diskMb: 5120,
  mode: "sandbox",
  network: { kind: "allowlist", hosts: ["pypi.org"] },
};

describe.skipIf(!READY)("sandbox-e2b live", { timeout: 180_000 }, () => {
  // describe 体在跳过时也会执行：配置放到 beforeAll 里解析
  let sbx: SandboxProvider;
  let api: E2BApi;
  let alias: string;
  beforeAll(() => {
    const cfg = DeploymentConfig.parse({
      apiKey: API_KEY,
      ...(filled(TEMPLATE) && { template: TEMPLATE }),
      ...(filled(env.CAPYBARA_TEST_E2B_API_URL) && { apiUrl: env.CAPYBARA_TEST_E2B_API_URL }),
      ...(filled(env.CAPYBARA_TEST_E2B_DOMAIN) && { domain: env.CAPYBARA_TEST_E2B_DOMAIN }),
      timeoutSeconds: 600,
    });
    const log = { info: console.info, warn: console.warn, error: console.error };
    const provider = providerConfig(cfg);
    alias = templateAlias(provider.defaultImage);
    sbx = createE2BSandbox(provider, { log });
    api = createE2BApi(cfg.apiUrl ?? `https://api.${cfg.domain}`, cfg.apiKey);
  });
  const name = `cap-device-live-${randomUUID()}`;
  let fs: FileSystemHandle;
  let h: SandboxHandle;

  afterAll(async () => {
    await sbx?.destroyFileSystemByName(name, sig());
  });

  const run = (command: string, timeoutMs = 30_000) =>
    sbx.exec(h, {
      ...who(),
      command,
      timeoutMs,
      maxOutputBytes: 64 * 1024,
      // outlive the command's own time limit, or the signal aborts a long command first
      signal: AbortSignal.timeout(Math.max(120_000, timeoutMs + 60_000)),
    });

  const stateOf = async (id: string) => {
    const r = await api.json<{ sandboxID: string; state: string }[]>("GET", "/v2/sandboxes", {
      query: { state: "running,paused", limit: "100" },
      signal: sig(),
    });
    return r.data?.find((x) => x.sandboxID === id)?.state;
  };

  it("builds or finds the template, creates the file system paused, and an instance runs as the sandbox user", {
    timeout: BUILD_MS + 60_000,
  }, async () => {
    if (!filled(TEMPLATE)) console.info(`[e2b-live] template auto-build: ${alias}`);
    fs = await sbx.createFileSystem({
      name,
      limits: allowlist,
      signal: AbortSignal.timeout(BUILD_MS),
    });
    expect(await stateOf(fs.id)).toBe("paused");
    expect(await sbx.createFileSystem({ name, limits: allowlist, signal: sig() })).toEqual(fs);
    h = await sbx.create({ name, limits: allowlist, fileSystem: fs, signal: sig() });
    expect(h.id).toBe(fs.id);
  });

  it("runs as the sandbox user in /workspace", async () => {
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

  it("network allowlist: allowed host reachable, others not", async () => {
    const ok = await run(
      "curl -sS -o /dev/null -w '%{http_code}' --max-time 20 https://pypi.org/simple/",
    );
    expect(ok.stdout).toMatch(/^[23]\d\d$/);
    const blocked = await run("curl -sS -o /dev/null --max-time 10 https://example.com/");
    expect(blocked.exitCode).not.toBe(0);
  });

  it("open-public is refused before any E2B call", async () => {
    await expect(
      sbx.createFileSystem({
        name: `cap-device-live-${randomUUID()}`,
        limits: { ...allowlist, network: { kind: "open-public", hosts: [] } },
        signal: sig(),
      }),
    ).rejects.toThrow(/open-public.*refused.*metadata endpoint/s);
  });

  it("records that the metadata endpoint stays reachable under the allowlist", async () => {
    // the reason open-public is refused: the Firecracker MMDS answers even when the sandbox has no
    // other network access, and a token is obtainable, so no E2B network setting can block it
    const r = await run(
      "curl -sS -o /dev/null -w '%{http_code}' --max-time 10 http://169.254.169.254/latest/meta-data/",
    );
    console.info(`[e2b-live] metadata endpoint under the allowlist: HTTP ${r.stdout.trim()}`);
    expect(r.stdout.trim()).toBe("401");
  });

  it("output is capped at maxOutputBytes", async () => {
    const r = await sbx.exec(h, {
      ...who(),
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
      ...who(),
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

  it("a child that escapes the session is killed by its environment marker; files survive", async () => {
    // setsid leaves the session and keeps stdout: real envd ends the stream when the command exits,
    // so only the kill script's marker scan (CAPYBARA_EXEC in /proc/<pid>/environ) finds the child
    const r = await run("setsid sleep 300 & sleep 300", 2000);
    expect(r.timedOut).toBe(true);
    expect((await run("pgrep -x sleep || echo none")).stdout).toBe("none\n");
    expect((await run("cat /workspace/d/a.txt")).stdout).toBe("hi 中文");
  });

  it("files survive instance destroy; the processes do not (pause without memory)", async () => {
    await run("echo kept > /workspace/kept.txt; nohup sleep 600 >/dev/null 2>&1 &");
    await sbx.destroy(h, sig());
    expect(await stateOf(fs.id)).toBe("paused");
    h = await sbx.create({ name, limits: allowlist, fileSystem: fs, signal: sig() });
    expect((await run("cat /workspace/kept.txt")).stdout).toBe("kept\n");
    expect((await run("pgrep -x sleep || echo none")).stdout).toBe("none\n");
  });

  it("records whether a paused sandbox's network rules can change (spec §5.3)", async () => {
    await sbx.suspend(h, sig());
    // the SDK's Sandbox.updateNetwork (PUT /sandboxes/{id}/network) is documented for running ones
    const outcome = await api
      .json("PUT", `/sandboxes/${fs.id}/network`, {
        body: { allow_internet_access: false },
        signal: sig(),
      })
      .then(
        (r) => `accepted (HTTP ${r.status})`,
        (e: unknown) => `refused: ${e instanceof Error ? e.message : String(e)}`,
      );
    console.info(`[e2b-live] paused network update: ${outcome}`);
    expect(await sbx.resume(h, sig())).toBe("resumed");
  });

  it("records whether the template carries the image's ENV into processes (README)", async () => {
    // the cache variables and NODE_USE_ENV_PROXY of the image's ENV: a template built with
    // fromImage may or may not keep them; logged until confirmed
    const r = await run(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
      'printf "%s|%s|%s" "${npm_config_cache:-unset}" "${XDG_CACHE_HOME:-unset}" "${NODE_USE_ENV_PROXY:-unset}"',
    );
    console.info(`[e2b-live] image env: ${r.stdout}`);
    expect(r.exitCode).toBe(0);
  });

  it("concurrent processes and uploads (phase C)", async () => {
    const [ta, tb] = [randomUUID(), randomUUID()];
    const t0 = Date.now();
    const [a, b] = await Promise.all([
      sbx.exec(h, {
        command: "sleep 2; echo a",
        timeoutMs: 30_000,
        maxOutputBytes: 100,
        signal: sig(),
        tag: ta,
        actor,
      }),
      sbx.exec(h, {
        command: "sleep 2; echo b",
        timeoutMs: 30_000,
        maxOutputBytes: 100,
        signal: sig(),
        tag: tb,
        actor,
      }),
      ...[1, 2, 3, 4].map((i) =>
        sbx.writeFile(h, `/workspace/c/${i}.txt`, enc.encode(`f${i}`), sig()),
      ),
    ]);
    expect(a?.stdout).toBe("a\n");
    expect(b?.stdout).toBe("b\n");
    expect(Date.now() - t0).toBeLessThan(4000 + 5000);
    expect((await run("cat /workspace/c/1.txt /workspace/c/4.txt")).stdout).toBe("f1f4");
    // killTagged ends one holder's command only
    const stop = new AbortController();
    const keep = sbx.exec(h, {
      command: "sleep 120",
      timeoutMs: 150_000,
      maxOutputBytes: 10,
      signal: stop.signal,
      tag: tb,
      actor,
    });
    const gone = sbx.exec(h, {
      command: "sleep 121",
      timeoutMs: 150_000,
      maxOutputBytes: 10,
      signal: sig(),
      tag: ta,
      actor,
    });
    await new Promise((r) => setTimeout(r, 2000));
    await sbx.killTagged?.(h, [ta], sig());
    expect((await gone).exitCode).not.toBe(0);
    expect((await run("pgrep -fc '^sleep 120' || true")).stdout.trim()).toBe("1");
    stop.abort();
    await keep;
    // concurrent connects on a paused sandbox
    await sbx.suspend(h, sig());
    const both = await Promise.all([
      run("echo x"),
      run("echo y"),
      sbx.stat(h, "/workspace", sig()),
    ]);
    expect(both[0].stdout).toBe("x\n");
    expect(both[1].stdout).toBe("y\n");
  });

  it("suspend / resume keeps files; destroyFileSystem → FileSystemGoneError", async () => {
    await sbx.suspend(h, sig());
    expect(await sbx.resume(h, sig())).toBe("resumed");
    expect((await run("cat /workspace/d/a.txt")).stdout).toBe("hi 中文");
    await sbx.destroyFileSystem(fs, sig());
    expect(await sbx.resume(h, sig())).toBe("gone");
    const e = await sbx
      .create({ name, limits: allowlist, fileSystem: fs, signal: sig() })
      .catch((x: unknown) => x);
    expect(isFileSystemGoneError(e)).toBe(true);
  });
});
