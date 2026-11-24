import { DeviceOfflineError, type DeviceStream } from "@capybara-hq/plugin-sdk";
import { runDeviceServiceConformance } from "@capybara-hq/testing";
import { describe, expect, it } from "vitest";
import { createDeviceLocalProvider, type LocalDeviceHandle } from "../src/index.js";
import { fakeDialIn, fakeLog, LIMITS, memoryStore, ROOTS, rejection, signal } from "./fakes.js";

const DEVICE = "dev-1";
const HANDLE: LocalDeviceHandle = { id: DEVICE, roots: ROOTS, limits: LIMITS, generation: "1" };
const STATE_DIR = "/home/me/capybara-device/dev-1/services/echo";

type Body = Record<string, unknown>;

/** An in-memory machine for the service ops: a service is "running" with the files it was given. */
function serviceMachine() {
  const running = new Map<string, { startedAt: string; network: unknown }>();
  const requests: Body[] = [];
  const answer = (body: Body) => {
    requests.push(body);
    const status = (name: string) => {
      const r = running.get(name);
      return {
        name,
        state: r ? "running" : "stopped",
        startedAt: r?.startedAt ?? null,
        stateDir: STATE_DIR,
      };
    };
    switch (body.op) {
      case "service.ensure": {
        const spec = body.spec as { name: string };
        if (!running.has(spec.name) && body.ifRunning !== true)
          running.set(spec.name, { startedAt: new Date().toISOString(), network: body.network });
        return { ok: true, result: status(spec.name) };
      }
      case "service.stop":
        running.delete(body.name as string);
        return { ok: true, result: null };
      case "service.status":
        return { ok: true, result: status(body.name as string) };
      case "service.request": {
        if (!running.has(body.name as string))
          return { ok: false, error: { kind: "error", message: "service is not running" } };
        return { ok: true, result: { body: body.body } };
      }
      default:
        return { ok: false, error: { kind: "invalid", message: "unknown" } };
    }
  };
  return { answer, requests, running };
}

function setup() {
  const m = serviceMachine();
  const dial = fakeDialIn((req) => m.answer(req.body as Body));
  const { store } = memoryStore();
  const provider = createDeviceLocalProvider({ dialIn: dial.channel, log: fakeLog().log }, store);
  return { m, dial, provider };
}

const SPEC = {
  name: "echo",
  runtime: "node" as const,
  entry: "echo.mjs",
  args: ["--x"],
  files: { "echo.mjs": new Uint8Array([1, 2, 3]) },
  env: { A: "b" },
};

describe("device-local services", () => {
  it("ensureService sends service.ensure with base64 files and the device network", async () => {
    const { m, provider } = setup();
    const status = await provider.ensureService?.(HANDLE, SPEC, signal());
    expect(status).toMatchObject({ name: "echo", state: "running", stateDir: STATE_DIR });
    expect(m.requests[0]).toEqual({
      op: "service.ensure",
      spec: {
        name: "echo",
        entry: "echo.mjs",
        args: ["--x"],
        files: { "echo.mjs": "AQID" },
        env: { A: "b" },
      },
      network: { kind: "allowlist", hosts: ["example.com"] },
    });
  });

  it("ensureService with ifRunning forwards the flag and starts nothing", async () => {
    const { m, provider } = setup();
    const status = await provider.ensureService?.(HANDLE, SPEC, signal(), { ifRunning: true });
    expect(status?.state).toBe("stopped");
    expect(m.requests[0]).toMatchObject({ ifRunning: true });
  });

  it("serviceRequest decodes the reply body", async () => {
    const { m, provider } = setup();
    await provider.ensureService?.(HANDLE, SPEC, signal());
    const out = await provider.serviceRequest?.(HANDLE, "echo", new Uint8Array([9, 8]), {
      timeoutMs: 1234,
      signal: signal(),
    });
    expect([...(out ?? [])]).toEqual([9, 8]);
    expect(m.requests.at(-1)).toEqual({
      op: "service.request",
      name: "echo",
      body: "CQg=",
      timeoutMs: 1234,
    });
  });

  it("serviceStatus and stopService send their ops", async () => {
    const { m, provider } = setup();
    await provider.ensureService?.(HANDLE, SPEC, signal());
    expect((await provider.serviceStatus?.(HANDLE, "echo", signal()))?.state).toBe("running");
    await provider.stopService?.(HANDLE, "echo", signal());
    expect(m.requests.map((r) => r.op)).toEqual([
      "service.ensure",
      "service.status",
      "service.stop",
    ]);
    expect(m.running.size).toBe(0);
  });

  it("openStream delegates to ctx.dialIn.openStream with { service }", async () => {
    const { dial, provider } = setup();
    const stream = {} as DeviceStream;
    dial.state.openStream = async () => stream;
    const s = signal();
    expect(await provider.openStream?.(HANDLE, { service: "echo" }, s)).toBe(stream);
    expect(dial.streams).toEqual([{ deviceId: DEVICE, body: { service: "echo" }, signal: s }]);
  });

  it("an offline machine surfaces DeviceOfflineError unchanged", async () => {
    const { dial, provider } = setup();
    dial.state.answer = () => {
      throw new DeviceOfflineError(DEVICE);
    };
    dial.state.openStream = async () => {
      throw new DeviceOfflineError(DEVICE);
    };
    const e1 = await rejection(
      provider.ensureService?.(HANDLE, SPEC, signal()) as Promise<unknown>,
    );
    expect(e1).toBeInstanceOf(DeviceOfflineError);
    const e2 = await rejection(
      provider.openStream?.(HANDLE, { service: "echo" }, signal()) as Promise<unknown>,
    );
    expect(e2).toBeInstanceOf(DeviceOfflineError);
  });

  it("maps typed machine failures to actionable errors", async () => {
    const { dial, provider } = setup();
    dial.state.answer = () => ({
      ok: false,
      error: { kind: "unsupported", message: "no services" },
    });
    const e = await rejection(
      provider.serviceStatus?.(HANDLE, "echo", signal()) as Promise<unknown>,
    );
    expect((e as Error).message).toContain("no services");
    expect((e as Error).name).toMatch(/Unsupported/);
  });

  it("passes the device service conformance", async () => {
    const { provider } = setup();
    await runDeviceServiceConformance({
      provider,
      handle: HANDLE,
      dispose: async () => {},
    });
  });
});
