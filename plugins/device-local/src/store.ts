import {
  type SandboxLimits,
  type SandboxPermissionSupport,
  type SandboxRoots,
  StaleFenceError,
} from "@capybara-hq/plugin-sdk";
import type {
  DeviceFeature,
  DeviceOwnerCeiling,
  DeviceRuntimeIdentity,
} from "@capybara-hq/plugin-sdk/device-protocol";
import { applyOwnerReport, type StoredOwnerReport } from "./owner-report.js";

/**
 * What the machine attested when it installed a binding (the verified `bindInstance` answer):
 * the runtime identity of the generation, its permission support and the owner ceiling it reported
 * with it.
 */
export interface InstalledBinding {
  runtimeIdentity: DeviceRuntimeIdentity;
  permissionSupport: SandboxPermissionSupport;
  ownerCeiling: DeviceOwnerCeiling;
}

/**
 * The binding of a device's current instance generation: one row per device, replaced by every
 * `create`. `generation` is a decimal integer string that only grows per device (the machine
 * compares generations as integers and never moves back); `previousGeneration` is the generation
 * committed before it (delivered or not), which the machine checks its stored binding against.
 */
export interface Binding {
  deviceId: string;
  /** The instance id the machine binds: the device id (one instance per device). */
  instanceId: string;
  generation: string;
  bindingId: string;
  previousGeneration: string | null;
  status: "awaiting-device" | "installed";
  /** Present exactly when `status` is `installed`. */
  installed?: InstalledBinding;
  /**
   * Set by a hello that did not attest this installed binding (the program restarted unbound,
   * typically under a new runtime after an upgrade): the machine will not serve the generation
   * again, so the instance is gone. Cleared when a binding answer installs it again.
   */
  unattested?: true;
  /**
   * The limits the generation enforces now: those of its `create`, replaced by every `update`
   * that answered `updated`. Absent on a row written before limits were stored (the handle's
   * create-time limits then stand).
   */
  limits?: SandboxLimits;
  /**
   * The highest fence token a lifecycle call of the device carried (`create` seeds it, `update`
   * raises it): a call with a lower token is a stale holder's and is refused. Absent on a row
   * written before tokens were stored (nothing to compare).
   */
  fenceToken?: number;
}

/**
 * What the device's machine said in its last accepted hello, and the owner report every carrier
 * (hello, `policy` event, binding answer) keeps current. One row per device.
 */
export interface Connection {
  deviceId: string;
  /**
   * The device's org, learned from the kernel's first `report` call (a hello names no org); null
   * until then. Reads for another org find nothing.
   */
  orgId: string | null;
  /** The kernel's id of the signed-in machine (its credential) whose hello was accepted. */
  machineId: string;
  /** The connection that hello arrived on (frames of any other connection are dropped). */
  connectionId: string;
  /**
   * Moves on when another machine's hello is accepted or the machine is revoked: part of the
   * report revision, so what was approved against the old machine no longer stands.
   */
  machineEpoch: number;
  mode: "os" | "docker";
  roots: SandboxRoots;
  home: string | null;
  sessionIsolation: boolean;
  features: DeviceFeature[];
  /** The support the hello reported (the bound generation's comes from its binding). */
  permissionSupport: SandboxPermissionSupport;
  /** Null only when the stored one became unreadable (the facts then fail closed). */
  ownerReport: StoredOwnerReport | null;
  /**
   * The project directories of this connection that another connection on the same machine also
   * uses, as the machine's last policy summary listed them (`sharedProjectRoots`: only directories
   * the owner listed for this connection, never naming the other connection); sorted, without
   * duplicates, empty when none or from an older device. Shown in the report only: it is not part
   * of the report revision, so a change never moves the device authority epoch.
   */
  sharedProjectRoots: string[];
  instanceGeneration: string | null;
  runtimeIdentity: DeviceRuntimeIdentity | null;
}

/**
 * The machine and connection a binding request was sent through: the stored connection record when
 * the request left (null: no record). A binding answer is installed only while the record still
 * names them, so a late answer of a replaced machine never re-attests or reports for the new one.
 */
