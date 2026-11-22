import type { SandboxPermissionSupport } from "@capybara-hq/plugin-sdk";
import type {
  DeviceOwnerCeiling,
  DeviceRuntimeIdentity,
} from "@capybara-hq/plugin-sdk/device-protocol";

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
}

/**
 * The plugin's durable state (schema `plugin_device_local`), as the provider uses it. Task 17
 * implements it over `ctx.db`; every write is conditional, so a delayed answer for a replaced
 * generation can never populate its replacement.
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
   * attested (again, on a resume that re-verified it). Returns false, and writes nothing, when the
   * device's binding is no longer that one.
   */
  installBinding(
    deviceId: string,
    generation: string,
    bindingId: string,
    installed: InstalledBinding,
  ): Promise<boolean>;
}
