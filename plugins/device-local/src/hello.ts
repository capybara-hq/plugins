import type { DevicesCtx, DialInHandler, ExtensionContext } from "@capybara-hq/plugin-sdk";
import {
  type DeviceHello,
  type DeviceRuntimeIdentity,
  parseDeviceFrame,
} from "@capybara-hq/plugin-sdk/device-protocol";
import { applyOwnerReport, type OwnerReportOutcome } from "./owner-report.js";
import { revisionOf } from "./report.js";
import type { Binding, Connection, DeviceChange, DeviceLocalStore, DeviceState } from "./store.js";

/** A hello refusal: the kernel closes the connection with `code: message` (shown to the owner). */
export interface HelloRefusal {
  ok: false;
  code:
    | "local.invalid_hello"
    | "local.identity_mismatch"
    | "local.stale_owner_report"
    | "local.owner_report_conflict";
  message: string;
}

/** The kernel's device ids are UUIDs; anything else is not one of ours. */
const DEVICE_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Generations this provider binds: decimal integers (`nextGeneration`), at most 16 digits. */
const GENERATION = /^[0-9]{1,16}$/;
/** The longest home directory a report carries (`DEVICE_REPORT_LIMITS.homeChars`). */
const MAX_HOME_CHARS = 4096;
/** The longest refusal message passed on (the kernel cuts the close reason anyway). */
const MAX_MESSAGE_CHARS = 200;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const refuse = (code: HelloRefusal["code"], message: string): HelloRefusal => ({
  ok: false,
  code,
  message: message.slice(0, MAX_MESSAGE_CHARS),
});

const sameRuntime = (a: DeviceRuntimeIdentity, b: DeviceRuntimeIdentity): boolean =>
  a.runtimeHash === b.runtimeHash &&
  a.helperHash === b.helperHash &&
  a.imageFingerprint === b.imageFingerprint;

/**
 * What a strictly parsed hello does to the device's rows, or why it is refused (then nothing is
 * written). Pure: the caller runs it under the device's lock.
 *
 * - **Runtime identity.** A hello naming the generation of the installed binding must attest the
 *   same runtime, helper and environment it was installed under (`local.identity_mismatch`
 *   otherwise), and may not name a generation this provider never committed. A hello that does not
 *   attest the installed binding (unbound: the program restarted, typically upgraded) marks it
 *   unattested: the machine will never serve that generation again, so the instance is gone and
 *   the kernel recreates it (which binds a new generation under the new runtime). One that attests
 *   it refreshes the binding's support with the hello's.
 * - **Owner report.** The hello's owner ceiling goes through the owner-report rule. A bound
 *   program (same credential) whose report is stale or conflicting is refused. An unbound one
 *   whose sequence is not above the stored one is another machine credential (a login restarts
 *   the sequence): its report is recorded and the machine epoch moves on.
 */
export function decideHello(
  s: DeviceState,
  deviceId: string,
  hello: DeviceHello,
  now: string,
): HelloRefusal | DeviceChange<OwnerReportOutcome> {
  const gen = hello.instanceGeneration;
  if (gen !== null && !GENERATION.test(gen))
    return refuse(
      "local.invalid_hello",
      "The hello's instance generation is not a decimal integer",
    );
  if (hello.home !== undefined && hello.home.length > MAX_HOME_CHARS)
    return refuse("local.invalid_hello", "The hello's home directory is too long");
  const b = s.binding;
  if (gen !== null && b && BigInt(gen) > BigInt(b.generation))
    return refuse(
      "local.identity_mismatch",
      "The machine names an instance generation this deployment never bound; sign in again",
    );
  const installed = b?.status === "installed" ? b.installed : undefined;
  const namesInstalled = installed !== undefined && gen === b?.generation;
  if (
    namesInstalled &&
    hello.runtimeIdentity &&
    !sameRuntime(hello.runtimeIdentity, installed.runtimeIdentity)
  )
    return refuse(
      "local.identity_mismatch",
      "The machine's runtime identity differs from the one its instance was bound under",
    );

  const stored = s.connection;
  let epoch = stored?.machineEpoch ?? 0;
  let applied = applyOwnerReport(stored?.ownerReport ?? null, hello.ownerCeiling, "hello", now);
  if (applied.outcome === "stale" || applied.outcome === "conflict") {
    if (gen !== null)
      return applied.outcome === "stale"
        ? refuse(
            "local.stale_owner_report",
            "The machine's owner report is older than the one recorded; restart capybara-device or sign in again",
          )
        : refuse(
            "local.owner_report_conflict",
            "The machine's owner report conflicts with the one recorded under the same sequence; sign in again",
          );
    // another machine credential: its sequence starts again
    epoch += 1;
    applied = {
      outcome: "recorded",
      next: { report: hello.ownerCeiling, observedAt: now, via: "hello" },
    };
  }

  const connection: Connection = {
    deviceId,
    orgId: stored?.orgId ?? null,
    machineEpoch: epoch,
    mode: hello.mode,
    roots: { workspace: hello.roots.workspace, skills: hello.roots.skills, tmp: hello.roots.tmp },
    home: hello.home ?? null,
    sessionIsolation: hello.sessionIsolation,
    features: [...(hello.features ?? [])],
    permissionSupport: hello.permissionSupport,
    ownerReport: applied.next ?? stored?.ownerReport ?? null,
    instanceGeneration: gen,
    runtimeIdentity: hello.runtimeIdentity ?? null,
  };

  let binding: Binding | undefined;
  if (b && installed) {
    if (namesInstalled && hello.runtimeIdentity) {
      const { unattested: _attested, ...kept } = b;
      binding = {
        ...kept,
        installed: { ...installed, permissionSupport: hello.permissionSupport },
      };
    } else if (!b.unattested) {
      binding = { ...b, unattested: true };
    }
  }
  return { result: applied.outcome, connection, ...(binding && { binding }) };
}

