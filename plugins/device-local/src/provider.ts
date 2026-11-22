import {
  DeviceOfflineError,
  type DeviceProvider,
  type ExecResult,
  type ExtensionContext,
  type FileSystemHandle,
  isDeviceOfflineError,
  type NetworkBlockedHost,
  parseSandboxBrowseScope,
  parseSandboxOperationScope,
  parseSandboxPreparationScope,
  type SandboxBackground,
  type SandboxBrowse,
  SandboxGoneError,
  type SandboxHandle,
  type SandboxLimits,
  type SandboxOperation,
  type SandboxOperationScope,
  SandboxPermissionUnsupportedError,
  type SandboxPreparation,
  type SandboxRoots,
  validateAllowHost,
} from "@capybara-hq/plugin-sdk";
import type { BackgroundReadOutputResult } from "@capybara-hq/plugin-sdk/device-protocol";
import { createInstanceBindings } from "./bindings.js";
import { EXEC_DEADLINE_MARGIN_MS, machineCall, OP_DEADLINE_MS } from "./frames.js";
import type { DeviceLocalStore } from "./store.js";

export { EXEC_DEADLINE_MARGIN_MS, OP_DEADLINE_MS } from "./frames.js";

/**
 * Room left in a frame for everything around a read result's base64 data (the response
 * envelope): a read is clamped so the machine's answer fits the connection's frame capacity.
 */
export const FRAME_ENVELOPE_BYTES = 64 * 1024;

/**
 * The frame capacity reads are sized for: the kernel's default `devices.dialIn.maxFrameBytes`
 * (`CAPYBARA_DEVICES__DIAL_IN__MAX_FRAME_BYTES`). The channel does not tell an extension the
 * capacity it negotiated with the machine; a deployment that lowers the limit gets the machine's
 * actionable "exceeds negotiated capacity" refusal for a read above it, never a silent cut.
 */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** The most raw bytes whose base64 plus {@link FRAME_ENVELOPE_BYTES} fit in `maxFrameBytes`. */
export const maxReadBytes = (maxFrameBytes: number): number =>
  Math.max(0, Math.floor((maxFrameBytes - FRAME_ENVELOPE_BYTES) / 4) * 3);

/** The most bytes one managed-output read or tail carries (the background contract's bound). */
const OUTPUT_READ_BYTES = 65_536;

const NAME_PREFIX = "cap-device-";

/**
 * The handle of a device's instance on its machine: the device id (one instance per device), the
 * roots the machine reported at `create`, the org's limits the kernel created it with (resources
 * and the outer network, sent with every command), and the generation bound at `create`.
 */
export interface LocalDeviceHandle extends SandboxHandle {
  roots: SandboxRoots;
  limits: SandboxLimits;
  generation: string;
}

/** The device id of a `cap-device-<deviceId>` name; undefined for any other name. */
export const deviceIdOfName = (name: string): string | undefined =>
  name.startsWith(NAME_PREFIX) && name.length > NAME_PREFIX.length
    ? name.slice(NAME_PREFIX.length)
    : undefined;

/** The handle's local fields, or undefined when it is not one this provider made. */
function localHandle(h: SandboxHandle): LocalDeviceHandle | undefined {
  const l = h as Partial<LocalDeviceHandle>;
  return l.roots && l.limits && typeof l.generation === "string"
    ? (h as LocalDeviceHandle)
    : undefined;
}

const sameRoots = (a: SandboxRoots, b: SandboxRoots): boolean =>
  a.workspace === b.workspace && a.skills === b.skills && a.tmp === b.tmp;

const bytesOf = (b64: string): Uint8Array => new Uint8Array(Buffer.from(b64, "base64"));
const b64Of = (data: Uint8Array): string => Buffer.from(data).toString("base64");

/** A raw method: a protocol 5 machine runs work only under an admitted operation scope. */
const refuseRaw =
  (method: string) =>
  async (..._args: unknown[]): Promise<never> => {
    throw new SandboxPermissionUnsupportedError(
      `${method} without an operation scope is not available on a connected machine; run it through an admitted operation scope`,
    );
  };

/** Whether the allowlist entry `pattern` admits `host` (`*.x.com`: subdomains, never the apex). */
const coversHost = (pattern: string, host: string): boolean =>
  pattern === host || (pattern.startsWith("*.") && host.endsWith(pattern.slice(1)));

const normalizeHost = (host: string): string => {
  const h = host.toLowerCase();
  return h.endsWith(".") ? h.slice(0, -1) : h;
};

