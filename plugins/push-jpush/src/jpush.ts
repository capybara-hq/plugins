import { createHash } from "node:crypto";
import type {
  PushErrorKind,
  PushMessage,
  PushProvider,
  PushResult,
  PushTarget,
  SetupCheckDefinition,
  SetupCheckResult,
} from "@capybara-hq/plugin-sdk";
import { JPUSH_API, type JPushDeploymentConfig } from "./config.js";

/**
 * JPush REST API v3 (https://docs.jiguang.cn/jpush/server/push/rest_api_v3_push, read
 * 2026-11-21). `POST /v3/push` with HTTP Basic `appKey:masterSecret`; one registration id per
 * request, so a request-level "no such target" answer is about that one id. No retries here: the
 * kernel's queue retries.
 */

/** Test seam: the base URL standing in for `https://api.jpush.cn` (never in the admin config). */
export interface JPushOptions {
  baseUrl?: string;
}

/** Opens the app's launcher activity; the app routes to `extras.path` itself. */
const HOME_INTENT = "intent:#Intent;action=android.intent.action.MAIN;end";

/**
 * The class of a JPush error code: `dead` (1003 invalid value, 1011 no matching target), `auth`
 * (1004 verification failed, 1008 bad app_key, 2003 app blocked, 2004 source IP not allowed),
 * `rate` (2002 API rate / HTTP 429, 1012 vendor quota or push limit, 2005 volume, 2008 broadcast,
 * 2009 / 2010 restricted), else undefined.
 */
function classOf(code: number | undefined): "dead" | "auth" | "rate" | undefined {
  switch (code) {
    case 1003:
    case 1011:
      return "dead";
    case 1004:
    case 1008:
    case 2003:
    case 2004:
      return "auth";
    case 1012:
    case 2002:
    case 2005:
    case 2008:
    case 2009:
    case 2010:
      return "rate";
    default:
      return undefined;
  }
}

/**
 * A string that can be a JPush registration id: printable ASCII without spaces. Anything else is
 * answered `unregistered` without a request; a well-formed sole target answered 1003 is dead too.
 */
const WELL_FORMED_ID = /^[\x21-\x7e]{1,4096}$/;

/**
 * The vendor notification id for a collapse id: the same positive 31-bit integer for every resend
 * of one event, so Huawei, Honor, Xiaomi, OPPO and vivo replace the notification instead of
 * showing it twice (`third_party_channel.<vendor>.notify_id`). JPush itself documents no collapse
 * field for Android; the collapse id also travels in `extras.collapseId` for the app.
 */
export function notifyIdOf(collapseId: string): number {
  const n = createHash("sha256").update(collapseId).digest().readUInt32BE(0) & 0x7fffffff;
  return n === 0 ? 1 : n;
}

const basicAuth = (appKey: string, masterSecret: string) =>
  `Basic ${Buffer.from(`${appKey}:${masterSecret}`).toString("base64")}`;

/** The `/v3/push` body for one registration id. */
export function pushBody(
  cfg: JPushDeploymentConfig,
  registrationId: string,
  m: PushMessage,
): Record<string, unknown> {
  const notifyId = notifyIdOf(m.collapseId);
  const template = { title: m.title, body: m.body };
  const xiaomi: Record<string, unknown> = { notify_id: notifyId };
  if (cfg.xiaomi?.channelId) xiaomi.channel_id = cfg.xiaomi.channelId;
  if (cfg.xiaomi?.templateId) {
    xiaomi.mi_template_id = cfg.xiaomi.templateId;
    xiaomi.mi_template_param = JSON.stringify(template);
  }
  const oppo: Record<string, unknown> = { notify_id: notifyId };
  if (cfg.oppo?.channelId) oppo.channel_id = cfg.oppo.channelId;
  if (cfg.oppo?.category) oppo.category = cfg.oppo.category;
  if (cfg.oppo?.notifyLevel !== undefined) oppo.notify_level = cfg.oppo.notifyLevel;
  const vivo: Record<string, unknown> = { notify_id: notifyId };
  if (cfg.vivo?.category) vivo.category = cfg.vivo.category;
  if (cfg.vivo?.templateId) {
    vivo.vivo_push_type = 4;
    vivo.vivo_template_id = cfg.vivo.templateId;
    vivo.vivo_template_param = template;
  }
  const huawei: Record<string, unknown> = { importance: "NORMAL", notify_id: notifyId };
  if (cfg.huawei?.category) huawei.category = cfg.huawei.category;
  return {
    platform: ["android"],
    audience: { registration_id: [registrationId] },
    notification: {
      android: {
        alert: m.body,
        title: m.title,
        intent: { url: HOME_INTENT },
        extras: {
          path: m.path,
          origin: m.origin,
          threadId: m.threadId,
          collapseId: m.collapseId,
        },
      },
    },
    options: {
      // 1 = system (service) message: highest priority, overrides the vendors' own fields
      classification: 1,
      third_party_channel: {
        huawei,
        honor: { importance: "NORMAL", notify_id: notifyId },
        xiaomi,
        oppo,
        vivo,
      },
    },
  };
}

