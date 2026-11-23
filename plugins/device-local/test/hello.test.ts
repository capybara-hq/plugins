import { isSandboxGoneError, type SandboxPermissionSupport } from "@capybara-hq/plugin-sdk";
import type { DeviceOwnerCeiling } from "@capybara-hq/plugin-sdk/device-protocol";
import { describe, expect, it } from "vitest";
import {
  createDeviceLocalProvider,
  createDialInHandler,
  type LocalDeviceHandle,
  reportFor,
  revisionOf,
  supportFor,
  viaOf,
} from "../src/index.js";
import {
  fakeDialIn,
  fakeLog,
  LIMITS,
  memoryStore,
  OWNER_CEILING,
  ROOTS,
  rejection,
  SUPPORT,
  scopeOf,
  signal,
} from "./fakes.js";

const DEVICE = "dev-1";
const ORG = "org-1";
const HASH = (c: string) => c.repeat(64);
const RUNTIME = { runtimeHash: HASH("a"), helperHash: HASH("b"), imageFingerprint: HASH("c") };
const OUTSIDE: SandboxPermissionSupport = { ...SUPPORT, outsideSandbox: true };

const UNBOUND_SUPPORT: SandboxPermissionSupport = {
  version: 2,
  boundary: "operation",
  restricted: null,
  network: { openPublic: false, allowlist: false, perOperationHosts: false },
  outsideSandbox: false,
  background: false,
  unavailableReason: "The instance is not bound yet",
};

const ceiling = (over: Partial<DeviceOwnerCeiling> = {}): DeviceOwnerCeiling => ({
  ...OWNER_CEILING,
  outsideSandbox: true,
  network: "allowlist",
  allowedDomains: ["example.com", "registry.npmjs.org"],
  projectReach: "machine",
  ...over,
});

/** A hello body of a program bound to `generation` (null: unbound). */
function hello(
  generation: string | null,
  over: { ownerCeiling?: DeviceOwnerCeiling; runtime?: Partial<typeof RUNTIME> } & Record<
    string,
    unknown
  > = {},
) {
  const { ownerCeiling = ceiling(), runtime, ...rest } = over;
  return {
    mode: "os",
    roots: ROOTS,
    sessionIsolation: false,
    features: ["networkReport", "projects"],
    home: "/home/me",
    permissionSupport: generation === null ? UNBOUND_SUPPORT : OUTSIDE,
    ownerCeiling,
    instanceGeneration: generation,
    ...(generation !== null && {
      runtimeIdentity: { ...RUNTIME, ...runtime, instanceGeneration: generation },
    }),
    ...rest,
  };
}

const policy = (ownerCeiling: DeviceOwnerCeiling, sharedProjectRoots?: string[]) => ({
  type: "policy",
  policy: {
    allowedDomains: [...ownerCeiling.allowedDomains],
    ...(sharedProjectRoots && { sharedProjectRoots }),
  },
  ownerCeiling,
});

/** The report's shared-directories line value in English (undefined: no such line). */
const sharedLine = async (store: Parameters<typeof reportFor>[0]) =>
  (await reportFor(store, { deviceId: DEVICE, orgId: ORG })).limits.find((l) =>
    l.label.en.startsWith("Also used by another connection"),
  )?.value.en;

