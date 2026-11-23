import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { DeviceProvider, SandboxHandle, SandboxLimits } from "@capybara-hq/plugin-sdk";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDockerSandbox,
  type DockerSandboxConfig,
  type DockerSandboxProvider,
} from "../src/index.js";
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
 * In-place allowlist changes on real Docker (core design 2026-11-23 docker in-place network
 * update, section 4): the egress proxy takes a wider or narrower list through its control socket,
 * the sandbox container and the connections the new list still covers stay, connections to removed
 * hosts close (also one still connecting), suspend / resume and a lost proxy keep the list in force
 * (rebuilt from the config volume, never from the wider create-time labels; without the volume the
 * instance is gone and recreated), `destroy` removes the volume, and a control failure throws.
 */

const RUN = randomUUID().slice(0, 8);
const sig = () => AbortSignal.timeout(120_000);
const sbxName = () => `cap-${randomUUID()}`;
const allow = (hosts: string[]): SandboxLimits["network"] => ({ kind: "allowlist", hosts });
const limits = (network: SandboxLimits["network"]): SandboxLimits => ({
  cpu: 1,
  memoryMb: 512,
  diskMb: 1024,
  network,
});
/** Pinned test names (the proxy pins them to the targets and exempts them from the address checks). */
const A = "a.example.com";
const B = "b.example.com";
const SLOW = "slow.example.com";

