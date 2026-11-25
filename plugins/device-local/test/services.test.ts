import { DeviceOfflineError, type DeviceStream } from "@capybara-hq/plugin-sdk";
import { DEVICE_SERVICE_ARGV_PROBE, runDeviceServiceConformance } from "@capybara-hq/testing";
import { describe, expect, it } from "vitest";
import { createDeviceLocalProvider, filesDigestOf, type LocalDeviceHandle } from "../src/index.js";
import { fakeDialIn, fakeLog, LIMITS, memoryStore, ROOTS, rejection, signal } from "./fakes.js";

const DEVICE = "dev-1";
const HANDLE: LocalDeviceHandle = { id: DEVICE, roots: ROOTS, limits: LIMITS, generation: "1" };
const DEVICE_DIR = "/home/me/capybara-device/dev-1";
const STATE_DIR = `${DEVICE_DIR}/services/tx.echo`;

type Body = Record<string, unknown>;

/**
 * An in-memory machine for the service ops, shaped like capybara-device's supervisor: a service is
 * "running" with the files it was given; every status names its state directory
 * (`<deviceDir>/services/<name>`) and its read-only code directory (`<deviceDir>/svc-files/<name>`),
 * and the entry runs from the code directory (the conformance argv probe answers that path).
 * `codeDir` overrides the reported code directory (invalid answers).
 */
function serviceMachine(opts: { oldMachine?: boolean; preIds?: boolean; codeDir?: unknown } = {}) {
  const digests = new Set<string>();
  const running = new Map<string, { startedAt: string; network: unknown; entry: string }>();
  const codeDirOf = (name: string): unknown =>
    opts.codeDir !== undefined ? opts.codeDir : `${DEVICE_DIR}/svc-files/${name}`;
  const requests: Body[] = [];
  const answer = (body: Body) => {
    requests.push(body);
    const status = (name: string) => {
      const r = running.get(name);
      return {
        name,
        state: r ? "running" : "stopped",
        startedAt: r?.startedAt ?? null,
        stateDir: `${DEVICE_DIR}/services/${name}`,
        codeDir: codeDirOf(name),
      };
    };
    switch (body.op) {
      case "service.ensure": {
        const spec = body.spec as { name: string; entry?: string; files?: Record<string, string> };
        // Like capybara-device: an ifRunning ensure carries only the name and starts nothing.
        if (body.ifRunning === true) {
          if (Object.keys(spec).join() !== "name" || "filesDigest" in body)
            return {
              ok: false,
              error: { kind: "invalid", message: "ifRunning takes a name only" },
            };
          return { ok: true, result: status(spec.name) };
        }
        // a capybara-device from before service ids refuses one by its old name rule
        if (opts.preIds)
          return {
            ok: false,
            error: {
              kind: "invalid",
              message: `Invalid device service name "${spec.name}": 1 to 32 characters, a lower-case letter then letters, digits and -`,
            },
          };
        if (opts.oldMachine && !spec.files)
          return { ok: false, error: { kind: "invalid", message: "spec.files must be an object" } };
        const digest = body.filesDigest as string | undefined;
        if (!opts.oldMachine && !running.has(spec.name) && body.ifRunning !== true) {
          if (spec.files) {
            if (digest) digests.add(digest);
          } else if (!digest || !digests.has(digest))
            return { ok: false, error: { kind: "files_needed", message: "send the files" } };
        }
        if (!running.has(spec.name) && body.ifRunning !== true)
          running.set(spec.name, {
            startedAt: new Date().toISOString(),
            network: body.network,
            entry: spec.entry ?? "",
          });
        return { ok: true, result: status(spec.name) };
      }
      case "service.stop":
        running.delete(body.name as string);
        return { ok: true, result: null };
      case "service.status":
        return { ok: true, result: status(body.name as string) };
      case "service.request": {
        const r = running.get(body.name as string);
        if (!r) return { ok: false, error: { kind: "error", message: "service is not running" } };
        const asked = Buffer.from(body.body as string, "base64").toString("utf8");
        if (asked === DEVICE_SERVICE_ARGV_PROBE) {
          const argv1 = `${String(codeDirOf(body.name as string))}/${r.entry}`;
          return { ok: true, result: { body: Buffer.from(argv1).toString("base64") } };
        }
        return { ok: true, result: { body: body.body } };
      }
      default:
        return { ok: false, error: { kind: "invalid", message: "unknown" } };
    }
  };
  return { answer, requests, running, digests };
}

function setup(opts: { oldMachine?: boolean; preIds?: boolean; codeDir?: unknown } = {}) {
  const m = serviceMachine(opts);
  const dial = fakeDialIn((req) => m.answer(req.body as Body));
  const { store } = memoryStore();
  const provider = createDeviceLocalProvider({ dialIn: dial.channel, log: fakeLog().log }, store);
  return { m, dial, provider, store };
}

