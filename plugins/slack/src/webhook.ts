import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  ChannelWebhookRequest,
  ChannelWebhookResponse,
  ChannelWebhookResult,
  InboundEvent,
} from "@capybara-hq/plugin-sdk";

/**
 * Slack webhook inbound (Events API Request URL and Interactivity Request URL), as an alternative
 * to Socket Mode. References (checked 2026-10-23):
 * - signing: https://docs.slack.dev/authentication/verifying-requests-from-slack/
 *   (`x-slack-signature` = `v0=` + hex HMAC-SHA256(signing secret, `v0:<timestamp>:<raw body>`),
 *   reject timestamps more than five minutes away from now);
 * - URL verification and event delivery: https://docs.slack.dev/apis/events-api/
 *   (`url_verification` carries `challenge`; events arrive as `event_callback`; Slack retries a
 *   delivery not answered with 2xx within 3 seconds, with `x-slack-retry-num`);
 * - interactivity: https://docs.slack.dev/interactivity/handling-user-interaction/
 *   (`application/x-www-form-urlencoded` body with one `payload` field holding the JSON).
 *
 * The payloads are the same objects Socket Mode wraps in `events_api` / `interactive` envelopes,
 * so both modes go through one parser and produce identical events (same `messageId` /
 * `eventId`, so the kernel's dedupe works across a mode switch).
 */

/** Replay window for `x-slack-request-timestamp`, in seconds either way. */
export const SLACK_REPLAY_WINDOW_SECONDS = 300;

/** A Socket Mode-style envelope: the payload of `events_api` or `interactive`. */
export interface SlackEnvelope {
  type: "events_api" | "interactive";
  body: unknown;
}

/** What a webhook request is, before turning it into events. */
export type SlackWebhookRead =
  | { kind: "respond"; response: ChannelWebhookResponse }
  | { kind: "reject"; status: 400 | 401 }
  | { kind: "ignore" }
  | { kind: "envelope"; envelope: SlackEnvelope };

/** Empty 200: Slack's ack for both events and interactive payloads. */
export const SLACK_WEBHOOK_ACK: ChannelWebhookResponse = {
  status: 200,
  headers: { "content-type": "text/plain; charset=utf-8" },
  body: "",
};

const obj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

/**
 * Checks Slack's request signature in constant time and that the timestamp lies within
 * {@link SLACK_REPLAY_WINDOW_SECONDS} of `nowMs`. Header names are lowercase (as the kernel passes
 * them).
 */
export function verifySlackSignature(
  h: Readonly<Record<string, string>>,
  body: Uint8Array,
  signingSecret: string,
  nowMs: number,
): boolean {
  const ts = h["x-slack-request-timestamp"];
  const sig = h["x-slack-signature"];
  if (ts === undefined || sig === undefined || !/^\d{1,12}$/.test(ts)) return false;
  if (Math.abs(nowMs / 1000 - Number(ts)) > SLACK_REPLAY_WINDOW_SECONDS) return false;
  const mac = createHmac("sha256", signingSecret).update(`v0:${ts}:`).update(body).digest("hex");
  const want = Buffer.from(`v0=${mac}`);
  const got = Buffer.from(sig);
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * Verifies and decodes one webhook request (no network): no signing secret configured or a bad /
 * stale signature → reject 401; malformed body → reject 400; `url_verification` → respond with
 * the challenge (before any event parsing); `event_callback` → `events_api` envelope; a form
 * `payload` → `interactive` envelope; anything else (e.g. `app_rate_limited`) → ignore (acked).
 */
export function readSlackWebhook(
  config: { signingSecret?: string | undefined },
  request: ChannelWebhookRequest,
): SlackWebhookRead {
  if (config.signingSecret === undefined) return { kind: "reject", status: 401 };
  if (
    !verifySlackSignature(request.headers, request.body, config.signingSecret, request.receivedAt)
  ) {
    return { kind: "reject", status: 401 };
  }
  const text = new TextDecoder().decode(request.body);
  const type = (request.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  if (type === "application/x-www-form-urlencoded") {
    const payload = new URLSearchParams(text).get("payload");
    if (payload === null) return { kind: "ignore" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return { kind: "reject", status: 400 };
    }
    if (!obj(parsed)) return { kind: "reject", status: 400 };
    return { kind: "envelope", envelope: { type: "interactive", body: parsed } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "reject", status: 400 };
  }
  const b = obj(parsed);
  if (!b) return { kind: "reject", status: 400 };
  if (b.type === "url_verification") {
    if (typeof b.challenge !== "string") return { kind: "reject", status: 400 };
    return {
      kind: "respond",
      response: {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ challenge: b.challenge }),
      },
    };
  }
  if (b.type === "event_callback") {
    return { kind: "envelope", envelope: { type: "events_api", body: b } };
  }
  return { kind: "ignore" };
}

/**
 * One webhook request → kernel result. `botUserId` is resolved only for a genuine
 * `event_callback` (never before the signature check); `toEvent` is the parser shared with Socket
 * Mode. A failing `botUserId` throws (the kernel answers 500 and Slack retries).
 */
export async function handleSlackWebhook(args: {
  config: { signingSecret?: string | undefined };
  request: ChannelWebhookRequest;
  botUserId: () => Promise<string>;
  toEvent: (envelope: SlackEnvelope, botUserId: string) => Promise<InboundEvent | null>;
}): Promise<ChannelWebhookResult> {
  const r = readSlackWebhook(args.config, args.request);
  if (r.kind === "respond" || r.kind === "reject") return r;
  if (r.kind === "ignore") return { kind: "events", events: [], ack: SLACK_WEBHOOK_ACK };
  const bot = r.envelope.type === "events_api" ? await args.botUserId() : "";
  const event = await args.toEvent(r.envelope, bot);
  return { kind: "events", events: event ? [event] : [], ack: SLACK_WEBHOOK_ACK };
}