export interface BindVia {
  machineId: string;
  connectionId: string;
}

/** The {@link BindVia} of a stored connection record (null without one). */
export const viaOf = (c: Connection | null): BindVia | null =>
  c ? { machineId: c.machineId, connectionId: c.connectionId } : null;

/** Whether the stored record still names `via` (both absent counts as the same). */
const sameVia = (c: Connection | null, via: BindVia | null): boolean =>
  c === null || via === null
    ? c === null && via === null
    : c.machineId === via.machineId && c.connectionId === via.connectionId;

/** A device's two rows. */
export interface DeviceState {
  connection: Connection | null;
  binding: Binding | null;
}

/** What a {@link DeviceRows.change} writes: the rows to replace (absent: unchanged). */
export interface DeviceChange<T> {
  result: T;
  connection?: Connection;
  binding?: Binding;
}

/**
 * The plugin's rows (schema `plugin_device_local`), one connection and one binding per device. A
 * change reads both rows and writes the replacements under one per-device lock in one transaction,
 * so concurrent writers of a device (a hello, a policy event, a binding answer, a create) never
 * compare against the same old value.
 */
export interface DeviceRows {
  /** Both rows, without a lock. */
  read(deviceId: string): Promise<DeviceState>;
  /**
   * Reads under the device's lock, applies `fn` (pure, synchronous) and writes what it returns.
   * A throwing `fn` writes nothing and rejects with its error.
   */
  change<T>(deviceId: string, fn: (s: DeviceState) => DeviceChange<T>): Promise<T>;
  /** The connection of `deviceId` in `orgId`, claiming a row whose org is not known yet. */
  connectionOf(deviceId: string, orgId: string): Promise<Connection | null>;
  /** Deletes both rows (the device is deleted). */
  forget(deviceId: string): Promise<void>;
}

/**
 * The plugin's durable state, as the provider uses it. Every binding write is conditional, so a
 * delayed answer for a replaced generation can never populate its replacement.
 */
export interface DeviceLocalStore {
  /** The device's current binding, or null when none was ever committed. */
  binding(deviceId: string): Promise<Binding | null>;
  /**
   * Commits a new `awaiting-device` binding in place of the current one, only while the current
   * binding's generation is still `expectedGeneration` (null: no binding yet). Returns false, and
   * writes nothing, when another commit came first. Throws {@link StaleFenceError}, writing
   * nothing, when the current binding holds a higher fence token than the new one carries.
   */
  commitBinding(binding: Binding, expectedGeneration: string | null): Promise<boolean>;
  /**
   * `update` of the instance generation `generation` (device update fencing): in one atomic step,
   * refuses a token lower than the stored one ({@link StaleFenceError}), then raises the stored
   * token and, when `limits` allow at least what the generation enforces (`current` when the row
   * stores none) with the same resources, stores them and answers `updated`. Anything narrower
   * keeps the stored limits and answers `recreate`: a running service or escalated command could
   * still reach a removed host. `gone` (nothing written) when the device's binding is another
   * generation.
   */
  updateLimits(
    deviceId: string,
    generation: string,
    limits: SandboxLimits,
    token: number,
    current: SandboxLimits,
  ): Promise<"updated" | "recreate" | "gone">;
  /**
   * Marks the binding of exactly `generation` and `bindingId` installed with what the machine
   * attested (again, on a resume that re-verified it), and applies the owner ceiling the answer
   * carried to the stored owner report. Returns false, and writes nothing, when the device's
   * binding is no longer that one, or the stored connection record no longer names `via`, the
   * machine and connection the request was sent through (another machine's hello came first).
   */
  installBinding(
    deviceId: string,
    generation: string,
    bindingId: string,
    installed: InstalledBinding,
    via: BindVia | null,
  ): Promise<boolean>;
  /** Both rows of the device, without a lock. */
  state(deviceId: string): Promise<DeviceState>;
  /** See {@link DeviceRows.change}. */
  change<T>(deviceId: string, fn: (s: DeviceState) => DeviceChange<T>): Promise<T>;
  /** See {@link DeviceRows.connectionOf}. */
  connectionOf(deviceId: string, orgId: string): Promise<Connection | null>;
  /** See {@link DeviceRows.forget}. */
  forget(deviceId: string): Promise<void>;
}

