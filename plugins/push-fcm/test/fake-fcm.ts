import { createPublicKey, generateKeyPairSync, type KeyObject, verify } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { PushOutcome, PushVendorRequest } from "@capybara-hq/testing";

/**
 * A local stand-in for Google's OAuth token endpoint and the FCM HTTP v1 send endpoint, enough
 * for the push-fcm provider: `POST /token` verifies the RS256 JWT bearer assertion against the
 * service account's public key and issues an access token; `POST /v1/projects/<id>/messages:send`
 * checks the bearer token and answers per device token as arranged (FCM's error shapes).
 */

/** One HTTP answer, for the mapping cases the named outcomes do not cover. */
export interface FakeReply {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

/** What the fake does with a device token: a conformance outcome, an FCM-specific case or a raw reply. */
export type FakeFcmOutcome =
  | PushOutcome
  | "invalid_token"
  | "invalid_argument"
  | "sender_mismatch"
  | "third_party_auth"
  | "not_found"
  | "server_error"
  | FakeReply;

/** What the token endpoint answers next. */
export type FakeTokenOutcome =
  | "ok"
  | "invalid_grant"
  | "invalid_client"
  | "server_error"
  | "rate_limited"
  | "network_error";

/** One send request as it reached the fake. */
export interface FakeSendRequest {
  projectId: string;
  authorization: string;
  /** The parsed JSON body (`{ message: … }`). */
  body: { message: Record<string, unknown> };
}

/** One token request as it reached the fake, with the decoded JWT claims. */
export interface FakeTokenRequest {
  grantType: string;
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  signatureValid: boolean;
}

export interface FakeFcm {
  /** Base URL of the send API (`<url>/v1/projects/…`). */
  apiBase: string;
  /** The token endpoint URL. */
  tokenUrl: string;
  /** The service account JSON (string) whose key the token endpoint accepts. */
  serviceAccount: string;
  projectId: string;
  clientEmail: string;
  arrange(token: string, outcome: FakeFcmOutcome): void;
  /** What the token endpoint answers from now on (default `ok`). */
  arrangeToken(outcome: FakeTokenOutcome, opts?: { expiresIn?: number }): void;
  sends: FakeSendRequest[];
  tokens: FakeTokenRequest[];
  /** Access tokens issued so far, in order. */
  issued: string[];
  /** The conformance view of every send request. */
  requests(): PushVendorRequest[];
  close(): Promise<void>;
}

/** One RSA key pair per test process: generating it is the slow part of a fake. */
const keys = (() => {
  let pair: { privatePem: string; publicKey: KeyObject } | undefined;
  return () => {
    if (pair === undefined) {
      const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      pair = {
        privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        publicKey: createPublicKey(publicKey.export({ type: "spki", format: "pem" })),
      };
    }
    return pair;
  };
})();

/** A PEM private key the fake does not accept (another key pair). */
export function otherPrivateKey(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const b64json = (part: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;

const fcmError = (
  status: number,
  code: string,
  extra: Record<string, unknown>[] = [],
  errorCode?: string,
): FakeReply => ({
  status,
  body: {
    error: {
      code: status,
      message: `fake fcm: ${code}`,
      status: code,
      details: [
        ...(errorCode === undefined
          ? []
          : [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode }]),
        ...extra,
      ],
    },
  },
});

function replyFor(outcome: Exclude<FakeFcmOutcome, "network_error" | "hang">): FakeReply {
  if (typeof outcome === "object") return outcome;
  switch (outcome) {
    case "delivered":
      return { status: 200, body: { name: "projects/fake/messages/0:1" } };
    case "unregistered":
      return fcmError(404, "NOT_FOUND", [], "UNREGISTERED");
    case "invalid_token":
      return fcmError(
        400,
        "INVALID_ARGUMENT",
        [
          {
            "@type": "type.googleapis.com/google.rpc.BadRequest",
            fieldViolations: [
              { field: "message.token", description: "Invalid registration token" },
            ],
          },
        ],
        "INVALID_ARGUMENT",
      );
    case "invalid_argument":
      return fcmError(
        400,
        "INVALID_ARGUMENT",
        [
          {
            "@type": "type.googleapis.com/google.rpc.BadRequest",
            fieldViolations: [{ field: "message.android.ttl", description: "Invalid ttl" }],
          },
        ],
        "INVALID_ARGUMENT",
      );
    case "auth":
      return fcmError(401, "UNAUTHENTICATED");
    case "sender_mismatch":
      return fcmError(403, "PERMISSION_DENIED", [], "SENDER_ID_MISMATCH");
    case "third_party_auth":
      return fcmError(401, "UNAUTHENTICATED", [], "THIRD_PARTY_AUTH_ERROR");
    case "rate_limited":
      return {
        ...fcmError(429, "RESOURCE_EXHAUSTED", [], "QUOTA_EXCEEDED"),
        headers: { "retry-after": "7" },
      };
    case "not_found":
      return fcmError(404, "NOT_FOUND");
    case "transient":
      return fcmError(503, "UNAVAILABLE", [], "UNAVAILABLE");
    case "server_error":
      return fcmError(500, "INTERNAL", [], "INTERNAL");
  }
}

function send(res: ServerResponse, r: FakeReply): void {
  res.writeHead(r.status, { "content-type": "application/json", ...r.headers });
  res.end(typeof r.body === "string" ? r.body : JSON.stringify(r.body));
}

/** Starts the fake on an ephemeral loopback port. */
export async function startFakeFcm(opts: { projectId?: string } = {}): Promise<FakeFcm> {
  const projectId = opts.projectId ?? "capybara-fake";
  const clientEmail = `push@${projectId}.iam.gserviceaccount.com`;
  const { privatePem, publicKey } = keys();
  const outcomes = new Map<string, FakeFcmOutcome>();
  let tokenOutcome: FakeTokenOutcome = "ok";
  let expiresIn = 3599;
  const sends: FakeSendRequest[] = [];
  const tokens: FakeTokenRequest[] = [];
  const issued: string[] = [];
  let tokenUrl = "";

  const server = createServer(async (req, res) => {
    const text = await readBody(req);
    const url = new URL(req.url ?? "/", "http://fake");
    if (req.method === "POST" && url.pathname === "/token") {
      const form = new URLSearchParams(text);
      const [h = "", c = "", s = ""] = (form.get("assertion") ?? "").split(".");
      let header: Record<string, unknown> = {};
      let claims: Record<string, unknown> = {};
      let signatureValid = false;
      try {
        header = b64json(h);
        claims = b64json(c);
        signatureValid = verify(
          "RSA-SHA256",
          Buffer.from(`${h}.${c}`),
          publicKey,
          Buffer.from(s, "base64url"),
        );
      } catch {
        signatureValid = false;
      }
      tokens.push({ grantType: form.get("grant_type") ?? "", header, claims, signatureValid });
      if (tokenOutcome === "network_error") {
        req.socket.destroy();
        return;
      }
      if (tokenOutcome === "server_error") return send(res, { status: 500, body: "oops" });
      if (tokenOutcome === "rate_limited") {
        return send(res, {
          status: 429,
          headers: { "retry-after": "30" },
          body: { error: "rate_limit_exceeded" },
        });
      }
      if (tokenOutcome === "invalid_client") {
        return send(res, { status: 401, body: { error: "invalid_client" } });
      }
      const now = Math.floor(Date.now() / 1000);
      const claimsOk =
        claims.iss === clientEmail &&
        claims.scope === "https://www.googleapis.com/auth/firebase.messaging" &&
        claims.aud === tokenUrl &&
        typeof claims.iat === "number" &&
        typeof claims.exp === "number" &&
        Math.abs(claims.iat - now) < 120 &&
        claims.exp - claims.iat <= 3600;
      if (
        tokenOutcome === "invalid_grant" ||
        !signatureValid ||
        !claimsOk ||
        header.alg !== "RS256" ||
        form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer"
      ) {
        return send(res, {
          status: 400,
          body: { error: "invalid_grant", error_description: "Invalid JWT Signature." },
        });
      }
      const accessToken = `ya29.fake-access-${issued.length + 1}`;
      issued.push(accessToken);
      return send(res, {
        status: 200,
        body: { access_token: accessToken, expires_in: expiresIn, token_type: "Bearer" },
      });
    }
    const m = /^\/v1\/projects\/([^/]+)\/messages:send$/.exec(url.pathname);
    if (req.method === "POST" && m) {
      const authorization = req.headers.authorization ?? "";
      let body: FakeSendRequest["body"];
      try {
        body = JSON.parse(text) as FakeSendRequest["body"];
      } catch {
        return send(res, fcmError(400, "INVALID_ARGUMENT"));
      }
      sends.push({ projectId: decodeURIComponent(m[1] as string), authorization, body });
      if (!issued.some((t) => authorization === `Bearer ${t}`)) {
        return send(res, fcmError(401, "UNAUTHENTICATED"));
      }
      const token = String(body.message?.token ?? "");
      const outcome = outcomes.get(token) ?? "delivered";
      if (outcome === "network_error") {
        req.socket.destroy();
        return;
      }
      if (outcome === "hang") return; // answered never; closed with the server
      return send(res, replyFor(outcome));
    }
    send(res, { status: 404, body: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  tokenUrl = `${base}/token`;
  const serviceAccount = JSON.stringify({
    type: "service_account",
    project_id: projectId,
    private_key_id: "fake-key-id",
    private_key: privatePem,
    client_email: clientEmail,
    client_id: "1234567890",
    token_uri: "https://oauth2.googleapis.com/token",
  });

  return {
    apiBase: base,
    tokenUrl,
    serviceAccount,
    projectId,
    clientEmail,
    arrange: (token, outcome) => void outcomes.set(token, outcome),
    arrangeToken(outcome, o) {
      tokenOutcome = outcome;
      if (o?.expiresIn !== undefined) expiresIn = o.expiresIn;
    },
    sends,
    tokens,
    issued,
    requests: () =>
      sends.map(({ body: { message } }) => {
        const notification = (message.notification ?? {}) as Record<string, unknown>;
        const data = (message.data ?? {}) as Record<string, unknown>;
        const android = (message.android ?? {}) as Record<string, unknown>;
        return {
          token: String(message.token),
          title: String(notification.title),
          body: String(notification.body),
          path: String(data.path),
          origin: String(data.origin),
          threadId: String(data.threadId),
          collapseId: String(android.collapse_key),
        };
      }),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A test-only kv (the real one is the kernel's): records every write with its TTL. */
export function memoryKv() {
  const map = new Map<string, string>();
  const writes: { key: string; value: string; ttlSeconds: number }[] = [];
  const deletes: string[] = [];
  return {
    map,
    writes,
    deletes,
    async get(key: string) {
      return map.get(key) ?? null;
    },
    async set(key: string, value: string, opts: { ttlSeconds: number }) {
      writes.push({ key, value, ttlSeconds: opts.ttlSeconds });
      map.set(key, value);
    },
    async del(key: string) {
      deletes.push(key);
      map.delete(key);
    },
  };
}
