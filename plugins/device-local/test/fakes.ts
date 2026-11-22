import type {
  DialInChannel,
  SandboxLimits,
  SandboxOperationScope,
  SandboxPermissionSupport,
} from "@capybara-hq/plugin-sdk";
import type {
  BindInstanceRequest,
  DeviceOperation,
  DeviceOwnerCeiling,
} from "@capybara-hq/plugin-sdk/device-protocol";
import {
  type Binding,
  type Connection,
  type DeviceLocalStore,
  type DeviceRows,
  storeOver,
} from "../src/index.js";

/** What a fake machine answers one request with: the protocol 5 response body, or a throw. */
export type Answer = { ok: true; result: unknown } | { ok: false; error: unknown } | unknown;

/** One request the fake channel relayed: the body, the device and the options it was sent with. */
export interface SentRequest {
  deviceId: string;
  op: DeviceOperation;
  args: Record<string, unknown>;
  timeoutMs: number;
  signal: AbortSignal | undefined;
}

/**
 * A fake `ctx.dialIn`: records every request body and answers it with `answer` (a response body;
 * a throw is the channel's own error). `online` is what `ctx.dialIn.online` answers.
 */
export function fakeDialIn(
  answer: (req: SentRequest) => Answer | Promise<Answer> = () => ({ ok: true, result: null }),
) {
  const sent: SentRequest[] = [];
  const state = { online: true, answer };
  const channel: DialInChannel = {
    async request(deviceId, frame, opts) {
      const body = frame as { op: DeviceOperation; args: Record<string, unknown> };
      const req: SentRequest = {
        deviceId,
        op: body.op,
        args: body.args,
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
      };
      sent.push(req);
      return await state.answer(req);
    },
    async online() {
      return state.online;
    },
    async stop() {},
  };
  return { channel, sent, state, ops: () => sent.map((r) => r.op) };
}

/** A silent `ctx.log` that keeps what was warned. */
export function fakeLog() {
  const warnings: { msg: string; fields: unknown }[] = [];
  const log = {
    debug() {},
    info() {},
    warn(msg: string, fields?: unknown) {
      warnings.push({ msg, fields });
    },
    error() {},
    child() {
      return log;
    },
  };
  return { log: log as never, warnings };
}

/**
 * In-memory {@link DeviceRows}: `rows` holds the bindings, `connections` the connections; a change
 * runs on copies and writes what it returns, as the PG rows do under their lock.
 */
export function memoryRows() {
  const rows = new Map<string, Binding>();
  const connections = new Map<string, Connection>();
  const copy = <T>(v: T | undefined): T | null => (v === undefined ? null : structuredClone(v));
  const api: DeviceRows = {
    async read(deviceId) {
      return { connection: copy(connections.get(deviceId)), binding: copy(rows.get(deviceId)) };
    },
    async change(deviceId, fn) {
      const c = fn(await api.read(deviceId));
      if (c.connection) {
        const org = connections.get(deviceId)?.orgId ?? null;
        connections.set(deviceId, {
          ...structuredClone(c.connection),
          orgId: org ?? c.connection.orgId,
        });
      }
      if (c.binding) rows.set(deviceId, structuredClone(c.binding));
      return c.result;
    },
    async connectionOf(deviceId, orgId) {
      const c = connections.get(deviceId);
      if (c && c.orgId === null) c.orgId = orgId;
      return c?.orgId === orgId ? structuredClone(c) : null;
    },
    async forget(deviceId) {
      rows.delete(deviceId);
      connections.delete(deviceId);
    },
  };
  return { api, rows, connections };
}

/** An in-memory {@link DeviceLocalStore} with the conditional writes the real one makes. */
export function memoryStore() {
  const { api, rows, connections } = memoryRows();
  return { store: storeOver(api, () => "2026-11-22T00:00:00.000Z"), rows, connections };
}

export const LIMITS: SandboxLimits = {
  cpu: 2,
  memoryMb: 1024,
  diskMb: 2048,
  network: { kind: "allowlist", hosts: ["example.com"] },
};

