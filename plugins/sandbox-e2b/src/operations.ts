import { createHash, randomBytes } from "node:crypto";
import { posix } from "node:path";
import {
  type ExecResult,
  parseSandboxBrowseScope,
  parseSandboxExecutionRef,
  parseSandboxOperationRef,
  parseSandboxOperationScope,
  parseSandboxPreparationScope,
  type SandboxBackground,
  type SandboxBrowse,
  type SandboxBrowseScope,
  type SandboxExecOptions,
  type SandboxExecutionRef,
  type SandboxHandle,
  type SandboxOperation,
  SandboxOperationOutcomeUnknownError,
  type SandboxOperationRef,
  type SandboxOperationScope,
  type SandboxPermissionSupport,
  SandboxPermissionUnsupportedError,
  type SandboxPreparation,
  type SandboxPreparationScope,
  SandboxScopeDeniedError,
  SandboxScopeValidationError,
  type SandboxStopResult,
  validateSandboxPathShape,
} from "@capybara-hq/plugin-sdk";
import {
  OPERATION_AGENT,
  OPS_DIR,
  RUNTIME_BASE,
  RUNTIME_DIR,
  runtimeFiles,
  sdkRuntimeDigests,
} from "./runtime-source.js";

/*
 * The operation-capable half of the E2B provider (core spec 2026-11-16 permission operation
 * contract), adapted from sandbox-docker's operations.ts: runtime capabilities, the per-invocation
 * operation factory, owner browsing, trusted preparation, revocation and exact background
 * supervision, all through the provider's agent inside the one device VM.
 *
 * The microVM is the sandbox (core approval-only profiles design, decision 1): its whole
 * filesystem is every operation's scope and its E2B network policy (open-public with the SDK's
 * closed IPv4 classes denied, or the device's allowlist) is the sandbox network. Support v2 says so
 * (`boundary: "instance"`, no restricted filters, no outside, no per-operation hosts). The kernel's
 * whole-instance scope runs the provider's ordinary exec and native paths behind the durable
 * admission, with the VM's existing OS user, environment and network. A narrower filesystem grant
 * (restricted filters: the SDK launcher needs Landlock ABI 6, which the tested template kernel
 * lacks, README "Permission profiles") and the escalated pair (an instance has no outside) are
 * refused before any effect, never widened. Every method resolves nothing itself: the immutable
 * scope is the whole grant.
 */

/** One command in the VM (provider.ts `run`). */
export interface AgentRun {
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
  truncated: boolean;
  timedOut: boolean;
  aborted: boolean;
}

export interface AgentRunOpts {
  cmd: string[];
  user: "sandbox" | "root";
  env?: Record<string, string>;
  stdin?: Uint8Array;
  maxOutputBytes: number;
  timeoutMs?: number;
  signal: AbortSignal;
}

/** What operations.ts needs from the provider (closures in provider.ts). */
export interface OperationTransport {
  /** Runs in the VM, connecting (and so resuming) it first; SandboxGoneError when it is gone. */
  run(h: SandboxHandle, o: AgentRunOpts): Promise<AgentRun>;
  /**
   * Connects (resumes) the VM once and returns a runner for several agent commands of one
   * operation call (consume, then the native call) on that connection.
   */
  session(h: SandboxHandle, signal: AbortSignal): Promise<(o: AgentRunOpts) => Promise<AgentRun>>;
  /** Runs only in an already running VM: never connects, starts or resumes it. */
  runIfRunning(h: SandboxHandle, o: AgentRunOpts): Promise<AgentRun | "not-running">;
  /** The provider's ordinary exec (Full access), with an admission prefix before its wrapper. */
  execFull(
    h: SandboxHandle,
    args: SandboxExecOptions & { tag: string },
    ctl: string,
    prefix: string[],
    nonce: string,
  ): Promise<ExecResult>;
  /**
   * The network policy the VM applies (`GET /sandboxes/{id}`, never connects), or null when it is
   * unknown; SandboxGoneError when the VM is gone.
   */
  appliedNetwork(h: SandboxHandle, signal: AbortSignal): Promise<AppliedNetwork | null>;
  /** Kills every foreground execution whose control path carries `uuid` (reboots if it cannot). */
  killOperation(h: SandboxHandle, uuid: string, signal: AbortSignal): Promise<void>;
  /** Test-only hooks (E2BSandboxTestOptions). */
  loseBackgroundAck?: ((taskId: string) => boolean) | undefined;
  backgroundStartCommand?: ((taskId: string, cmd: string[]) => string[]) | undefined;
}

/**
 * Paths reserved for the provider: its records, runtime, root staging area (`/opt/capybara`) and
 * the Full wrapper's control files. A read root inside them, or a preparation or output path
 * there, is refused (the agent applies the same rule).
 */
// capybara:allow-module-state read-only list of reserved paths, never mutated
const PROTECTED = Object.freeze(["/tmp/.capybara-exec-", OPS_DIR, "/opt/capybara", RUNTIME_BASE]);

export function protectedRoot(path: string, write: boolean): boolean {
  const p = posix.normalize(path);
  for (const entry of PROTECTED) {
    const bare = entry.replace(/-$/, "");
    const inside = p === bare || p.startsWith(`${entry.replace(/\/$/, "")}/`);
    if (write && (inside || entry.startsWith(`${p.replace(/\/$/, "")}/`))) return true;
    if (!write && inside && entry !== "/tmp/.capybara-exec-") return true;
  }
  return false;
}

