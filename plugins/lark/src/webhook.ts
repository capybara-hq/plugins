import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import type {
  ChannelWebhookRequest,
  ChannelWebhookResponse,
  ChannelWebhookResult,
  InboundEvent,
} from "@capybara-hq/plugin-sdk";

/**
 * Lark webhook inbound (event subscription and card callback Request URLs), as an alternative to
 * the long connection. References (checked 2026-10-23):
 * - encryption: https://open.larksuite.com/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-/encrypt-key-encryption-configuration-case
 *   (with an Encrypt Key every request body is `{"encrypt":"<base64>"}`: AES-256-CBC, key =
 *   SHA-256(Encrypt Key), the first 16 bytes are the IV, PKCS#7 padding);
 * - signature: `x-lark-signature` = hex SHA-256(`x-lark-request-timestamp` +
 *   `x-lark-request-nonce` + Encrypt Key + raw body), sent when an Encrypt Key is set;
 * - URL verification: `{"type":"url_verification","challenge","token"}` (encrypted like any other
 *   request when a key is set), answered with `{"challenge"}` within 1 second;
 * - events (schema 2.0) carry the Verification Token in `header.token`; card callbacks
 *   `card.action.trigger` are delivered the same way.
 *
 * Decrypted payloads are the same objects the long connection delivers, so both modes go through
 * one parser and produce identical events (same `messageId` / `eventId`, so the kernel's dedupe
 * works across a mode switch).
 */

/** Replay window for `x-lark-request-timestamp`, in seconds either way. */
export const LARK_REPLAY_WINDOW_SECONDS = 300;

/** Lark's ack: 200 with an empty JSON object (for a card callback: leave the card unchanged). */
export const LARK_WEBHOOK_ACK: ChannelWebhookResponse = {
  status: 200,
  headers: { "content-type": "application/json; charset=utf-8" },
  body: "{}",
};

/** What a webhook request is, before turning it into events. */
export type LarkWebhookRead =
  | { kind: "respond"; response: ChannelWebhookResponse }
  | { kind: "reject"; status: 400 | 401 }
  | { kind: "payload"; payload: Record<string, unknown> };

export interface LarkWebhookSecrets {
  encryptKey?: string | undefined;
  verificationToken?: string | undefined;
}

const obj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

const sameText = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Decrypts an `encrypt` field and parses the JSON inside; throws when either step fails. */
export function decryptLarkEvent(encrypt: string, encryptKey: string): unknown {
  const buf = Buffer.from(encrypt, "base64");
  if (buf.length < 32 || buf.length % 16 !== 0) throw new Error("malformed Lark ciphertext");
  const key = createHash("sha256").update(encryptKey).digest();
  const decipher = createDecipheriv("aes-256-cbc", key, buf.subarray(0, 16));
  const plain = Buffer.concat([decipher.update(buf.subarray(16)), decipher.final()]);
  return JSON.parse(plain.toString("utf8"));
}

/**
 * Checks Lark's request signature in constant time and that the timestamp lies within
 * {@link LARK_REPLAY_WINDOW_SECONDS} of `nowMs`. Header names are lowercase (as the kernel passes
 * them).
 */
export function verifyLarkSignature(
  h: Readonly<Record<string, string>>,
  body: Uint8Array,
  encryptKey: string,
  nowMs: number,
): boolean {
  const ts = h["x-lark-request-timestamp"];
  const nonce = h["x-lark-request-nonce"];
  const sig = h["x-lark-signature"];
  if (ts === undefined || nonce === undefined || sig === undefined) return false;
  if (!/^\d{1,12}$/.test(ts)) return false;
  if (Math.abs(nowMs / 1000 - Number(ts)) > LARK_REPLAY_WINDOW_SECONDS) return false;
  const want = createHash("sha256")
    .update(ts + nonce + encryptKey)
    .update(body)
    .digest("hex");
  return sameText(sig.toLowerCase(), want);
}