/** Throws {@link StaleFenceError} when `held` is higher than `token` (equal: the same holder). */
function assertFresh(deviceId: string, held: number | undefined, token: number, op: string): void {
  if (held !== undefined && held > token)
    throw new StaleFenceError(
      `device-local: the device ${deviceId} holds fence ${held}; ${op} carries ${token}`,
      { current: held },
    );
}

const hostKey = (h: string): string => {
  const l = h.toLowerCase();
  return l.endsWith(".") ? l.slice(0, -1) : l;
};

/** Whether `next` allows every host `prev` allows (open-public allows every public host). */
export function networkCovers(
  next: SandboxLimits["network"],
  prev: SandboxLimits["network"],
): boolean {
  if (next.kind === "open-public") return true;
  if (prev.kind === "open-public") return false;
  const allowed = new Set(next.hosts.map(hostKey));
  return prev.hosts.every((h) => allowed.has(hostKey(h)));
}

const sameResources = (a: SandboxLimits, b: SandboxLimits): boolean =>
  a.cpu === b.cpu && a.memoryMb === b.memoryMb && a.diskMb === b.diskMb;

/** The store over `rows` (PG in production, memory in unit tests): the binding rules live here. */
export function storeOver(
  rows: DeviceRows,
  now: () => string = () => new Date().toISOString(),
): DeviceLocalStore {
  return {
    binding: async (deviceId) => (await rows.read(deviceId)).binding,
    commitBinding: (binding, expectedGeneration) =>
      rows.change(binding.deviceId, (s) => {
        if (binding.fenceToken !== undefined)
          assertFresh(binding.deviceId, s.binding?.fenceToken, binding.fenceToken, "create");
        return (s.binding?.generation ?? null) === expectedGeneration
          ? { result: true, binding }
          : { result: false };
      }),
    updateLimits: (deviceId, generation, limits, token, current) =>
      rows.change(deviceId, (s) => {
        const b = s.binding;
        assertFresh(deviceId, b?.fenceToken, token, "update");
        if (b?.generation !== generation) return { result: "gone" as const };
        const enforced = b.limits ?? current;
        const widens =
          sameResources(limits, enforced) && networkCovers(limits.network, enforced.network);
        const binding: Binding = {
          ...b,
          fenceToken: token,
          ...(widens && { limits: structuredClone(limits) }),
        };
        return { result: widens ? ("updated" as const) : ("recreate" as const), binding };
      }),
    installBinding: (deviceId, generation, bindingId, installed, via) =>
      rows.change(deviceId, (s) => {
        const b = s.binding;
        if (b?.generation !== generation || b.bindingId !== bindingId) return { result: false };
        // the answer came from the machine the request was sent to: never another one's record
        if (!sameVia(s.connection, via)) return { result: false };
        const { unattested: _attestedAgain, ...kept } = b;
        const binding: Binding = { ...kept, status: "installed", installed };
        // the answer is one more owner-report carrier: a newer ceiling is recorded, a stale one
        // ignored, a conflicting one blocks (fail closed)
        const c = s.connection;
        const applied = c && applyOwnerReport(c.ownerReport, installed.ownerCeiling, "bind", now());
        return {
          result: true,
          binding,
          ...(c && applied?.next && { connection: { ...c, ownerReport: applied.next } }),
        };
      }),
    state: (deviceId) => rows.read(deviceId),
    change: (deviceId, fn) => rows.change(deviceId, fn),
    connectionOf: (deviceId, orgId) => rows.connectionOf(deviceId, orgId),
    forget: (deviceId) => rows.forget(deviceId),
  };
}