/** Whether the network a command was sent with lets it reach `host`. */
const networkAllows = (host: string, limits: Pick<SandboxLimits, "network">): boolean => {
  if (limits.network.kind === "open-public") return true;
  const h = normalizeHost(host);
  return limits.network.hosts.some((p) => coversHost(p.toLowerCase(), h));
};

/**
 * The provider's own layer over a machine's network report: it trusts the machine's word that a
 * host was refused, never its word that the org allows it. A host the machine calls `device` that
 * the network the command was sent with (`limits`) does not allow becomes `org` (only an admin can
 * lift it, never a question to the machine's owner); one that is no valid host name, or a
 * wildcard, becomes `address`. Other layers are kept.
 */
export function relayer(
  blocked: NetworkBlockedHost[],
  limits: Pick<SandboxLimits, "network">,
): NetworkBlockedHost[] {
  return blocked.map((b) => {
    if (b.layer !== "device") return b;
    const h = normalizeHost(b.host);
    if (validateAllowHost(h).length > 0 || h.startsWith("*.")) return { ...b, layer: "address" };
    return networkAllows(b.host, limits) ? b : { ...b, layer: "org" };
  });
}

/**
 * The limits a command carries to the machine: the instance's resources, and as the outer network
 * the network the kernel admitted for this operation (its scope: the device sandbox network within
 * the org's ceiling, plus the hosts it granted for the call). The machine intersects it with its
 * owner's ceiling; the kernel's generic wire has no separate grants field, so admitted hosts travel
 * here. An escalated call (`environment`) runs outside the sandbox: its network is the instance's.
 */
export function commandLimits(h: LocalDeviceHandle, scope: SandboxOperationScope): SandboxLimits {
  const { cpu, memoryMb, diskMb } = h.limits;
  const network: SandboxLimits["network"] =
    scope.network.kind === "open-public"
      ? { kind: "open-public", hosts: [] }
      : scope.network.kind === "allowlist"
        ? { kind: "allowlist", hosts: [...scope.network.hosts] }
        : scope.network.kind === "none"
          ? { kind: "allowlist", hosts: [] }
          : { kind: h.limits.network.kind, hosts: [...h.limits.network.hosts] };
  return { cpu, memoryMb, diskMb, network };
}

/** The handle as a local one, or the kernel rebuilds the instance (a handle it cannot use). */
function requireLocal(h: SandboxHandle): LocalDeviceHandle {
  const l = localHandle(h);
  if (!l) throw new SandboxGoneError("The instance handle is not a connected machine's instance");
  return l;
}

/** The provider without its report, permission support and dial-in handler (Task 17's parts). */
export type DeviceLocalLifecycle = Omit<DeviceProvider, "report" | "permissionSupport" | "dialIn">;

/**
 * `device-provider@1` for devices served by a machine connected with `capybara-device`: every
 * operation runs on the device's machine through `ctx.dialIn` (protocol 5). The file system is the
 * machine's device directory, which belongs to the machine's owner: `createFileSystem` touches
 * nothing and `destroyFileSystem` does nothing (deleting the device revokes the machine's credential
 * in the kernel; the files stay on the machine).
 *
 * Every instance generation is bound before use ({@link createInstanceBindings}): `create` binds a
 * new one, `resume` re-verifies the bound one. `suspend` and `destroy` end the generation's tracked
 * background work on the machine (files kept), so the kernel's idle suspension and limits recreate
 * never leave machine work running untracked; neither fails while the machine is offline (the next
 * `resume` or `create` ends it before anything else runs).
 */
