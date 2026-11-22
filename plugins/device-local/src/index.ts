import {
  DEVICE_PROVIDER_EXTENSION_POINT,
  type DeviceProvider,
  defineExtension,
  type SandboxPermissionSupport,
} from "@capybara-hq/plugin-sdk";
import { DEVICE_DIAL_IN_PROTOCOL } from "@capybara-hq/plugin-sdk/device-protocol";
import { createDeviceLocalProvider } from "./provider.js";
import type { DeviceLocalStore } from "./store.js";

export { createInstanceBindings, InstanceBindingError, nextGeneration } from "./bindings.js";
export { failureOf, machineCall, ON_MACHINE_PREFIX, POLICY_REFUSAL_PREFIX } from "./frames.js";
export {
  commandLimits,
  createDeviceLocalProvider,
  type DeviceLocalLifecycle,
  deviceIdOfName,
  EXEC_DEADLINE_MARGIN_MS,
  FRAME_ENVELOPE_BYTES,
  type LocalDeviceHandle,
  MAX_FRAME_BYTES,
  maxReadBytes,
  OP_DEADLINE_MS,
  relayer,
} from "./provider.js";
export type { Binding, DeviceLocalStore, InstalledBinding } from "./store.js";

const NOT_READY =
  "device-local cannot serve machines yet: its store, hello handling and device report are not installed";

/**
 * Interim parts until the store, the hello handling and the device report land (implementation
 * plan Task 17): no machine is accepted, nothing is stored, and the support claims nothing, so no
 * operation is ever admitted on a device of this provider.
 */
const unavailableStore: DeviceLocalStore = {
  binding: async () => {
    throw new Error(NOT_READY);
  },
  commitBinding: async () => {
    throw new Error(NOT_READY);
  },
  installBinding: async () => {
    throw new Error(NOT_READY);
  },
};

const unavailableSupport: SandboxPermissionSupport = {
  version: 2,
  boundary: "operation",
  restricted: null,
  network: { openPublic: false, allowlist: false, perOperationHosts: false },
  outsideSandbox: false,
  background: false,
  unavailableReason: NOT_READY,
};

/**
 * `device-provider@1` over the kernel's dial-in channel: a machine signs in with `capybara-device`
 * (protocol `capybara-device/5`) and serves one device; every operation is relayed to it.
 */
const plugin = defineExtension({
  name: "device-local",
  version: "0.1.0-rc.0",
  // ctx.dialIn, ctx.devices and the protocol 5 bodies are the rc.54 SDK's
  sdk: "^0.1.0-rc.54",
  provides: [DEVICE_PROVIDER_EXTENSION_POINT],
  permissions: { dialIn: { protocol: DEVICE_DIAL_IN_PROTOCOL } },
  setup(ctx) {
    const provider: DeviceProvider = {
      ...createDeviceLocalProvider(ctx, unavailableStore),
      async report(_device, signal) {
        signal.throwIfAborted();
        return {
          revision: "unavailable",
          description: {
            en: "Runs on a computer connected with capybara-device; the computer's owner limits it there.",
            zh: "运行在用 capybara-device 连接的电脑上，由电脑的主人在本机限制它。",
          },
          home: null,
          limits: [],
          reset: false,
        };
      },
      async permissionSupport(_h, signal) {
        signal.throwIfAborted();
        return unavailableSupport;
      },
      dialIn: {
        async onHello() {
          return { ok: false, code: "local.unavailable", message: NOT_READY };
        },
      },
    };
    ctx.provide(DEVICE_PROVIDER_EXTENSION_POINT, provider);
  },
});

export default plugin;
