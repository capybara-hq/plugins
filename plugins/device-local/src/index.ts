import {
  DEVICE_PROVIDER_EXTENSION_POINT,
  type DeviceProvider,
  defineExtension,
} from "@capybara-hq/plugin-sdk";
import { DEVICE_DIAL_IN_PROTOCOL } from "@capybara-hq/plugin-sdk/device-protocol";
import { createDialInHandler } from "./hello.js";
import { pgRows } from "./pg-rows.js";
import { createDeviceLocalProvider } from "./provider.js";
import { reportFor, supportFor } from "./report.js";
import { storeOver } from "./store.js";

export { createInstanceBindings, InstanceBindingError, nextGeneration } from "./bindings.js";
export {
  failureOf,
  filesDigestOf,
  machineCall,
  ON_MACHINE_PREFIX,
  POLICY_REFUSAL_PREFIX,
} from "./frames.js";
export { createDialInHandler, decideHello, type HelloRefusal } from "./hello.js";
export {
  applyOwnerReport,
  decideOwnerReport,
  type OwnerFacts,
  type OwnerReportOutcome,
  ownerFactsOf,
  type StoredOwnerReport,
  storedOwnerReportOf,
} from "./owner-report.js";
export { pgRows } from "./pg-rows.js";
export { PROJECT_REFUSAL_TEXT, projectRefusalError } from "./project-refusal.js";
export {
  commandLimits,
  createDeviceLocalProvider,
  type DeviceLocalLifecycle,
  deviceIdOfName,
  EXEC_DEADLINE_MARGIN_MS,
  FRAME_ENVELOPE_BYTES,
  frameCapacity,
  type LocalDeviceHandle,
  maxReadBytes,
  OP_DEADLINE_MS,
  relayer,
} from "./provider.js";
export {
  closedSupport,
  describeLocalDevice,
  deviceReportOf,
  reportFor,
  reportMoved,
  revisionOf,
  sharedRootsValue,
  supportFor,
  supportOf,
} from "./report.js";
export {
  type Binding,
  type BindVia,
  type Connection,
  type DeviceChange,
  type DeviceLocalStore,
  type DeviceRows,
  type DeviceState,
  type InstalledBinding,
  storeOver,
  viaOf,
} from "./store.js";

/**
 * `device-provider@1` over the kernel's dial-in channel: a machine signs in with `capybara-device`
 * (protocol `capybara-device/6`) and serves one device; every operation is relayed to it.
 */
const plugin = defineExtension({
  name: "device-local",
  version: "0.1.0-rc.12",
  // ctx.dialIn.capacity and the handlers' connection argument are the rc.56 SDK's
  sdk: "^0.1.0-rc.56",
  provides: [DEVICE_PROVIDER_EXTENSION_POINT],
  permissions: { dialIn: { protocol: DEVICE_DIAL_IN_PROTOCOL } },
  migrations: "../migrations",
  setup(ctx) {
    const store = storeOver(pgRows(ctx.db));
    const provider: DeviceProvider = {
      ...createDeviceLocalProvider(ctx, store),
      /** From the stored rows only; the org is learned here (a hello names none). */
      async report(device, signal) {
        signal.throwIfAborted();
        return reportFor(store, device);
      },
      /** From the stored rows only, never a machine round trip. */
      async permissionSupport(h, signal) {
        signal.throwIfAborted();
        return supportFor(store, h);
      },
      dialIn: createDialInHandler(ctx, store),
    };
    ctx.provide(DEVICE_PROVIDER_EXTENSION_POINT, provider);
  },
});

export default plugin;
