import { randomUUID } from "node:crypto";
import type { SandboxHandle, SandboxLimits, SandboxProvider } from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDockerSandbox } from "../src/index.js";
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
 * Concurrent use of one Docker sandbox (sub-agents spec §10.6, §10.7): tagged exec commands run
 * side by side, `killTagged` kills only one holder's commands, a timeout kills only its own
 * command, and concurrent auto-start of a stopped container succeeds for every call. Real Docker
 * through the socket proxy; skipped without Docker.
 */

const RUN = randomUUID().slice(0, 8);
const sig = () => AbortSignal.timeout(120_000);
const limits = (egress: SandboxLimits["egress"], allowHosts: string[] = []): SandboxLimits => ({
  cpu: 1,
  memoryMb: 512,
  diskMb: 1024,
  egress,
  allowHosts,
});

describe.skipIf(!dockerAvailable)("sandbox-docker concurrent exec", { timeout: 120_000 }, () => {
  let images: TestImages;
  let proxy: SocketProxy;
  const netName = `capybara-sandbox-test-${RUN}`;
  let sbx: SandboxProvider;

  beforeAll(async () => {
    [images, proxy] = await Promise.all([
      buildTestImages(),
      startSocketProxy(),
      docker("network", "create", "--label", `${TEST_LABEL}=${RUN}`, netName),
    ]);
    sbx = createDockerSandbox(
      {
        endpoint: proxy.endpoint,
        runtime: "runc",
        network: netName,
        egressProxyImage: images.egressImage,
      },
      { labels: { [TEST_LABEL]: RUN } },
    );
  }, 600_000);

  afterAll(async () => {
    await cleanupTestResources(RUN);
    await proxy?.stop();
    await images?.remove();
  }, 120_000);

  const create = (egress: SandboxLimits["egress"] = "none", hosts: string[] = []) =>
    sbx.create({
      name: `cap-${randomUUID()}`,
      image: images.sandboxImage,
      limits: limits(egress, hosts),
      signal: sig(),
    });
  const exec = (
    h: SandboxHandle,
    command: string,
    o: { tag?: string; timeoutMs?: number; signal?: AbortSignal } = {},
  ) =>
    sbx.exec(h, {
      command,
      timeoutMs: o.timeoutMs ?? 60_000,
      maxOutputBytes: 10_000,
      signal: o.signal ?? sig(),
      ...(o.tag === undefined ? {} : { tag: o.tag }),
    });
  const count = async (h: SandboxHandle, pattern: string) =>
    Number((await exec(h, `pgrep -fc -- ${JSON.stringify(pattern)} || true`)).stdout.trim());
  const waitUntil = async (cond: () => Promise<boolean>, ms: number) => {
    const end = Date.now() + ms;
    while (!(await cond())) {
      if (Date.now() > end) throw new Error("condition not met in time");
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  it("declares concurrent exec with killTagged", () => {
    expect(sbx.concurrentExec).toBe(true);
    expect(typeof sbx.killTagged).toBe("function");
  });

  it("two sleep 2; date +%s%N commands overlap", async () => {
    const h = await create();
    try {
      const t0 = Date.now();
      const [a, b] = await Promise.all([
        exec(h, "sleep 2; date +%s%N", { tag: randomUUID() }),
        exec(h, "sleep 2; date +%s%N", { tag: randomUUID() }),
      ]);
      expect(a.exitCode).toBe(0);
      expect(b.exitCode).toBe(0);
      const [ea, eb] = [BigInt(a.stdout.trim()), BigInt(b.stdout.trim())];
      const gap = ea > eb ? ea - eb : eb - ea;
      expect(gap < 1_000_000_000n).toBe(true);
      expect(Date.now() - t0).toBeLessThan(4000 + 2000);
    } finally {
      await sbx.destroy(h, sig());
    }
  });

  it("killTagged kills one tag's process tree and leaves the other running", async () => {
    const h = await create();
    try {
      const [ta, tb] = [randomUUID(), randomUUID()];
      const bStop = new AbortController();
      const a = exec(h, "sleep 301 & sleep 302", { tag: ta });
      const b = exec(h, "sleep 303; echo never", {
        tag: tb,
        timeoutMs: 110_000,
        signal: bStop.signal,
      });
      await waitUntil(async () => (await count(h, "^sleep 30[123]")) === 3, 15_000);
      await sbx.killTagged?.(h, [ta], sig());
      const ra = await a;
      expect(ra.exitCode).not.toBe(0);
      expect(await count(h, "^sleep 30[12]")).toBe(0);
      expect(await count(h, "^sleep 303")).toBe(1);
      bStop.abort();
      expect(await b).toMatchObject({ exitCode: null, timedOut: false });
    } finally {
      await sbx.destroy(h, sig());
    }
  });

  it("a timed-out command kills only itself", async () => {
    const h = await create();
    try {
      const [a, b] = await Promise.all([
        exec(h, "sleep 30", { tag: randomUUID(), timeoutMs: 1500 }),
        exec(h, "sleep 4; echo b", { tag: randomUUID() }),
      ]);
      expect(a).toMatchObject({ timedOut: true, exitCode: null });
      expect(b).toMatchObject({ exitCode: 0, stdout: "b\n" });
    } finally {
      await sbx.destroy(h, sig());
    }
  });

  it("concurrent auto-start of a stopped container succeeds for both calls", async () => {
    const h = await create("allowlist", ["example.com"]);
    try {
      await docker("stop", "-t", "1", h.id, `${h.id}-egress`);
      const [a, b, s] = await Promise.all([
        exec(h, "echo a", { tag: randomUUID() }),
        exec(h, "echo b", { tag: randomUUID() }),
        sbx.stat(h, "/workspace", sig()),
      ]);
      expect(a).toMatchObject({ exitCode: 0, stdout: "a\n" });
      expect(b).toMatchObject({ exitCode: 0, stdout: "b\n" });
      expect(s).toEqual(expect.objectContaining({ isDir: true }));
    } finally {
      await sbx.destroy(h, sig());
    }
  });

  it("killTagged rejects a tag outside SANDBOX_TAG_RE", async () => {
    const h = { id: "cap-not-created" };
    await expect(sbx.killTagged?.(h, ["bad tag; rm -rf /"], sig())).rejects.toThrow(/tag/);
    await expect(
      sbx.exec(h, {
        command: "true",
        timeoutMs: 1000,
        maxOutputBytes: 10,
        signal: sig(),
        tag: "UPPER",
      }),
    ).rejects.toThrow(/tag/);
  });
});
