import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createDockerSandbox } from "../src/provider.js";

/**
 * The device service state volume (`<name>-svc`) against a fake Engine API that knows only volumes:
 * its size cap under `volumeDriver`, and a stale one dropped when the file system is made anew.
 */
interface Volume {
  Name: string;
  Driver?: string;
  DriverOpts?: Record<string, string>;
  Labels?: Record<string, string>;
}

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

async function fakeEngine(existing: Volume[] = []) {
  const volumes = new Map(existing.map((v) => [v.Name, v]));
  const calls: string[] = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const path = (req.url ?? "").replace(/^\/v[\d.]+/, "").split("?")[0] as string;
      calls.push(`${req.method} ${path}`);
      const name = decodeURIComponent(path.slice("/volumes/".length));
      const send = (status: number, body?: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(body === undefined ? "" : JSON.stringify(body));
      };
      if (req.method === "POST" && path === "/volumes/create") {
        const v = JSON.parse(Buffer.concat(chunks).toString()) as Volume;
        volumes.set(v.Name, v);
        return send(201, v);
      }
      if (req.method === "GET" && path.startsWith("/volumes/")) {
        const v = volumes.get(name);
        return v ? send(200, v) : send(404, { message: "no such volume" });
      }
      if (req.method === "DELETE" && path.startsWith("/volumes/")) {
        volumes.delete(name);
        return send(204);
      }
      send(404, { message: "not in the fake" });
    });
  });
  await new Promise<void>((r) => server?.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return { endpoint: `tcp://127.0.0.1:${port}`, volumes, calls };
}

const LIMITS = {
  cpu: 1,
  memoryMb: 512,
  diskMb: 8192,
  network: { kind: "allowlist" as const, hosts: [] },
};
const signal = () => new AbortController().signal;

function provider(endpoint: string, volumeDriver?: string) {
  return createDockerSandbox({
    endpoint,
    network: "cap-test",
    egressProxyImage: "egress:test",
    runtime: "runc",
    ...(volumeDriver !== undefined && { volumeDriver }),
  });
}

describe("device-docker service state volume", () => {
  it("is made with the workspace volume's driver and a size cap", async () => {
    const e = await fakeEngine();
    await provider(e.endpoint, "sized").createFileSystem({
      name: "cap-device-a",
      limits: LIMITS,
      signal: signal(),
    });
    expect(e.volumes.get("cap-device-a-workspace")).toMatchObject({
      Driver: "sized",
      DriverOpts: { size: "8192M" },
    });
    expect(e.volumes.get("cap-device-a-svc")).toMatchObject({
      Driver: "sized",
      DriverOpts: { size: "2048M" },
    });
  });

  it("a small disk caps the service volume at the disk size", async () => {
    const e = await fakeEngine();
    await provider(e.endpoint, "sized").createFileSystem({
      name: "cap-device-b",
      limits: { ...LIMITS, diskMb: 1024 },
      signal: signal(),
    });
    expect(e.volumes.get("cap-device-b-svc")?.DriverOpts).toEqual({ size: "1024M" });
  });

  it("without volumeDriver the service volume is a plain local one", async () => {
    const e = await fakeEngine();
    await provider(e.endpoint).createFileSystem({
      name: "cap-device-c",
      limits: LIMITS,
      signal: signal(),
    });
    const v = e.volumes.get("cap-device-c-svc");
    expect(v).toBeDefined();
    expect(v).not.toHaveProperty("Driver");
    expect(v).not.toHaveProperty("DriverOpts");
  });

  it("a stale service volume is dropped when the workspace volume has to be made", async () => {
    const e = await fakeEngine([{ Name: "cap-device-d-svc", Labels: { stale: "1" } }]);
    await provider(e.endpoint).createFileSystem({
      name: "cap-device-d",
      limits: LIMITS,
      signal: signal(),
    });
    expect(e.calls).toContain("DELETE /volumes/cap-device-d-svc");
    expect(e.volumes.get("cap-device-d-svc")?.Labels).not.toHaveProperty("stale");
  });

  it("an existing file system keeps its service volume", async () => {
    const e = await fakeEngine([
      { Name: "cap-device-e-workspace" },
      { Name: "cap-device-e-skills" },
      { Name: "cap-device-e-svc", Labels: { kept: "1" } },
    ]);
    await provider(e.endpoint).createFileSystem({
      name: "cap-device-e",
      limits: LIMITS,
      signal: signal(),
    });
    expect(e.calls).not.toContain("DELETE /volumes/cap-device-e-svc");
    expect(e.volumes.get("cap-device-e-svc")?.Labels).toEqual({ kept: "1" });
  });
});