/** The JPush error code of an answer body, when there is one. */
function errorCodeOf(text: string): number | undefined {
  try {
    const code = (JSON.parse(text) as { error?: { code?: unknown } } | null)?.error?.code;
    return typeof code === "number" ? code : undefined;
  } catch {
    return undefined;
  }
}

/** Retry-After (seconds), else JPush's X-Rate-Limit-Reset (seconds to the window reset). */
function retryAfterMsOf(h: Headers): number | undefined {
  for (const name of ["retry-after", "x-rate-limit-reset"]) {
    const v = h.get(name);
    if (v !== null && /^\d+$/.test(v.trim())) return Number(v.trim()) * 1000;
  }
  return undefined;
}

type Outcome =
  | { status: "delivered" | "unregistered" }
  | { status: "failed"; kind: PushErrorKind; message: string; retryAfterMs?: number };

const failed = (kind: PushErrorKind, message: string, retryAfterMs?: number): Outcome => ({
  status: "failed",
  kind,
  message,
  ...(retryAfterMs !== undefined && { retryAfterMs }),
});

/** Maps one JPush answer (never quoting JPush's message text, which may name the target). */
export function outcomeOf(status: number, headers: Headers, text: string): Outcome {
  const code = errorCodeOf(text);
  if (status >= 200 && status < 300 && code === undefined) return { status: "delivered" };
  const what = code === undefined ? `HTTP ${status}` : `code ${code}, HTTP ${status}`;
  if (classOf(code) === "dead") return { status: "unregistered" };
  if (classOf(code) === "auth" || (code === undefined && (status === 401 || status === 403))) {
    return failed("auth", `JPush rejected the app key or master secret (${what})`);
  }
  if (classOf(code) === "rate" || (code === undefined && status === 429)) {
    return failed("rate_limited", `JPush limited the push (${what})`, retryAfterMsOf(headers));
  }
  return failed("transient", `JPush could not take the push (${what})`);
}

async function postOne(
  url: string,
  auth: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Outcome> {
  let res: Response;
  let text: string;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    text = await res.text();
  } catch {
    return failed(
      "transient",
      signal.aborted ? "the JPush request was aborted" : "JPush could not be reached",
    );
  }
  return outcomeOf(res.status, res.headers, text);
}

/**
 * The `push-provider@1` implementation for JPush: one request per registration, in order. After
 * an auth or rate_limited answer (which concern the whole app key) and after an abort, the
 * remaining registrations get the same failure without a request.
 */