const SPEC = {
  name: "tx.echo",
  runtime: "node" as const,
  entry: "echo.mjs",
  args: ["--x"],
  files: { "echo.mjs": new Uint8Array([1, 2, 3]) },
  env: { A: "b" },
};

describe("device-local services", () => {
  it("a machine from before service ids answers an actionable update, not a retry", async () => {
    const { m, provider } = setup({ preIds: true });
    await expect(provider.ensureService?.(HANDLE, SPEC, signal())).rejects.toMatchObject({
      name: "SandboxPermissionUnsupportedError",
      message: expect.stringMatching(/update capybara-device on that machine/),
    });
    // refused once, never retried with the files
    expect(m.requests).toHaveLength(1);
  });

  it("ensureService sends service.ensure with base64 files and the device network", async () => {
    const { m, provider } = setup();
    const status = await provider.ensureService?.(HANDLE, SPEC, signal());
    expect(status).toMatchObject({ name: "tx.echo", state: "running", stateDir: STATE_DIR });
    expect(m.requests).toHaveLength(2);
    expect(m.requests[0]).not.toHaveProperty("spec.files");
    expect(m.requests[1]).toEqual({
      op: "service.ensure",
      spec: {
        name: "tx.echo",
        entry: "echo.mjs",
        args: ["--x"],
        files: { "echo.mjs": "AQID" },
        env: { A: "b" },
      },
      filesDigest: filesDigestOf(SPEC.files),
      network: { kind: "allowlist", hosts: ["example.com"] },
    });
  });

  it("a digest hit starts without sending files", async () => {
    const { m, provider } = setup();
    await provider.ensureService?.(HANDLE, SPEC, signal());
    await provider.stopService?.(HANDLE, "tx.echo", signal());
    m.requests.length = 0;
    const status = await provider.ensureService?.(HANDLE, SPEC, signal());
    expect(status?.state).toBe("running");
    expect(m.requests).toHaveLength(1);
    expect(m.requests[0]).toMatchObject({ filesDigest: filesDigestOf(SPEC.files) });
    expect(m.requests[0]).not.toHaveProperty("spec.files");
  });

  it("the digest covers paths and bytes, sorted by path", () => {
    const a = filesDigestOf({ b: new Uint8Array([1]), a: new Uint8Array([2]) });
    expect(a).toBe(filesDigestOf({ a: new Uint8Array([2]), b: new Uint8Array([1]) }));
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a).not.toBe(filesDigestOf({ a: new Uint8Array([1]), b: new Uint8Array([2]) }));
  });

  it("an old machine's invalid answer to the files-less ensure is retried once with files", async () => {
    const { m, provider } = setup({ oldMachine: true });
    const status = await provider.ensureService?.(HANDLE, SPEC, signal());
    expect(status?.state).toBe("running");
    expect(m.requests).toHaveLength(2);
    expect(m.requests[1]).toHaveProperty("spec.files");
  });

  it("ensureService with ifRunning sends only the name and starts nothing", async () => {
    const { m, provider } = setup();
    const status = await provider.ensureService?.(HANDLE, SPEC, signal(), { ifRunning: true });
    expect(status?.state).toBe("stopped");
    expect(m.requests).toEqual([
      {
        op: "service.ensure",
        spec: { name: "tx.echo" },
        network: { kind: "allowlist", hosts: ["example.com"] },
        ifRunning: true,
      },
    ]);
  });

  it("an ifRunning ensure is never retried with files", async () => {
    const { dial, provider } = setup();
    for (const kind of ["files_needed", "invalid"]) {
      dial.sent.length = 0;
      dial.state.answer = () => ({ ok: false, error: { kind, message: "no" } });
      const e = await rejection(
        provider.ensureService?.(HANDLE, SPEC, signal(), { ifRunning: true }) as Promise<unknown>,
      );
      expect(e).toBeInstanceOf(Error);
      expect(dial.sent).toHaveLength(1);
    }
  });

  it("keeps the machine's code directory in the status", async () => {
    const codeDir = "/home/me/capybara-device/dev-1/services/echo/code";
    const { provider } = setup({ codeDir });
    const status = await provider.ensureService?.(HANDLE, SPEC, signal());
    expect(status).toEqual({
      name: "tx.echo",
      state: "running",
      startedAt: expect.any(String),
      stateDir: STATE_DIR,
      codeDir,
    });
    expect(await provider.serviceStatus?.(HANDLE, "tx.echo", signal())).toHaveProperty(
      "codeDir",
      codeDir,
    );
  });

  it("refuses a code directory that is not an absolute path", async () => {
    for (const codeDir of ["code", 7, "/a\0b"]) {
      const { provider } = setup({ codeDir });
      const e = await rejection(
        provider.serviceStatus?.(HANDLE, "tx.echo", signal()) as Promise<unknown>,
      );
      expect((e as Error).message).toMatch(/invalid service status/);
    }
  });

  it("refuses service files larger than the connection's frame capacity before sending", async () => {
    const { m, dial, provider } = setup();
    dial.state.capacity = 128 * 1024;
    const big = { ...SPEC, files: { "echo.mjs": new Uint8Array(200 * 1024) } };
    const e = await rejection(provider.ensureService?.(HANDLE, big, signal()) as Promise<unknown>);
    expect((e as Error).message).toMatch(/frame/i);
    expect((e as Error).message).toMatch(/MAX_FRAME_BYTES/);
    // Only the digest-first ensure went out; the files never did.
    expect(m.requests).toHaveLength(1);
    expect(m.requests[0]).not.toHaveProperty("spec.files");
  });

  it("serviceRequest decodes the reply body", async () => {
    const { m, provider } = setup();
    await provider.ensureService?.(HANDLE, SPEC, signal());
    const out = await provider.serviceRequest?.(HANDLE, "tx.echo", new Uint8Array([9, 8]), {
      timeoutMs: 1234,
      signal: signal(),
    });
    expect([...(out ?? [])]).toEqual([9, 8]);
    expect(m.requests.at(-1)).toEqual({
      op: "service.request",
      name: "tx.echo",
      body: "CQg=",
      timeoutMs: 1234,
    });
  });

  it("serviceStatus and stopService send their ops", async () => {
    const { m, provider } = setup();
    await provider.ensureService?.(HANDLE, SPEC, signal());
    expect((await provider.serviceStatus?.(HANDLE, "tx.echo", signal()))?.state).toBe("running");
    await provider.stopService?.(HANDLE, "tx.echo", signal());
    expect(m.requests.map((r) => r.op)).toEqual([
      "service.ensure",
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
    expect(await provider.openStream?.(HANDLE, { service: "tx.echo" }, s)).toBe(stream);
    expect(dial.streams).toEqual([{ deviceId: DEVICE, body: { service: "tx.echo" }, signal: s }]);
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
      provider.openStream?.(HANDLE, { service: "tx.echo" }, signal()) as Promise<unknown>,
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
      provider.serviceStatus?.(HANDLE, "tx.echo", signal()) as Promise<unknown>,
    );
    expect((e as Error).message).toContain("no services");
    expect((e as Error).name).toMatch(/Unsupported/);
  });

  it("maps denied, invalid and other machine failures", async () => {
    const { dial, provider } = setup();
    const cases: [string, RegExp, RegExp][] = [
      ["denied", /ScopeDenied/, /not yours/],
      ["invalid", /ToolError|Refused/, /refused the service.status request: bad name/],
      ["error", /ToolError/, /boom.*check the service and retry/],
    ];
    for (const [kind, name, message] of cases) {
      const text = kind === "denied" ? "not yours" : kind === "invalid" ? "bad name" : "boom";
      dial.state.answer = () => ({ ok: false, error: { kind, message: text } });
      const e = await rejection(
        provider.serviceStatus?.(HANDLE, "tx.echo", signal()) as Promise<unknown>,
      );
      expect((e as Error).message).toMatch(message);
      expect((e as Error).name + (e as Error).constructor.name).toMatch(name);
    }
  });

  it("after update, an ensure sends the stored network, so the machine restarts a running service", async () => {
    const { m, provider, store } = setup();
    // the handle's generation, committed by its create with the create's limits and fence token
    await store.commitBinding(
      {
        deviceId: DEVICE,
        instanceId: DEVICE,
        generation: HANDLE.generation,
        bindingId: "b-1",
        previousGeneration: null,
        status: "awaiting-device",
        limits: LIMITS,
        fenceToken: 1,
      },
      null,
    );
    await provider.ensureService?.(HANDLE, SPEC, signal());
    const wider = { kind: "allowlist" as const, hosts: ["example.com", "example.org"] };
    expect(
      await provider.update?.(HANDLE, { ...LIMITS, network: wider }, signal(), { token: 2 }),
    ).toBe("updated");
    m.requests.length = 0;
    // the kernel's refresh right after the panel's allow: an ifRunning ensure on the same handle
    await provider.ensureService?.(HANDLE, SPEC, signal(), { ifRunning: true });
    expect(m.requests).toEqual([
      { op: "service.ensure", spec: { name: "tx.echo" }, network: wider, ifRunning: true },
    ]);
    // a stale holder's update changes nothing the next ensure sends
    await expect(provider.update?.(HANDLE, LIMITS, signal(), { token: 1 })).rejects.toMatchObject({
      staleFence: true,
    });
    m.requests.length = 0;
    await provider.ensureService?.(HANDLE, SPEC, signal());
    expect(m.requests[0]).toMatchObject({ network: wider });
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