export const ROOTS = {
  workspace: "/home/me/capybara-device/dev-1/workspace",
  skills: "/home/me/capybara-device/dev-1/skills",
  tmp: "/home/me/capybara-device/dev-1/tmp",
};

export const SUPPORT: SandboxPermissionSupport = {
  version: 2,
  boundary: "operation",
  restricted: { filesystem: true, network: true, native: true, concurrentScopes: true },
  network: { openPublic: true, allowlist: true, perOperationHosts: true },
  outsideSandbox: false,
  background: true,
};

export const OWNER_CEILING: DeviceOwnerCeiling = {
  version: 3,
  sequence: 1,
  revision: "owner-1",
  outsideSandbox: false,
  network: "open",
  allowedDomains: [],
  restrictedProjectReach: "workspace",
};

/** A scope as the kernel admits it (overrides replace top-level fields). */
export function scopeOf(
  overrides: Partial<SandboxOperationScope> = {},
  deviceId = "dev-1",
): SandboxOperationScope {
  return {
    operationId: "operation-1",
    admitBeforeMs: Date.now() + 30_000,
    deviceId,
    rootConversationId: "root",
    profileRevision: 1,
    ceilingRevision: "c",
    profile: "approve-for-me",
    actor: { accountId: "owner", conversationId: "root", runId: "run" },
    tag: "operation",
    filesystem: { kind: "scoped", projectRoot: ROOTS.workspace, writeRoots: [ROOTS.workspace] },
    network: { kind: "allowlist", hosts: ["example.com"] },
    ...overrides,
  };
}

const HASH = (c: string) => c.repeat(64);

/**
 * The machine half of the binding chain (the rules of capybara-device's instance binder): one
 * stored binding per device, generations only move forward, the same binding is idempotent and
 * re-verifies the runtime, a stored binding of the same credential must not be newer than the
 * request's previous, another credential's binding counts as none.
 */
export function fakeBinder(deviceId = "dev-1") {
  const machine = {
    credential: "credential-1",
    runtime: { runtimeHash: HASH("a"), helperHash: HASH("b"), imageFingerprint: HASH("c") },
    stored: undefined as
      | (BindInstanceRequest & { credential: string; runtime: Record<string, string> })
      | undefined,
    /** Binds as the machine does; the response body. */
    bind(r: BindInstanceRequest): Answer {
      const denied = (message: string) => ({ ok: false, error: { kind: "denied", message } });
      if (r.instanceId !== deviceId) return denied("The binding names another instance");
      const s = machine.stored;
      if (s?.instanceGeneration === r.instanceGeneration) {
        if (s.bindingId !== r.bindingId)
          return denied("This generation is already bound under another binding id");
        if (s.runtime.runtimeHash !== machine.runtime.runtimeHash)
          return {
            ok: false,
            error: {
              kind: "unsupported",
              message: "The installed runtime changed since this generation was bound",
            },
          };
      } else {
        if (s && BigInt(r.instanceGeneration) <= BigInt(s.instanceGeneration))
          return denied("A binding never moves to an older generation");
        const previous = s?.credential === machine.credential ? s.instanceGeneration : null;
        if (
          previous !== null &&
          (r.expectedPreviousGeneration === null ||
            BigInt(previous) > BigInt(r.expectedPreviousGeneration))
        )
          return denied("The binding does not follow this device's previous binding");
        machine.stored = { ...r, credential: machine.credential, runtime: { ...machine.runtime } };
      }
      return {
        ok: true,
        result: {
          instanceId: r.instanceId,
          instanceGeneration: r.instanceGeneration,
          bindingId: r.bindingId,
          runtimeIdentity: { ...machine.runtime, instanceGeneration: r.instanceGeneration },
          permissionSupport: SUPPORT,
          ownerCeiling: OWNER_CEILING,
        },
      };
    },
  };
  return machine;
}

export const signal = () => AbortSignal.timeout(10_000);

/** The rejection of `p` (undefined when it resolves). */
export const rejection = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );
