import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  isSandboxGoneError,
  type Logger,
  type SandboxLimits,
  type SandboxProvider,
} from "@capybara-hq/plugin-sdk";
import { type FakeE2BCall, type FakeE2BServer, startFakeE2B } from "@capybara-hq/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createE2BSandbox, type E2BSandboxConfig, METADATA_NAME } from "../src/index.js";

/**
 * sandbox@1 的 E2B 实现，对着假 E2B（@capybara-hq/testing 的 startFakeE2B：控制面 API + envd，命令在本机跑）：
 * 生命周期与 API 映射、gone / 普通错误、exec 输出 / 超时 / 中止杀进程、文件读写、/skills 以 root 写、出站映射。
 */

const enc = new TextEncoder();
const dec = new TextDecoder();
const sig = () => AbortSignal.timeout(20_000);
const sbxName = () => `cap-${randomUUID()}`;
const limits = (
  egress: SandboxLimits["egress"] = "none",
  allowHosts: string[] = [],
): SandboxLimits => ({
  cpu: 1,
  memoryMb: 2048,
  diskMb: 5120,
  egress,
  allowHosts,
});

/** Start 请求里的 process 字段。 */
const procOf = (c: FakeE2BCall | undefined) =>
  (c?.body as { process?: { cwd?: string; args?: string[] } } | undefined)?.process;

const argsOf = (c: FakeE2BCall) => (procOf(c)?.args ?? []).join(" ");