function setup() {
  const { store, rows, connections } = memoryStore();
  const changed: string[] = [];
  const { log, warnings } = fakeLog();
  const devices = {
    async reportChanged(id: string) {
      changed.push(id);
    },
  };
  const handler = createDialInHandler({ devices, log }, store, () => "2026-11-22T00:00:00.000Z");
  /** Commits and installs `generation` as a create's binding answer would. */
  const install = async (
    generation: string,
    over: { runtime?: Partial<typeof RUNTIME>; support?: SandboxPermissionSupport } = {},
  ) => {
    const previous = (await store.binding(DEVICE))?.generation ?? null;
    const bindingId = `binding-${generation}`;
    expect(
      await store.commitBinding(
        {
          deviceId: DEVICE,
          instanceId: DEVICE,
          generation,
          bindingId,
          previousGeneration: previous,
          status: "awaiting-device",
        },
        previous,
      ),
    ).toBe(true);
    expect(
      await store.installBinding(
        DEVICE,
        generation,
        bindingId,
        {
          runtimeIdentity: { ...RUNTIME, ...over.runtime, instanceGeneration: generation },
          permissionSupport: over.support ?? OUTSIDE,
          ownerCeiling: ceiling(),
        },
        viaOf((await store.state(DEVICE)).connection),
      ),
    ).toBe(true);
  };
  const handle = (generation: string): LocalDeviceHandle => ({
    id: DEVICE,
    roots: ROOTS,
    limits: LIMITS,
    generation,
  });
  const revision = async () => {
    const s = await store.state(DEVICE);
    return revisionOf(s.connection, s.binding);
  };
  /**
   * Whether an operation on `generation`'s handle is gone (`SandboxGoneError`) before anything
   * reaches the machine: the kernel then recreates the instance.
   */
  const operationGone = async (generation: string) => {
    const dial = fakeDialIn();
    const provider = createDeviceLocalProvider({ dialIn: dial.channel, log }, store);
    const e = await rejection(
      provider.operation?.(handle(generation), scopeOf({}, DEVICE), signal()) ?? Promise.resolve(),
    );
    expect(dial.sent).toEqual([]);
    return isSandboxGoneError(e);
  };
  /** The connection hellos, frames and closes arrive on (the kernel's machine and connection). */
  const conn = { machineId: "machine-1", connectionId: "connection-1" };
  const say = (body: unknown) => handler.onHello(DEVICE, body, signal(), { ...conn });
  const frame = (body: unknown) => handler.onFrame?.(DEVICE, body, { ...conn });
  const close = (reason: "offline" | "replaced" | "revoked" | "deleted") =>
    handler.onClose?.(DEVICE, reason, { ...conn });
  return {
    store,
    rows,
    connections,
    changed,
    warnings,
    handler,
    install,
    handle,
    revision,
    operationGone,
    say,
    frame,
    close,
    conn,
  };
}

