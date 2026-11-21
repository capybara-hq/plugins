import type {
  PushErrorKind,
  PushMessage,
  PushProvider,
  PushResult,
  PushTarget,
} from "@capybara-hq/plugin-sdk";
import { type FcmDeploymentConfig, parseServiceAccount, type ServiceAccount } from "./config.js";
import {
  accessToken,
  FCM_ENDPOINTS,
  type FcmEndpoints,
  type TokenKv,
  tokenCacheKey,
} from "./oauth.js";

/** The FCM v1 request body for one device (`android.collapse_key` carries the collapse id). */
export function fcmRequestBody(token: string, m: PushMessage) {
  return {
    message: {
      token,
      notification: { title: m.title, body: m.body },
      data: { path: m.path, origin: m.origin, threadId: m.threadId },
      android: {
        priority: "HIGH",
        ttl: "86400s",
        collapse_key: m.collapseId,
        notification: {
          tag: m.threadId,
          ...(m.badge !== undefined && { notification_count: m.badge }),
        },
      },
    },
  };
}

interface FcmErrorBody {
  status: string | undefined;
  errorCode: string | undefined;
  fields: string[];
}

/** FCM's error enum values are uppercase words; anything else is not echoed. */
const safeEnum = (v: unknown): string | undefined =>
  typeof v === "string" && /^[A-Z_]{1,64}$/.test(v) ? v : undefined;

/** The status, the FcmError code and the bad request fields of an FCM error answer. */
function readError(body: unknown): FcmErrorBody {
  const error = (body as { error?: unknown } | null)?.error as
    | { status?: unknown; details?: unknown }
    | undefined;
  const out: FcmErrorBody = { status: safeEnum(error?.status), errorCode: undefined, fields: [] };
  if (!Array.isArray(error?.details)) return out;
  for (const d of error.details as Record<string, unknown>[]) {
    if (typeof d !== "object" || d === null) continue;
    const code = safeEnum(d.errorCode);
    if (code !== undefined && out.errorCode === undefined) out.errorCode = code;
    if (Array.isArray(d.fieldViolations)) {
      for (const v of d.fieldViolations as { field?: unknown }[]) {
        if (typeof v?.field === "string") out.fields.push(v.field);
      }
    }
  }
  return out;
}

/** `Retry-After` (seconds or an HTTP date) in milliseconds, when present and sensible. */
export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (header === null || header.trim() === "") return undefined;
  if (/^\d+$/.test(header.trim())) return Number(header.trim()) * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

const failed = (
  registrationId: string,
  kind: PushErrorKind,
  message: string,
  retry?: number,
): PushResult => ({
  registrationId,
  status: "failed",
  kind,
  message: `push-fcm: ${message}`,
  ...(retry !== undefined && { retryAfterMs: retry }),
});

/** Maps one FCM v1 answer to a result (the mapping table in the README). */
export function mapResponse(
  registrationId: string,
  status: number,
  body: unknown,
  retryAfter: string | null,
): PushResult {
  if (status >= 200 && status < 300) return { registrationId, status: "delivered" };
  const e = readError(body);
  const label = [status, e.errorCode ?? e.status].filter((x) => x !== undefined).join(" ");
  if (status === 404 && e.errorCode === "UNREGISTERED") {
    return { registrationId, status: "unregistered" };
  }
  if (
    status === 400 &&
    (e.status === "INVALID_ARGUMENT" || e.errorCode === "INVALID_ARGUMENT") &&
    e.fields.includes("message.token")
  ) {
    return { registrationId, status: "unregistered" };
  }
  if (status === 401)
    return failed(registrationId, "auth", `FCM refused the credentials (${label})`);
  if (status === 403) {
    return failed(registrationId, "auth", `FCM refused the sender for this device (${label})`);
  }
  if (status === 429) {
    return failed(
      registrationId,
      "rate_limited",
      `FCM rate-limited the send (${label})`,
      retryAfterMs(retryAfter),
    );
  }
  return failed(registrationId, "transient", `FCM answered ${label}`);
}

export interface FcmProviderOptions {
  config: FcmDeploymentConfig;
  kv: TokenKv;
  /** Test seam: the token endpoint and API origin (default Google's). */
  endpoints?: FcmEndpoints;
}

/**
 * The `push-provider@1` implementation over FCM HTTP v1: one access token per send (from kv or
 * one exchange), then one request per registration, in parallel; no retries (the kernel's queue
 * retries). A 401 drops the cached token, so the kernel's retry exchanges a new one.
 */
export function makeFcmProvider(opts: FcmProviderOptions): PushProvider {
  const endpoints = opts.endpoints ?? FCM_ENDPOINTS;
  const apps = Object.freeze([...opts.config.applicationIds]);
  const parsed = parseServiceAccount(opts.config.serviceAccount);

  async function sendOne(
    sa: ServiceAccount,
    token: string,
    r: PushTarget,
    message: PushMessage,
    signal: AbortSignal,
  ): Promise<{ result: PushResult; unauthenticated: boolean }> {
    const url = `${endpoints.apiBase}/v1/projects/${encodeURIComponent(sa.projectId)}/messages:send`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(fcmRequestBody(r.token, message)),
        redirect: "error",
        signal,
      });
    } catch {
      const reason = signal.aborted ? "the FCM request was aborted" : "FCM could not be reached";
      return { result: failed(r.id, "transient", reason), unauthenticated: false };
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      if (signal.aborted) {
        const result = failed(r.id, "transient", "the FCM request was aborted");
        return { result, unauthenticated: false };
      }
      body = null;
    }
    return {
      result: mapResponse(r.id, res.status, body, res.headers.get("retry-after")),
      unauthenticated: res.status === 401,
    };
  }

  return {
    apps: () => apps,
    async send({ registrations, message, signal }) {
      if (registrations.length === 0) return [];
      if ("problem" in parsed) {
        // unreachable with a validated config; never echo the config
        return registrations.map((r) => failed(r.id, "auth", parsed.problem));
      }
      const token = await accessToken(parsed, endpoints, opts.kv, signal);
      const answers = await Promise.all(
        registrations.map((r) => sendOne(parsed, token, r, message, signal)),
      );
      // A 401 means the access token itself was refused: drop it so the retry exchanges anew
      if (answers.some((a) => a.unauthenticated)) {
        await opts.kv.del(tokenCacheKey(parsed.clientEmail));
      }
      return answers.map((a) => a.result);
    },
  };
}