/**
 * Verifies and decodes one webhook request (no network):
 * - neither `encryptKey` nor `verificationToken` configured → reject 401;
 * - with `encryptKey`: the body must be encrypted (plaintext → 401); a signature, when present,
 *   is checked first (bad / stale → 401); decryption failure → 400; events must be signed
 *   (unsigned → 401; only URL verification comes unsigned);
 * - without `encryptKey`: plaintext only (an encrypted body → 401), authenticated by the token;
 * - `verificationToken`, when configured, must match (`token` of the challenge, `header.token` of
 *   events) → else 401;
 * - `url_verification` is answered with the challenge before any event parsing.
 */
export function readLarkWebhook(
  config: LarkWebhookSecrets,
  request: ChannelWebhookRequest,
): LarkWebhookRead {
  const { encryptKey, verificationToken } = config;
  if (encryptKey === undefined && verificationToken === undefined) {
    return { kind: "reject", status: 401 };
  }
  let outer: Record<string, unknown> | undefined;
  try {
    outer = obj(JSON.parse(new TextDecoder().decode(request.body)));
  } catch {
    return { kind: "reject", status: 400 };
  }
  if (!outer) return { kind: "reject", status: 400 };
  const encrypted = typeof outer.encrypt === "string";
  if (encrypted !== (encryptKey !== undefined)) return { kind: "reject", status: 401 };

  // A signed request is checked before decrypting, so a changed byte is a 401, not a 400
  const signed = request.headers["x-lark-signature"] !== undefined;
  if (
    encryptKey !== undefined &&
    signed &&
    !verifyLarkSignature(request.headers, request.body, encryptKey, request.receivedAt)
  ) {
    return { kind: "reject", status: 401 };
  }
  let payload: Record<string, unknown> | undefined = outer;
  if (encryptKey !== undefined) {
    try {
      payload = obj(decryptLarkEvent(outer.encrypt as string, encryptKey));
    } catch {
      return { kind: "reject", status: 400 };
    }
    if (!payload) return { kind: "reject", status: 400 };
  }

  if (payload.type === "url_verification") {
    // A request that decrypted with our key is genuine; the token is checked when configured
    if (verificationToken !== undefined) {
      if (typeof payload.token !== "string" || !sameText(payload.token, verificationToken)) {
        return { kind: "reject", status: 401 };
      }
    }
    if (typeof payload.challenge !== "string") return { kind: "reject", status: 400 };
    return {
      kind: "respond",
      response: {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ challenge: payload.challenge }),
      },
    };
  }

  // Events must be signed when a key is set (only URL verification comes unsigned)
  if (encryptKey !== undefined && !signed) return { kind: "reject", status: 401 };
  if (verificationToken !== undefined) {
    const token = obj(payload.header)?.token ?? payload.token;
    if (typeof token !== "string" || !sameText(token, verificationToken)) {
      return { kind: "reject", status: 401 };
    }
  }
  return { kind: "payload", payload };
}

/**
 * One webhook request → kernel result. `botOpenId` is resolved only for a genuine message event
 * (`im.message.receive_v1`; card callbacks and directory events don't need it); `toEvent` is the
 * parser shared with the long connection. A failing `botOpenId` throws (the kernel answers 500 and
 * Lark retries).
 */
export async function handleLarkWebhook(args: {
  config: LarkWebhookSecrets;
  request: ChannelWebhookRequest;
  botOpenId: () => Promise<string>;
  toEvent: (payload: Record<string, unknown>, botOpenId: string) => Promise<InboundEvent | null>;
}): Promise<ChannelWebhookResult> {
  const r = readLarkWebhook(args.config, args.request);
  if (r.kind !== "payload") return r;
  const needsBot = obj(r.payload.header)?.event_type === "im.message.receive_v1";
  const bot = needsBot ? await args.botOpenId() : "";
  const event = await args.toEvent(r.payload, bot);
  return { kind: "events", events: event ? [event] : [], ack: LARK_WEBHOOK_ACK };
}