describe("hello validation", () => {
  it("a hello that does not parse strictly is refused with local.invalid_hello and nothing is stored", async () => {
    const s = setup();
    const bodies: unknown[] = [
      null,
      "hello",
      [],
      { ...hello(null), extra: true },
      { ...hello(null), mode: "vm" },
      { ...hello(null), ownerCeiling: undefined },
      { ...hello(null), ownerCeiling: { ...ceiling(), fullAccess: true } },
      { ...hello(null), roots: { ...ROOTS, workspace: "relative" } },
      // an unbound program cannot claim anything it would run
      { ...hello(null), permissionSupport: OUTSIDE },
      // a generation this provider never makes
      hello("not-a-number"),
      hello("1", { runtime: { runtimeHash: "short" } }),
      { ...hello("1"), runtimeIdentity: { ...RUNTIME, instanceGeneration: "2" } },
    ];
    for (const body of bodies) {
      const r = await s.say(body);
      expect(r, JSON.stringify(body)?.slice(0, 120)).toMatchObject({
        ok: false,
        code: "local.invalid_hello",
      });
      if (!r.ok) expect(r.message.length).toBeLessThanOrEqual(200);
    }
    expect(s.connections.size).toBe(0);
    expect(s.changed).toEqual([]);
  });

  it("a malformed home directory is dropped, never stored", async () => {
    const s = setup();
    for (const home of [`/${"a".repeat(5000)}`, "relative/home", 42]) {
      expect(await s.say(hello(null, { home }))).toEqual({ ok: true });
      expect(s.connections.get(DEVICE)?.home).toBeNull();
    }
  });

  it("a device id that is not one of the kernel's is refused", async () => {
    const s = setup();
    const r = await s.handler.onHello("../etc", hello(null), signal(), s.conn);
    expect(r).toMatchObject({ ok: false, code: "local.invalid_hello" });
    expect(s.connections.size).toBe(0);
  });

  it("a hello the kernel names no machine or connection for is refused", async () => {
    const s = setup();
    for (const conn of [undefined, { machineId: "", connectionId: "c" }, { machineId: "m" }]) {
      const r = await s.handler.onHello(DEVICE, hello(null), signal(), conn as never);
      expect(r).toMatchObject({ ok: false, code: "local.invalid_hello" });
    }
    expect(s.connections.size).toBe(0);
  });

  it("a first hello is stored and tells the kernel the report changed", async () => {
    const s = setup();
    expect(await s.say(hello(null))).toEqual({ ok: true });
    expect(s.changed).toEqual([DEVICE]);
    expect(s.connections.get(DEVICE)).toMatchObject({
      mode: "os",
      roots: ROOTS,
      home: "/home/me",
      features: ["networkReport", "projects"],
      instanceGeneration: null,
      machineId: "machine-1",
      connectionId: "connection-1",
      machineEpoch: 0,
      ownerReport: { report: ceiling(), via: "hello" },
    });
  });

  it("the same hello twice does not call reportChanged the second time", async () => {
    const s = setup();
    await s.install("100");
    expect(await s.say(hello("100"))).toEqual({ ok: true });
    const revision = await s.revision();
    expect(await s.say(hello("100"))).toEqual({ ok: true });
    expect(s.changed).toEqual([DEVICE]);
    expect(await s.revision()).toBe(revision);
  });

  it("a hello with a stale owner ceiling sequence is refused and nothing is stored", async () => {
    const s = setup();
    await s.install("100");
    expect(await s.say(hello("100", { ownerCeiling: ceiling({ sequence: 5 }) }))).toEqual({
      ok: true,
    });
    const before = structuredClone(s.connections.get(DEVICE));
    const r = await s.say(
      hello("100", { ownerCeiling: ceiling({ sequence: 4, outsideSandbox: false }) }),
    );
    expect(r).toMatchObject({ ok: false, code: "local.stale_owner_report" });
    expect(s.connections.get(DEVICE)).toEqual(before);
    expect(s.changed).toEqual([DEVICE]);
  });

  it("a bound hello whose report conflicts under the same sequence is refused", async () => {
    const s = setup();
    await s.install("100");
    await s.say(hello("100", { ownerCeiling: ceiling({ sequence: 5 }) }));
    const r = await s.say(
      hello("100", { ownerCeiling: ceiling({ sequence: 5, outsideSandbox: false }) }),
    );
    expect(r).toMatchObject({ ok: false, code: "local.owner_report_conflict" });
    expect(s.connections.get(DEVICE)?.ownerReport?.report.outsideSandbox).toBe(true);
  });

  it("a hello whose runtime identity differs from the installed binding is refused with local.identity_mismatch", async () => {
    const s = setup();
    await s.install("100");
    const r = await s.say(hello("100", { runtime: { imageFingerprint: HASH("d") } }));
    expect(r).toMatchObject({ ok: false, code: "local.identity_mismatch" });
    expect(s.connections.size).toBe(0);
    expect(s.rows.get(DEVICE)?.unattested).toBeUndefined();
    expect(s.changed).toEqual([]);
  });

  it("a hello naming a generation this provider never bound is refused", async () => {
    const s = setup();
    await s.install("100");
    const r = await s.say(hello("101"));
    expect(r).toMatchObject({ ok: false, code: "local.identity_mismatch" });
  });
});