const waitFor = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe("sandbox-e2b (fake E2B)", { timeout: 20_000 }, () => {
  let fake: FakeE2BServer;
  let warns: string[];
  const warnFields: (Record<string, unknown> | undefined)[] = [];
  let sbx: SandboxProvider;
  let cfg: E2BSandboxConfig;

  const make = (over: Partial<E2BSandboxConfig> = {}) => {
    const log: Logger = {
      info: () => undefined,
      warn: (m, f) => {
        warns.push(m);
        warnFields.push(f);
      },
      error: () => undefined,
    };
    return createE2BSandbox({ ...cfg, ...over }, { log }, { envdUrl: fake.url });
  };

  beforeAll(async () => {
    fake = await startFakeE2B();
    cfg = {
      apiKey: fake.apiKey,
      apiUrl: fake.url,
      domain: "e2b.app",
      template: "capybara-sandbox",
      timeoutSeconds: 3600,
      domainAllowlist: true,
      allowOpenEgress: false,
    };
  });
  afterAll(async () => {
    await fake?.close();
  });
  afterEach(() => {
    warns = [];
  });
  warns = [];

  const createdBody = () => {
    const c = fake.calls.filter((x) => x.method === "POST" && x.path === "/v2/sandboxes").at(-1);
    return c?.body as Record<string, unknown>;
  };

  describe("create / lifecycle", () => {
    beforeAll(() => {
      sbx = make();
    });

    it("creates from the template, tagged with the name, auto-pausing on timeout", async () => {
      const name = sbxName();
      const h = await sbx.create({
        name,
        image: "ignored:latest",
        limits: limits(),
        signal: sig(),
      });
      const s = fake.sandboxes.get(h.id);
      expect(s?.templateID).toBe("capybara-sandbox");
      expect(s?.metadata[METADATA_NAME]).toBe(name);
      expect(s?.autoPause).toBe(true);
      expect(s?.timeout).toBe(3600);
      expect(s?.allowInternetAccess).toBe(false);
    });

    it("replaces an existing sandbox with the same name (across pages)", async () => {
      const name = sbxName();
      const p = await startFakeE2B({ apiKey: fake.apiKey, pageSize: 1 });
      try {
        const s2 = createE2BSandbox(
          { ...cfg, apiUrl: p.url },
          { log: console },
          { envdUrl: p.url },
        );
        const other = await s2.create({
          name: sbxName(),
          image: "x",
          limits: limits(),
          signal: sig(),
        });
        const a = await s2.create({ name, image: "x", limits: limits(), signal: sig() });
        await s2.suspend(a, sig());
        // 模拟内核在记下句柄前退出：同名又建了一个（第二个也带同名元数据）
        const b = await s2.create({ name, image: "x", limits: limits(), signal: sig() });
        expect(p.sandboxes.has(a.id)).toBe(false);
        expect(p.sandboxes.has(b.id)).toBe(true);
        expect(p.sandboxes.has(other.id)).toBe(true);
        await s2.destroyByName?.(name, sig());
        expect(p.sandboxes.has(b.id)).toBe(false);
        expect(p.sandboxes.has(other.id)).toBe(true);
        // 不存在也成功
        await s2.destroyByName?.(name, sig());
      } finally {
        await p.close();
      }
    });

    it("suspend pauses, resume connects; missing instances are gone / no-ops", async () => {
      const h = await sbx.create({ name: sbxName(), image: "x", limits: limits(), signal: sig() });
      await sbx.suspend(h, sig());
      expect(fake.sandboxes.get(h.id)?.state).toBe("paused");
      await sbx.suspend(h, sig()); // 已暂停（409）也成功
      expect(await sbx.resume(h, sig())).toBe("resumed");
      expect(fake.sandboxes.get(h.id)?.state).toBe("running");
      expect(await sbx.resume(h, sig())).toBe("resumed");
      await fake.expire(h.id);
      expect(await sbx.resume(h, sig())).toBe("gone");
      await sbx.suspend(h, sig());
      await sbx.destroy(h, sig());
    });

    it("destroy kills the sandbox", async () => {
      const h = await sbx.create({ name: sbxName(), image: "x", limits: limits(), signal: sig() });
      await sbx.destroy(h, sig());
      expect(fake.sandboxes.has(h.id)).toBe(false);
      await sbx.destroy(h, sig());
    });

    it("auth and server errors are plain errors (never gone) and never echo the API key", async () => {
      const h = await sbx.create({ name: sbxName(), image: "x", limits: limits(), signal: sig() });
      fake.failNext({ path: /\/connect$/ }, 401, "Invalid API key");
      const e1 = await sbx.resume(h, sig()).catch((e: unknown) => e);
      expect(e1).toBeInstanceOf(Error);
      expect(isSandboxGoneError(e1)).toBe(false);
      expect(String((e1 as Error).message)).toMatch(/401/);
      fake.failNext({ path: /\/connect$/ }, 503, "busy");
      const e2 = await sbx
        .exec(h, {
          command: "true",
          timeoutMs: 5000,
          maxOutputBytes: 100,
          signal: sig(),
        })
        .catch((e: unknown) => e);
      expect(isSandboxGoneError(e2)).toBe(false);
      expect(String((e2 as Error).message)).toMatch(/503/);
      fake.failNext({ path: /\/pause$/ }, 500);
      await expect(sbx.suspend(h, sig())).rejects.toThrow(/500/);
      fake.failNext({ method: "POST", path: /^\/v2\/sandboxes$/ }, 500);
      const e3 = await sbx
        .create({ name: sbxName(), image: "x", limits: limits(), signal: sig() })
        .catch((e: unknown) => e);
      for (const e of [e1, e2, e3]) expect(String((e as Error).message)).not.toContain(fake.apiKey);
      const bad = createE2BSandbox(
        { ...cfg, apiKey: "e2b_wrong" },
        { log: console },
        { envdUrl: fake.url },
      );
      await expect(
        bad.create({ name: sbxName(), image: "x", limits: limits(), signal: sig() }),
      ).rejects.toThrow(/401/);
    });

    it("a bare 404 (not E2B's error shape) is a plain error, never gone", async () => {
      const h = await sbx.create({ name: sbxName(), image: "x", limits: limits(), signal: sig() });
      fake.failNext({ path: /\/connect$/ }, 404, "404 page not found", { raw: true });
      await expect(sbx.resume(h, sig())).rejects.toThrow(/404/);
      fake.failNext({ path: /\/connect$/ }, 404, "Not Found", { raw: true });
      const e = await sbx.stat(h, "/workspace", sig()).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(Error);
      expect(isSandboxGoneError(e)).toBe(false);
      fake.failNext({ method: "DELETE", path: /^\/sandboxes\// }, 404, "nope", { raw: true });
      await expect(sbx.destroy(h, sig())).rejects.toThrow(/404/);
      fake.failNext({ path: /\/pause$/ }, 404, "nope", { raw: true });
      await expect(sbx.suspend(h, sig())).rejects.toThrow(/404/);
      // E2B 格式的 404 才是 gone
      fake.failNext({ path: /\/connect$/ }, 404, "sandbox not found");
      expect(await sbx.resume(h, sig())).toBe("gone");
    });

    it("rejects an invalid sandbox domain returned by the API", async () => {
      const p = await startFakeE2B({ apiKey: fake.apiKey, domain: "evil.com/x?" });
      try {
        const s2 = createE2BSandbox(
          { ...cfg, apiUrl: p.url },
          { log: console },
          { envdUrl: p.url },
        );
        const h = await s2.create({ name: sbxName(), image: "x", limits: limits(), signal: sig() });
        await expect(s2.stat(h, "/workspace", sig())).rejects.toThrow(/invalid sandbox domain/);
      } finally {
        await p.close();
      }
    });

    it("every method rejects immediately when already aborted", async () => {
      const h = await sbx.create({ name: sbxName(), image: "x", limits: limits(), signal: sig() });
      const ac = new AbortController();
      ac.abort(new Error("stop"));
      const s = ac.signal;
      const before = fake.calls.length;
      await expect(
        sbx.create({ name: sbxName(), image: "x", limits: limits(), signal: s }),
      ).rejects.toThrow("stop");
      await expect(sbx.resume(h, s)).rejects.toThrow("stop");
      await expect(sbx.suspend(h, s)).rejects.toThrow("stop");
      await expect(sbx.destroy(h, s)).rejects.toThrow("stop");
      await expect(sbx.destroyByName?.("cap-x", s)).rejects.toThrow("stop");
      await expect(
        sbx.exec(h, { command: "true", timeoutMs: 1000, maxOutputBytes: 10, signal: s }),
      ).rejects.toThrow("stop");
      await expect(sbx.readFile(h, "/workspace/a", { maxBytes: 10, signal: s })).rejects.toThrow(
        "stop",
      );
      await expect(sbx.writeFile(h, "/workspace/a", enc.encode("x"), s)).rejects.toThrow("stop");
      await expect(sbx.stat(h, "/workspace/a", s)).rejects.toThrow("stop");
      expect(fake.calls.length).toBe(before);
    });

    it("a hanging API request stops promptly on abort", async () => {
      const h = await sbx.create({ name: sbxName(), image: "x", limits: limits(), signal: sig() });
      for (const run of [
        (s: AbortSignal) => sbx.resume(h, s),
        (s: AbortSignal) => sbx.suspend(h, s),
        (s: AbortSignal) => sbx.stat(h, "/workspace", s),
      ]) {
        fake.hangNext({ path: /\/(connect|pause)$/ });
        const ac = new AbortController();
        const started = Date.now();
        const p = run(ac.signal);
        setTimeout(() => ac.abort(new Error("lost lock")), 100);
        await expect(p).rejects.toThrow("lost lock");
        expect(Date.now() - started).toBeLessThan(2000);
      }
    });

    it("rejects bad names and invalid limits", async () => {
      await expect(
        sbx.create({ name: "../x", image: "x", limits: limits(), signal: sig() }),
      ).rejects.toThrow(/invalid sandbox name/);
      await expect(
        sbx.create({
          name: sbxName(),
          image: "x",
          limits: limits("allowlist", ["10.0.0.1"]),
          signal: sig(),
        }),
      ).rejects.toThrow(/allowHosts/);
      await expect(
        sbx.create({ name: sbxName(), image: "x", limits: { ...limits(), cpu: 0 }, signal: sig() }),
      ).rejects.toThrow(/positive/);
    });
  });

  describe("egress", () => {
    beforeAll(() => {
      sbx = make();
    });

    it("none → no internet access", async () => {
      const h = await sbx.create({
        name: sbxName(),
        image: "x",
        limits: limits("none"),
        signal: sig(),
      });
      expect(fake.sandboxes.get(h.id)?.allowInternetAccess).toBe(false);
      expect(createdBody().network).toBeUndefined();
    });

    it("allowlist → allowOut domains with everything else denied", async () => {
      const hosts = ["registry.npmjs.org", "*.githubusercontent.com"];
      const h = await sbx.create({
        name: sbxName(),
        image: "x",
        limits: limits("allowlist", hosts),
        signal: sig(),
      });
      expect(fake.sandboxes.get(h.id)?.network).toEqual({
        allowOut: hosts,
        denyOut: ["0.0.0.0/0"],
      });
      expect(createdBody().allow_internet_access).toBeUndefined();
    });

    it("empty allowlist → no internet access", async () => {
      const h = await sbx.create({
        name: sbxName(),
        image: "x",
        limits: limits("allowlist", []),
        signal: sig(),
      });
      expect(fake.sandboxes.get(h.id)?.allowInternetAccess).toBe(false);
    });

    it("open requires allowOpenEgress", async () => {
      await expect(
        sbx.create({ name: sbxName(), image: "x", limits: limits("open"), signal: sig() }),
      ).rejects.toThrow(/allowOpenEgress/);
      const open = make({ allowOpenEgress: true });
      const h = await open.create({
        name: sbxName(),
        image: "x",
        limits: limits("open"),
        signal: sig(),
      });
      expect(fake.sandboxes.get(h.id)?.allowInternetAccess).toBe(true);
      expect(createdBody().network).toBeUndefined();
    });

    it("without domain allowlist support, allowlist degrades to none with a warning", async () => {
      const s = make({ domainAllowlist: false });
      const h = await s.create({
        name: sbxName(),
        image: "x",
        limits: limits("allowlist", ["pypi.org"]),
        signal: sig(),
      });
      expect(fake.sandboxes.get(h.id)?.allowInternetAccess).toBe(false);
      expect(createdBody().network).toBeUndefined();
      expect(warns.join("\n")).toMatch(/allowlist/);
    });
  });

  describe("exec", () => {
    let h: { id: string };
    beforeAll(async () => {
      sbx = make();
      h = await sbx.create({ name: sbxName(), image: "x", limits: limits(), signal: sig() });
    });

    const run = (command: string, over: Partial<Parameters<SandboxProvider["exec"]>[1]> = {}) =>
      sbx.exec(h, {
        command,
        timeoutMs: 10_000,
        maxOutputBytes: 64 * 1024,
        signal: sig(),
        ...over,
      });

    it("runs as the sandbox user in /workspace with env, collecting stdout / stderr / exit code", async () => {
      const r = await run('echo out; echo err >&2; printf "%s" "$FOO"; exit 3', {
        env: { FOO: "bar" },
      });
      expect(r).toEqual({
        exitCode: 3,
        stdout: "out\nbar",
        stderr: "err\n",
        truncated: false,
        timedOut: false,
      });
      const start = fake.calls.filter((c) => c.path === "/process.Process/Start").at(-1);
      expect(start?.user).toBe("sandbox");
      expect(start?.sandboxId).toBe(h.id);
      expect(procOf(start)?.cwd).toBe("/workspace");
      expect((await run("exit 0")).exitCode).toBe(0);
      await writeFile(fake.hostPath(h.id, "/workspace/marker"), "m");
      expect((await run("cat marker")).stdout).toBe("m");
      expect((await run("pwd", { cwd: "/tmp" })).stdout.trim()).toBe(
        realpathSync(fake.hostPath(h.id, "/tmp")),
      );
      await expect(run("true", { env: { "A=B": "x" } })).rejects.toThrow(/environment variable/);
    });

    it("extends the sandbox timeout for long commands", async () => {
      await run("true", { timeoutMs: 7_200_000 });
      expect(fake.sandboxes.get(h.id)?.timeout).toBeGreaterThanOrEqual(7200);
    });

    it("caps output at maxOutputBytes on a UTF-8 boundary", async () => {
      const r = await run("printf 'a中中中中'", { maxOutputBytes: 5 });
      expect(r.truncated).toBe(true);
      expect(r.stdout).toBe("a中");
      const big = await run("head -c 200000 /dev/zero | tr '\\0' x", { maxOutputBytes: 1000 });
      expect(big.truncated).toBe(true);
      expect(big.stdout.length + big.stderr.length).toBe(1000);
      expect(big.exitCode).toBe(0);
    });

    it("times out: kills the command and its children, resolves timedOut", async () => {
      const started = Date.now();
      const r = await run("echo started; sleep 30 & sleep 30; echo never", { timeoutMs: 500 });
      expect(r.timedOut).toBe(true);
      expect(r.exitCode).toBeNull();
      expect(r.stdout).toContain("started");
      expect(Date.now() - started).toBeLessThan(5000);
      await waitFor(() => fake.running(h.id).length === 0);
      // 沙箱仍可用
      expect((await run("echo ok")).stdout).toBe("ok\n");
    });

    it("abort mid-run kills the command and resolves exitCode null, timedOut false", async () => {
      const ac = new AbortController();
      const p = run("echo begin; sleep 30", { signal: ac.signal });
      await waitFor(() => fake.running(h.id).length > 0);
      const pids = fake.running(h.id).map((x) => x.pid);
      await new Promise((r) => setTimeout(r, 200));
      ac.abort(new Error("cancelled"));
      const r = await p;
      expect(r).toMatchObject({ exitCode: null, timedOut: false, stdout: "begin\n" });
      await waitFor(() => pids.every((pid) => !fake.alive(pid)));
    });

    it("kill script cannot run → reboots the sandbox (pause + connect memory:false), all processes die", async () => {
      const r0 = fake.reboots.get(h.id) ?? 0;
      fake.failNext(
        { path: /^\/process\.Process\/Start$/, when: (c) => argsOf(c).includes("capybara-kill") },
        503,
        "envd busy",
      );
      const started = Date.now();
      const r = await run("echo go; sleep 30 & sleep 30", { timeoutMs: 500 });
      expect(r).toMatchObject({ timedOut: true, exitCode: null, stdout: "go\n" });
      expect(Date.now() - started).toBeLessThan(8000);
      expect(fake.reboots.get(h.id)).toBe(r0 + 1);
      expect(fake.sandboxes.get(h.id)?.state).toBe("running");
      expect(warns.join("\n")).toMatch(/rebooting/);
      await waitFor(() => fake.running(h.id).length === 0);
      expect((await run("echo ok")).stdout).toBe("ok\n");
    });

    it("reboot failure during the fallback is logged and the exec result is still returned", async () => {
      for (const failing of [/\/pause$/, /\/connect$/]) {
        warns = [];
        fake.failNext(
          { path: /^\/process\.Process\/Start$/, when: (c) => argsOf(c).includes("capybara-kill") },
          503,
          "envd busy",
        );
        // exec 自己的 connect 先过，之后的 pause / connect（重启）失败
        let skip = failing.source.includes("connect") ? 1 : 0;
        fake.failNext(
          {
            path: failing,
            when: () => {
              if (skip > 0) {
                skip--;
                return false;
              }
              return true;
            },
          },
          500,
          "control plane down",
        );
        const r = await run("echo go; sleep 2", { timeoutMs: 300 });
        expect(r).toMatchObject({ timedOut: true, exitCode: null, stdout: "go\n" });
        const log = warns.join("\n");
        expect(log).toMatch(/reboot failed/);
        expect(log).not.toContain(fake.apiKey);
        expect(log).not.toContain(fake.sandboxes.get(h.id)?.envdAccessToken ?? "-");
        expect(warnFields.at(-1)).toMatchObject({
          sandboxId: h.id,
          err: expect.stringMatching(/500/),
        });
        await waitFor(() => fake.running(h.id).length === 0);
      }
    });

    it("output stream still open after the kill grace period → reboots the sandbox", async () => {
      const r0 = fake.reboots.get(h.id) ?? 0;
      const pidFile = fake.hostPath(h.id, "/tmp/escaped.pid");
      // 逃出会话的子进程（杀进程脚本按会话杀不到它）拿着 stdout 不放
      const escaped = `perl -MPOSIX -e 'POSIX::setsid(); open(my $f, ">", $ARGV[0]); print $f $$; close $f; exec "sleep", "20"' ${pidFile} &`;
      try {
        const r = await run(`${escaped} sleep 20`, { timeoutMs: 1500 });
        expect(r.timedOut).toBe(true);
        expect(fake.reboots.get(h.id)).toBe(r0 + 1);
      } finally {
        try {
          process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
        } catch {
          // 已结束
        }
      }
    }, 15_000);

    it("a command killed by a signal it did not get from us reports 128 + signal", async () => {
      const r = await run("echo x; kill -9 $PPID; sleep 1");
      expect(r).toMatchObject({ exitCode: 137, timedOut: false });
    });

    it("gone sandbox → SandboxGoneError; envd 502 on a live sandbox is a plain error", async () => {
      const g = await sbx.create({ name: sbxName(), image: "x", limits: limits(), signal: sig() });
      fake.failNext({ path: /^\/process\.Process\/Start$/ }, 502, "upstream error");
      const e = await sbx
        .exec(g, { command: "true", timeoutMs: 1000, maxOutputBytes: 10, signal: sig() })
        .catch((x: unknown) => x);
      expect(e).toBeInstanceOf(Error);
      expect(isSandboxGoneError(e)).toBe(false);
      await fake.expire(g.id);
      const e2 = await sbx
        .exec(g, { command: "true", timeoutMs: 1000, maxOutputBytes: 10, signal: sig() })
        .catch((x: unknown) => x);
      expect(isSandboxGoneError(e2)).toBe(true);
    });
  });

  describe("files", () => {
    let h: { id: string };
    beforeAll(async () => {
      sbx = make();
      h = await sbx.create({ name: sbxName(), image: "x", limits: limits(), signal: sig() });
    });

    it("writeFile creates parents (as the sandbox user via runuser), readFile / stat round-trip", async () => {
      const data = enc.encode("hello 中文\n");
      await sbx.writeFile(h, "/workspace/a/b/c.txt", data, sig());
      expect(readFileSync(fake.hostPath(h.id, "/workspace/a/b/c.txt"), "utf8")).toBe(
        "hello 中文\n",
      );
      const write = fake.calls.filter((c) => c.path === "/process.Process/Start").at(-1);
      const args = (procOf(write)?.args ?? []).join(" ");
      expect(write?.user).toBe("root");
      expect(args).toContain("runuser -u sandbox");
      const upload = fake.calls.filter((c) => c.path === "/files").at(-1);
      expect(upload?.user).toBe("root");
      expect(upload?.query.path).toMatch(/^\/opt\/capybara\/upload\//);
      // 中转文件已删除
      expect(readdirSync(fake.hostPath(h.id, "/opt/capybara/upload"))).toEqual([]);

      const r = await sbx.readFile(h, "/workspace/a/b/c.txt", { maxBytes: 1000, signal: sig() });
      expect(r && dec.decode(r.data)).toBe("hello 中文\n");
      expect(r?.truncated).toBe(false);
      const t = await sbx.readFile(h, "/workspace/a/b/c.txt", { maxBytes: 5, signal: sig() });
      expect(t && dec.decode(t.data)).toBe("hello");
      expect(t?.truncated).toBe(true);
      expect(await sbx.stat(h, "/workspace/a/b/c.txt", sig())).toEqual({
        size: data.byteLength,
        isDir: false,
      });
      expect(await sbx.stat(h, "/workspace/a", sig())).toMatchObject({ isDir: true });
      expect(await sbx.stat(h, "/workspace/nope", sig())).toBeNull();
      expect(await sbx.readFile(h, "/workspace/nope", { maxBytes: 10, signal: sig() })).toBeNull();
      expect(await sbx.readFile(h, "/workspace/a", { maxBytes: 10, signal: sig() })).toBeNull();
    });

    it("binary data and empty files round-trip", async () => {
      const bin = new Uint8Array(70_000).map((_, i) => i % 256);
      await sbx.writeFile(h, "/tmp/bin.dat", bin, sig());
      const r = await sbx.readFile(h, "/tmp/bin.dat", { maxBytes: 100_000, signal: sig() });
      expect(r?.data).toEqual(bin);
      await sbx.writeFile(h, "/workspace/empty", new Uint8Array(0), sig());
      expect(await sbx.stat(h, "/workspace/empty", sig())).toEqual({ size: 0, isDir: false });
      // 覆盖写
      await sbx.writeFile(h, "/workspace/empty", enc.encode("x"), sig());
      expect(statSync(fake.hostPath(h.id, "/workspace/empty")).size).toBe(1);
    });

    it("/skills is written as root directly (no runuser), world-readable", async () => {
      await sbx.writeFile(h, "/skills/pdf/SKILL.md", enc.encode("# pdf"), sig());
      const host = fake.hostPath(h.id, "/skills/pdf/SKILL.md");
      expect(readFileSync(host, "utf8")).toBe("# pdf");
      expect(statSync(host).mode & 0o777).toBe(0o644);
      const write = fake.calls.filter((c) => c.path === "/process.Process/Start").at(-1);
      expect(write?.user).toBe("root");
      expect((procOf(write)?.args ?? []).join(" ")).not.toContain("runuser");
      // 读与 stat 照常以沙箱用户
      expect(await sbx.stat(h, "/skills/pdf/SKILL.md", sig())).toEqual({ size: 5, isDir: false });
      const stat = fake.calls.filter((c) => c.path === "/process.Process/Start").at(-1);
      expect(stat?.user).toBe("sandbox");
    });

    it("rejects paths outside the sandbox roots", async () => {
      await expect(sbx.writeFile(h, "/etc/passwd", enc.encode("x"), sig())).rejects.toThrow(/path/);
      await expect(
        sbx.readFile(h, "/workspace/../etc/passwd", { maxBytes: 1, signal: sig() }),
      ).rejects.toThrow(/path/);
      await expect(sbx.stat(h, "relative", sig())).rejects.toThrow(/path/);
    });

    it("write failures surface as errors and clean the staged upload", async () => {
      await mkdir(dirname(fake.hostPath(h.id, "/workspace/dir/x")), { recursive: true });
      await mkdir(fake.hostPath(h.id, "/workspace/dir/x"), { recursive: true });
      await expect(sbx.writeFile(h, "/workspace/dir/x", enc.encode("x"), sig())).rejects.toThrow(
        /cannot write/,
      );
      expect(readdirSync(fake.hostPath(h.id, "/opt/capybara/upload"))).toEqual([]);
    });

    it("gone sandbox → SandboxGoneError for every file operation", async () => {
      const g = await sbx.create({ name: sbxName(), image: "x", limits: limits(), signal: sig() });
      await fake.expire(g.id);
      for (const op of [
        () => sbx.readFile(g, "/workspace/a", { maxBytes: 1, signal: sig() }),
        () => sbx.writeFile(g, "/workspace/a", enc.encode("x"), sig()),
        () => sbx.stat(g, "/workspace/a", sig()),
      ]) {
        const e = await op().catch((x: unknown) => x);
        expect(isSandboxGoneError(e)).toBe(true);
      }
    });
  });
});