describe.skipIf(!dockerAvailable)(
  "device-docker in-place network update",
  { timeout: 180_000 },
  () => {
    let images: TestImages;
    let proxy: SocketProxy;
    const netName = `capybara-sandbox-test-${RUN}`;
    let target: StartedTestContainer;
    let blackhole: StartedTestContainer;
    let cfg: DockerSandboxConfig;
    let sbx: DockerSandboxProvider;

    beforeAll(async () => {
      [images, proxy] = await Promise.all([
        buildTestImages(),
        startSocketProxy(),
        docker("network", "create", "--label", `${TEST_LABEL}=${RUN}`, netName),
      ]);
      // a line echo server on 7000 (long-lived connections) and HTTP on 80
      target = await new GenericContainer(images.egressImage)
        .withNetworkMode(netName)
        .withUser("root")
        .withCommand([
          "node",
          "-e",
          [
            "const net=require('net');",
            "net.createServer(s=>{s.on('error',()=>{});s.pipe(s)}).listen(7000);",
            "require('http').createServer((q,s)=>s.end('hello-egress')).listen(80,()=>console.log('ready'))",
          ].join(""),
        ])
        .withWaitStrategy(Wait.forLogMessage("ready"))
        .start();
      // a listener whose accept queue is full: a new connection to it hangs in connect (SYNs dropped)
      blackhole = await new GenericContainer(images.sandboxImage)
        .withNetworkMode(netName)
        .withUser("root")
        .withCommand([
          "python3",
          "-c",
          [
            "import socket,time",
            "s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)",
            "s.bind(('0.0.0.0',81)); s.listen(0)",
            "fill=[socket.socket() for _ in range(8)]",
            "[(c.setblocking(False), c.connect_ex(('127.0.0.1',81))) for c in fill]",
            "time.sleep(1); print('ready', flush=True); time.sleep(86400)",
          ].join("\n"),
        ])
        .withWaitStrategy(Wait.forLogMessage("ready"))
        .start();
      cfg = {
        endpoint: proxy.endpoint,
        runtime: "runc",
        network: netName,
        egressProxyImage: images.egressImage,
        deniedCidrs: ["198.51.100.0/24"],
      };
      const ip = target.getIpAddress(netName);
      sbx = createDockerSandbox(cfg, {
        labels: { [TEST_LABEL]: RUN },
        egressTestHosts: { [A]: ip, [B]: ip, [SLOW]: blackhole.getIpAddress(netName) },
      });
    }, 1_200_000);

    afterAll(async () => {
      await Promise.all([target?.stop(), blackhole?.stop()]);
      await cleanupTestResources(RUN);
      await proxy?.stop();
      await images?.remove();
    }, 120_000);

    const newSandbox = async (p: DeviceProvider, name: string, hosts: string[]) => {
      const fileSystem = await p.createFileSystem({
        name,
        limits: limits(allow(hosts)),
        signal: sig(),
      });
      return p.create({
        name,
        image: images.sandboxImage,
        limits: limits(allow(hosts)),
        fileSystem,
        signal: sig(),
      });
    };

    const inspect = async (name: string) =>
      JSON.parse(await docker("inspect", name))[0] as {
        Id: string;
        State: { Running: boolean };
        Config: { Labels: Record<string, string> };
        HostConfig: { Tmpfs?: Record<string, string> };
        Mounts: { Name?: string; Destination: string; Type: string }[];
      };

    const exists = async (kind: "container" | "volume", name: string) =>
      docker(kind, "inspect", name).then(
        () => true,
        () => false,
      );

    /** Runs a shell command in the sandbox as its user (docker CLI, outside the provider). */
    const inSandbox = (name: string, command: string) =>
      docker("exec", "-u", "1000:1000", name, "sh", "-c", command);

    /** Starts a background process in the sandbox that holds a line connection to `host`:7000. */
    const holdConnection = async (name: string, host: string, file: string) => {
      await docker(
        "exec",
        "-d",
        "-u",
        "1000:1000",
        name,
        "sh",
        "-c",
        `(while true; do echo ping; sleep 0.2; done) | nc -X connect -x ${name}-egress:3128 ${host} 7000 > ${file} 2>&1; echo exit:$? >> ${file}`,
      );
      await expect.poll(() => lines(name, file), { timeout: 30_000 }).toBeGreaterThan(2);
    };
    const lines = async (name: string, file: string) =>
      Number((await inSandbox(name, `grep -c ping ${file} 2>/dev/null || echo 0`)).trim());
    const ended = async (name: string, file: string) =>
      (await inSandbox(name, `cat ${file} 2>/dev/null`)).includes("exit:");

    /** Whether a fresh connection through the proxy to `host` gets the HTTP answer. */
    const reaches = async (name: string, host: string) =>
      (
        await inSandbox(
          name,
          `curl -sS -p -x http://${name}-egress:3128 --max-time 10 http://${host}/ 2>&1 || true`,
        )
      ).includes("hello-egress");

    const status = async (name: string) =>
      JSON.parse(
        await docker(
          "exec",
          "-u",
          "node",
          `${name}-egress`,
          "node",
          "/app/proxy.mjs",
          "control",
          "status",
        ),
      ) as { ok: boolean; hosts: string[]; connections: number };

    it("create gives the instance the egress control: labels, config volume and control tmpfs", async () => {
      const name = sbxName();
      const h = await newSandbox(sbx, name, [A]);
      try {
        expect((await inspect(name)).Config.Labels).toMatchObject({
          "dev.capybara.sandbox.egress-control": "1",
        });
        const p = await inspect(`${name}-egress`);
        expect(p.Config.Labels).toMatchObject({ "dev.capybara.sandbox.egress-control": "1" });
        expect(p.Mounts).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              Type: "volume",
              Name: `${name}-egress-conf`,
              Destination: "/config",
            }),
          ]),
        );
        expect(p.HostConfig.Tmpfs?.["/run/egress"]).toMatch(/mode=0700/);
        // the sandbox has no way to the control socket: it is not in its file system or network
        expect(await inSandbox(name, "ls /run/egress 2>&1 || true")).not.toMatch(/control\.sock/);
        expect(
          (
            await docker(
              "exec",
              "-u",
              "node",
              `${name}-egress`,
              "stat",
              "-c",
              "%a %U",
              "/run/egress/control.sock",
            )
          ).trim(),
        ).toBe("600 node");
      } finally {
        await sbx.destroy(h, sig());
      }
      // destroy removes the instance's config volume with the containers
      expect(await exists("volume", `${name}-egress-conf`)).toBe(false);
      expect(await exists("container", `${name}-egress`)).toBe(false);
    });

    it("a widening keeps a background connection and the containers; the new host is reachable", async () => {
      const name = sbxName();
      const h = await newSandbox(sbx, name, [A]);
      try {
        const ids = [(await inspect(name)).Id, (await inspect(`${name}-egress`)).Id];
        expect(await reaches(name, B)).toBe(false);
        await holdConnection(name, A, "/tmp/a.out");
        expect(await sbx.update(h, limits(allow([A, B])), sig())).toBe("updated");
        const before = await lines(name, "/tmp/a.out");
        await expect
          .poll(() => lines(name, "/tmp/a.out"), { timeout: 30_000 })
          .toBeGreaterThan(before + 2);
        expect(await ended(name, "/tmp/a.out")).toBe(false);
        expect([(await inspect(name)).Id, (await inspect(`${name}-egress`)).Id]).toEqual(ids);
        expect(await reaches(name, B)).toBe(true);
        expect((await status(name)).hosts).toEqual([A, B]);
        // the current denied ranges went with the list
        expect(
          JSON.parse(
            await docker("exec", "-u", "node", `${name}-egress`, "cat", "/config/allow.json"),
          ),
        ).toMatchObject({
          hosts: [A, B],
          deniedCidrs: expect.arrayContaining(["198.51.100.0/24"]),
        });
      } finally {
        await sbx.destroy(h, sig());
      }
    });

    it("a narrowing closes the connection to the removed host, keeps the others and the container, refuses new ones", async () => {
      const name = sbxName();
      const h = await newSandbox(sbx, name, [A, B]);
      try {
        const id = (await inspect(name)).Id;
        await holdConnection(name, A, "/tmp/a.out");
        await holdConnection(name, B, "/tmp/b.out");
        expect(await sbx.update(h, limits(allow([A])), sig())).toBe("updated");
        await expect.poll(() => ended(name, "/tmp/b.out"), { timeout: 30_000 }).toBe(true);
        const before = await lines(name, "/tmp/a.out");
        await expect
          .poll(() => lines(name, "/tmp/a.out"), { timeout: 30_000 })
          .toBeGreaterThan(before + 2);
        expect(await ended(name, "/tmp/a.out")).toBe(false);
        expect(await reaches(name, B)).toBe(false);
        expect(await reaches(name, A)).toBe(true);
        expect((await inspect(name)).Id).toBe(id);
        // the same list again is idempotent
        expect(await sbx.update(h, limits(allow([A])), sig())).toBe("updated");
      } finally {
        await sbx.destroy(h, sig());
      }
    });

    it("drops a connection still connecting to a removed host when the narrowing lands", async () => {
      const name = sbxName();
      const h = await newSandbox(sbx, name, [A, SLOW]);
      try {
        await docker(
          "exec",
          "-d",
          "-u",
          "1000:1000",
          name,
          "sh",
          "-c",
          `curl -sS -p -x http://${name}-egress:3128 --max-time 60 http://${SLOW}:81/ > /tmp/slow.out 2>&1; echo exit:$? >> /tmp/slow.out`,
        );
        // admitted, connecting (the target never completes the handshake)
        await expect
          .poll(async () => (await status(name)).connections, { timeout: 30_000 })
          .toBe(1);
        expect(await sbx.update(h, limits(allow([A])), sig())).toBe("updated");
        await expect.poll(() => ended(name, "/tmp/slow.out"), { timeout: 30_000 }).toBe(true);
        const out = await inSandbox(name, "cat /tmp/slow.out");
        // closed by the narrowing, not answered 502 by a dial that ran out (10 s)
        expect(out).not.toMatch(/502/);
        expect(out).not.toMatch(/exit:0/);
        expect((await status(name)).connections).toBe(0);
      } finally {
        await sbx.destroy(h, sig());
      }
    });

    it("suspend and resume keep the updated list; a suspended instance takes a change with its proxy stopped again", async () => {
      const name = sbxName();
      const h = await newSandbox(sbx, name, [A, B]);
      try {
        expect(await sbx.update(h, limits(allow([A])), sig())).toBe("updated");
        await sbx.suspend(h, sig());
        expect(await sbx.resume(h, sig())).toBe("resumed");
        expect(await reaches(name, B)).toBe(false);
        expect(await reaches(name, A)).toBe(true);

        await sbx.suspend(h, sig());
        expect(await sbx.update(h, limits(allow([B])), sig())).toBe("updated");
        expect((await inspect(`${name}-egress`)).State.Running).toBe(false);
        expect((await inspect(name)).State.Running).toBe(false);
        expect(await sbx.resume(h, sig())).toBe("resumed");
        expect(await reaches(name, A)).toBe(false);
        expect(await reaches(name, B)).toBe(true);
      } finally {
        await sbx.destroy(h, sig());
      }
    });

    it("a lost proxy is rebuilt from the config volume, not from the wider create-time labels", async () => {
      const name = sbxName();
      const h = await newSandbox(sbx, name, [A, B]);
      try {
        expect(await sbx.update(h, limits(allow([A])), sig())).toBe("updated");
        await docker("rm", "-f", `${name}-egress`);
        expect(await sbx.resume(h, sig())).toBe("resumed");
        // the labels still say [A, B]; the rebuilt proxy enforces [A]
        expect((await inspect(name)).Config.Labels["dev.capybara.sandbox.allow-hosts"]).toBe(
          JSON.stringify([A, B]),
        );
        expect((await status(name)).hosts).toEqual([A]);
        expect(await reaches(name, B)).toBe(false);
        expect(await reaches(name, A)).toBe(true);
        // update rebuilds a lost proxy the same way and applies the change on it
        await docker("rm", "-f", `${name}-egress`);
        expect(await sbx.update(h, limits(allow([B])), sig())).toBe("updated");
        expect((await status(name)).hosts).toEqual([B]);
      } finally {
        await sbx.destroy(h, sig());
      }
    });

    it("proxy lost and volume lost on a narrowed instance: resume answers gone and update recreates", async () => {
      const name = sbxName();
      const h: SandboxHandle = await newSandbox(sbx, name, [A, B]);
      try {
        expect(await sbx.update(h, limits(allow([A])), sig())).toBe("updated");
        await docker("rm", "-f", `${name}-egress`);
        await docker("volume", "rm", `${name}-egress-conf`);
        expect(await sbx.update(h, limits(allow([A])), sig())).toBe("recreate");
        expect(await sbx.resume(h, sig())).toBe("gone");
        // never a proxy rebuilt from the labels
        expect(await exists("container", `${name}-egress`)).toBe(false);
        // a volume Docker would make on its own (no role label) does not count either
        await docker("volume", "create", `${name}-egress-conf`);
        expect(await sbx.resume(h, sig())).toBe("gone");
        expect(await exists("container", `${name}-egress`)).toBe(false);
        await docker("volume", "rm", `${name}-egress-conf`);
      } finally {
        await sbx.destroy(h, sig());
      }
    });

    it("a proxy whose saved list cannot be read stops: resume answers gone, never the labels' list", async () => {
      const name = sbxName();
      const h = await newSandbox(sbx, name, [A, B]);
      try {
        expect(await sbx.update(h, limits(allow([A])), sig())).toBe("updated");
        await docker(
          "exec",
          "-u",
          "node",
          `${name}-egress`,
          "sh",
          "-c",
          "echo '{' > /config/allow.json",
        );
        await sbx.suspend(h, sig());
        expect(await sbx.resume(h, sig())).toBe("gone");
        expect((await inspect(`${name}-egress`)).State.Running).toBe(false);
      } finally {
        await sbx.destroy(h, sig());
      }
    });

    it("a control failure throws; the kind and the empty list still recreate", async () => {
      const name = sbxName();
      const h = await newSandbox(sbx, name, [A]);
      try {
        expect(await sbx.update(h, limits(allow([])), sig())).toBe("recreate");
        expect(await sbx.update(h, limits({ kind: "open-public", hosts: [] }), sig())).toBe(
          "recreate",
        );
        // an apply that read an older list (a holder that lost its lease) is refused
        const stale = await new Promise<number | null>((resolve) => {
          const p = spawn("docker", [
            "exec",
            "-i",
            "-u",
            "node",
            `${name}-egress`,
            "node",
            "/app/proxy.mjs",
            "control",
            "apply",
          ]);
          p.on("close", resolve);
          p.stdin.end(
            `${JSON.stringify({ config: { mode: "allowlist", hosts: [A, B] }, ifDigest: "0".repeat(64) })}\n`,
          );
        });
        expect(stale).toBe(1);
        expect(await reaches(name, B)).toBe(false);
        await docker("exec", "-u", "node", `${name}-egress`, "rm", "/run/egress/control.sock");
        await expect(sbx.update(h, limits(allow([A, B])), sig())).rejects.toThrow(
          /egress proxy's control (status|apply) failed/,
        );
        // nothing changed in the proxy
        expect(await reaches(name, B)).toBe(false);
        // an abort before the call rejects at once
        await expect(
          sbx.update(h, limits(allow([A, B])), AbortSignal.abort(new Error("stop"))),
        ).rejects.toThrow(/stop/);
      } finally {
        await sbx.destroy(h, sig());
      }
    });
  },
);
