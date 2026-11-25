import { createHash } from "node:crypto";
import {
  type DialInChannel,
  FileSystemGoneError,
  SandboxGoneError,
  SandboxOperationOutcomeUnknownError,
  SandboxPermissionUnsupportedError,
  SandboxScopeDeniedError,
  SandboxScopeValidationError,
  SandboxWorkUnsettledError,
  ToolError,
} from "@capybara-hq/plugin-sdk";
import {
  type BackgroundReadOutputRequest,
  type BindInstanceRequest,
  type DeviceOperation,
  type DeviceResponseBody,
  parseDeviceFrame,
  parseOperationResult,
} from "@capybara-hq/plugin-sdk/device-protocol";
import { projectRefusalError } from "./project-refusal.js";

/**
 * The `capybara-device` bodies (protocol 6, `@capybara-hq/plugin-sdk/device-protocol`) over the
 * kernel's dial-in channel: a request body is `{ op, args }`, a response body the operation's
 * result or its typed failure. The kernel relays both without reading them, and the machine is
 * not trusted: every request is checked before it is sent and every answer is parsed strictly
 * before anything uses it.
 */

/** The text a machine's `policy` refusal reaches the model with. */
export const POLICY_REFUSAL_PREFIX = "Refused by the machine's local policy: ";

/** The text a machine's `error` result reaches the model with. */
export const ON_MACHINE_PREFIX = "On the connected machine: ";

/** Extra time the machine gets beyond a command's own timeout (spawn, output, the trip back). */
export const EXEC_DEADLINE_MARGIN_MS = 5000;

/** How long the machine may take for one operation other than a command. */
export const OP_DEADLINE_MS = 30_000;

/** One protocol 6 operation on the device's machine, resolving its validated result. */
export type MachineCall = (
  deviceId: string,
  op: DeviceOperation,
  args: Record<string, unknown>,
  opts: { deadlineMs: number; signal: AbortSignal },
) => Promise<unknown>;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** An answer the machine sent that is not valid protocol 6: never passed on. */
const invalidAnswer = (op: string, e: unknown): ToolError =>
  new ToolError(
    `The connected machine sent an invalid answer to ${op} (${errMsg(e)}); update capybara-device on that machine and retry`,
  );

/**
 * Runs one operation on the device's machine through `ctx.dialIn` and returns its validated
 * result. The request body is checked first (an invalid one is never sent). The channel's own
 * errors reach the caller unchanged, so the kernel keeps their meaning: `DeviceOfflineError` (no
 * machine within the reconnect grace), `DeviceRequestNotSentError` (the request never left), a
 * restarted program (outcome unknown), a frame too large, an abort. The machine's typed failures
 * map to the SDK's errors ({@link failureOf}); an answer that does not parse is a `ToolError`
 * naming the machine.
 */
export function machineCall(dialIn: Pick<DialInChannel, "request">): MachineCall {
  return async (deviceId, op, args, opts) => {
    const body = parseDeviceFrame({ op, args }, "req");
    const raw = await dialIn.request(deviceId, body, {
      timeoutMs: opts.deadlineMs,
      signal: opts.signal,
    });
    let res: DeviceResponseBody;
    try {
      res = parseDeviceFrame(raw, "res");
    } catch (e) {
      throw invalidAnswer(op, e);
    }
    if (!res.ok) throw failureOf(res.error, op);
    try {
      return parseOperationResult(op, res.result, requestOf(op, body.args));
    } catch (e) {
      throw invalidAnswer(op, e);
    }
  };
}

/** The request an answer is checked against: an output read's bounds, a binding's identity. */
function requestOf(
  op: DeviceOperation,
  args: Readonly<Record<string, unknown>>,
): BackgroundReadOutputRequest | BindInstanceRequest | undefined {
  if (op === "backgroundReadOutput") return args as unknown as BackgroundReadOutputRequest;
  if (op === "bindInstance") return args as unknown as BindInstanceRequest;
  return undefined;
}

/**
 * A machine's typed failure as the SDK error the kernel knows. A `project_refused` outcome is the
 * provider refusing a project directory (`ProjectPathRefusedError`): its reason is the fixed text
 * of the refusal code ({@link projectRefusalError}), never the machine's message.
 */
export function failureOf(
  error: Extract<DeviceResponseBody, { ok: false }>["error"],
  op: string,
): Error {
  const { kind, message } = error;
  if (kind === "project_refused") {
    // the parser requires the code on this kind; without it the answer is not valid protocol 6
    if (error.refusal === undefined) return invalidAnswer(op, "a project refusal without a code");
    return projectRefusalError(error.refusal);
  }
  switch (kind) {
    case "denied":
      return new SandboxScopeDeniedError(message);
    case "unsupported":
      return new SandboxPermissionUnsupportedError(message);
    case "unsettled":
      return new SandboxWorkUnsettledError(message);
    case "unknown":
      return new SandboxOperationOutcomeUnknownError(message);
    case "invalid":
      return new SandboxScopeValidationError(message);
    case "gone":
      return new SandboxGoneError(message);
    case "fs_gone":
      return new FileSystemGoneError(message);
    case "policy":
      return new ToolError(
        `${POLICY_REFUSAL_PREFIX}${message} (ask the machine's owner to allow it, or use another way)`,
      );
    default:
      return new ToolError(`${ON_MACHINE_PREFIX}${message} (check the path or command and retry)`);
  }
}

