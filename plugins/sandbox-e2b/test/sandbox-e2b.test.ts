import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";
import {
  isFileSystemGoneError,
  isSandboxGoneError,
  type Logger,
  type SandboxActor,
  type SandboxLimits,
  type SandboxProvider,
} from "@capybara-hq/plugin-sdk";
import { type FakeE2BCall, type FakeE2BServer, startFakeE2B } from "@capybara-hq/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { envdStart } from "../src/e2b-api.js";
import {
  createE2BSandbox,
  type E2BSandboxConfig,
  execArgs,
  IN_SANDBOX_GRACE_SECONDS,
  METADATA_NAME,
  publishedImage,
  templateAlias,
} from "../src/index.js";

/**
 * sandbox@2 on E2B, against the fake E2B (startFakeE2B of @capybara-hq/testing: control plane API +
 * envd, commands run on this machine): one E2B sandbox per device, kept by pausing it without
 * memory; template auto-build; gone / plain errors; exec output / timeout / abort kills; file reads
 * and writes, /skills written as root; the network policy mapping (open-public refused).
 */

const enc = new TextEncoder();
const dec = new TextDecoder();
const sig = () => AbortSignal.timeout(20_000);
const sbxName = () => `cap-device-${randomUUID()}`;
const limits = (
  network: SandboxLimits["network"] = { kind: "allowlist", hosts: [] },
): SandboxLimits => ({
  cpu: 1,
  memoryMb: 2048,
  diskMb: 5120,
  mode: "sandbox",
  network,
});
/** The image the template is built from in these tests, and its alias. */
const IMAGE = publishedImage("0.0.0-test.1");
const ALIAS = templateAlias(IMAGE);
const ACTOR: SandboxActor = { accountId: "acc-1", conversationId: "conv-1" };
/** The holder tag and actor every exec carries. */
const who = () => ({ tag: randomUUID(), actor: ACTOR });
/** Whether a host process still exists. */
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A file system plus an instance attached to it (what the kernel does before first use). */
const provision = async (
  s: SandboxProvider,
  l: SandboxLimits = limits(),
  name: string = sbxName(),
) => {
  const fileSystem = await s.createFileSystem({ name, limits: l, signal: sig() });
  return s.create({ name, limits: l, fileSystem, signal: sig() });
};

/**
 * A proxy in front of a fake E2B: `override` may answer a request itself (to play an E2B answer
 * the fake cannot give); everything else is forwarded.
 */