export function createDeviceLocalProvider(
  ctx: Pick<ExtensionContext, "dialIn" | "log">,
  store: DeviceLocalStore,
  opts: { now?: () => number } = {},
): DeviceLocalLifecycle {
  const call = machineCall(ctx.dialIn);
  const bindings = createInstanceBindings(call, store, opts.now);

  /**
   * The machine's `create`: it drops the bound generation's tracked background work (exact stops
   * by reference, files kept) and answers the device directory's roots. The only protocol 5
   * operation that ends a generation's work without stopping the program.
   */
  const machineCreate = async (
    deviceId: string,
    limits: SandboxLimits,
    signal: AbortSignal,
  ): Promise<SandboxRoots> =>
    (
      (await call(deviceId, "create", { limits }, { deadlineMs: OP_DEADLINE_MS, signal })) as {
        roots: SandboxRoots;
      }
    ).roots;

  /**
   * `suspend` / `destroy`: ends the generation's background work when the machine is online. A
   * failure is logged, never thrown: the kernel treats every background task of a suspended or
   * destroyed instance as finished, and the next `resume` or `create` ends what is left first.
   */
  const endGenerationWork = async (
    h: SandboxHandle,
    signal: AbortSignal,
    why: "suspend" | "destroy",
  ): Promise<void> => {
    signal.throwIfAborted();
    const l = localHandle(h);
    if (!l) return;
    try {
      if (!(await ctx.dialIn.online(l.id))) return;
      await machineCreate(l.id, l.limits, signal);
    } catch (e) {
      if (signal.aborted) throw e;
      if (!isDeviceOfflineError(e))
        ctx.log.warn(`could not end the device's work on its machine at ${why}`, {
          deviceId: l.id,
          error: e instanceof Error ? e.message : String(e),
        });
    }
  };

  /** The scoped native methods of one operation, relayed under `prefix` with their scope. */
  const native = (
    h: SandboxHandle,
    scope: unknown,
    prefix: "" | "prepare" | "browse",
    factorySignal: AbortSignal,
  ): Omit<Required<SandboxOperation>, "exec"> => {
    const send = (op: string, args: Record<string, unknown>, signal: AbortSignal) =>
      call(
        h.id,
        (prefix ? prefix + op.charAt(0).toUpperCase() + op.slice(1) : op) as never,
        { scope, ...args },
        { deadlineMs: OP_DEADLINE_MS, signal: AbortSignal.any([factorySignal, signal]) },
      );
    return {
      readFile: async (path, o) => {
        const maxBytes = Math.min(o.maxBytes, maxReadBytes(MAX_FRAME_BYTES));
        const r = (await send("readFile", { path, maxBytes }, o.signal)) as {
          dataB64: string;
          truncated: boolean;
        } | null;
        return r === null ? null : { data: bytesOf(r.dataB64), truncated: r.truncated };
      },
      writeFile: async (path, data, signal) => {
        await send("writeFile", { path, dataB64: b64Of(data) }, signal);
      },
      stat: async (path, signal) =>
        (await send("stat", { path }, signal)) as Awaited<ReturnType<SandboxOperation["stat"]>>,
      list: async (path, o) =>
        (await send("list", { path, limit: o.limit }, o.signal)) as Awaited<
          ReturnType<NonNullable<SandboxOperation["list"]>>
        >,
      scan: async (base, o) =>
        (await send("scan", { base }, o.signal)) as Awaited<
          ReturnType<NonNullable<SandboxOperation["scan"]>>
        >,
    };
  };

  const background: SandboxBackground = {
    start: async (h, input, args) => {
      const scope = parseSandboxOperationScope(input);
      const l = requireLocal(h);
      // the machine knows its bound generation: the kernel's generation never goes on the wire
      const { signal, instanceGeneration: _generation, ...rest } = args;
      signal.throwIfAborted();
      return (await call(
        h.id,
        "backgroundStart",
        { scope, ...rest, limits: commandLimits(l, scope) },
        { deadlineMs: args.timeoutMs + EXEC_DEADLINE_MARGIN_MS, signal },
      )) as Awaited<ReturnType<SandboxBackground["start"]>>;
    },
    status: async (h, ref, signal) =>
      (await call(
        h.id,
        "backgroundStatus",
        { ref },
        { deadlineMs: OP_DEADLINE_MS, signal },
      )) as Awaited<ReturnType<SandboxBackground["status"]>>,
    readOutput: async (h, ref, o) => {
      o.signal.throwIfAborted();
      const maxBytes = Math.min(o.maxBytes, OUTPUT_READ_BYTES, maxReadBytes(MAX_FRAME_BYTES));
      const r = (await call(
        h.id,
        "backgroundReadOutput",
        { ref, offset: o.offset, maxBytes },
        { deadlineMs: OP_DEADLINE_MS, signal: o.signal },
      )) as BackgroundReadOutputResult;
      if ("unavailable" in r) return r;
      return {
        data: bytesOf(r.dataB64),
        offset: r.offset,
        nextOffset: r.nextOffset,
        totalBytes: r.totalBytes,
      };
    },
    tail: async (h, ref, o) => {
      const r = (await call(
        h.id,
        "backgroundTail",
        { ref, maxBytes: Math.min(o.maxBytes, OUTPUT_READ_BYTES) },
        { deadlineMs: OP_DEADLINE_MS, signal: o.signal },
      )) as { dataB64: string; truncated: boolean } | { unavailable: "lost" | "expired" };
      return "unavailable" in r ? r : { data: bytesOf(r.dataB64), truncated: r.truncated };
    },
    stop: async (h, ref, o) =>
      (await call(
        h.id,
        "backgroundStop",
        { ref, graceMs: o.graceMs },
        { deadlineMs: OP_DEADLINE_MS, signal: o.signal },
      )) as Awaited<ReturnType<SandboxBackground["stop"]>>,
  };

  return {
    concurrentExec: true,
    networkAllowlist: true,
    sessionIsolation: false,

    operation: async (h, input, signal) => {
      const scope = parseSandboxOperationScope(input);
      const methods = native(h, scope, "", signal);
      return {
        ...methods,
        exec: async (args) => {
          const l = requireLocal(h);
          const { signal: callSignal, ...rest } = args;
          const limits = commandLimits(l, scope);
          const combined = AbortSignal.any([signal, callSignal]);
          combined.throwIfAborted();
          const result = (await call(
            h.id,
            "exec",
            { scope, ...rest, limits },
            { deadlineMs: args.timeoutMs + EXEC_DEADLINE_MARGIN_MS, signal: combined },
          )) as ExecResult;
          if (result.network?.blocked === undefined) return result;
          return { ...result, network: { blocked: relayer(result.network.blocked, limits) } };
        },
      };
    },
    prepare: async (h, input, signal) => {
      const n = native(h, parseSandboxPreparationScope(input), "prepare", signal);
      return {
        readFile: n.readFile,
        writeFile: n.writeFile,
        stat: n.stat,
      } satisfies SandboxPreparation;
    },
    browse: async (h, input, signal) => {
      const n = native(h, parseSandboxBrowseScope(input), "browse", signal);
      return { stat: n.stat, list: n.list, scan: n.scan } satisfies SandboxBrowse;
    },
    revokeOperation: async (h, ref, signal) => {
      await call(h.id, "revokeOperation", { ref }, { deadlineMs: OP_DEADLINE_MS, signal });
    },
    background,

    async createFileSystem(args): Promise<FileSystemHandle> {
      args.signal.throwIfAborted();
      const id = deviceIdOfName(args.name);
      if (id === undefined) throw new Error(`not a device name: ${args.name}`);
      return { id };
    },

    /** The files are the machine owner's: nothing to do (never a machine stop). */
    async destroyFileSystem(_fs, signal) {
      signal.throwIfAborted();
    },

    async destroyFileSystemByName(_name, signal) {
      signal.throwIfAborted();
    },

    /**
     * Asks the machine for a new instance (it ends the older generation's background work), then
     * commits and binds the next generation before the handle is handed out.
     */
    async create(args): Promise<LocalDeviceHandle> {
      const id = args.fileSystem.id;
      if (deviceIdOfName(args.name) !== id)
        throw new Error(`instance ${args.name} does not belong to file system ${id}`);
      const roots = await machineCreate(id, args.limits, args.signal);
      const binding = await bindings.bindNew(id, args.signal);
      return { id, roots, limits: args.limits, generation: binding.generation };
    },

    /**
     * Needs the machine online. Ends any background work a suspension could not reach (the machine
     * was offline then), then re-verifies the generation's binding. `gone` (the kernel recreates the
     * instance) when the handle is not this provider's, the device directory's roots changed (a
     * new login into another directory or mode), or the generation can never be bound again.
     */
    async resume(h, signal) {
      signal.throwIfAborted();
      const l = localHandle(h);
      if (!l) return "gone";
      if (!(await ctx.dialIn.online(l.id))) throw new DeviceOfflineError(l.id);
      const current = await store.binding(l.id);
      if (current?.generation !== l.generation) return "gone";
      const roots = await machineCreate(l.id, l.limits, signal);
      if (!sameRoots(roots, l.roots)) return "gone";
      return (await bindings.rebind(l.id, l.generation, signal)) === "bound" ? "resumed" : "gone";
    },

    async suspend(h, signal) {
      await endGenerationWork(h, signal, "suspend");
    },

    async destroy(h, signal) {
      await endGenerationWork(h, signal, "destroy");
    },

    /**
     * No handle, so no limits to send with the machine's `create`: nothing to do. The next
     * `create` ends the older generation's work before it binds a new one.
     */
    async destroyByName(_name, signal) {
      signal.throwIfAborted();
    },

    /** A protocol 5 machine has no broad kill: the kernel revokes exact operations instead. */
    async killAll(_h, signal) {
      signal.throwIfAborted();
    },

    async killTagged(_h, _tags, signal) {
      signal.throwIfAborted();
    },

    exec: refuseRaw("exec"),
    readFile: refuseRaw("readFile"),
    writeFile: refuseRaw("writeFile"),
    stat: refuseRaw("stat"),
    list: refuseRaw("list"),
    scan: refuseRaw("scan"),
  };
}
