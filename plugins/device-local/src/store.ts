import type { SandboxPermissionSupport, SandboxRoots } from "@capybara-hq/plugin-sdk";
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
  /**
   * Moves on when the device's machine is replaced or revoked: part of the report revision, so
   * what was approved against the old machine no longer stands.
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
  instanceGeneration: string | null;
  runtimeIdentity: DeviceRuntimeIdentity | null;
}

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
  /** Reads under the device's lock, applies `fn` (pure, synchronous) and writes what it returns. */
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
   * writes nothing, when another commit came first.
   */
  commitBinding(binding: Binding, expectedGeneration: string | null): Promise<boolean>;
  /**
   * Marks the binding of exactly `generation` and `bindingId` installed with what the machine
   * attested (again, on a resume that re-verified it), and applies the owner ceiling the answer
   * carried to the stored owner report. Returns false, and writes nothing, when the device's
   * binding is no longer that one.
   */
  installBinding(
    deviceId: string,
    generation: string,
    bindingId: string,
    installed: InstalledBinding,
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

/** The store over `rows` (PG in production, memory in unit tests): the binding rules live here. */
export function storeOver(
  rows: DeviceRows,
  now: () => string = () => new Date().toISOString(),
): DeviceLocalStore {
  return {
    binding: async (deviceId) => (await rows.read(deviceId)).binding,
    commitBinding: (binding, expectedGeneration) =>
      rows.change(binding.deviceId, (s) =>
        (s.binding?.generation ?? null) === expectedGeneration
          ? { result: true, binding }
          : { result: false },
      ),
    installBinding: (deviceId, generation, bindingId, installed) =>
      rows.change(deviceId, (s) => {
        const b = s.binding;
        if (b?.generation !== generation || b.bindingId !== bindingId) return { result: false };
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