const proxyOf = async (
  target: FakeE2BServer,
  override: (
    method: string,
    path: string,
    body: Buffer,
  ) => { status: number; body: unknown } | undefined,
) => {
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const path = new URL(req.url ?? "/", "http://x").pathname;
      const own = override(req.method ?? "GET", path, Buffer.concat(chunks));
      if (own) {
        res
          .writeHead(own.status, { "content-type": "application/json" })
          .end(JSON.stringify(own.body));
        return;
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string" && k !== "host" && k !== "content-length") headers[k] = v;
      }
      const body = Buffer.concat(chunks);
      const r = await fetch(target.url + (req.url ?? "/"), {
        method: req.method ?? "GET",
        headers,
        ...(body.byteLength > 0 && { body }),
      });
      const out = Buffer.from(await r.arrayBuffer());
      const resHeaders: Record<string, string> = {};
      r.headers.forEach((v, k) => {
        if (k !== "content-length" && k !== "transfer-encoding") resHeaders[k] = v;
      });
      res.writeHead(r.status, resHeaders).end(out);
    })().catch(() => res.destroy());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
};

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

  const make = (over: Partial<E2BSandboxConfig> = {}, server: FakeE2BServer = fake) => {
    const log: Logger = {
      info: () => undefined,
      warn: (m, f) => {
        warns.push(m);
        warnFields.push(f);
      },
      error: () => undefined,
    };
    return createE2BSandbox(
      { ...cfg, apiUrl: server.url, ...over },
      { log },
      { envdUrl: server.url },
    );
  };

  beforeAll(async () => {
    fake = await startFakeE2B();
    cfg = {
      apiKey: fake.apiKey,
      apiUrl: fake.url,
      domain: "e2b.app",
      template: "capybara-sandbox",
      defaultImage: IMAGE,
      timeoutSeconds: 3600,
      domainAllowlist: true,
    };
  });
  afterAll(async () => {
    await fake?.close();
  });
  afterEach(() => {
    warns = [];
  });
  warns = [];

  const createdBody = (server: FakeE2BServer = fake) => {
    const c = server.calls.filter((x) => x.method === "POST" && x.path === "/v2/sandboxes").at(-1);
    return c?.body as Record<string, unknown>;
  };
  const pauseBodies = (id: string, server: FakeE2BServer = fake) =>
    server.calls.filter((x) => x.path === `/sandboxes/${id}/pause`).map((x) => x.body);

  describe("file systems and instances", () => {
    beforeAll(() => {
      sbx = make();
    });

    it("createFileSystem creates from the template, tagged with the name, then pauses it without memory", async () => {
      const name = sbxName();
      const fs = await sbx.createFileSystem({ name, limits: limits(), signal: sig() });
      const s = fake.sandboxes.get(fs.id);
      expect(s?.templateID).toBe("capybara-sandbox");
      expect(s?.metadata[METADATA_NAME]).toBe(name);
      expect(s?.autoPause).toBe(true);
      expect(s?.timeout).toBe(3600);
      expect(s?.allowInternetAccess).toBe(false);
      expect(createdBody()).toMatchObject({ secure: true, autoPauseMemory: false });
      expect(s?.state).toBe("paused");
      expect(s?.pausedWithMemory).toBe(false);
      expect(pauseBodies(fs.id)).toEqual([{ memory: false }]);
    });

    it("createFileSystem returns the existing file system of the same name", async () => {
      const name = sbxName();
      const a = await sbx.createFileSystem({ name, limits: limits(), signal: sig() });
      const before = fake.calls.filter((c) => c.path === "/v2/sandboxes" && c.method === "POST");
      const b = await sbx.createFileSystem({ name, limits: limits(), signal: sig() });
      expect(b).toEqual(a);
      expect(fake.calls.filter((c) => c.path === "/v2/sandboxes" && c.method === "POST")).toEqual(
        before,
      );
    });

    it("create connects the file system's sandbox; the instance id is the file system id", async () => {
      const name = sbxName();
      const fileSystem = await sbx.createFileSystem({ name, limits: limits(), signal: sig() });
      const h = await sbx.create({
        name,
        image: "ignored:latest",
        limits: limits(),
        fileSystem,
        signal: sig(),
      });
      expect(h).toEqual({ id: fileSystem.id });
      expect(fake.sandboxes.get(h.id)?.state).toBe("running");
      const connect = fake.calls.filter((c) => c.path === `/v2/sandboxes/${h.id}/connect`).at(-1);
      expect(connect?.body).toEqual({ timeout: 3600 });
    });

    it("files survive destroy and recreate", async () => {
      const name = sbxName();
      const fileSystem = await sbx.createFileSystem({ name, limits: limits(), signal: sig() });
      const h = await sbx.create({ name, limits: limits(), fileSystem, signal: sig() });
      await sbx.writeFile(h, "/workspace/keep.txt", enc.encode("kept"), sig());
      await sbx.destroy(h, sig());
      expect(fake.sandboxes.get(h.id)?.state).toBe("paused");
      expect(pauseBodies(h.id).at(-1)).toEqual({ memory: false });
      await sbx.destroy(h, sig()); // already paused (409) also succeeds
      const h2 = await sbx.create({ name, limits: limits(), fileSystem, signal: sig() });
      const r = await sbx.readFile(h2, "/workspace/keep.txt", { maxBytes: 100, signal: sig() });
      expect(r && dec.decode(r.data)).toBe("kept");
      // destroyByName pauses the instance found by name and keeps the files
      await sbx.destroyByName(name, sig());
      expect(fake.sandboxes.get(h.id)?.state).toBe("paused");
      await sbx.destroyByName(name, sig()); // nothing running: success
      const h3 = await sbx.create({ name, limits: limits(), fileSystem, signal: sig() });
      expect((await sbx.stat(h3, "/workspace/keep.txt", sig()))?.size).toBe(4);
      // the file system goes with destroyFileSystem
      await sbx.destroyFileSystem(fileSystem, sig());
      expect(fake.sandboxes.has(fileSystem.id)).toBe(false);
      await sbx.destroyFileSystem(fileSystem, sig()); // missing: success
    });

    it("connect 404 throws FileSystemGoneError", async () => {
      const name = sbxName();
      const fileSystem = await sbx.createFileSystem({ name, limits: limits(), signal: sig() });
      await fake.removeSandbox(fileSystem.id);
      const e = await sbx
        .create({ name, limits: limits(), fileSystem, signal: sig() })
        .catch((x: unknown) => x);
      expect(isFileSystemGoneError(e)).toBe(true);
      expect(String((e as Error).message)).toContain(fileSystem.id);
      // a plain failure (5xx, a bare 404 from a proxy) is never "files lost"
      const name2 = sbxName();
      const fs2 = await sbx.createFileSystem({ name: name2, limits: limits(), signal: sig() });
      for (const fail of [
        () => fake.failNext({ path: /\/connect$/ }, 503, "busy"),
        () => fake.failNext({ path: /\/connect$/ }, 404, "Not Found", { raw: true }),
      ]) {
        fail();
        const e2 = await sbx
          .create({ name: name2, limits: limits(), fileSystem: fs2, signal: sig() })
          .catch((x: unknown) => x);
        expect(e2).toBeInstanceOf(Error);
        expect(isFileSystemGoneError(e2)).toBe(false);
      }
    });

    it("pause drops memory: suspend ends the processes and keeps the files", async () => {
      const h = await provision(sbx);
      await sbx.writeFile(h, "/workspace/f", enc.encode("x"), sig());
      const ac = new AbortController();
      const p = sbx.exec(h, {
        ...who(),
        command: "sleep 30",
        timeoutMs: 60_000,
        maxOutputBytes: 100,
        signal: ac.signal,
      });
      await waitFor(() => fake.running(h.id).length === 1);
      const pid = fake.running(h.id)[0]?.pid as number;
      await sbx.suspend(h, sig());
      expect(fake.sandboxes.get(h.id)).toMatchObject({ state: "paused", pausedWithMemory: false });
      await waitFor(() => !fake.alive(pid));
      ac.abort();
      await p.catch(() => undefined);
      await sbx.suspend(h, sig()); // already paused (409) also succeeds
      expect(await sbx.resume(h, sig())).toBe("resumed");
      expect(fake.running(h.id)).toEqual([]);
      expect((await sbx.stat(h, "/workspace/f", sig()))?.size).toBe(1);
    });

    it("suspend / resume; a missing instance is gone, suspend and destroy are no-ops", async () => {
      const h = await provision(sbx);
      await sbx.suspend(h, sig());
      expect(fake.sandboxes.get(h.id)?.state).toBe("paused");
      expect(await sbx.resume(h, sig())).toBe("resumed");
      expect(fake.sandboxes.get(h.id)?.state).toBe("running");
      expect(await sbx.resume(h, sig())).toBe("resumed");
      await fake.expire(h.id);
      expect(await sbx.resume(h, sig())).toBe("gone");
      await sbx.suspend(h, sig());
      await sbx.destroy(h, sig());
    });

    it("destroyFileSystemByName kills every sandbox of the name across pages, legacy names too", async () => {
      const p = await startFakeE2B({ apiKey: fake.apiKey, pageSize: 1 });
      try {
        const s2 = make({}, p);
        const name = sbxName();
        const other = await s2.createFileSystem({
          name: sbxName(),
          limits: limits(),
          signal: sig(),
        });
        const a = await s2.createFileSystem({ name, limits: limits(), signal: sig() });
        // a running instance on it, plus a sandbox@1 sandbox under a cap-<conversationId> name
        await s2.create({ name, limits: limits(), fileSystem: a, signal: sig() });
        const legacyName = `cap-${randomUUID()}`;
        const legacy = await s2.createFileSystem({
          name: legacyName,
          limits: limits(),
          signal: sig(),
        });
        await s2.destroyFileSystemByName(name, sig());
        expect(p.sandboxes.has(a.id)).toBe(false);
        expect(p.sandboxes.has(other.id)).toBe(true);
        await s2.destroyFileSystemByName(name, sig()); // none left: success
        await s2.destroyFileSystemByName(legacyName, sig());
        expect(p.sandboxes.has(legacy.id)).toBe(false);
        expect(p.sandboxes.has(other.id)).toBe(true);
      } finally {
        await p.close();
      }
    });

    it("auth and server errors are plain errors (never gone) and never echo the API key", async () => {
      const h = await provision(sbx);
      fake.failNext({ path: /\/connect$/ }, 401, "Invalid API key");
      const e1 = await sbx.resume(h, sig()).catch((e: unknown) => e);
      expect(e1).toBeInstanceOf(Error);
      expect(isSandboxGoneError(e1)).toBe(false);
      expect(String((e1 as Error).message)).toMatch(/401/);
      fake.failNext({ path: /\/connect$/ }, 503, "busy");
      const e2 = await sbx
        .exec(h, {
          ...who(),
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
        .createFileSystem({ name: sbxName(), limits: limits(), signal: sig() })
        .catch((e: unknown) => e);
      expect(String((e3 as Error).message)).toMatch(/500/);
      for (const e of [e1, e2, e3]) expect(String((e as Error).message)).not.toContain(fake.apiKey);
      const bad = make({ apiKey: "e2b_wrong" });
      await expect(
        bad.createFileSystem({ name: sbxName(), limits: limits(), signal: sig() }),
      ).rejects.toThrow(/401/);
    });

    it("a bare 404 (not E2B's error shape) is a plain error, never gone", async () => {
      const h = await provision(sbx);
      fake.failNext({ path: /\/connect$/ }, 404, "404 page not found", { raw: true });
      await expect(sbx.resume(h, sig())).rejects.toThrow(/404/);
      fake.failNext({ path: /\/connect$/ }, 404, "Not Found", { raw: true });
      const e = await sbx.stat(h, "/workspace", sig()).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(Error);
      expect(isSandboxGoneError(e)).toBe(false);
      fake.failNext({ method: "DELETE", path: /^\/sandboxes\// }, 404, "nope", { raw: true });
      await expect(sbx.destroyFileSystem(h, sig())).rejects.toThrow(/404/);
      fake.failNext({ path: /\/pause$/ }, 404, "nope", { raw: true });
      await expect(sbx.suspend(h, sig())).rejects.toThrow(/404/);
      // only E2B's 404 shape means gone
      fake.failNext({ path: /\/connect$/ }, 404, "sandbox not found");
      expect(await sbx.resume(h, sig())).toBe("gone");
    });

    it("rejects an invalid sandbox domain returned by the API", async () => {
      const p = await startFakeE2B({ apiKey: fake.apiKey, domain: "evil.com/x?" });
      try {
        const s2 = make({}, p);
        const fileSystem = await s2.createFileSystem({
          name: sbxName(),
          limits: limits(),
          signal: sig(),
        });
        await expect(
          s2.create({ name: sbxName(), limits: limits(), fileSystem, signal: sig() }),
        ).rejects.toThrow(/invalid sandbox domain/);
      } finally {
        await p.close();
      }
    });

    it("every method rejects immediately when already aborted", async () => {
      const h = await provision(sbx);
      const ac = new AbortController();
      ac.abort(new Error("stop"));
      const s = ac.signal;
      const before = fake.calls.length;
      await expect(
        sbx.createFileSystem({ name: sbxName(), limits: limits(), signal: s }),
      ).rejects.toThrow("stop");
      await expect(
        sbx.create({ name: sbxName(), limits: limits(), fileSystem: h, signal: s }),
      ).rejects.toThrow("stop");
      await expect(sbx.destroyFileSystem(h, s)).rejects.toThrow("stop");
      await expect(sbx.destroyFileSystemByName("cap-x", s)).rejects.toThrow("stop");
      await expect(sbx.resume(h, s)).rejects.toThrow("stop");
      await expect(sbx.suspend(h, s)).rejects.toThrow("stop");
      await expect(sbx.destroy(h, s)).rejects.toThrow("stop");
      await expect(sbx.destroyByName("cap-x", s)).rejects.toThrow("stop");
      await expect(
        sbx.exec(h, { ...who(), command: "true", timeoutMs: 1000, maxOutputBytes: 10, signal: s }),
      ).rejects.toThrow("stop");
      await expect(sbx.readFile(h, "/workspace/a", { maxBytes: 10, signal: s })).rejects.toThrow(
        "stop",
      );
      await expect(sbx.writeFile(h, "/workspace/a", enc.encode("x"), s)).rejects.toThrow("stop");
      await expect(sbx.stat(h, "/workspace/a", s)).rejects.toThrow("stop");
      expect(fake.calls.length).toBe(before);
    });

    it("a hanging API request stops promptly on abort", async () => {
      const h = await provision(sbx);
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
        sbx.createFileSystem({ name: "../x", limits: limits(), signal: sig() }),
      ).rejects.toThrow(/invalid sandbox name/);
      await expect(
        sbx.create({ name: "../x", limits: limits(), fileSystem: { id: "i1" }, signal: sig() }),
      ).rejects.toThrow(/invalid sandbox name/);
      await expect(
        sbx.create({
          name: sbxName(),
          limits: limits(),
          fileSystem: { id: "bad/id?x" },
          signal: sig(),
        }),
      ).rejects.toThrow(/invalid E2B sandbox id/);
      await expect(
        sbx.createFileSystem({
          name: sbxName(),
          limits: limits({ kind: "allowlist", hosts: ["10.0.0.1"] }),
          signal: sig(),
        }),
      ).rejects.toThrow(/invalid network host/);
      await expect(
        sbx.createFileSystem({ name: sbxName(), limits: { ...limits(), cpu: 0 }, signal: sig() }),
      ).rejects.toThrow(/positive/);
    });
  });

  describe("template", () => {
    let p: FakeE2BServer;
    afterEach(async () => {
      await p?.close();
    });
    const builds = () => p.calls.filter((c) => c.method === "POST" && c.path === "/v3/templates");

    it("missing template is built from the image once", async () => {
      p = await startFakeE2B({ apiKey: fake.apiKey, templateBuildMs: 1200 });
      const s = make({ template: undefined }, p);
      const [a, b] = await Promise.all([
        s.createFileSystem({ name: sbxName(), limits: limits(), signal: sig() }),
        s.createFileSystem({ name: sbxName(), limits: limits(), signal: sig() }),
      ]);
      await s.createFileSystem({ name: sbxName(), limits: limits(), signal: sig() });
      const t = p.templates.get(ALIAS);
      expect(t?.image).toBe(IMAGE);
      expect(builds()).toHaveLength(1);
      expect(builds()[0]?.body).toMatchObject({ name: ALIAS });
      const trigger = p.calls.find(
        (c) => c.path === `/v2/templates/${t?.templateID}/builds/${t?.buildID}`,
      );
      expect(trigger?.body).toEqual({ fromImage: IMAGE, steps: [], force: false });
      // the build was polled until ready before any sandbox was created
      const status = p.calls.filter((c) => c.path.endsWith("/status"));
      expect(status.length).toBeGreaterThanOrEqual(2);
      expect(status.every((c) => c.query.logsOffset === "0")).toBe(true);
      const firstCreate = p.calls.findIndex(
        (c) => c.method === "POST" && c.path === "/v2/sandboxes",
      );
      expect(firstCreate).toBeGreaterThan(p.calls.indexOf(status.at(-1) as FakeE2BCall));
      expect(p.sandboxes.get(a.id)?.templateID).toBe(t?.templateID);
      expect(p.sandboxes.get(b.id)?.templateID).toBe(t?.templateID);
    });

    it("an existing alias is used without a build; a configured template skips the lookup", async () => {
      p = await startFakeE2B({ apiKey: fake.apiKey, templates: [ALIAS] });
      const s = make({ template: undefined }, p);
      const fs = await s.createFileSystem({ name: sbxName(), limits: limits(), signal: sig() });
      expect(builds()).toHaveLength(0);
      expect(p.sandboxes.get(fs.id)?.templateID).toBe(p.templates.get(ALIAS)?.templateID);
      const configured = make({ template: "my-template" }, p);
      const before = p.calls.length;
      const fs2 = await configured.createFileSystem({
        name: sbxName(),
        limits: limits(),
        signal: sig(),
      });
      expect(p.sandboxes.get(fs2.id)?.templateID).toBe("my-template");
      expect(p.calls.slice(before).some((c) => c.path.includes("/templates"))).toBe(false);
    });

    it("an alias that exists but is not ready is rebuilt and polled, never taken as ready", async () => {
      p = await startFakeE2B({ apiKey: fake.apiKey, templateBuildMs: 60_000 });
      // another replica requested a build that is still running: the alias exists already
      const other = make({ template: undefined }, p);
      const stuck = other.createFileSystem({
        name: sbxName(),
        limits: limits(),
        signal: AbortSignal.timeout(1500),
      });
      await waitFor(() => p.templates.has(ALIAS));
      await stuck.catch(() => undefined);
      const s = make({ template: undefined }, p);
      const done = s.createFileSystem({ name: sbxName(), limits: limits(), signal: sig() });
      await waitFor(() => builds().length === 2);
      // let the second build finish
      const t = p.templates.get(ALIAS);
      await waitFor(() => t?.readyAt !== undefined);
      if (t) t.readyAt = Date.now();
      const fs = await done;
      expect(p.sandboxes.get(fs.id)?.templateID).toBe(t?.templateID);
    });

    it("a failed build is an error pointing at the template setting, and is not memoised", async () => {
      p = await startFakeE2B({ apiKey: fake.apiKey });
      const s = make({ template: undefined }, p);
      p.failNext({ method: "POST", path: /^\/v2\/templates\// }, 400, "image not found");
      const e = await s
        .createFileSystem({ name: sbxName(), limits: limits(), signal: sig() })
        .catch((x: unknown) => x);
      expect(String((e as Error).message)).toMatch(/image not found/);
      expect(String((e as Error).message)).toMatch(/setting `template`/);
      await s.createFileSystem({ name: sbxName(), limits: limits(), signal: sig() });
      expect(builds()).toHaveLength(2);
    });

    it("a build whose status is error surfaces E2B's reason and is not memoised", async () => {
      p = await startFakeE2B({ apiKey: fake.apiKey });
      let failStatus = true;
      const proxy = await proxyOf(p, (method, path) => {
        if (!(failStatus && method === "GET" && path.endsWith("/status"))) return undefined;
        failStatus = false;
        return {
          status: 200,
          body: { status: "error", logEntries: [], reason: { message: "pull access denied" } },
        };
      });
      try {
        const s = createE2BSandbox(
          { ...cfg, apiUrl: proxy.url, template: undefined },
          { log: console },
          { envdUrl: p.url },
        );
        const e = await s
          .createFileSystem({ name: sbxName(), limits: limits(), signal: sig() })
          .catch((x: unknown) => x);
        expect(String((e as Error).message)).toMatch(/error: pull access denied/);
        expect(String((e as Error).message)).toMatch(/setting `template`/);
        expect(p.sandboxes.size).toBe(0);
        // not memoised: the next use provisions again (the alias lookup runs a second time)
        const lookups = () => p.calls.filter((c) => c.path === `/templates/aliases/${ALIAS}`);
        expect(lookups()).toHaveLength(1);
        await s.createFileSystem({ name: sbxName(), limits: limits(), signal: sig() });
        expect(lookups()).toHaveLength(2);
        expect(p.sandboxes.size).toBe(1);
      } finally {
        await proxy.close();
      }
    });

    it("a public template under the alias is refused, never used", async () => {
      p = await startFakeE2B({ apiKey: fake.apiKey });
      const proxy = await proxyOf(p, (method, path) =>
        method === "GET" && path === `/templates/aliases/${ALIAS}`
          ? { status: 200, body: { templateID: "tsquatter", public: true } }
          : undefined,
      );
      try {
        const s = createE2BSandbox(
          { ...cfg, apiUrl: proxy.url, template: undefined },
          { log: console },
          { envdUrl: p.url },
        );
        await expect(
          s.createFileSystem({ name: sbxName(), limits: limits(), signal: sig() }),
        ).rejects.toThrow(
          `E2B template alias ${ALIAS} is owned by another E2B team or is public; set the sandbox-e2b setting \`template\``,
        );
        expect(p.sandboxes.size).toBe(0);
        expect(builds()).toHaveLength(0);
      } finally {
        await proxy.close();
      }
    });

    it("an alias of another team (403) and a build refused with 403 map to the same error", async () => {
      p = await startFakeE2B({ apiKey: fake.apiKey });
      const s = make({ template: undefined }, p);
      p.failNext({ method: "GET", path: /^\/templates\/aliases\// }, 403, "forbidden");
      await expect(
        s.createFileSystem({ name: sbxName(), limits: limits(), signal: sig() }),
      ).rejects.toThrow(/owned by another E2B team or is public/);
      p.failNext({ method: "POST", path: /^\/v3\/templates$/ }, 403, "forbidden");
      await expect(
        s.createFileSystem({ name: sbxName(), limits: limits(), signal: sig() }),
      ).rejects.toThrow(/owned by another E2B team or is public/);
      expect(p.sandboxes.size).toBe(0);
    });

    it("a build in flight stops with the extension's lifetime signal", async () => {
      p = await startFakeE2B({ apiKey: fake.apiKey, templateBuildMs: 60_000 });
      const life = new AbortController();
      const s = createE2BSandbox(
        { ...cfg, apiUrl: p.url, template: undefined },
        { log: console, signal: life.signal },
        { envdUrl: p.url },
      );
      const started = s
        .createFileSystem({ name: sbxName(), limits: limits(), signal: sig() })
        .catch((x: unknown) => x);
      await waitFor(() => p.calls.some((c) => c.path.endsWith("/status")));
      life.abort(new Error("extension revoked"));
      expect(String(await started)).toMatch(/extension revoked/);
      const polls = p.calls.filter((c) => c.path.endsWith("/status")).length;
      await new Promise((r) => setTimeout(r, 1500));
      expect(p.calls.filter((c) => c.path.endsWith("/status")).length).toBe(polls);
    });
  });

  describe("network policy (set when the file system is created)", () => {
    beforeAll(() => {
      sbx = make();
    });
    const fsWith = (s: SandboxProvider, l: SandboxLimits) =>
      s.createFileSystem({ name: sbxName(), limits: l, signal: sig() });

    it("an empty allowlist means no network", async () => {
      const fs = await fsWith(sbx, limits());
      expect(fake.sandboxes.get(fs.id)?.allowInternetAccess).toBe(false);
      expect(createdBody().network).toBeUndefined();
    });

    it("an allowlist allows exactly its hosts (allowOut, IPv4 and IPv6 private / loopback denied)", async () => {
      const hosts = ["registry.npmjs.org", "*.githubusercontent.com"];
      const fs = await fsWith(sbx, limits({ kind: "allowlist", hosts }));
      expect(fake.sandboxes.get(fs.id)?.network).toEqual({
        allowOut: hosts,
        denyOut: ["0.0.0.0/0", "fc00::/7", "fe80::/10", "::1/128"],
      });
      expect(createdBody().allow_internet_access).toBeUndefined();
    });

    it("open-public is refused before any E2B call (fail closed, never silently open)", async () => {
      const before = fake.calls.length;
      await expect(fsWith(sbx, limits({ kind: "open-public", hosts: [] }))).rejects.toThrow(
        /open-public.*refused.*metadata endpoint/s,
      );
      expect(fake.calls.length).toBe(before);
    });

    it("an older kernel's limits (tier / egress / allowHosts, no mode or network) are refused", async () => {
      const before = fake.calls.length;
      const old = {
        cpu: 1,
        memoryMb: 2048,
        diskMb: 5120,
        egress: "none",
        allowHosts: [],
        tier: "strict",
        devHosts: [],
      } as unknown as SandboxLimits;
      await expect(fsWith(sbx, old)).rejects.toThrow(/no mode/);
      const oldOpen = {
        ...limits(),
        mode: undefined,
        network: { kind: "open", hosts: ["pypi.org"] },
      } as unknown as SandboxLimits;
      await expect(fsWith(sbx, oldOpen)).rejects.toThrow(/no mode/);
      const badKind = {
        ...limits(),
        network: { kind: "open", hosts: ["pypi.org"] },
      } as unknown as SandboxLimits;
      await expect(fsWith(sbx, badKind)).rejects.toThrow(/no valid network/);
      expect(fake.calls.length).toBe(before);
    });

    it("validates the allowlist hosts", async () => {
      await expect(fsWith(sbx, limits({ kind: "allowlist", hosts: ["10.0.0.1"] }))).rejects.toThrow(
        /invalid network host/,
      );
      await expect(
        fsWith(sbx, limits({ kind: "allowlist", hosts: ["not a host"] })),
      ).rejects.toThrow(/invalid network host/);
    });

    it("one template for every network policy", async () => {
      const allowed = await fsWith(sbx, limits({ kind: "allowlist", hosts: ["pypi.org"] }));
      const none = await fsWith(sbx, limits());
      expect(fake.sandboxes.get(allowed.id)?.templateID).toBe(
        fake.sandboxes.get(none.id)?.templateID,
      );
    });

    it("without domain allowlist support, an allowlist degrades to none with a warning", async () => {
      const fs = await fsWith(
        make({ domainAllowlist: false }),
        limits({ kind: "allowlist", hosts: ["pypi.org"] }),
      );
      expect(fake.sandboxes.get(fs.id)?.allowInternetAccess).toBe(false);
      expect(createdBody().network).toBeUndefined();
      expect(warns.join("\n")).toMatch(/allowlist/);
    });
  });

  describe("update (network of a running sandbox)", () => {
    /** Network update bodies the stub accepted, by sandbox id. */
    const updates = new Map<string, unknown[]>();
    /** Sandbox ids whose next network update answers E2B's 404 although connect succeeded. */
    const vanishOnUpdate = new Set<string>();
    /** Sandbox ids whose next network update answers this status (E2B's error format). */
    const failUpdate = new Map<string, number>();
    let proxy: Awaited<ReturnType<typeof proxyOf>>;
    let s: ReturnType<typeof make>;
    beforeAll(async () => {
      // the fake E2B has no network route: play E2B's answer here (204 when running, E2B's
      // 404 when paused or missing, as verified on E2B 2026-11-08)
      proxy = await proxyOf(fake, (method, path, body) => {
        const m = /^\/sandboxes\/([^/]+)\/network$/.exec(path);
        if (method !== "PUT" || !m?.[1]) return undefined;
        const id = decodeURIComponent(m[1]);
        if (fake.sandboxes.get(id)?.state !== "running" || vanishOnUpdate.delete(id)) {
          return { status: 404, body: { code: 404, message: `sandbox ${id} not found` } };
        }
        const status = failUpdate.get(id);
        if (status !== undefined) {
          failUpdate.delete(id);
          return { status, body: { code: status, message: "update failed" } };
        }
        updates.set(id, [...(updates.get(id) ?? []), JSON.parse(body.toString("utf8"))]);
        return { status: 204, body: undefined };
      });
      s = make({ apiUrl: proxy.url });
    });
    afterAll(async () => {
      await proxy?.close();
    });

    it('declares limitsApplyAt "fileSystem"', () => {
      expect(s.limitsApplyAt).toBe("fileSystem");
    });

    it("resumes a suspended sandbox first, then replaces its network", async () => {
      const h = await provision(s, limits());
      await s.suspend(h, sig());
      expect(fake.sandboxes.get(h.id)?.state).toBe("paused");
      // the stub answers 404 for a paused sandbox, so "updated" means it was resumed first
      expect(await s.update?.(h, limits({ kind: "allowlist", hosts: ["pypi.org"] }), sig())).toBe(
        "updated",
      );
      expect(fake.sandboxes.get(h.id)?.state).toBe("running");
      expect(
        await s.update?.(
          h,
          limits({ kind: "allowlist", hosts: ["registry.npmjs.org", "*.githubusercontent.com"] }),
          sig(),
        ),
      ).toBe("updated");
      expect(await s.update?.(h, limits(), sig())).toBe("updated");
      expect(await s.update?.(h, limits({ kind: "allowlist", hosts: [] }), sig())).toBe("updated");
      expect(updates.get(h.id)).toEqual([
        { allowOut: ["pypi.org"], denyOut: ["0.0.0.0/0", "fc00::/7", "fe80::/10", "::1/128"] },
        {
          allowOut: ["registry.npmjs.org", "*.githubusercontent.com"],
          denyOut: ["0.0.0.0/0", "fc00::/7", "fe80::/10", "::1/128"],
        },
        { allow_internet_access: false },
        { allow_internet_access: false },
      ]);
    });

    it("refuses open-public without touching the sandbox", async () => {
      const h = await provision(s, limits());
      const connects = () =>
        fake.calls.filter((c) => c.path === `/v2/sandboxes/${h.id}/connect`).length;
      const seen = connects();
      await expect(
        s.update?.(h, limits({ kind: "open-public", hosts: [] }), sig()),
      ).rejects.toThrow(/open-public.*refused.*metadata endpoint/s);
      expect(connects()).toBe(seen);
      expect(updates.get(h.id)).toBeUndefined();
    });

    it("refuses an older kernel's limits without touching the sandbox", async () => {
      const h = await provision(s, limits());
      const connects = () =>
        fake.calls.filter((c) => c.path === `/v2/sandboxes/${h.id}/connect`).length;
      const seen = connects();
      const old = {
        cpu: 1,
        memoryMb: 2048,
        diskMb: 5120,
        egress: "open",
        allowHosts: [],
        tier: "open",
        devHosts: [],
      } as unknown as SandboxLimits;
      await expect(s.update?.(h, old, sig())).rejects.toThrow(/no mode/);
      expect(connects()).toBe(seen);
      expect(updates.get(h.id)).toBeUndefined();
    });

    it("refuses an unknown network kind without touching the sandbox", async () => {
      const h = await provision(s, limits());
      const connects = () =>
        fake.calls.filter((c) => c.path === `/v2/sandboxes/${h.id}/connect`).length;
      const seen = connects();
      const badKind = {
        ...limits(),
        network: { kind: "open", hosts: ["pypi.org"] },
      } as unknown as SandboxLimits;
      await expect(s.update?.(h, badKind, sig())).rejects.toThrow(/no valid network/);
      expect(connects()).toBe(seen);
      expect(updates.get(h.id)).toBeUndefined();
    });

    it("without domain allowlist support, an allowlist update degrades to none", async () => {
      const noDomains = make({ apiUrl: proxy.url, domainAllowlist: false });
      const h = await provision(noDomains, limits());
      expect(
        await noDomains.update?.(h, limits({ kind: "allowlist", hosts: ["pypi.org"] }), sig()),
      ).toBe("updated");
      expect(updates.get(h.id)).toEqual([{ allow_internet_access: false }]);
      expect(warns.join("\n")).toMatch(/allowlist/);
    });

    it("a sandbox that is gone → SandboxGoneError (at connect or at the network update)", async () => {
      const a = await provision(s, limits());
      await fake.expire(a.id);
      const e1 = await s.update?.(a, limits(), sig()).catch((x: unknown) => x);
      expect(isSandboxGoneError(e1)).toBe(true);
      const b = await provision(s, limits());
      vanishOnUpdate.add(b.id);
      const e2 = await s.update?.(b, limits(), sig()).catch((x: unknown) => x);
      expect(isSandboxGoneError(e2)).toBe(true);
    });

    it("other failures stay ordinary errors (at connect, and 401 / 5xx on the update)", async () => {
      const h = await provision(s, limits());
      fake.failNext({ method: "POST", path: /\/connect$/ }, 500, "boom");
      const e = await s.update?.(h, limits(), sig()).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(Error);
      expect(isSandboxGoneError(e)).toBe(false);
      for (const status of [401, 500, 503]) {
        failUpdate.set(h.id, status);
        const u = await s.update?.(h, limits(), sig()).catch((x: unknown) => x);
        expect(u).toBeInstanceOf(Error);
        expect(String((u as Error).message)).toMatch(new RegExp(`HTTP ${status}`));
        expect(isSandboxGoneError(u)).toBe(false);
      }
      expect(updates.get(h.id)).toBeUndefined();
    });

    it("abort: an aborted call rejects at once; an abort during resume rejects with its reason", async () => {
      const h = await provision(s, limits());
      await s.suspend(h, sig());
      const before = AbortSignal.abort(new Error("stop early"));
      await expect(s.update?.(h, limits(), before)).rejects.toThrow(/stop early/);
      const connects = () =>
        fake.calls.filter((c) => c.path === `/v2/sandboxes/${h.id}/connect`).length;
      const seen = connects();
      fake.hangNext({ method: "POST", path: /\/connect$/ });
      const ac = new AbortController();
      const p = s.update?.(h, limits(), ac.signal);
      // the hanging connect reached the fake (so the hang is used up, not left for later tests)
      await waitFor(() => connects() > seen);
      ac.abort(new Error("stop now"));
      await expect(p).rejects.toThrow(/stop now/);
      expect(updates.get(h.id)).toBeUndefined();
    });
  });

  describe("exec", () => {
    let h: { id: string };
    beforeAll(async () => {
      sbx = make();
      h = await provision(sbx);
    });

    const run = (command: string, over: Partial<Parameters<SandboxProvider["exec"]>[1]> = {}) =>
      sbx.exec(h, {
        ...who(),
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
      // A child that left the session (the kill script's session kill misses it) and cleared its
      // environment (the marker scan misses it too) holds stdout. The fake maps the sandbox path in
      // the command to the host, so the command names the sandbox path.
      const escaped = `perl -MPOSIX -e 'POSIX::setsid(); %ENV = (); open(my $f, ">", $ARGV[0]); print $f $$; close $f; exec "/bin/sleep", "20"' /tmp/escaped.pid &`;
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

    // Real envd ends the stream when the command exits, so a child that left the session with its
    // output closed is invisible to the stream check: the kill script finds it by the exec marker
    // in its environment. Needs /proc (Linux: CI and real sandboxes).
    it.skipIf(!existsSync("/proc/self/environ"))(
      "a child that left the session with its output closed is killed by its environment marker",
      async () => {
        const r0 = fake.reboots.get(h.id) ?? 0;
        const pidFile = fake.hostPath(h.id, "/tmp/escaped-quiet.pid");
        const escaped = `perl -MPOSIX -e 'POSIX::setsid(); open(STDOUT, ">", "/dev/null"); open(STDERR, ">", "/dev/null"); open(my $f, ">", $ARGV[0]); print $f $$; close $f; exec "sleep", "20"' /tmp/escaped-quiet.pid &`;
        let pid = 0;
        try {
          const r = await run(`${escaped} sleep 20`, { timeoutMs: 1500 });
          expect(r.timedOut).toBe(true);
          pid = Number(readFileSync(pidFile, "utf8"));
          expect(alive(pid)).toBe(false);
          expect(fake.reboots.get(h.id) ?? 0).toBe(r0);
        } finally {
          if (pid && alive(pid)) process.kill(pid, "SIGKILL");
        }
      },
      15_000,
    );

    it("a command killed by a signal it did not get from us reports 128 + signal", async () => {
      const r = await run("echo x; kill -9 $PPID; sleep 1");
      expect(r).toMatchObject({ exitCode: 137, timedOut: false });
    });

    it("gone sandbox → SandboxGoneError; envd 502 on a live sandbox is a plain error", async () => {
      const g = await provision(sbx);
      fake.failNext({ path: /^\/process\.Process\/Start$/ }, 502, "upstream error");
      const e = await sbx
        .exec(g, { ...who(), command: "true", timeoutMs: 1000, maxOutputBytes: 10, signal: sig() })
        .catch((x: unknown) => x);
      expect(e).toBeInstanceOf(Error);
      expect(isSandboxGoneError(e)).toBe(false);
      await fake.expire(g.id);
      const e2 = await sbx
        .exec(g, { ...who(), command: "true", timeoutMs: 1000, maxOutputBytes: 10, signal: sig() })
        .catch((x: unknown) => x);
      expect(isSandboxGoneError(e2)).toBe(true);
    });
  });

  describe("envd access token (fix wave S2 minor 1)", () => {
    beforeAll(() => {
      sbx = make();
    });
    afterEach(() => {
      fake.withholdAccessToken = false;
    });

    it("create asks for a secured envd; without an access token nothing is sent to envd", async () => {
      const h = await provision(sbx);
      expect(createdBody().secure).toBe(true);
      fake.withholdAccessToken = true;
      const before = fake.calls.filter((c) => c.sandboxId !== undefined).length;
      // 当作「已不在」（SandboxGoneError）：内核据此重建带令牌的沙箱（加 secure 之前建的沙箱永远没有令牌）
      const call = async (p: Promise<unknown>) => {
        const e = await p.then(
          () => null,
          (x: unknown) => x,
        );
        expect(String(e)).toMatch(/no envd access token/);
        expect(isSandboxGoneError(e)).toBe(true);
      };
      await call(
        sbx.exec(h, {
          ...who(),
          command: "true",
          timeoutMs: 1000,
          maxOutputBytes: 10,
          signal: sig(),
        }),
      );
      await call(sbx.readFile(h, "/workspace/a", { maxBytes: 1, signal: sig() }));
      await call(sbx.writeFile(h, "/workspace/a", enc.encode("x"), sig()));
      await call(sbx.stat(h, "/workspace/a", sig()));
      expect(await sbx.resume(h, sig())).toBe("gone");
      expect(fake.calls.filter((c) => c.sandboxId !== undefined).length).toBe(before);
    });
  });

  describe("commands left behind by a crashed kernel replica (fix wave S2 I2)", () => {
    let h: { id: string };
    beforeAll(async () => {
      sbx = make();
      h = await provision(sbx);
    });

    /** 经 envd 以 exec 的命令行启动一条命令，收到 start 事件就断开（模拟发起它的内核副本崩溃）。 */
    const orphan = async (command: string, timeoutMs: number): Promise<void> => {
      const s = fake.sandboxes.get(h.id);
      if (!s) throw new Error("no sandbox");
      const conn = new AbortController();
      const t = { url: fake.url, sandboxId: h.id, accessToken: s.envdAccessToken };
      const ctl = `/tmp/.capybara-exec-${randomUUID()}`;
      await envdStart(
        t,
        "sandbox",
        { cmd: "setsid", args: execArgs(ctl, command, timeoutMs), cwd: "/workspace" },
        (e) => {
          if ("start" in e) conn.abort();
        },
        conn.signal,
      ).catch(() => undefined);
    };

    it("the command is killed inside the sandbox at its deadline even with nobody watching", async () => {
      const started = Date.now();
      await orphan("sleep 31 & sleep 32; echo never > /workspace/never", 1000);
      await waitFor(() => fake.running(h.id).length === 1);
      const pids = fake.running(h.id).map((p) => p.pid);
      await waitFor(
        () => fake.running(h.id).length === 0 && pids.every((p) => !fake.alive(p)),
        15_000,
      );
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(1000);
      expect(elapsed).toBeLessThan((1 + IN_SANDBOX_GRACE_SECONDS + 5) * 1000);
      expect(await sbx.stat(h, "/workspace/never", sig())).toBeNull();
    });

    it("killAll stops every leftover exec command (also after pause), gone → SandboxGoneError", async () => {
      await orphan("sleep 41 & sleep 42", 600_000);
      await orphan("sleep 43", 600_000);
      await waitFor(() => fake.running(h.id).length === 2);
      const pids = fake.running(h.id).map((p) => p.pid);
      await sbx.killAll?.(h, sig());
      await waitFor(() => pids.every((pid) => !fake.alive(pid)));
      // 进程的输出管道全部关闭（孙进程也都结束）才会从 running 里消失
      await waitFor(() => fake.running(h.id).length === 0);
      const kill = fake.calls.filter((c) => c.path === "/process.Process/Start").at(-1);
      expect(kill?.user).toBe("sandbox");
      expect(argsOf(kill as FakeE2BCall)).toContain("capybara-killall");

      // a paused sandbox: killAll connects (resumes) it first; pausing without memory already
      // ended the command
      await orphan("sleep 44", 600_000);
      await waitFor(() => fake.running(h.id).length === 1);
      const pid = fake.running(h.id)[0]?.pid as number;
      await sbx.suspend(h, sig());
      await sbx.killAll?.(h, sig());
      await waitFor(() => !fake.alive(pid) && fake.running(h.id).length === 0);
      expect(fake.sandboxes.get(h.id)?.state).toBe("running");
      // 沙箱照常可用
      expect(
        (
          await sbx.exec(h, {
            ...who(),
            command: "echo ok",
            timeoutMs: 5000,
            maxOutputBytes: 100,
            signal: sig(),
          })
        ).stdout,
      ).toBe("ok\n");

      await fake.expire(h.id);
      await expect(sbx.killAll?.(h, sig())).rejects.toSatisfy(isSandboxGoneError);
    });
  });

  describe("concurrent exec (sub-agents spec §10.6, §10.7)", () => {
    let h: { id: string };
    beforeAll(async () => {
      sbx = make();
      h = await provision(sbx);
    });
    const run = (
      command: string,
      o: { tag?: string; timeoutMs?: number; signal?: AbortSignal } = {},
    ) =>
      sbx.exec(h, {
        command,
        timeoutMs: o.timeoutMs ?? 15_000,
        maxOutputBytes: 1000,
        signal: o.signal ?? sig(),
        tag: o.tag ?? randomUUID(),
        actor: ACTOR,
      });

    it("declares concurrent exec with killTagged; the control file carries the tag", async () => {
      expect(sbx.concurrentExec).toBe(true);
      expect(typeof sbx.killTagged).toBe("function");
      const tag = randomUUID();
      await run("true", { tag });
      const start = fake.calls.filter((c) => c.path === "/process.Process/Start").at(-1);
      expect(argsOf(start as FakeE2BCall)).toContain(`/tmp/.capybara-exec-${tag}-`);
    });

    it("two sleep 2; date commands overlap", async () => {
      const t0 = Date.now();
      const [a, b] = await Promise.all([
        run("sleep 2; date +%s", { tag: randomUUID() }),
        run("sleep 2; date +%s", { tag: randomUUID() }),
      ]);
      expect(a.exitCode).toBe(0);
      expect(b.exitCode).toBe(0);
      expect(Math.abs(Number(a.stdout) - Number(b.stdout))).toBeLessThanOrEqual(1);
      expect(Date.now() - t0).toBeLessThan(3900);
    });

    it("killTagged kills one tag's process tree and leaves the other running", async () => {
      const [ta, tb] = [randomUUID(), randomUUID()];
      const bStop = new AbortController();
      const a = run("sleep 51 & sleep 52", { tag: ta });
      const b = run("sleep 53; echo never", { tag: tb, signal: bStop.signal });
      await waitFor(() => fake.running(h.id).length === 2);
      const before = fake.running(h.id).map((p) => p.pid);
      await sbx.killTagged?.(h, [ta], sig());
      const ra = await a;
      expect(ra.exitCode).not.toBe(0);
      await waitFor(() => fake.running(h.id).length === 1);
      expect(before.filter((p) => fake.alive(p))).toHaveLength(1);
      const kill = fake.calls.filter((c) => c.path === "/process.Process/Start").at(-1);
      expect(kill?.user).toBe("sandbox");
      expect(argsOf(kill as FakeE2BCall)).toContain("capybara-killtagged");
      bStop.abort();
      expect(await b).toMatchObject({ exitCode: null, timedOut: false });
    });

    it("killTagged matches whole tags: a tag that is a prefix of another kills only its own", async () => {
      const stop = new AbortController();
      const short = run("sleep 61", { tag: "deadbeef" });
      const long = run("sleep 62", { tag: "deadbeef-1", signal: stop.signal });
      await waitFor(() => fake.running(h.id).length === 2);
      await sbx.killTagged?.(h, ["deadbeef"], sig());
      expect((await short).exitCode).not.toBe(0);
      await waitFor(() => fake.running(h.id).length === 1);
      stop.abort();
      expect(await long).toMatchObject({ exitCode: null, timedOut: false });
    });

    it("a timed-out command kills only itself", async () => {
      const [a, b] = await Promise.all([
        run("sleep 30", { tag: randomUUID(), timeoutMs: 1000 }),
        run("sleep 3; echo b", { tag: randomUUID() }),
      ]);
      expect(a).toMatchObject({ timedOut: true, exitCode: null });
      expect(b).toMatchObject({ exitCode: 0, stdout: "b\n" });
    });

    it("concurrent auto-start of a paused sandbox succeeds for every call", async () => {
      await sbx.suspend(h, sig());
      expect(fake.sandboxes.get(h.id)?.state).toBe("paused");
      const [a, b, st] = await Promise.all([
        run("echo a", { tag: randomUUID() }),
        run("echo b", { tag: randomUUID() }),
        sbx.stat(h, "/workspace", sig()),
      ]);
      expect(a).toMatchObject({ exitCode: 0, stdout: "a\n" });
      expect(b).toMatchObject({ exitCode: 0, stdout: "b\n" });
      expect(st).toMatchObject({ isDir: true });
      expect(fake.sandboxes.get(h.id)?.state).toBe("running");
    });

    it("a connect answered 409 (a concurrent resume in flight) is retried", async () => {
      fake.failNext({ path: /\/connect$/ }, 409, "sandbox is resuming");
      expect((await run("echo ok")).stdout).toBe("ok\n");
    });

    it("killTagged and exec reject a tag outside SANDBOX_TAG_RE", async () => {
      await expect(sbx.killTagged?.(h, ["bad tag; rm -rf /"], sig())).rejects.toThrow(/tag/);
      await expect(run("true", { tag: "UPPER" })).rejects.toThrow(/tag/);
    });
  });

  describe("files", () => {
    let h: { id: string };
    beforeAll(async () => {
      sbx = make();
      h = await provision(sbx);
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
      const g = await provision(sbx);
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
