import http2 from "node:http2";
import {
  PUSH_LIMITS,
  PushError,
  type PushErrorKind,
  type PushMessage,
  type PushProvider,
  type PushResult,
  type PushTarget,
} from "@capybara-hq/plugin-sdk";
import type { ApnsDeployment, ApnsEnvironment } from "./config.js";
import { ApnsKeyError, type ApnsKv, dropProviderToken, providerToken } from "./jwt.js";

/** Apple's APNs hosts (HTTP/2 over TLS). */
export const APPLE_ORIGINS: Readonly<Record<ApnsEnvironment, string>> = Object.freeze({
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
});

/**
 * Where requests go. The extension always uses Apple's hosts and the system trust store; tests
 * construct a provider with a local origin and their test-only certificate. Not part of the
 * deployment config.
 */
export interface ApnsNet {
  origin(environment: ApnsEnvironment): string;
  /** Extra trusted certificates (PEM), replacing the default store. */
  ca?: string;
}

const APPLE_NET: ApnsNet = { origin: (env) => APPLE_ORIGINS[env] };

/** A notification's lifetime at APNs when the device is offline. */
const EXPIRATION_SECONDS = 86_400;
/** Bytes of an APNs answer body read (the JSON `{ reason, timestamp }` is far smaller). */
const MAX_ANSWER_BYTES = 16_384;

/** The answer of one APNs request. */
export interface ApnsAnswer {
  status: number;
  /** The `reason` of the JSON body, when there is one. */
  reason: string | undefined;
  /** The `retry-after` header, when there is one. */
  retryAfter: string | undefined;
}

type ResultBody =
  | { status: "delivered" }
  | { status: "unregistered" }
  | { status: "failed"; kind: PushErrorKind; message: string; retryAfterMs?: number };

/** An APNs reason code as it may appear in a message (anything else is replaced). */
const reasonCode = (reason: string | undefined) =>
  reason !== undefined && /^[A-Za-z]{1,64}$/.test(reason) ? reason : undefined;

const failed = (kind: PushErrorKind, message: string, retryAfterMs?: number): ResultBody => ({
  status: "failed",
  kind,
  message,
  ...(retryAfterMs !== undefined && { retryAfterMs }),
});

/**
 * Maps an APNs answer to a result. `dropToken`: the shared provider token must be forgotten
 * (`ExpiredProviderToken`). The message names the status and the reason code only.
 */
export function mapApnsAnswer(a: ApnsAnswer): { result: ResultBody; dropToken: boolean } {
  const code = reasonCode(a.reason);
  const message = `push-apns: APNs answered ${a.status}${code === undefined ? "" : ` ${code}`}`;
  if (a.status === 200) return { result: { status: "delivered" }, dropToken: false };
  if (
    a.status === 410 ||
    (a.status === 400 && (code === "BadDeviceToken" || code === "Unregistered"))
  ) {
    return { result: { status: "unregistered" }, dropToken: false };
  }
  if (a.status === 403 && code === "ExpiredProviderToken") {
    // a token signed seconds ago that APNs calls expired means this server's clock is off; every
    // re-sign then fails the same way, so the message says where to look
    const hint = `${message}: the provider token is re-signed; if this repeats, check the server clock (NTP)`;
    return { result: failed("transient", hint), dropToken: true };
  }
  if (a.status === 403) return { result: failed("auth", message), dropToken: false };
  if (
    a.status === 400 &&
    (code === "DeviceTokenNotForTopic" ||
      code === "TopicDisallowed" ||
      code === "BadTopic" ||
      code === "MissingTopic")
  ) {
    return { result: failed("auth", message), dropToken: false };
  }
  if (a.status === 429) {
    const seconds = a.retryAfter !== undefined ? Number(a.retryAfter) : Number.NaN;
    const retryAfterMs =
      Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) * 1000 : undefined;
    return { result: failed("rate_limited", message, retryAfterMs), dropToken: false };
  }
  return { result: failed("transient", message), dropToken: false };
}

/** The signal aborted before an answer. */
class AbortedError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortedError";
  }
}

/** Opens an HTTP/2 session; its errors surface on the streams, never as an unhandled event. */
export function openApnsSession(origin: string, net: ApnsNet): http2.ClientHttp2Session {
  const session = http2.connect(origin, net.ca === undefined ? {} : { ca: net.ca });
  session.on("error", () => {});
  return session;
}

/** One request on `session`; rejects on a stream error, a closed session or the signal's abort. */
export function apnsRequest(
  session: http2.ClientHttp2Session,
  req: { path: string; headers: Record<string, string>; body: string; signal: AbortSignal },
): Promise<ApnsAnswer> {
  return new Promise((resolve, reject) => {
    if (req.signal.aborted) {
      reject(new AbortedError());
      return;
    }
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      req.signal.removeEventListener("abort", onAbort);
      fn();
    };
    let stream: http2.ClientHttp2Stream;
    try {
      stream = session.request({ ":method": "POST", ":path": req.path, ...req.headers });
    } catch (error) {
      done(() => reject(error));
      return;
    }
    function onAbort() {
      done(() => reject(new AbortedError()));
      stream.close(http2.constants.NGHTTP2_CANCEL);
    }
    req.signal.addEventListener("abort", onAbort, { once: true });
    let status = 0;
    let retryAfter: string | undefined;
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on("response", (h) => {
      status = Number(h[":status"]);
      const ra = h["retry-after"];
      retryAfter = typeof ra === "string" ? ra : undefined;
    });
    stream.on("data", (c: Buffer) => {
      size += c.length;
      if (size <= MAX_ANSWER_BYTES) chunks.push(c);
    });
    stream.on("end", () => {
      let reason: string | undefined;
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { reason?: unknown };
        if (typeof parsed.reason === "string") reason = parsed.reason;
      } catch {
        // no JSON body (200 has none)
      }
      done(() => resolve({ status, reason, retryAfter }));
    });
    stream.on("error", (error) => done(() => reject(error)));
    stream.on("close", () => {
      done(() =>
        status === 0
          ? reject(new Error("stream closed without an answer"))
          : resolve({ status, reason: undefined, retryAfter }),
      );
    });
    stream.end(req.body);
  });
}

