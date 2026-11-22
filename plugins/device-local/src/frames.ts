import {
  type DialInChannel,
  FileSystemGoneError,
  ProjectPathRefusedError,
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

/**
 * The `capybara-device` bodies (protocol 5, `@capybara-hq/plugin-sdk/device-protocol`) over the
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

/** One protocol 5 operation on the device's machine, resolving its validated result. */
export type MachineCall = (
  deviceId: string,
  op: DeviceOperation,
  args: Record<string, unknown>,
  opts: { deadlineMs: number; signal: AbortSignal },
) => Promise<unknown>;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** An answer the machine sent that is not valid protocol 5: never passed on. */
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

/** The operations that list a project directory (a `policy` refusal there refuses the path). */
const isProjectListing = (op: string): boolean =>
  op === "list" || op === "scan" || op === "browseList" || op === "browseScan";

/**
 * A machine's typed failure as the SDK error the kernel knows. A `policy` refusal of a project
 * listing is the provider refusing that directory (`ProjectPathRefusedError`, the machine's text as
 * its reason).
 */
export function failureOf(
  error: Extract<DeviceResponseBody, { ok: false }>["error"],
  op: string,
): Error {
  const { kind, message } = error;
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
      if (isProjectListing(op))
        return new ProjectPathRefusedError({ en: `${POLICY_REFUSAL_PREFIX}${message}` });
      return new ToolError(
        `${POLICY_REFUSAL_PREFIX}${message} (ask the machine's owner to allow it, or use another way)`,
      );
    default:
      return new ToolError(`${ON_MACHINE_PREFIX}${message} (check the path or command and retry)`);
  }
}