export function createJPushProvider(
  cfg: JPushDeploymentConfig,
  opts: JPushOptions = {},
): PushProvider {
  const apps = Object.freeze([...cfg.applicationIds]);
  const url = `${(opts.baseUrl ?? JPUSH_API).replace(/\/+$/, "")}/v3/push`;
  const auth = basicAuth(cfg.appKey, cfg.masterSecret);
  return {
    apps: () => apps,
    async send({ registrations, message, signal }) {
      const results: PushResult[] = [];
      let stop: Outcome | undefined;
      for (const r of registrations) {
        const outcome = stop ?? (await one(r));
        if (outcome.status === "failed" && outcome.kind !== "transient") stop = outcome;
        results.push({ registrationId: r.id, ...outcome } as PushResult);
      }
      return results;

      async function one(r: PushTarget): Promise<Outcome> {
        if (signal.aborted) return failed("transient", "the JPush request was aborted");
        if (!WELL_FORMED_ID.test(r.token)) return { status: "unregistered" };
        return postOne(url, auth, pushBody(cfg, r.token, message), signal);
      }
    },
  };
}

const text = (en: string, zh: string) => ({ en, zh });

/** What to do for a credential code of JPush. */
function fixOf(code: number | undefined): { en: string; zh: string } {
  switch (code) {
    case 2004:
      return text(
        "Add this deployment's outbound IP addresses to the IP allowlist in the JPush console (app settings), or turn the allowlist off.",
        "在极光控制台（应用设置）的 IP 白名单中加入本部署的出口 IP，或关闭白名单。",
      );
    case 2003:
      return text(
        "JPush has restricted API calls for this app key; contact JPush support.",
        "极光已限制该 AppKey 调用 API，请联系极光技术支持。",
      );
    default:
      return text(
        "Copy the AppKey and Master Secret again from the JPush console (app settings) and save them on this page.",
        "从极光控制台（应用设置）重新复制 AppKey 和 Master Secret，并保存到本页面。",
      );
  }
}

/**
 * The `jpush-credentials` setup check (place `extension-deployment`): `GET /v3/push/cid?count=1`
 * needs a valid appKey:masterSecret and sends nothing (it hands out a push id that expires after a
 * day unused). ok on 200; failing on JPush's credential codes; unknown otherwise. The result names
 * only JPush's codes, never a part of the credentials.
 */
export function createCredentialsCheck(opts: JPushOptions = {}): SetupCheckDefinition {
  const base = (opts.baseUrl ?? JPUSH_API).replace(/\/+$/, "");
  return {
    place: "extension-deployment",
    async run(args): Promise<SetupCheckResult> {
      const c = (args.target.kind === "extension-deployment" ? args.target.config : null) as {
        appKey?: unknown;
        masterSecret?: unknown;
      } | null;
      const appKey = typeof c?.appKey === "string" ? c.appKey.trim() : "";
      const masterSecret = typeof c?.masterSecret === "string" ? c.masterSecret.trim() : "";
      if (appKey === "" || masterSecret === "") {
        return {
          status: "failing",
          reason: text(
            "The AppKey or the Master Secret is not set.",
            "尚未设置 AppKey 或 Master Secret。",
          ),
          fix: fixOf(undefined),
        };
      }
      let res: Response;
      let body: string;
      try {
        res = await fetch(`${base}/v3/push/cid?count=1`, {
          headers: { authorization: basicAuth(appKey, masterSecret) },
          signal: args.signal,
        });
        body = await res.text();
      } catch {
        return {
          status: "unknown",
          reason: text("JPush could not be reached.", "无法连接极光推送。"),
        };
      }
      if (res.ok) {
        return {
          status: "ok",
          reason: text(
            "JPush accepted the AppKey and Master Secret.",
            "极光推送接受了 AppKey 和 Master Secret。",
          ),
        };
      }
      const code = errorCodeOf(body);
      const credential = classOf(code) === "auth" || (code === undefined && res.status === 401);
      if (credential) {
        const what = code === undefined ? `HTTP ${res.status}` : `code ${code}`;
        return {
          status: "failing",
          reason: text(
            `JPush refused the credentials (${what}).`,
            `极光推送拒绝了这组凭据（${what}）。`,
          ),
          fix: fixOf(code),
        };
      }
      const what = code === undefined ? `HTTP ${res.status}` : `code ${code}`;
      return {
        status: "unknown",
        reason: text(
          `JPush could not verify the credentials right now (${what}).`,
          `极光推送暂时无法验证凭据（${what}）。`,
        ),
      };
    },
  };
}