/** A transport error as a short code that never carries a token or a path. */
export function errorCode(error: unknown): string {
  if (error instanceof AbortedError) return "aborted";
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code) ? code : "connection failed";
}

/** The request headers of one notification. */
export function apnsHeaders(opts: {
  jwt: string;
  bundleId: string;
  collapseId: string;
  nowMs: number;
}): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `bearer ${opts.jwt}`,
    "apns-topic": opts.bundleId,
    "apns-push-type": "alert",
    "apns-priority": "10",
    "apns-expiration": String(Math.floor(opts.nowMs / 1000) + EXPIRATION_SECONDS),
    "content-type": "application/json",
  };
  // APNs refuses a collapse id over 64 bytes (BadCollapseId); the kernel's ids are shorter.
  if (
    opts.collapseId.length > 0 &&
    Buffer.byteLength(opts.collapseId) <= PUSH_LIMITS.collapseIdChars
  ) {
    headers["apns-collapse-id"] = opts.collapseId;
  }
  return headers;
}

/** The JSON payload of one notification. */
export function apnsPayload(m: PushMessage): string {
  return JSON.stringify({
    aps: {
      alert: { title: m.title, body: m.body },
      "thread-id": m.threadId,
      sound: "default",
      ...(m.badge !== undefined && { badge: m.badge }),
    },
    path: m.path,
    origin: m.origin,
  });
}

export interface ApnsProviderOptions {
  config: ApnsDeployment;
  kv: ApnsKv;
  /** Default: Apple's hosts and the system trust store. */
  net?: ApnsNet;
  /** Milliseconds since the epoch (default Date.now). */
  now?: () => number;
}

/**
 * The `push-provider@1` provider: one HTTP/2 `POST /3/device/<token>` per registration to the host
 * of the registration's bundle, authenticated with the shared provider token. No retries (the
 * kernel's queue retries); a token never appears in a result message or an error.
 */
export function createApnsProvider(opts: ApnsProviderOptions): PushProvider {
  const { config, kv } = opts;
  const net = opts.net ?? APPLE_NET;
  const now = opts.now ?? Date.now;
  const envOf = new Map<string, ApnsEnvironment>();
  for (const b of config.bundles) if (!envOf.has(b.bundleId)) envOf.set(b.bundleId, b.environment);
  const apps: readonly string[] = Object.freeze([...envOf.keys()]);

  return {
    apps: () => apps,
    async send({ registrations, message, signal }) {
      const transient = (r: PushTarget, why: string): PushResult => ({
        registrationId: r.id,
        status: "failed",
        kind: "transient",
        message: `push-apns: ${why}`,
      });
      if (signal.aborted) return registrations.map((r) => transient(r, "aborted"));

      const nowMs = now();
      let jwt: string;
      try {
        jwt = await providerToken(kv, config, nowMs);
      } catch (error) {
        if (error instanceof ApnsKeyError) throw new PushError(error.message, { kind: "auth" });
        throw error;
      }

      const body = apnsPayload(message);
      const sessions = new Map<ApnsEnvironment, http2.ClientHttp2Session>();
      const sessionFor = (env: ApnsEnvironment) => {
        let s = sessions.get(env);
        if (s === undefined || s.destroyed || s.closed) {
          s = openApnsSession(net.origin(env), net);
          sessions.set(env, s);
        }
        return s;
      };
      const destroyAll = () => {
        for (const s of sessions.values()) s.destroy();
      };
      signal.addEventListener("abort", destroyAll, { once: true });

      async function one(r: PushTarget): Promise<PushResult> {
        const env = envOf.get(r.appId);
        if (env === undefined) {
          return {
            registrationId: r.id,
            status: "failed",
            kind: "auth",
            message: `push-apns: no bundle in the deployment config covers the app id ${r.appId}`,
          };
        }
        let answer: ApnsAnswer;
        try {
          answer = await apnsRequest(sessionFor(env), {
            path: `/3/device/${encodeURIComponent(r.token)}`,
            headers: apnsHeaders({ jwt, bundleId: r.appId, collapseId: message.collapseId, nowMs }),
            body,
            signal,
          });
        } catch (error) {
          return transient(r, `APNs request failed (${errorCode(error)})`);
        }
        const { result, dropToken } = mapApnsAnswer(answer);
        // the next send signs anew; a failed delete only delays that until the entry expires
        if (dropToken) await dropProviderToken(kv, config.keyId).catch(() => {});
        return { registrationId: r.id, ...result } as PushResult;
      }

      try {
        return await Promise.all(registrations.map(one));
      } finally {
        signal.removeEventListener("abort", destroyAll);
        for (const s of sessions.values()) s.close();
      }
    },
  };
}
