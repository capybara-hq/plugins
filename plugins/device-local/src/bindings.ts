import { randomUUID } from "node:crypto";
import {
  isDeviceRequestNotSent,
  isSandboxPermissionUnsupportedError,
  isSandboxScopeDeniedError,
  isSandboxWorkUnsettledError,
} from "@capybara-hq/plugin-sdk";
import type {
  BindInstanceRequest,
  BindInstanceResult,
  DeviceRuntimeIdentity,
} from "@capybara-hq/plugin-sdk/device-protocol";
import { type MachineCall, OP_DEADLINE_MS } from "./frames.js";
import type { Binding, DeviceLocalStore, InstalledBinding } from "./store.js";

/** The binding cannot be completed; the instance is not handed out and admits nothing. */
export class InstanceBindingError extends Error {
  override name = "InstanceBindingError";
}

/**
 * The generation after `previous`: the clock in milliseconds, or one more than `previous` when the
 * clock is not ahead of it (a rolled-back clock, two creates within one millisecond). Generations
 * are decimal integers that only grow per device: the machine refuses to move a binding back.
 */
export function nextGeneration(previous: string | null, nowMs: number): string {
  const now = BigInt(Math.max(0, Math.floor(nowMs)));
  if (previous === null) return now.toString();
  const after = BigInt(previous) + 1n;
  return (now > after ? now : after).toString();
}

/** Whether two attested identities name the same installed runtime, helper and environment. */
const sameRuntime = (a: DeviceRuntimeIdentity, b: DeviceRuntimeIdentity): boolean =>
  a.runtimeHash === b.runtimeHash &&
  a.helperHash === b.helperHash &&
  a.imageFingerprint === b.imageFingerprint;

/** The binding's request, exactly as committed (a retry resends it unchanged). */
const requestOf = (b: Binding): BindInstanceRequest => ({
  instanceId: b.instanceId,
  instanceGeneration: b.generation,
  bindingId: b.bindingId,
  expectedPreviousGeneration: b.previousGeneration,
});

/**
 * The instance bindings of the device's machine (the post-commit binding of the permission
 * runtime, moved from the kernel). Every instance generation is bound before it is used: `create`
 * commits a new generation and binds it before it returns the handle, `resume` re-sends the
 * identical binding of the handle's generation and re-verifies the answer before it says
 * `resumed`. Nothing here holds a transaction across the machine round trip: the store's writes
 * are single conditional statements.
 *
 * The chain the machine checks: `previousGeneration` is the generation committed before this one,
 * delivered or not. The machine's stored binding of the same credential is always one this
 * provider sent, so it is never newer than that; another credential's binding counts as none on
 * the machine's side (a re-login), so nothing here needs to know which machine is signed in.
 */
export interface InstanceBindings {
  /** Commits the next generation of the device and binds it; resolves the installed binding. */
  bindNew(deviceId: string, signal: AbortSignal): Promise<Binding>;
  /**
   * Re-sends the binding of `generation` and verifies the machine still holds it with the same
   * runtime. `gone` when it can never hold again: the device's binding is another generation, the
   * machine's runtime changed since (a restarted program comes back unbound and refuses the old
   * identity), or the machine refuses the chain; the kernel then recreates the instance, which
   * binds a new generation.
   */
  rebind(deviceId: string, generation: string, signal: AbortSignal): Promise<"bound" | "gone">;
}

export function createInstanceBindings(
  call: MachineCall,
  store: DeviceLocalStore,
  now: () => number = Date.now,
): InstanceBindings {
  /** Sends the binding and installs the verified answer; `gone` when the identity changed. */
  const send = async (b: Binding, signal: AbortSignal): Promise<Binding | "gone"> => {
    const request = requestOf(b);
    // the codec checks the answer against this exact request (ids and the identity's generation)
    const answer = (await call(
      b.deviceId,
      "bindInstance",
      { ...request },
      { deadlineMs: OP_DEADLINE_MS, signal },
    )) as BindInstanceResult;
    if (
      answer.instanceId !== request.instanceId ||
      answer.instanceGeneration !== request.instanceGeneration ||
      answer.bindingId !== request.bindingId ||
      answer.runtimeIdentity.instanceGeneration !== request.instanceGeneration
    )
      throw new InstanceBindingError("The binding answer belongs to another instance generation");
    // an installed generation is never re-attested under another runtime
    if (b.installed && !sameRuntime(b.installed.runtimeIdentity, answer.runtimeIdentity))
      return "gone";
    const installed: InstalledBinding = {
      runtimeIdentity: answer.runtimeIdentity,
      permissionSupport: answer.permissionSupport,
      ownerCeiling: answer.ownerCeiling,
    };
    if (!(await store.installBinding(b.deviceId, b.generation, b.bindingId, installed)))
      throw new InstanceBindingError(
        "The instance was replaced before its binding completed; retry",
      );
    const { unattested: _attestedAgain, ...kept } = b;
    return { ...kept, status: "installed", installed };
  };

  return {
    async bindNew(deviceId, signal) {
      signal.throwIfAborted();
      const current = await store.binding(deviceId);
      const previous = current?.generation ?? null;
      const binding: Binding = {
        deviceId,
        instanceId: deviceId,
        generation: nextGeneration(previous, now()),
        bindingId: randomUUID(),
        previousGeneration: previous,
        status: "awaiting-device",
      };
      if (!(await store.commitBinding(binding, previous)))
        throw new InstanceBindingError(
          "Another instance of this device was created at the same time; retry",
        );
      const bound = await send(binding, signal);
      // a new binding has no earlier identity to differ from
      if (bound === "gone") throw new InstanceBindingError("The new binding was not installed");
      return bound;
    },

    async rebind(deviceId, generation, signal) {
      signal.throwIfAborted();
      const binding = await store.binding(deviceId);
      if (binding?.generation !== generation) return "gone";
      try {
        return (await send(binding, signal)) === "gone" ? "gone" : "bound";
      } catch (e) {
        if (signal.aborted) throw e;
        // nothing reached the machine, or older work has not settled yet: try again later
        if (isDeviceRequestNotSent(e) || isSandboxWorkUnsettledError(e)) throw e;
        // the machine will never bind this generation again (a changed runtime, a refused chain)
        if (isSandboxPermissionUnsupportedError(e) || isSandboxScopeDeniedError(e)) return "gone";
        throw e;
      }
    },
  };
}