const PYTHON = "/usr/bin/python3";
/** Stdout + stderr of one framed native reply (a listing of every entry fits well within it). */
const NATIVE_MAX_OUTPUT = 64 * 1024 * 1024;
/** How long a consumed record stays after its admission deadline. */
const RECORD_RETENTION_MS = 60 * 60 * 1000;
/** The in-VM time limit of one record step or native call (ms). */
const STEP_TIMEOUT_MS = 120_000;

/** A UUID-shaped, deterministic control suffix for an operation ID (revocation finds it). */
export function operationUuid(operationId: string): string {
  const h = createHash("sha256").update(`capybara-operation\0${operationId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** The control path of an operation (the provider's `execControlPath` shape, tag first). */
export function operationControlPath(tag: string, operationId: string): string {
  return `/tmp/.capybara-exec-${tag}-${operationUuid(operationId)}`;
}

const opKey = (operationId: string) => createHash("sha256").update(operationId).digest("hex");

/** Canonical JSON (sorted keys) for the input digest of a consumed operation. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function inputHash(method: string, scope: unknown, input: unknown): string {
  return createHash("sha256").update(canonical({ method, scope, input })).digest("hex");
}

/** Length-prefixed request for the agent's stdin. */
function request(body: unknown): Uint8Array {
  const json = Buffer.from(JSON.stringify(body));
  return Buffer.concat([Buffer.from(`${json.byteLength}\n`), json]);
}

interface Frames {
  out: Buffer[];
  err: Buffer[];
  result: AgentResult | null;
}

interface AgentEvent {
  event: string;
  code?: string;
  message?: string;
  [key: string]: unknown;
}

interface AgentResult {
  events?: AgentEvent[];
  native?: { result?: unknown; error?: { code: string; message: string } } | null;
  probe?: { restricted: unknown; reason?: string; arch?: string; landlockAbi?: number };
  kernel?: string;
  state?: string;
  [key: string]: unknown;
}

/** Splits the agent's framed stdout (kind byte, 4-byte big-endian length, data). */
export function parseFrames(raw: Buffer): Frames {
  const frames: Frames = { out: [], err: [], result: null };
  let at = 0;
  while (at + 5 <= raw.byteLength) {
    const kind = String.fromCharCode(raw[at] as number);
    const size = raw.readUInt32BE(at + 1);
    if (at + 5 + size > raw.byteLength) break;
    const data = raw.subarray(at + 5, at + 5 + size);
    if (kind === "O") frames.out.push(data);
    else if (kind === "E") frames.err.push(data);
    else if (kind === "R") {
      try {
        frames.result = JSON.parse(data.toString("utf8")) as AgentResult;
      } catch {
        frames.result = null;
      }
    }
    at += 5 + size;
  }
  return frames;
}

/**
 * The one result frame a background start writes, or "malformed" when its stdout holds anything
 * else (same-uid processes can write into the start's descriptors during its start-up).
 */
function soleResult(raw: Buffer): AgentResult | null | "malformed" {
  if (raw.byteLength === 0) return null;
  if (raw.byteLength < 5 || String.fromCharCode(raw[0] as number) !== "R") return "malformed";
  if (5 + raw.readUInt32BE(1) !== raw.byteLength) return "malformed";
  try {
    return JSON.parse(raw.subarray(5).toString("utf8")) as AgentResult;
  } catch {
    return "malformed";
  }
}

/** Maps the agent's refusal to the SDK's error kinds (never SandboxGoneError). */
function refusalError(result: AgentResult | null): Error | null {
  const refused = result?.events?.find((e) => e.event === "refused");
  if (!refused) return null;
  switch (refused.code) {
    case "UNAVAILABLE":
      return new SandboxPermissionUnsupportedError(
        `Restricted execution is unavailable on this device: ${refused.message ?? "unsupported"}`,
      );
    case "SCOPE_DENIED":
    case "ROOT_CHANGED":
      return new SandboxScopeDeniedError(
        "A granted root is missing its pinned identity or the path is outside the operation scope",
      );
    case "REVOKED":
      return new SandboxScopeDeniedError("The operation was revoked before it started");
    case "EXPIRED":
      return new SandboxScopeDeniedError("The operation's admission deadline passed");
    case "CANCELLED":
      return null;
    default:
      return new Error(`Operation refused (${refused.code ?? "unknown"})`);
  }
}

/**
 * The refusal in a Full access admission frame: an error, `"cancelled"`, or null when none. Only a
 * frame carrying this invocation's nonce counts: the command never sees the nonce (the agent
 * removes it from its environment before exec), so a command cannot fake "not executed".
 */
export function refusedFrame(raw: Buffer, nonce: string): Error | "cancelled" | null {
  const result = parseFrames(raw).result;
  if (!result || result.nonce !== nonce) return null;
  if (result.events?.some((e) => e.event === "refused" && e.code === "CANCELLED")) {
    return "cancelled";
  }
  return refusalError(result);
}

function checkPath(p: string): void {
  const errors = validateSandboxPathShape(p);
  if (errors.length > 0) {
    throw new SandboxScopeDeniedError(`Invalid native path: ${errors.join("; ")}`);
  }
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function checkedEnv(env: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    if (!ENV_KEY_RE.test(k)) throw new Error(`invalid environment variable name: ${k}`);
    out[k] = v;
  }
  return out;
}

const NO_RUNTIME =
  "The device has no operation runtime (sandbox-e2b stages it as root on first use; check that the template provides /usr/bin/python3 and sha256sum)";

function nativeReply(result: AgentResult | null, scoped: boolean): unknown {
  const error = refusalError(result);
  if (error) throw error;
  if (!result) throw new SandboxPermissionUnsupportedError(NO_RUNTIME);
  const reply = result.native;
  if (!reply) throw new Error("The native helper gave no reply");
  if (reply.error) {
    if (reply.error.code === "SCOPE_DENIED" || (scoped && reply.error.code === "EACCES")) {
      throw new SandboxScopeDeniedError("The native path is outside the operation scope");
    }
    throw new Error(`Native operation failed (${reply.error.code})`);
  }
  return reply.result;
}

type NativeMethod = "readFile" | "writeFile" | "stat" | "list" | "scan";

/** Decodes the helper's native results into the SDK shapes. */
function nativeResult(method: NativeMethod, value: unknown): unknown {
  if (method === "readFile") {
    const v = value as { dataB64: string; truncated: boolean } | null;
    return v && { data: new Uint8Array(Buffer.from(v.dataB64, "base64")), truncated: v.truncated };
  }
  if (method === "writeFile") return undefined;
  return value;
}

const OUTSIDE_UNSUPPORTED =
  "sandbox-e2b has no outside of its instance: the microVM is the sandbox, so an escalated (device) operation cannot run here";
const NARROWER_UNSUPPORTED =
  "sandbox-e2b runs operations on the whole instance only (the microVM is the sandbox): a narrower filesystem grant needs restricted filters, and the SDK launcher's Landlock ABI 6 is not available on this template";

/** The network a VM applies: no network, an allowlist of hosts, or open-public. */
export interface AppliedNetwork {
  mode: "none" | "allowlist" | "open-public";
  allowHosts: string[];
}

/**
 * Whether the VM's applied network allows nothing beyond the operation's network (pure). The VM
 * network covers every operation (no per-operation hosts), so an operation whose network is
 * narrower than the VM's would be silently widened: it is refused instead. A VM whose network is
 * unknown admits nothing. Hosts compare case-insensitively as written.
 */
export function appliedWithin(
  network: SandboxOperationScope["network"],
  applied: AppliedNetwork | null,
): boolean {
  if (applied === null) return false;
  if (network.kind === "open-public") return true;
  if (network.kind === "environment") return false;
  if (applied.mode === "none") return true;
  if (network.kind === "none" || applied.mode === "open-public") return false;
  const granted = new Set(network.hosts.map((host) => host.toLowerCase()));
  return applied.allowHosts.every((host) => granted.has(host.toLowerCase()));
}

/**
 * Whether a scope is the whole instance: the kernel names `/` (plus the working root) readable and
 * writable on an instance-boundary device. Anything narrower would need restricted filters.
 */
export function isInstanceScope(scope: SandboxOperationScope): boolean {
  return (
    scope.filesystem.kind === "scoped" &&
    scope.network.kind !== "environment" &&
    // writable roots are also readable (SandboxFileScope): a writable `/` is the whole instance
    scope.filesystem.writeRoots.includes("/")
  );
}

export interface OperationDeps {
  transport: OperationTransport;
  decode: (buf: Buffer, truncated: boolean) => string;
  /** What the VM's network policy offers: allowlists are off where domain allowlists are. */
  network: { allowlist: boolean };
}

/** The permission-capable methods of the E2B provider. */
export function createOperations(deps: OperationDeps) {
  const { transport: t } = deps;

  /** Refuses an operation whose network is narrower than the VM's (before any VM call). */
  const checkNetwork = async (
    h: SandboxHandle,
    scope: SandboxOperationScope,
    signal: AbortSignal,
  ) => {
    if (!appliedWithin(scope.network, await t.appliedNetwork(h, signal))) {
      throw new SandboxScopeDeniedError(
        "The VM's network allows more than this operation's network (or is not this provider version's); sandbox-e2b cannot narrow it per operation, so the operation is refused. Changing the device's network or resetting its files applies the current policy",
      );
    }
  };

  /** Root-run record steps (consume, markers, background records). */
  const rootStep = async (
    h: SandboxHandle,
    command: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
    started = false,
  ): Promise<AgentResult | "not-running"> => {
    const o: AgentRunOpts = {
      cmd: [PYTHON, "-I", OPERATION_AGENT, command],
      user: "root",
      stdin: request(body),
      maxOutputBytes: 1 << 20,
      timeoutMs: STEP_TIMEOUT_MS,
      signal,
    };
    const r = started ? await t.run(h, o) : await t.runIfRunning(h, o);
    if (r === "not-running") return r;
    if (r.aborted) signal.throwIfAborted();
    const result = parseFrames(r.stdout).result;
    if (!result) throw new Error(`The operation record step ${command} gave no result`);
    const error = refusalError(result);
    if (error) throw error;
    return result;
  };

  /** Atomically consumes `(generation, operationId)` before any effect (root-only records). */
  const record = async (
    h: SandboxHandle,
    ref: SandboxOperationRef,
    method: string,
    hash: string,
    signal: AbortSignal,
    retainUntilMs?: number,
    runner?: (o: AgentRunOpts) => Promise<AgentRun>,
  ): Promise<{ state: "new" | "duplicate"; generation: string }> => {
    const exec = runner ?? ((o: AgentRunOpts) => t.run(h, o));
    const r = await exec({
      cmd: [PYTHON, "-I", OPERATION_AGENT, "consume"],
      user: "root",
      stdin: request({
        opKey: opKey(ref.operationId),
        method,
        inputHash: hash,
        admitBeforeMs: ref.admitBeforeMs,
        expiresAtMs: Math.max(ref.admitBeforeMs, retainUntilMs ?? 0) + RECORD_RETENTION_MS,
      }),
      maxOutputBytes: 1 << 20,
      timeoutMs: STEP_TIMEOUT_MS,
      signal,
    });
    if (r.aborted) signal.throwIfAborted();
    const result = parseFrames(r.stdout).result;
    if (r.exitCode !== 0 || !result) throw new SandboxPermissionUnsupportedError(NO_RUNTIME);
    const error = refusalError(result);
    if (error) throw error;
    switch (result.state) {
      case "new":
        return { state: "new", generation: String(result.generation) };
      case "duplicate":
        return {
          state: "duplicate",
          generation: String((result.record as { generation?: unknown } | undefined)?.generation),
        };
      case "revoked":
        throw new SandboxScopeDeniedError("The operation was revoked");
      case "expired":
        throw new SandboxScopeDeniedError("The operation's admission deadline passed");
      case "mismatch":
        throw new SandboxScopeValidationError(
          "This operation ID was consumed with a different method or input",
        );
      default:
        throw new Error("Unexpected operation record state");
    }
  };

  /** Consumes a foreground operation: a duplicate is an unknown outcome, never a repeat. */
  const consume = async (
    h: SandboxHandle,
    ref: SandboxOperationRef,
    method: string,
    hash: string,
    signal: AbortSignal,
    runner?: (o: AgentRunOpts) => Promise<AgentRun>,
  ) => {
    const r = await record(h, ref, method, hash, signal, undefined, runner);
    if (r.state === "duplicate") {
      throw new SandboxOperationOutcomeUnknownError(
        "This operation ID was already consumed; its outcome is not retried",
      );
    }
  };

  /** Runs one agent command (`direct`) and parses its result frame. */
  const direct = async (
    h: SandboxHandle,
    user: "sandbox" | "root",
    body: Record<string, unknown>,
    signal: AbortSignal,
    runner?: (o: AgentRunOpts) => Promise<AgentRun>,
  ) => {
    const exec = runner ?? ((o: AgentRunOpts) => t.run(h, o));
    const r = await exec({
      cmd: [PYTHON, "-I", OPERATION_AGENT, "direct"],
      user,
      stdin: request(body),
      maxOutputBytes: NATIVE_MAX_OUTPUT,
      timeoutMs: STEP_TIMEOUT_MS,
      signal,
    });
    if (r.aborted) signal.throwIfAborted();
    if (r.timedOut) throw new Error("The native operation timed out");
    return parseFrames(r.stdout).result;
  };

  /** Native work on the whole instance: the helper on "/" as the device user (descriptor-relative). */
  const nativeOp = async (
    h: SandboxHandle,
    scope: SandboxOperationScope,
    method: NativeMethod,
    native: Record<string, unknown>,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    checkPath(String(native.path));
    const input = { ...native, dataB64: undefined, data: digestOf(native.dataB64) };
    // native work runs no command and opens no connection: the network does not apply
    const runner = await t.session(h, signal);
    await consume(h, scope, method, inputHash(method, scope, input), signal, runner);
    const result = await direct(
      h,
      "sandbox",
      {
        opKey: opKey(scope.operationId),
        admitBeforeMs: scope.admitBeforeMs,
        expect: sdkRuntimeDigests(),
        kind: "device",
        native: { method, ...native },
      },
      signal,
      runner,
    );
    signal.throwIfAborted();
    return nativeResult(method, nativeReply(result, false));
  };

  const execOp = async (
    h: SandboxHandle,
    scope: SandboxOperationScope,
    args: SandboxExecOptions,
  ): Promise<ExecResult> => {
    args.signal.throwIfAborted();
    const input = { ...args, signal: undefined, env: args.env };
    await checkNetwork(h, scope, args.signal);
    await consume(h, scope, "exec", inputHash("exec", scope, input), args.signal);
    const ctl = operationControlPath(scope.tag, scope.operationId);
    return t.execFull(
      h,
      { ...args, tag: scope.tag },
      ctl,
      [
        PYTHON,
        "-I",
        OPERATION_AGENT,
        "full",
        opKey(scope.operationId),
        String(scope.admitBeforeMs),
        ctl,
        "--",
      ],
      randomBytes(16).toString("hex"),
    );
  };

  /**
   * Only the whole instance runs here (`isInstanceScope`): the escalated pair and any narrower
   * filesystem grant are refused before any effect, never widened. Every operation runs under the
   * VM's own network policy (no per-operation hosts); one whose network is narrower than the VM's
   * applied policy is refused when it runs (`checkNetwork`), never silently widened.
   */
  const checkScope = (scope: SandboxOperationScope) => {
    if (scope.filesystem.kind === "device" || scope.network.kind === "environment") {
      throw new SandboxPermissionUnsupportedError(OUTSIDE_UNSUPPORTED);
    }
    if (!isInstanceScope(scope)) throw new SandboxPermissionUnsupportedError(NARROWER_UNSUPPORTED);
  };

  const checkReadRoots = (readRoots: readonly string[]) => {
    for (const root of readRoots) {
      if (posix.normalize(root) !== root) {
        throw new SandboxScopeDeniedError("Granted roots must be canonical absolute paths");
      }
      if (protectedRoot(root, false)) {
        throw new SandboxScopeDeniedError(
          "A readable root may not be inside the provider's records",
        );
      }
    }
  };

  /** The exact execution a reference names on this handle; other instances are scope-denied. */
  const exactRef = (h: SandboxHandle, input: SandboxExecutionRef) => {
    const ref = parseSandboxExecutionRef(input);
    if (ref.instanceId !== h.id || ref.executionId !== operationUuid(ref.operationId)) {
      throw new SandboxScopeDeniedError("The execution reference names another instance");
    }
    return ref;
  };

  /** One root-run read of a background record against a running VM (never resumes it). */
  const bgCall = (
    h: SandboxHandle,
    command: "bg-status" | "bg-tail" | "bg-read",
    ref: SandboxExecutionRef,
    extra: Record<string, unknown>,
    signal: AbortSignal,
  ) =>
    rootStep(
      h,
      command,
      { executionId: ref.executionId, generation: ref.instanceGeneration, ...extra },
      signal,
    );

  /**
   * Stops one recorded execution: root reads the recorded identity, the sandbox user signals
   * exactly that supervisor (pidfd, start time), root claims the outcome once.
   */
  const stopExecution = async (
    h: SandboxHandle,
    executionId: string,
    generation: string | null,
    graceMs: number,
    signal: AbortSignal,
    aborted = false,
  ): Promise<SandboxStopResult> => {
    const key = { executionId, generation, anyGeneration: generation === null };
    const plan = await rootStep(h, "bg-stop-plan", key, signal);
    if (plan === "not-running") return { outcome: "lost" };
    if (plan.outcome) return toStopResult(plan.outcome as AgentResult);
    let signalled = false;
    const target = plan.signal as { pid: number; start: number } | undefined;
    if (target) {
      const r = await t.runIfRunning(h, {
        cmd: [PYTHON, "-I", OPERATION_AGENT, "bg-signal"],
        user: "sandbox",
        stdin: request({ ...target, graceMs }),
        maxOutputBytes: 1 << 20,
        timeoutMs: STEP_TIMEOUT_MS,
        signal,
      });
      if (r === "not-running") return { outcome: "lost" };
      signalled = parseFrames(r.stdout).result?.signalled === true;
    }
    const claim = await rootStep(
      h,
      "bg-stop-claim",
      { ...key, signalled, ...(aborted && { aborted }) },
      signal,
    );
    if (claim === "not-running") return { outcome: "lost" };
    return toStopResult(claim);
  };

  /**
   * Aborts a background start: the root cancellation marker (a late supervisor never launches),
   * then a stop by the recorded identity whose claim marks the reference aborted, so status
   * reports it lost and serves none of its output. Best effort with its own deadline.
   */
  const abortStart = async (
    h: SandboxHandle,
    scope: SandboxOperationScope,
    ref: SandboxExecutionRef,
  ) => {
    const cleanup = AbortSignal.timeout(30_000);
    await rootStep(
      h,
      "cancel-mark",
      { opKey: opKey(scope.operationId), expiresAtMs: scope.admitBeforeMs + RECORD_RETENTION_MS },
      cleanup,
    )
      .then(() => stopExecution(h, ref.executionId, ref.instanceGeneration, 0, cleanup, true))
      .catch(() => undefined);
  };

  /**
   * A start is contested when a second supervisor presented the token and the admitted digest
   * after one was bound: one of them is not the provider's own, so an unacknowledged contested
   * start is aborted.
   */
  const abortIfContested = async (
    h: SandboxHandle,
    scope: SandboxOperationScope,
    ref: SandboxExecutionRef,
  ) => {
    const check = await rootStep(
      h,
      "bg-contested",
      { executionId: ref.executionId, generation: ref.instanceGeneration },
      AbortSignal.timeout(15_000),
    ).catch(() => "not-running" as const);
    if (check !== "not-running" && check.contested === true) await abortStart(h, scope, ref);
  };

  const MAX_OUTPUT_READ = 65_536;
  const bytes = (result: AgentResult) =>
    new Uint8Array(Buffer.from(String(result.dataB64 ?? ""), "base64"));
  const checkMaxBytes = (maxBytes: number) => {
    if (!Number.isInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_OUTPUT_READ) {
      throw new SandboxScopeDeniedError("Supply maxBytes as an integer from 0 to 65536");
    }
  };

  /**
   * Exact background supervision of whole-instance work: a detached supervisor per operation inside
   * the VM records itself (pid and start time) with a root recorder before `start` acknowledges,
   * appends merged output to the root spool and to `outputPath`, and records the exit. Status,
   * tail, output reads and stop use only the recorded identity and never resume the VM.
   */
  const background: SandboxBackground = {
    async start(h, input, args) {
      args.signal.throwIfAborted();
      const scope = parseSandboxOperationScope(input);
      checkScope(scope);
      if (typeof args.taskId !== "string" || args.taskId.length === 0 || args.taskId.length > 128) {
        throw new SandboxScopeValidationError("Supply a task id of 1 to 128 characters");
      }
      if (!Number.isSafeInteger(args.retainUntilMs) || args.retainUntilMs <= 0) {
        throw new SandboxScopeValidationError("Supply retainUntilMs as a positive safe integer");
      }
      checkPath(args.outputPath);
      if (protectedRoot(args.outputPath, true)) {
        throw new SandboxScopeDeniedError("The output path is reserved for the provider");
      }
      const input2 = { ...args, signal: undefined };
      await checkNetwork(h, scope, args.signal);
      const consumed = await record(
        h,
        scope,
        "backgroundStart",
        inputHash("backgroundStart", scope, input2),
        args.signal,
        args.retainUntilMs,
      );
      const ref: SandboxExecutionRef = Object.freeze({
        executionId: operationUuid(scope.operationId),
        operationId: scope.operationId,
        instanceId: h.id,
        instanceGeneration: consumed.generation,
      });
      // A retry after a lost acknowledgement returns the same reference and launches nothing
      // (the kernel's reconcile); a contested start is aborted first (see abortIfContested).
      if (consumed.state === "duplicate") {
        await abortIfContested(h, scope, ref);
        return ref;
      }
      // The exact request the supervisor runs. Root records its digest before anything launches,
      // and the recorder binds the record only to a supervisor that reports the same digest.
      const launch = {
        opKey: opKey(scope.operationId),
        admitBeforeMs: scope.admitBeforeMs,
        expect: sdkRuntimeDigests(),
        executionId: ref.executionId,
        kind: "device",
        writeRoots: [],
        readRoots: [],
        network: scope.network,
        command: args.command,
        cwd: args.cwd ?? "/workspace",
        // the ordinary exec's environment (provider.ts execWith), then the caller's variables
        env: { HOME: "/workspace", LANG: "C.UTF-8", ...checkedEnv(args.env) },
        timeoutMs: args.timeoutMs,
        maxOutputBytes: args.maxOutputBytes,
        taskId: args.taskId,
        outputPath: args.outputPath,
        retainUntilMs: args.retainUntilMs,
      };
      // The channel's random name and the identity token reach only the supervisor (envd stdin),
      // never argv or the environment.
      const secret = randomBytes(16).toString("hex");
      const token = randomBytes(16).toString("hex");
      const prepared = await rootStep(
        h,
        "bg-prepare",
        {
          executionId: ref.executionId,
          secret,
          token,
          start: launch,
          opKey: opKey(scope.operationId),
          taskId: args.taskId,
          retainUntilMs: args.retainUntilMs,
        },
        args.signal,
        true,
      );
      if (prepared === "not-running" || prepared.existing) {
        throw new SandboxOperationOutcomeUnknownError(
          "This execution was already prepared; reconcile it by its reference",
        );
      }
      // "unknown" (keep for the same-id retry) only when the exec itself exited 0 with exactly
      // one result frame: the genuine agent exits 0 only after its own supervisor was accepted,
      // so only the reply was lost. Anything else aborts.
      let outcome: "acknowledged" | "refused" | "unknown" | "failed" = "failed";
      try {
        const cmd = [PYTHON, "-I", OPERATION_AGENT, "bg-start"];
        const r = await t.run(h, {
          cmd: t.backgroundStartCommand?.(args.taskId, cmd) ?? cmd,
          user: "sandbox",
          stdin: request({ secret, token, ...launch }),
          maxOutputBytes: 1 << 20,
          timeoutMs: STEP_TIMEOUT_MS,
          signal: args.signal,
        });
        const sole = soleResult(r.stdout);
        if (r.exitCode !== 0 || r.aborted || r.timedOut || sole === "malformed") {
          throw new SandboxOperationOutcomeUnknownError(
            "The background start did not finish and was aborted; reconcile it by its reference",
          );
        }
        outcome = "unknown";
        // Test-only: the reply is dropped as if the transport lost it.
        const result = t.loseBackgroundAck?.(args.taskId) ? null : sole;
        const error = refusalError(result);
        if (error) {
          outcome = "refused";
          throw error;
        }
        if (!result?.started) {
          throw new SandboxOperationOutcomeUnknownError(
            "The background start was not acknowledged; reconcile it by its reference",
          );
        }
        outcome = "acknowledged";
        return ref;
      } finally {
        if (outcome === "refused" || outcome === "failed") await abortStart(h, scope, ref);
        if (outcome === "unknown") await abortIfContested(h, scope, ref);
      }
    },

    async status(h, input, signal) {
      signal.throwIfAborted();
      const ref = exactRef(h, input);
      const result = await bgCall(h, "bg-status", ref, {}, signal);
      if (result === "not-running" || result.state === "lost") return { state: "lost" };
      if (result.state === "running") return { state: "running" };
      return {
        state: "exited",
        exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
        timedOut: result.timedOut === true,
      };
    },

    async tail(h, input, opts) {
      opts.signal.throwIfAborted();
      const ref = exactRef(h, input);
      checkMaxBytes(opts.maxBytes);
      const result = await bgCall(h, "bg-tail", ref, { maxBytes: opts.maxBytes }, opts.signal);
      if (result === "not-running") return { unavailable: "lost" };
      if (result.unavailable === "lost" || result.unavailable === "expired") {
        return { unavailable: result.unavailable };
      }
      return { data: bytes(result), truncated: result.truncated === true };
    },

    async readOutput(h, input, opts) {
      opts.signal.throwIfAborted();
      const ref = exactRef(h, input);
      if (!Number.isSafeInteger(opts.offset) || opts.offset < 0) {
        throw new SandboxScopeDeniedError("Supply offset as a nonnegative safe integer");
      }
      checkMaxBytes(opts.maxBytes);
      const result = await bgCall(
        h,
        "bg-read",
        ref,
        { offset: opts.offset, maxBytes: opts.maxBytes },
        opts.signal,
      );
      if (result === "not-running") return { unavailable: "lost" };
      if (result.unavailable === "lost" || result.unavailable === "expired") {
        return { unavailable: result.unavailable };
      }
      const data = bytes(result);
      return {
        data,
        offset: opts.offset,
        nextOffset: opts.offset + data.byteLength,
        totalBytes: Number(result.totalBytes),
      };
    },

    async stop(h, input, opts) {
      opts.signal.throwIfAborted();
      const ref = exactRef(h, input);
      return stopExecution(h, ref.executionId, ref.instanceGeneration, opts.graceMs, opts.signal);
    },
  };

  return {
    /**
     * Support v2 of this VM (approval-only profiles design, "SDK and protocol"): the microVM is the
     * sandbox (`boundary: "instance"`, no restricted filters, no outside), its network policy
     * offers open-public and (unless domain allowlists are off) allowlists, never per-operation
     * hosts, and background work is supervised exactly. The agent's probe stages the runtime when
     * this VM has none yet; the staged runtime must then be root-owned, read-only and match its
     * digests, otherwise nothing is offered and the reason says why. Never connects or resumes
     * the VM.
     */
    async permissionSupport(
      h: SandboxHandle,
      signal: AbortSignal,
    ): Promise<SandboxPermissionSupport> {
      signal.throwIfAborted();
      const unavailable = (reason: string): SandboxPermissionSupport => ({
        version: 2,
        boundary: "instance",
        restricted: null,
        network: { openPublic: false, allowlist: false, perOperationHosts: false },
        outsideSandbox: false,
        background: false,
        unavailableReason: reason,
      });
      // The agent's probe first: running it stages the runtime when this VM has none yet (its
      // launcher facts no longer matter: restricted filters are not offered on an instance).
      const probe = await t.runIfRunning(h, {
        cmd: [PYTHON, "-I", OPERATION_AGENT, "probe"],
        user: "sandbox",
        maxOutputBytes: 1 << 20,
        timeoutMs: STEP_TIMEOUT_MS,
        signal,
      });
      if (probe === "not-running") {
        throw new Error("The device instance is not running; probe it during execution");
      }
      const files = runtimeFiles();
      const names = files.map((f) => f.name);
      const staged = await t.runIfRunning(h, {
        cmd: [
          "/bin/sh",
          "-c",
          'cd "$1" && shift && stat -c "%u %a %F %n" . .. "$@" && sha256sum -- "$@"',
          "capybara-probe",
          RUNTIME_DIR,
          ...names,
        ],
        user: "sandbox",
        env: { PATH: "/usr/bin:/bin" },
        maxOutputBytes: 64 * 1024,
        timeoutMs: STEP_TIMEOUT_MS,
        signal,
      });
      if (staged === "not-running") {
        throw new Error("The device instance is not running; probe it during execution");
      }
      if (staged.exitCode !== 0) return unavailable("The VM has no staged operation runtime");
      const lines = staged.stdout.toString("utf8").trim().split("\n");
      for (const line of lines.slice(0, names.length + 2)) {
        const m = line.match(/^(\d+) ([0-7]+) (.+?) (\S+)$/);
        const writable = (Number.parseInt(m?.[2] ?? "777", 8) & 0o022) !== 0;
        if (m?.[1] !== "0" || writable || /symbolic/.test(m[3] ?? "")) {
          return unavailable("The staged operation runtime is not root-owned and read-only");
        }
      }
      const expect = Object.fromEntries(files.map((f) => [f.name, f.sha256]));
      const digests = lines.slice(names.length + 2);
      if (digests.length !== names.length) {
        return unavailable("The staged operation runtime is incomplete");
      }
      for (const line of digests) {
        const [digest, name] = line.split(/\s+/);
        if (!name || expect[name] !== digest) {
          return unavailable(`The staged ${name ?? "runtime"} does not match its digest`);
        }
      }
      return {
        version: 2,
        boundary: "instance",
        restricted: null,
        network: {
          openPublic: true,
          allowlist: deps.network.allowlist,
          perOperationHosts: false,
        },
        outsideSandbox: false,
        background: true,
      };
    },

    async operation(
      h: SandboxHandle,
      input: SandboxOperationScope,
      signal: AbortSignal,
    ): Promise<SandboxOperation> {
      signal.throwIfAborted();
      // A deeply frozen copy: later caller mutation never changes this grant.
      const scope = parseSandboxOperationScope(input);
      checkScope(scope);
      const both = (s: AbortSignal) => AbortSignal.any([signal, s]);
      return {
        exec: (args) => execOp(h, scope, { ...args, signal: both(args.signal) }),
        readFile: async (path, o) =>
          nativeOp(
            h,
            scope,
            "readFile",
            { path, maxBytes: o.maxBytes },
            both(o.signal),
          ) as Promise<{
            data: Uint8Array;
            truncated: boolean;
          } | null>,
        writeFile: async (path, data, s) => {
          await nativeOp(
            h,
            scope,
            "writeFile",
            { path, dataB64: Buffer.from(data).toString("base64") },
            both(s),
          );
        },
        stat: async (path, s) =>
          nativeOp(h, scope, "stat", { path }, both(s)) as Promise<{
            size: number;
            isDir: boolean;
          } | null>,
        list: async (path, o) =>
          nativeOp(h, scope, "list", { path, limit: o.limit }, both(o.signal)) as Promise<{
            entries: { name: string; isDir: boolean }[];
            truncated: boolean;
          } | null>,
        scan: async (base, o) =>
          nativeOp(h, scope, "scan", { path: base }, both(o.signal)) as Promise<
            { path: string; suggestedName: string }[]
          >,
      };
    },

    /**
     * Owner metadata browsing on pinned read roots (no launcher: metadata only, descriptor-relative
     * and no-follow, as the device user).
     */
    async browse(
      h: SandboxHandle,
      input: SandboxBrowseScope,
      signal: AbortSignal,
    ): Promise<SandboxBrowse> {
      signal.throwIfAborted();
      const scope = parseSandboxBrowseScope(input);
      checkReadRoots(scope.readRoots);
      const run = async (
        method: "stat" | "list" | "scan",
        native: Record<string, unknown>,
        s: AbortSignal,
      ) => {
        const sig = AbortSignal.any([signal, s]);
        sig.throwIfAborted();
        checkPath(String(native.path));
        const runner = await t.session(h, sig);
        const key = `browse-${method}`;
        await consume(h, scope, key, inputHash(key, scope, native), sig, runner);
        const result = await direct(
          h,
          "sandbox",
          {
            opKey: opKey(scope.operationId),
            admitBeforeMs: scope.admitBeforeMs,
            expect: sdkRuntimeDigests(),
            kind: "scoped",
            readRoots: [...scope.readRoots],
            writeRoots: [],
            native: { method, ...native },
          },
          sig,
          runner,
        );
        sig.throwIfAborted();
        return nativeReply(result, true);
      };
      return {
        stat: async (path, s) =>
          (await run("stat", { path }, s)) as { size: number; isDir: boolean } | null,
        list: async (path, o) =>
          (await run("list", { path, limit: o.limit }, o.signal)) as {
            entries: { name: string; isDir: boolean }[];
            truncated: boolean;
          } | null,
        scan: async (base, o) =>
          (await run("scan", { path: base }, o.signal)) as {
            path: string;
            suggestedName: string;
          }[],
      };
    },

    /**
     * Trusted staging: skills only under /skills (written by root, files 0644), attachments only
     * under /workspace/attachments/<x> (as the device user), through pinned, no-follow roots.
     */
    async prepare(
      h: SandboxHandle,
      input: SandboxPreparationScope,
      signal: AbortSignal,
    ): Promise<SandboxPreparation> {
      signal.throwIfAborted();
      const scope = parseSandboxPreparationScope(input);
      const roots = scope.writeRoots.map((root) => {
        if (posix.normalize(root) !== root) {
          throw new SandboxScopeDeniedError("Preparation roots must be canonical absolute paths");
        }
        if (scope.purpose === "skills") {
          if (root !== "/skills" && !root.startsWith("/skills/")) {
            throw new SandboxScopeDeniedError("Skills are prepared only under /skills");
          }
          return { path: root, base: "/skills", relative: root.slice("/skills".length) };
        }
        const m = root.match(/^\/workspace\/attachments\/[^/]+(\/.*)?$/);
        if (!m) {
          throw new SandboxScopeDeniedError(
            "Attachments are prepared only under /workspace/attachments/<conversation>",
          );
        }
        return { path: root, base: "/workspace", relative: root.slice("/workspace".length) };
      });
      const user = scope.purpose === "skills" ? "root" : "sandbox";
      const run = async (
        method: "readFile" | "writeFile" | "stat",
        native: Record<string, unknown>,
        s: AbortSignal,
      ) => {
        const sig = AbortSignal.any([signal, s]);
        sig.throwIfAborted();
        checkPath(String(native.path));
        const result = await direct(
          h,
          user,
          {
            expect: sdkRuntimeDigests(),
            kind: "prepare",
            prepareRoots: roots,
            publicFiles: scope.purpose === "skills",
            native: { method, ...native },
          },
          sig,
        );
        sig.throwIfAborted();
        return nativeResult(method, nativeReply(result, true));
      };
      return {
        readFile: async (path, o) =>
          (await run("readFile", { path, maxBytes: o.maxBytes }, o.signal)) as {
            data: Uint8Array;
            truncated: boolean;
          } | null,
        writeFile: async (path, data, s) => {
          await run("writeFile", { path, dataB64: Buffer.from(data).toString("base64") }, s);
        },
        stat: async (path, s) =>
          (await run("stat", { path }, s)) as { size: number; isDir: boolean } | null,
      };
    },

    background,

    async revokeOperation(h: SandboxHandle, input: SandboxOperationRef, signal: AbortSignal) {
      signal.throwIfAborted();
      const ref = parseSandboxOperationRef(input);
      const marker = {
        opKey: opKey(ref.operationId),
        expiresAtMs: ref.admitBeforeMs + RECORD_RETENTION_MS,
      };
      // 1. The tombstone first (root-owned, on the VM's persistent disk): a delayed launch checks
      //    it right before creating processes. Never resumes a paused VM.
      const first = await rootStep(h, "revoke", marker, signal);
      if (first === "not-running") {
        // Pending even past the admission deadline: this provider pauses without memory, but a
        // control plane that restores a memory snapshot would bring the operation's processes
        // back, and a paused VM cannot confirm they are gone. The kernel retries; the next
        // running VM gets the tombstone and the kill.
        throw new Error("The device instance is not running; the revocation stays pending");
      }
      // 2. Running work of this operation ends: foreground (by its wrapper) and its background
      //    execution by the recorded identity.
      const uuid = operationUuid(ref.operationId);
      await t.killOperation(h, uuid, signal);
      await stopExecution(h, uuid, null, 0, signal);
      // 3. Rewrite the tombstone; a generation change means the VM rebooted meanwhile (the kill's
      //    reboot fallback), so success is not reported: the kernel retries.
      const second = await rootStep(h, "revoke", marker, signal);
      if (second === "not-running" || second.generation !== first.generation) {
        throw new Error("The device instance restarted during the revocation; retry it");
      }
    },
  };
}

function toStopResult(result: AgentResult): SandboxStopResult {
  switch (result.outcome) {
    case "already-exited":
      return {
        outcome: "already-exited",
        exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
        timedOut: result.timedOut === true,
      };
    case "stopped":
      return { outcome: "stopped" };
    default:
      return { outcome: "lost" };
  }
}

function digestOf(data: unknown): string | undefined {
  return typeof data === "string" ? createHash("sha256").update(data).digest("hex") : undefined;
}