describe("binding attestation", () => {
  it("an unbound hello marks the installed binding unattested: the instance is gone", async () => {
    const s = setup();
    await s.install("100");
    await s.say(hello("100"));
    const revision = await s.revision();
    // the program restarted under a new runtime: it comes back unbound
    expect(await s.say(hello(null))).toEqual({ ok: true });
    expect(s.rows.get(DEVICE)?.unattested).toBe(true);
    expect(await s.revision()).not.toBe(revision);
    expect(s.changed).toEqual([DEVICE, DEVICE]);
    // the support stays readable (the kernel records it before a use); the operation is gone
    expect((await supportFor(s.store, s.handle("100"))).unavailableReason).toBeUndefined();
    expect(await s.operationGone("100")).toBe(true);
    // the kernel recreates: the next generation installs attested
    await s.install("101");
    expect(s.rows.get(DEVICE)?.unattested).toBeUndefined();
    expect((await supportFor(s.store, s.handle("101"))).unavailableReason).toBeUndefined();
    expect(await s.operationGone("101")).toBe(false);
  });

  it("a bound hello attesting the binding refreshes its support from the hello", async () => {
    const s = setup();
    await s.install("100", { support: SUPPORT });
    await s.say(hello("100"));
    expect(s.rows.get(DEVICE)?.installed?.permissionSupport).toEqual(OUTSIDE);
    // the support moved: the revision too
    expect(s.changed).toEqual([DEVICE]);
  });
});

describe("owner policy events", () => {
  it("an owner policy event that turns outside-sandbox off changes the revision and calls reportChanged once", async () => {
    const s = setup();
    await s.install("100");
    await s.say(hello("100", { ownerCeiling: ceiling({ sequence: 1 }) }));
    expect((await supportFor(s.store, s.handle("100"))).outsideSandbox).toBe(true);
    const revision = await s.revision();
    const off = ceiling({ sequence: 2, revision: "owner-2", outsideSandbox: false });
    await s.frame(policy(off));
    expect(await s.revision()).not.toBe(revision);
    expect(s.changed).toEqual([DEVICE, DEVICE]);
    // the same event again is no change
    await s.frame(policy(off));
    expect(s.changed).toEqual([DEVICE, DEVICE]);
    // the support narrows to what the owner allows now
    expect((await supportFor(s.store, s.handle("100"))).outsideSandbox).toBe(false);
    const report = await reportFor(s.store, { deviceId: DEVICE, orgId: ORG });
    expect(report.description.en).toContain("never runs outside the sandbox");
  });

  it("a stale event is ignored; a conflicting one blocks the owner facts (fail closed)", async () => {
    const s = setup();
    await s.install("100");
    await s.say(hello("100", { ownerCeiling: ceiling({ sequence: 3 }) }));
    await s.frame(policy(ceiling({ sequence: 2, outsideSandbox: false })));
    expect(s.changed).toEqual([DEVICE]);
    expect((await supportFor(s.store, s.handle("100"))).outsideSandbox).toBe(true);
    await s.frame(policy(ceiling({ sequence: 3, revision: "other" })));
    expect(s.changed).toEqual([DEVICE, DEVICE]);
    expect((await supportFor(s.store, s.handle("100"))).outsideSandbox).toBe(false);
    const report = await reportFor(s.store, { deviceId: DEVICE, orgId: ORG });
    expect(report.description.en).toContain("as narrowly as possible");
    // a valid current report unblocks
    await s.frame(policy(ceiling({ sequence: 4, revision: "owner-4" })));
    expect((await supportFor(s.store, s.handle("100"))).outsideSandbox).toBe(true);
  });

  it("an invalid frame is dropped with a warning and changes nothing", async () => {
    const s = setup();
    await s.say(hello(null));
    for (const frame of [
      null,
      { type: "other" },
      { type: "policy", ownerCeiling: { ...ceiling(), sequence: -1 } },
      { ...policy(ceiling()), extra: 1 },
    ])
      await s.frame(frame);
    expect(s.warnings).toHaveLength(4);
    expect(s.changed).toEqual([DEVICE]);
  });
});

