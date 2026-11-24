import {
  DeviceOfflineError,
  type DeviceProvider,
  type DeviceServiceStatus,
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
  StaleFenceError,
  ToolError,
  validateAllowHost,
} from "@capybara-hq/plugin-sdk";
import type { BackgroundReadOutputResult } from "@capybara-hq/plugin-sdk/device-protocol";
import { createInstanceBindings } from "./bindings.js";
import {
  EXEC_DEADLINE_MARGIN_MS,
  filesDigestOf,
  machineCall,
  OP_DEADLINE_MS,
  SERVICE_OP_DEADLINE_MS,
  ServiceOpRefusedError,
  serviceCall,
} from "./frames.js";
import type { DeviceLocalStore } from "./store.js";

export { EXEC_DEADLINE_MARGIN_MS, OP_DEADLINE_MS } from "./frames.js";

/**
 * Room left in a frame for everything around a read result's base64 data (the response
 * envelope): a read is clamped so the machine's answer fits the connection's frame capacity.
 */
export const FRAME_ENVELOPE_BYTES = 64 * 1024;

/** The most raw bytes whose base64 plus {@link FRAME_ENVELOPE_BYTES} fit in `maxFrameBytes`. */
export const maxReadBytes = (maxFrameBytes: number): number =>
  Math.max(0, Math.floor((maxFrameBytes - FRAME_ENVELOPE_BYTES) / 4) * 3);

/**
 * The negotiated frame capacity of the machine's current connection (`ctx.dialIn.capacity`, the
 * smaller of the machine's and the deployment's `CAPYBARA_DEVICES__DIAL_IN__MAX_FRAME_BYTES`),
 * read before every sized request. No machine holding the device (null), or a capacity that
 * cannot be read, is the device being offline.
 */
export async function frameCapacity(
  dialIn: Pick<ExtensionContext["dialIn"], "capacity">,
  deviceId: string,
): Promise<number> {
  let cap: { maxFrameBytes: number } | null;
  try {
    cap = await dialIn.capacity(deviceId);
  } catch (e) {
    if (isDeviceOfflineError(e)) throw e;
    throw new DeviceOfflineError(deviceId, { cause: e });
  }
  if (cap === null) throw new DeviceOfflineError(deviceId);
  return cap.maxFrameBytes;
}

/** The most bytes one managed-output read or tail carries (the background contract's bound). */
const OUTPUT_READ_BYTES = 65_536;

const NAME_PREFIX = "cap-device-";

/**
 * The handle of a device's instance on its machine: the device id (one instance per device), the
 * roots the machine reported at `create`, the org's limits the kernel created it with, and the
 * generation bound at `create`. The limits in force are the binding's stored ones (`update`
 * replaces them; the kernel keeps the handle as `create` returned it): `limits` here only stands
 * for a binding row that stores none.
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

/** A raw method: a protocol 6 machine runs work only under an admitted operation scope. */
const refuseRaw =
  (method: string) =>
  async (..._args: unknown[]): Promise<never> => {
    throw new SandboxPermissionUnsupportedError(
      `${method} without an operation scope is not available on a connected machine; run it through an admitted operation scope`,
    );
  };

const normalizeHost = (host: string): string => {
  const h = host.toLowerCase();
  return h.endsWith(".") ? h.slice(0, -1) : h;
};

/**
 * The provider's own layer over a machine's network report: a host the machine calls `device`
 * that is no valid host name, or a wildcard, becomes `address` (nobody can allow it from a
 * refusal). Every other report is kept as the machine gave it: whether a `device` host can be
 * granted for a call, and by whom, is the kernel's network-ask planning (it checks the per-call
 * ceiling itself), so a grantable host is never turned into an admin-only one here.
 */