/** How long the machine may take to start, stop or read a service (a start spawns a process). */
export const SERVICE_OP_DEADLINE_MS = 60_000;

/**
 * The service op bodies sent beside the protocol 6 operations (capybara-device's `service.*` ops):
 * file and request bodies travel as standard base64.
 */
export type ServiceBody =
  | {
      /** `ifRunning`: the name only; the machine starts nothing and needs no files. */
      op: "service.ensure";
      spec: { name: string };
      network: { kind: "open-public" | "allowlist"; hosts: string[] };
      ifRunning: true;
    }
  | {
      op: "service.ensure";
      spec: {
        name: string;
        entry: string;
        args: string[];
        files?: Record<string, string>;
        env?: Record<string, string>;
      };
      /** `sha256:` + hex over the files ({@link filesDigestOf}); sent with or without `files`. */
      filesDigest?: string;
      network: { kind: "open-public" | "allowlist"; hosts: string[] };
    }
  | { op: "service.stop"; name: string }
  | { op: "service.status"; name: string }
  | { op: "service.request"; name: string; body: string; timeoutMs: number };

/** A machine's `invalid` or `files_needed` answer to a service op, with its kind. */
export class ServiceOpRefusedError extends ToolError {
  constructor(
    message: string,
    readonly refusal: "invalid" | "files_needed",
  ) {
    super(message);
  }
}

/** `sha256:` + hex of the files sorted by path: path, NUL, byte length, NUL, bytes. */
export function filesDigestOf(files: Record<string, Uint8Array>): string {
  const h = createHash("sha256");
  for (const path of Object.keys(files).sort()) {
    const data = files[path] as Uint8Array;
    h.update(`${path}\0${data.byteLength}\0`);
    h.update(data);
  }
  return `sha256:${h.digest("hex")}`;
}

/** How a capybara-device from before service ids refuses one ("Invalid device service name"). */
export const OLD_SERVICE_NAME_REFUSAL = /Invalid device service name\b/;

/** A machine's typed failure of a service op as the SDK error the kernel knows. */
function serviceFailure(error: { kind?: unknown; message?: unknown }, op: string): Error {
  const message = typeof error.message === "string" ? error.message : "no message";
  switch (error.kind) {
    case "unsupported":
      return new SandboxPermissionUnsupportedError(
        `${message} (update capybara-device on that machine to use device services)`,
      );
    case "denied":
      return new SandboxScopeDeniedError(message);
    case "files_needed":
      return new ServiceOpRefusedError(
        `The connected machine needs the service files for ${op} (retry with the files)`,
        "files_needed",
      );
    case "invalid":
      // a machine from before service ids (core#817) refuses `<extension>.<name>` by the old
      // name rule: only an update helps, never a retry
      if (OLD_SERVICE_NAME_REFUSAL.test(message))
        return new SandboxPermissionUnsupportedError(
          "The connected machine runs a capybara-device that predates device service ids; update capybara-device on that machine, then retry",
        );
      return new ServiceOpRefusedError(
        `The connected machine refused the ${op} request: ${message} (check the request and retry)`,
        "invalid",
      );
    default:
      return new ToolError(`${ON_MACHINE_PREFIX}${message} (check the service and retry)`);
  }
}

/**
 * One service op on the device's machine through `ctx.dialIn`, resolving the `result` of its
 * answer. Channel errors (`DeviceOfflineError`, aborts, timeouts) reach the caller unchanged; a
 * typed failure maps by {@link serviceFailure}; an answer that is no `{ ok }` body is a `ToolError`.
 */
export async function serviceCall(
  dialIn: Pick<DialInChannel, "request">,
  deviceId: string,
  body: ServiceBody,
  opts: { deadlineMs: number; signal: AbortSignal },
): Promise<unknown> {
  const raw = await dialIn.request(deviceId, body, {
    timeoutMs: opts.deadlineMs,
    signal: opts.signal,
  });
  const res = raw as { ok?: unknown; result?: unknown; error?: unknown } | null;
  if (typeof res !== "object" || res === null || typeof res.ok !== "boolean")
    throw invalidAnswer(body.op, "not a response body");
  if (!res.ok) {
    const e = res.error;
    if (typeof e !== "object" || e === null) throw invalidAnswer(body.op, "no error body");
    throw serviceFailure(e, body.op);
  }
  return res.result;
}