describe("shared project directories", () => {
  it("a hello's shared directories are stored sorted and shown; an older hello shows none", async () => {
    const s = setup();
    await s.say(
      hello(null, {
        policy: { allowedDomains: [], sharedProjectRoots: ["/p/b", "/p/a", "/p/b"] },
      }),
    );
    expect(s.connections.get(DEVICE)?.sharedProjectRoots).toEqual(["/p/a", "/p/b"]);
    expect(await sharedLine(s.store)).toBe("/p/a, /p/b");
    // an older device (no field) after a restart: no line
    await s.say(hello(null, { policy: { allowedDomains: [] } }));
    expect(s.connections.get(DEVICE)?.sharedProjectRoots).toEqual([]);
    expect(await sharedLine(s.store)).toBeUndefined();
  });

  it("a policy event with the same ceiling and new shared directories tells the kernel once, keeping the revision", async () => {
    const s = setup();
    await s.install("100");
    const same = ceiling({ sequence: 1 });
    await s.say(hello("100", { ownerCeiling: same }));
    expect(s.changed).toEqual([DEVICE]);
    const revision = await s.revision();
    const owner = s.connections.get(DEVICE)?.ownerReport?.report;

    await s.frame(policy(same, ["/p/shared"]));
    expect(s.changed).toEqual([DEVICE, DEVICE]);
    // the owner ceiling and the report revision (the kernel's authority epoch input) stay
    expect(await s.revision()).toBe(revision);
    expect(s.connections.get(DEVICE)?.ownerReport?.report).toEqual(owner);
    expect(await sharedLine(s.store)).toBe("/p/shared");

    // the same again (also reordered or duplicated) tells nothing
    await s.frame(policy(same, ["/p/shared", "/p/shared"]));
    expect(s.changed).toEqual([DEVICE, DEVICE]);

    // gone again: told once more, the line disappears, the revision still stays
    await s.frame(policy(same, []));
    expect(s.changed).toEqual([DEVICE, DEVICE, DEVICE]);
    expect(await sharedLine(s.store)).toBeUndefined();
    expect(await s.revision()).toBe(revision);
  });

  it("a ceiling change with new shared directories tells the kernel once", async () => {
    const s = setup();
    await s.say(hello(null, { ownerCeiling: ceiling({ sequence: 1 }) }));
    const revision = await s.revision();
    await s.frame(
      policy(ceiling({ sequence: 2, revision: "owner-2", outsideSandbox: false }), ["/p/x"]),
    );
    expect(s.changed).toEqual([DEVICE, DEVICE]);
    expect(await s.revision()).not.toBe(revision);
    expect(await sharedLine(s.store)).toBe("/p/x");
  });

  it("a stale or conflicting event never changes the shared directories; an unreadable summary or list keeps them", async () => {
    const s = setup();
    await s.say(hello(null, { ownerCeiling: ceiling({ sequence: 2, revision: "owner-2" }) }));
    await s.frame(policy(ceiling({ sequence: 2, revision: "owner-2" }), ["/p/kept"]));
    expect(await sharedLine(s.store)).toBe("/p/kept");
    const told = s.changed.length;
    // stale
    await s.frame(policy(ceiling({ sequence: 1 }), ["/p/stale"]));
    expect(await sharedLine(s.store)).toBe("/p/kept");
    expect(s.changed.length).toBe(told);
    // an unreadable summary (absent after parsing) keeps what was shown
    await s.frame({ type: "policy", ownerCeiling: ceiling({ sequence: 2, revision: "owner-2" }) });
    expect(await sharedLine(s.store)).toBe("/p/kept");
    expect(s.changed.length).toBe(told);
    // an unreadable list in an otherwise readable summary (dropped by the parser) keeps them too
    const unreadable = policy(ceiling({ sequence: 2, revision: "owner-2" }));
    for (const sharedProjectRoots of [
      ["relative/path"],
      Array.from({ length: 257 }, (_, i) => `/p/${i}`),
      "/p/not-a-list",
    ]) {
      await s.frame({ ...unreadable, policy: { ...unreadable.policy, sharedProjectRoots } });
      expect(await sharedLine(s.store)).toBe("/p/kept");
      expect(s.changed.length).toBe(told);
    }
    // conflicting: blocks the owner facts, keeps the directories
    await s.frame(policy(ceiling({ sequence: 2, revision: "other" }), ["/p/conflict"]));
    expect(await sharedLine(s.store)).toBe("/p/kept");
  });
});