export function relayer(blocked: NetworkBlockedHost[]): NetworkBlockedHost[] {
  return blocked.map((b) => {
    if (b.layer !== "device") return b;
    const h = normalizeHost(b.host);
    return validateAllowHost(h).length > 0 || h.startsWith("*.") ? { ...b, layer: "address" } : b;
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

/** An absolute path the machine reported: a string starting with `/`, without NUL. */
const isAbsolutePath = (v: unknown): v is string =>
  typeof v === "string" && v.startsWith("/") && !v.includes("\0");

/** A service status answer, checked before anything uses it (`codeDir` is kept when present). */
function statusOf(v: unknown): DeviceServiceStatus {
  const s = v as Partial<DeviceServiceStatus> | null;
  if (
    typeof s !== "object" ||
    s === null ||
    typeof s.name !== "string" ||
    (s.state !== "running" && s.state !== "stopped") ||
    (s.startedAt !== null && typeof s.startedAt !== "string") ||
    typeof s.stateDir !== "string" ||
    (s.codeDir !== undefined && !isAbsolutePath(s.codeDir))
  )
    throw new ToolError(
      "The connected machine sent an invalid service status; update capybara-device on that machine and retry",
    );
  return {
    name: s.name,
    state: s.state,
    startedAt: s.startedAt,
    stateDir: s.stateDir,
    ...(s.codeDir !== undefined && { codeDir: s.codeDir }),
  };
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
 * operation runs on the device's machine through `ctx.dialIn` (protocol 6). The file system is the
 * machine's device directory, which belongs to the machine's owner: `createFileSystem` touches
 * nothing and `destroyFileSystem` only forgets the device's rows (deleting the device revokes the
 * machine's credential in the kernel; the files stay on the machine).
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
   * by reference, files kept) and answers the device directory's roots. The only protocol 6
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
      // an older handle never ends the live generation's work: only the device's bound one
      const b = await store.binding(l.id);
      if (b?.generation !== l.generation) return;
      if (!(await ctx.dialIn.online(l.id))) return;
      await machineCreate(l.id, b.limits ?? l.limits, signal);
    } catch (e) {
      if (signal.aborted) throw e;
      if (!isDeviceOfflineError(e))
        ctx.log.warn(`could not end the device's work on its machine at ${why}`, {
          deviceId: l.id,
          error: e instanceof Error ? e.message : String(e),
        });
    }
  };

  /**
   * Before an operation reaches the machine: the handle's generation must be the device's bound
   * one and its binding attested by the machine's last hello. Otherwise the machine will never
   * serve it again (a newer generation, or the program restarted unbound, typically after an
   * upgrade): `SandboxGoneError`, on which the kernel recreates the instance (a new generation
   * bound under the machine's current runtime). Nothing is sent to the machine.
   */
  const assertLive = async (h: SandboxHandle): Promise<LocalDeviceHandle> => {
    const l = requireLocal(h);
    const b = await store.binding(l.id);
    if (!b || b.generation !== l.generation)
      throw new SandboxGoneError("The device's machine no longer holds this instance generation");
    if (b.unattested)
      throw new SandboxGoneError(
        "The machine restarted without this instance's binding (for example after an upgrade)",
      );
    // the limits in force: the binding's, which `update` replaces
    return b.limits ? { ...l, limits: b.limits } : l;
  };

  /** The limits the handle's generation enforces now: its binding's, else the handle's own. */
  const limitsInForce = async (l: LocalDeviceHandle): Promise<SandboxLimits> => {
    const b = await store.binding(l.id);
    return b?.generation === l.generation && b.limits ? b.limits : l.limits;
  };

  /** Refuses a lifecycle call whose fence token is lower than the device's stored one. */
  const assertFence = async (
    deviceId: string,
    fence: { token: number } | null | undefined,
    op: string,
  ): Promise<void> => {
    if (fence === null || fence === undefined) return;
    const held = (await store.binding(deviceId))?.fenceToken;
    if (held !== undefined && held > fence.token)
      throw new StaleFenceError(
        `device-local: the device ${deviceId} holds fence ${held}; ${op} carries ${fence.token}`,
        { current: held },
      );
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
        const cap = await frameCapacity(ctx.dialIn, h.id);
        const maxBytes = Math.min(o.maxBytes, maxReadBytes(cap));
        const r = (await send("readFile", { path, maxBytes }, o.signal)) as {
          dataB64: string;
          truncated: boolean;
        } | null;
        return r === null ? null : { data: bytesOf(r.dataB64), truncated: r.truncated };
      },
      writeFile: async (path, data, signal) => {
        const cap = await frameCapacity(ctx.dialIn, h.id);
        if (data.byteLength > maxReadBytes(cap))
          throw new ToolError(
            `The file is too large to send to the connected machine in one piece (${data.byteLength} bytes, at most ${maxReadBytes(cap)}); use smaller writes, or ask a platform admin to raise the dial-in frame limit`,
          );
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
      const l = await assertLive(h);
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
      const cap = await frameCapacity(ctx.dialIn, h.id);
      const maxBytes = Math.min(o.maxBytes, OUTPUT_READ_BYTES, maxReadBytes(cap));
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
      const cap = await frameCapacity(ctx.dialIn, h.id);
      const r = (await call(
        h.id,
        "backgroundTail",
        { ref, maxBytes: Math.min(o.maxBytes, OUTPUT_READ_BYTES, maxReadBytes(cap)) },
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
      const l = await assertLive(h);
      const methods = native(h, scope, "", signal);
      return {
        ...methods,
        exec: async (args) => {
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
          return { ...result, network: { blocked: relayer(result.network.blocked) } };
        },
      };
    },
    prepare: async (h, input, signal) => {
      const scope = parseSandboxPreparationScope(input);
      await assertLive(h);
      const n = native(h, scope, "prepare", signal);
      return {
        readFile: n.readFile,
        writeFile: n.writeFile,
        stat: n.stat,
      } satisfies SandboxPreparation;
    },
    browse: async (h, input, signal) => {
      const scope = parseSandboxBrowseScope(input);
      await assertLive(h);
      const n = native(h, scope, "browse", signal);
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

    /**
     * The device is deleted: its rows go (connection and binding). The files are the machine
     * owner's: nothing is sent to the machine (never a machine stop).
     */
    async destroyFileSystem(fs, signal) {
      signal.throwIfAborted();
      await store.forget(fs.id);
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
      // a stale holder is refused before the machine is asked (a read: the commit below compares
      // again in its locked transaction); without a fence (an older kernel) nothing is compared
      // and the new generation stores 0
      const fence = args.fence?.token;
      await assertFence(id, args.fence, "create");
      const roots = await machineCreate(id, args.limits, args.signal);
      const binding = await bindings.bindNew(id, args.signal, { limits: args.limits, fence });
      return { id, roots, limits: args.limits, generation: binding.generation };
    },

    /**
     * Applies new limits to the running generation without recreating it, a store write only:
     * every command already carries its operation's network, and the next `ensureService` sends
     * the stored network, on which the machine restarts a running service started with another.
     * A network widening (every enforced host still allowed) is stored with the new resources
     * (sent with the commands from then on) and `updated`; a narrowing or a call without a fence
     * (an older kernel) answers `recreate`, since a running service or escalated command could
     * still reach a removed host. A token lower
     * than the stored one is refused with `StaleFenceError`, checked and stored in one step.
     */
    async update(h, limits, signal, fence) {
      signal.throwIfAborted();
      const l = requireLocal(h);
      if (fence === undefined) return "recreate";
      const answer = await store.updateLimits(l.id, l.generation, limits, fence.token, l.limits);
      if (answer === "gone")
        throw new SandboxGoneError("The device's machine no longer holds this instance generation");
      return answer;
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
      const roots = await machineCreate(l.id, current.limits ?? l.limits, signal);
      if (!sameRoots(roots, l.roots)) return "gone";
      return (await bindings.rebind(l.id, l.generation, signal)) === "bound" ? "resumed" : "gone";
    },

    async suspend(h, signal) {
      await endGenerationWork(h, signal, "suspend");
    },

    async destroy(h, signal, fence) {
      signal.throwIfAborted();
      const l = localHandle(h);
      // a stale holder never ends the work of the generation a newer holder uses
      if (l && (await store.binding(l.id))?.generation === l.generation)
        await assertFence(l.id, fence, "destroy");
      await endGenerationWork(h, signal, "destroy");
    },

    /**
     * No handle, so no limits to send with the machine's `create`: nothing to do. The next
     * `create` ends the older generation's work before it binds a new one.
     */
    async destroyByName(_name, signal) {
      signal.throwIfAborted();
    },

    /** A protocol 6 machine has no broad kill: the kernel revokes exact operations instead. */
    async killAll(_h, signal) {
      signal.throwIfAborted();
    },

    async killTagged(_h, _tags, signal) {
      signal.throwIfAborted();
    },

    /**
     * Starts the service on the machine (or finds it running) with the network the generation
     * enforces now (the binding's limits, which `update` replaces), which the machine compares
     * with the running service's and restarts it on a change (from the spec it launched).
     * `ifRunning` starts nothing: a stopped service answers `stopped`.
     */
    async ensureService(h, spec, signal, o) {
      const l = requireLocal(h);
      const inForce = (await limitsInForce(l)).network;
      const network = { kind: inForce.kind, hosts: [...inForce.hosts] };
      const opts = { deadlineMs: SERVICE_OP_DEADLINE_MS, signal };
      // ifRunning finds a running service by its name: nothing to start, so no files and no retry.
      if (o?.ifRunning)
        return statusOf(
          await serviceCall(
            ctx.dialIn,
            l.id,
            { op: "service.ensure", spec: { name: spec.name }, network, ifRunning: true },
            opts,
          ),
        );
      const filesDigest = filesDigestOf(spec.files);
      const send = async (files?: Record<string, string>) =>
        statusOf(
          await serviceCall(
            ctx.dialIn,
            l.id,
            {
              op: "service.ensure",
              network,
              spec: {
                name: spec.name,
                entry: spec.entry,
                args: spec.args,
                ...(files && { files }),
                ...(spec.env && { env: spec.env }),
              },
              filesDigest,
            },
            opts,
          ),
        );
      // The digest goes first, so a machine that holds these files starts without them crossing
      // the relay (`files_needed` asks for them); an older machine, which does not know the digest
      // and answers `invalid`, gets the files once.
      try {
        return await send();
      } catch (e) {
        if (!(e instanceof ServiceOpRefusedError)) throw e;
      }
      // Encoded only now that the machine asked for them, and checked against the frame capacity
      // of the machine's connection, which would otherwise drop the oversized frame.
      const files: Record<string, string> = {};
      let size = 0;
      for (const [path, data] of Object.entries(spec.files)) {
        files[path] = b64Of(data);
        size += files[path].length + path.length;
      }
      const cap = await frameCapacity(ctx.dialIn, l.id);
      if (size + FRAME_ENVELOPE_BYTES > cap)
        throw new ToolError(
          `The service files for ${spec.name} (${size} bytes encoded) do not fit in one frame of the connected machine (${cap} bytes); raise CAPYBARA_DEVICES__DIAL_IN__MAX_FRAME_BYTES on the deployment and the machine, or use a smaller service`,
        );
      return await send(files);
    },

    async stopService(h, name, signal) {
      const l = requireLocal(h);
      await serviceCall(
        ctx.dialIn,
        l.id,
        { op: "service.stop", name },
        { deadlineMs: SERVICE_OP_DEADLINE_MS, signal },
      );
    },

    async serviceStatus(h, name, signal) {
      const l = requireLocal(h);
      return statusOf(
        await serviceCall(
          ctx.dialIn,
          l.id,
          { op: "service.status", name },
          { deadlineMs: OP_DEADLINE_MS, signal },
        ),
      );
    },

    async serviceRequest(h, name, body, o) {
      const l = requireLocal(h);
      const result = (await serviceCall(
        ctx.dialIn,
        l.id,
        { op: "service.request", name, body: b64Of(body), timeoutMs: o.timeoutMs },
        { deadlineMs: o.timeoutMs + EXEC_DEADLINE_MARGIN_MS, signal: o.signal },
      )) as { body?: unknown } | null;
      if (typeof result?.body !== "string")
        throw new ToolError(
          "The connected machine sent an invalid answer to service.request; update capybara-device on that machine and retry",
        );
      return bytesOf(result.body);
    },

    async openStream(h, target, signal) {
      const l = requireLocal(h);
      return await ctx.dialIn.openStream(l.id, { service: target.service }, { signal });
    },

    exec: refuseRaw("exec"),
    readFile: refuseRaw("readFile"),
    writeFile: refuseRaw("writeFile"),
    stat: refuseRaw("stat"),
    list: refuseRaw("list"),
    scan: refuseRaw("scan"),
  };
}