/**
 * The provider's dial-in handler for `capybara-device/5`. The machine is not trusted: every hello
 * and event body is parsed strictly (`parseDeviceFrame`) and checked against the stored binding
 * before anything is stored. When the device's report revision moved, the kernel is told
 * (`ctx.devices.reportChanged`) after the write committed; it reads the report and the permission
 * support from the stored rows (no machine round trip: the connection is not ready yet during a
 * hello).
 */
export function createDialInHandler(
  ctx: { devices: Pick<DevicesCtx, "reportChanged">; log: ExtensionContext["log"] },
  store: DeviceLocalStore,
  now: () => string = () => new Date().toISOString(),
): DialInHandler {
  /** Tells the kernel; a failure is logged (the next hello or change tells it again). */
  const tell = async (deviceId: string) => {
    try {
      await ctx.devices.reportChanged(deviceId);
    } catch (e) {
      ctx.log.warn("could not tell the kernel the device report changed", {
        deviceId,
        error: errMsg(e),
      });
    }
  };

  /** Runs `fn` under the device's lock; tells the kernel when the revision moved. */
  const change = async <T>(
    deviceId: string,
    fn: (s: DeviceState) => DeviceChange<T> | HelloRefusal,
  ): Promise<T | HelloRefusal> => {
    let moved = false;
    const out = await store.change<T | HelloRefusal>(deviceId, (s) => {
      const c = fn(s);
      if ("ok" in c) return { result: c };
      const before = revisionOf(s.connection, s.binding);
      moved = before !== revisionOf(c.connection ?? s.connection, c.binding ?? s.binding);
      return c;
    });
    if (moved) await tell(deviceId);
    return out;
  };

  return {
    async onHello(deviceId, body, signal) {
      signal.throwIfAborted();
      if (typeof deviceId !== "string" || !DEVICE_ID.test(deviceId))
        return refuse("local.invalid_hello", "The device id is not one this provider serves");
      let hello: DeviceHello;
      try {
        hello = parseDeviceFrame(body, "hello");
      } catch (e) {
        return refuse("local.invalid_hello", `Invalid hello: ${errMsg(e)}`);
      }
      const out = await change(deviceId, (s) => decideHello(s, deviceId, hello, now()));
      if (typeof out === "object" && out !== null && "ok" in out) {
        ctx.log.info("refused a machine's hello", { deviceId, code: out.code });
        return out;
      }
      return { ok: true };
    },

    /**
     * A `policy` event: the owner changed the machine's ceiling while connected. Recorded through
     * the owner-report rule (stale ignored, conflicting blocks); an invalid body is logged and
     * dropped (the kernel keeps the connection; the machine's own enforcement stands).
     */
    async onFrame(deviceId, frame) {
      let event: ReturnType<typeof parseDeviceFrame<"event">>;
      try {
        event = parseDeviceFrame(frame, "event");
      } catch (e) {
        ctx.log.warn("dropped an invalid frame from a machine", { deviceId, error: errMsg(e) });
        return;
      }
      await change(deviceId, (s) => {
        if (!s.connection) return { result: "none" };
        const applied = applyOwnerReport(
          s.connection.ownerReport,
          event.ownerCeiling,
          "policy",
          now(),
        );
        if (applied.outcome === "conflict")
          ctx.log.warn("a machine's owner report conflicts with the recorded one", { deviceId });
        return applied.next
          ? { result: applied.outcome, connection: { ...s.connection, ownerReport: applied.next } }
          : { result: applied.outcome };
      });
    },

    /**
     * A revoked machine: the epoch moves on, so what was approved against it no longer stands. A
     * replacement by a newer connection of the same machine changes nothing (its hello is checked
     * like every hello); a deleted device's rows go with its file system (`destroyFileSystem`).
     */
    onClose(deviceId, reason) {
      if (reason !== "revoked") return;
      // the kernel awaits a returned promise only to log its failure; it never throws here
      return change(deviceId, (s) =>
        s.connection
          ? {
              result: undefined,
              connection: { ...s.connection, machineEpoch: s.connection.machineEpoch + 1 },
            }
          : { result: undefined },
      ).then(
        () => undefined,
        (e: unknown) =>
          ctx.log.warn("could not record a revoked machine", { deviceId, error: errMsg(e) }),
      );
    },
  };
}