describe("machine replacement", () => {
  it("a hello from another machine gets a fresh record and moves the epoch, whatever its sequence", async () => {
    for (const sequence of [0, 9]) {
      const s = setup();
      await s.install("100");
      await s.say(hello("100", { ownerCeiling: ceiling({ sequence: 7 }) }));
      const revision = await s.revision();
      // `capybara-device login` again, on this computer or another: a new machine id
      s.conn.machineId = "machine-2";
      s.conn.connectionId = "connection-2";
      const fresh = ceiling({ sequence, revision: "fresh", outsideSandbox: false });
      expect(await s.say(hello(null, { ownerCeiling: fresh }))).toEqual({ ok: true });
      expect(s.connections.get(DEVICE)).toMatchObject({
        machineId: "machine-2",
        connectionId: "connection-2",
        machineEpoch: 1,
        ownerReport: { report: fresh, via: "hello" },
      });
      // the old credential's generation is gone
      expect(s.rows.get(DEVICE)?.unattested).toBe(true);
      expect(await s.revision()).not.toBe(revision);
      expect(s.changed.at(-1)).toBe(DEVICE);
    }
  });

  it("another machine never attests the installed binding, even naming its generation", async () => {
    const s = setup();
    await s.install("100");
    await s.say(hello("100"));
    s.conn.machineId = "machine-2";
    expect(await s.say(hello("100", { runtime: { runtimeHash: HASH("f") } }))).toEqual({
      ok: true,
    });
    expect(s.rows.get(DEVICE)?.unattested).toBe(true);
    expect(await s.operationGone("100")).toBe(true);
  });

  it("the same machine's stale or conflicting report is refused, bound or not, and not recorded", async () => {
    const s = setup();
    await s.install("100");
    await s.say(hello("100", { ownerCeiling: ceiling({ sequence: 5 }) }));
    const before = structuredClone(s.connections.get(DEVICE));
    const binding = structuredClone(s.rows.get(DEVICE));
    const revision = await s.revision();
    for (const generation of [null, "100"]) {
      expect(
        await s.say(hello(generation, { ownerCeiling: ceiling({ sequence: 4, revision: "old" }) })),
      ).toMatchObject({ ok: false, code: "local.stale_owner_report" });
      expect(
        await s.say(
          hello(generation, { ownerCeiling: ceiling({ sequence: 5, outsideSandbox: false }) }),
        ),
      ).toMatchObject({ ok: false, code: "local.owner_report_conflict" });
    }
    expect(s.connections.get(DEVICE)).toEqual(before);
    expect(s.rows.get(DEVICE)).toEqual(binding);
    expect(await s.revision()).toBe(revision);
  });

  it("replaced: a takeover by the same machine keeps the revision, another machine's hello moves it", async () => {
    const s = setup();
    await s.install("100");
    await s.say(hello("100"));
    const revision = await s.revision();
    // the same machine reconnects: the old connection closes as replaced, the new one says hello
    await s.close("replaced");
    s.conn.connectionId = "connection-2";
    expect(await s.say(hello("100"))).toEqual({ ok: true });
    expect(await s.revision()).toBe(revision);
    expect(s.connections.get(DEVICE)).toMatchObject({
      machineEpoch: 0,
      connectionId: "connection-2",
    });
    expect(s.changed).toEqual([DEVICE]);
    // the device signs in from another machine: the close names the old machine, then the new hello
    await s.close("replaced");
    expect(await s.revision()).toBe(revision);
    s.conn.machineId = "machine-2";
    s.conn.connectionId = "connection-3";
    expect(await s.say(hello(null))).toEqual({ ok: true });
    expect(s.connections.get(DEVICE)?.machineEpoch).toBe(1);
    expect(await s.revision()).not.toBe(revision);
  });

  it("revoked moves the revision only for the recorded machine; offline changes nothing", async () => {
    const s = setup();
    await s.say(hello(null));
    const revision = await s.revision();
    await s.close("offline");
    // a late close of an older machine
    await s.handler.onClose?.(DEVICE, "revoked", {
      machineId: "machine-0",
      connectionId: "connection-0",
    });
    expect(await s.revision()).toBe(revision);
    expect(s.changed).toEqual([DEVICE]);
    await s.close("revoked");
    expect(await s.revision()).not.toBe(revision);
    expect(s.changed).toEqual([DEVICE, DEVICE]);
  });

  it("a policy event from any connection but the recorded one is dropped", async () => {
    const s = setup();
    await s.say(hello(null, { ownerCeiling: ceiling({ sequence: 1 }) }));
    const revision = await s.revision();
    const off = policy(ceiling({ sequence: 2, revision: "owner-2", outsideSandbox: false }));
    await s.handler.onFrame?.(DEVICE, off, { machineId: "machine-1", connectionId: "old" });
    await s.handler.onFrame?.(DEVICE, off, {
      machineId: "machine-0",
      connectionId: "connection-1",
    });
    expect(await s.revision()).toBe(revision);
    await s.frame(off);
    expect(await s.revision()).not.toBe(revision);
  });
});

describe("report and permission support", () => {
  it("report describes outside-sandbox off in en and zh", async () => {
    const s = setup();
    await s.say(hello(null, { ownerCeiling: ceiling({ outsideSandbox: false }) }));
    const r = await reportFor(s.store, { deviceId: DEVICE, orgId: ORG });
    expect(r.description).toEqual({
      en: "Reads the whole machine except secrets and other connections; writes only in the project and workspace; never runs outside the sandbox; network: 2 allowed hosts.",
      zh: "读取本机全部文件（密钥和其他连接除外）；只在项目和工作区写入；从不在沙箱外运行；网络：允许 2 个主机。",
    });
    expect(r.home).toBe("/home/me");
    expect(r.reset).toBe(false);
    expect(r.limits).toEqual([
      { label: { en: "Mode", zh: "模式" }, value: { en: "os", zh: "本机系统" } },
      { label: { en: "Outside the sandbox", zh: "沙箱外运行" }, value: { en: "off", zh: "关闭" } },
      { label: { en: "Project reach", zh: "项目范围" }, value: { en: "machine", zh: "整台机器" } },
      { label: { en: "Network", zh: "网络" }, value: { en: "allowlist", zh: "允许列表" } },
      { label: { en: "Allowed hosts", zh: "允许的主机" }, value: { en: "2" } },
    ]);
  });

  it("report describes outside-sandbox per call, the workspace reach and docker mode", async () => {
    const s = setup();
    await s.say(
      hello(null, {
        mode: "docker",
        ownerCeiling: ceiling({ network: "open", projectReach: "workspace" }),
      }),
    );
    const r = await reportFor(s.store, { deviceId: DEVICE, orgId: ORG });
    expect(r.description.en).toBe(
      "In a Docker container: Reads and writes only the device's workspace; runs outside the sandbox only per approved call; network: the open internet.",
    );
    expect(r.description.zh).toContain("仅在获批的单次调用中在沙箱外运行");
    expect(r.home).toBeNull();
  });

  it("before any hello the report says the computer is not connected", async () => {
    const s = setup();
    const r = await reportFor(s.store, { deviceId: DEVICE, orgId: ORG });
    expect(r.description.en).toContain("Waiting for the computer");
    expect(r.limits).toEqual([]);
  });

  it("another org reads the device as never connected", async () => {
    const s = setup();
    await s.say(hello(null));
    const own = await reportFor(s.store, { deviceId: DEVICE, orgId: ORG });
    const other = await reportFor(s.store, { deviceId: DEVICE, orgId: "org-2" });
    expect(other.description.en).toContain("Waiting for the computer");
    expect(other.revision).not.toBe(own.revision);
    expect(other.home).toBeNull();
  });

  it("the revision moves with a new generation, a new environment fingerprint and a rewritten support", async () => {
    const s = setup();
    await s.say(hello(null));
    await s.install("100");
    const first = await s.revision();
    await s.install("101");
    const second = await s.revision();
    expect(second).not.toBe(first);
    await s.install("102", { runtime: { imageFingerprint: HASH("e") } });
    const third = await s.revision();
    expect(third).not.toBe(second);
    // a resume re-verifying the same generation with another support
    await s.store.installBinding(
      DEVICE,
      "102",
      "binding-102",
      {
        runtimeIdentity: { ...RUNTIME, imageFingerprint: HASH("e"), instanceGeneration: "102" },
        permissionSupport: SUPPORT,
        ownerCeiling: ceiling(),
      },
      viaOf((await s.store.state(DEVICE)).connection),
    );
    expect(await s.revision()).not.toBe(third);
  });

  it("permission support is the installed binding's, closed otherwise; operations of a dead generation are gone", async () => {
    const s = setup();
    const foreign = await supportFor(s.store, { id: DEVICE });
    expect(foreign.unavailableReason).toBeDefined();
    expect((await supportFor(s.store, s.handle("100"))).unavailableReason).toBeDefined();
    expect(await s.operationGone("100")).toBe(true);
    await s.store.commitBinding(
      {
        deviceId: DEVICE,
        instanceId: DEVICE,
        generation: "100",
        bindingId: "b",
        previousGeneration: null,
        status: "awaiting-device",
      },
      null,
    );
    expect((await supportFor(s.store, s.handle("100"))).unavailableReason).toContain(
      "not complete",
    );
    await s.install("101");
    // no hello stored yet: closed
    expect((await supportFor(s.store, s.handle("101"))).unavailableReason).toBeDefined();
    await s.say(hello("101"));
    // the owner's network is an allowlist: no open public internet
    expect(await supportFor(s.store, s.handle("101"))).toEqual({
      ...OUTSIDE,
      network: { ...OUTSIDE.network, openPublic: false },
    });
    // an open owner network keeps it
    await s.frame(policy(ceiling({ sequence: 2, revision: "owner-2", network: "open" })));
    expect(await supportFor(s.store, s.handle("101"))).toEqual(OUTSIDE);
    // blocked owner facts close it again
    await s.frame(policy(ceiling({ sequence: 2, revision: "other", network: "open" })));
    expect((await supportFor(s.store, s.handle("101"))).network.openPublic).toBe(false);
    // an older handle: the machine holds the newer generation, so its operations are gone
    expect(await s.operationGone("100")).toBe(true);
    expect(await s.operationGone("101")).toBe(false);
  });

  it("deleting the device forgets its rows", async () => {
    const s = setup();
    await s.say(hello(null));
    await s.install("100");
    const dial = fakeDialIn();
    const provider = createDeviceLocalProvider(
      { dialIn: dial.channel, log: fakeLog().log },
      s.store,
    );
    await provider.destroyFileSystem({ id: DEVICE }, signal());
    expect(s.connections.size).toBe(0);
    expect(s.rows.size).toBe(0);
    expect(dial.sent).toEqual([]);
  });
});
