import type {
  SetupCheckArgs,
  SetupCheckDefinition,
  SetupCheckResult,
} from "@capybara-hq/plugin-sdk";
import { workspaceTokenProblem } from "./config.js";

/**
 * The live checks of the `slack-app` setup guide (`guides/slack-app.md`, spec
 * `2026-11-09-setup-guides-v2-design.md` §5.2, §10). Each is registered in `setup` with
 * `ctx.setup.check` and listed in `permissions.setupChecks`.
 *
 * Contract: read only (`auth.test`, `apps.connections.open`; the socket is never opened), one
 * request per run, `signal` on every request, no retries, and never a token in a reason or fix:
 * the texts carry only Slack error codes (checked against {@link ERROR_CODE_RE}), the workspace
 * name and id, and scope names.
 */

/** The bot scopes of the manifests in `guides/slack-app.md` (both modes ask for the same set). */
// capybara:allow-module-state read-only list of scope names, never mutated
export const REQUIRED_BOT_SCOPES = [
  "chat:write",
  "commands",
  "im:write",
  "im:history",
  "app_mentions:read",
  "channels:history",
  "groups:history",
  "users:read",
  "users:read.email",
] as const;

export interface SlackSetupCheckOptions {
  /** The Web API root, read at each run (deployment config `apiUrl`, hot). */
  apiUrl: () => string;
}

type Text = { en: string; zh: string };

/** What one Web API call answered, without the token or any response text beyond these fields. */
type CallResult =
  | { kind: "ok"; body: Record<string, unknown>; headers: Headers }
  | { kind: "error"; code: string }
  | { kind: "http"; status: number }
  | { kind: "network" };

/** A Slack error code is lowercase words; anything else is not echoed into a result. */
const ERROR_CODE_RE = /^[a-z][a-z0-9_.]{0,63}$/;

async function slackCall(
  apiUrl: string,
  method: string,
  token: string,
  signal: AbortSignal,
): Promise<CallResult> {
  let res: Response;
  try {
    res = await fetch(new URL(method, apiUrl), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Bearer ${token}`,
      },
      body: "",
      redirect: "manual",
      signal,
    });
  } catch {
    return { kind: "network" };
  }
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => undefined);
    return { kind: "http", status: res.status };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { kind: "network" };
  }
  if (typeof body !== "object" || body === null) return { kind: "error", code: "invalid_response" };
  const b = body as Record<string, unknown>;
  if (b.ok === true) return { kind: "ok", body: b, headers: res.headers };
  const code =
    typeof b.error === "string" && ERROR_CODE_RE.test(b.error) ? b.error : "unknown_error";
  return { kind: "error", code };
}

const unknown = (reason: Text): SetupCheckResult => ({ status: "unknown", reason });
const failing = (reason: Text, fix: Text): SetupCheckResult => ({ status: "failing", reason, fix });

/** Error codes meaning Slack is busy or down: nothing for the admin to fix. */
// capybara:allow-module-state read-only lookup table, never mutated
const TRANSIENT = new Set([
  "ratelimited",
  "rate_limited",
  "internal_error",
  "fatal_error",
  "service_unavailable",
  "request_timeout",
]);

/** Error codes meaning the token itself is not accepted. */
// capybara:allow-module-state read-only lookup table, never mutated
const REFUSED = new Set([
  "invalid_auth",
  "not_authed",
  "token_revoked",
  "token_expired",
  "account_inactive",
  "no_permission",
  "ekm_access_denied",
]);

/** The result for a call that did not answer `ok`, when it is not a token problem. */
function notAnswered(r: Exclude<CallResult, { kind: "ok" }>): SetupCheckResult {
  if (r.kind === "network")
    return unknown({
      en: "Could not reach Slack (network error or timeout); check again later.",
      zh: "无法连接 Slack（网络错误或超时），请稍后再检查。",
    });
  if (r.kind === "http") {
    if (r.status === 429)
      return unknown({
        en: "Slack is rate limiting requests; check again in a minute.",
        zh: "Slack 正在限流，请一分钟后再检查。",
      });
    return unknown({
      en: `Slack answered HTTP ${r.status}; check again later.`,
      zh: `Slack 返回 HTTP ${r.status}，请稍后再检查。`,
    });
  }
  if (r.code === "ratelimited" || r.code === "rate_limited")
    return unknown({
      en: "Slack is rate limiting requests; check again in a minute.",
      zh: "Slack 正在限流，请一分钟后再检查。",
    });
  if (TRANSIENT.has(r.code))
    return unknown({
      en: `Slack is temporarily unavailable (${r.code}); check again later.`,
      zh: `Slack 暂时不可用（${r.code}），请稍后再检查。`,
    });
  return unknown({
    en: `Slack answered ${r.code}; the check could not tell whether the setup is right.`,
    zh: `Slack 返回 ${r.code}，无法判断设置是否正确。`,
  });
}

const BOT_TOKEN_FIX: Text = {
  en: "Under Install App, reinstall the app to the workspace and copy the new Bot User OAuth Token (xoxb-…) into the Bot token field.",
  zh: "在 Install App 中把应用重新安装到工作区，再把新的 Bot User OAuth Token（xoxb-…）填进「机器人令牌」。",
};

const MANIFEST_FIX: Text = {
  en: "Open the app at https://api.slack.com/apps, paste the manifest from this guide under App Manifest, save, then reinstall the app under Install App.",
  zh: "在 https://api.slack.com/apps 打开该应用，在 App Manifest 粘贴本指南中的 manifest 并保存，然后在 Install App 中重新安装应用。",
};

/** A bot token refused by Slack, by error code; undefined when the code is not a token problem. */
function botTokenRefused(code: string): SetupCheckResult | undefined {
  if (REFUSED.has(code))
    return failing(
      {
        en: `Slack refused the bot token (${code}); it may have been revoked or the app uninstalled.`,
        zh: `Slack 拒绝了机器人令牌（${code}），令牌可能已被撤销或应用已被卸载。`,
      },
      BOT_TOKEN_FIX,
    );
  if (code === "not_allowed_token_type")
    return failing(
      {
        en: "The Bot token field holds a token of the wrong type (not_allowed_token_type).",
        zh: "「机器人令牌」中的令牌类型不对（not_allowed_token_type）。",
      },
      {
        en: "Copy the Bot User OAuth Token (xoxb-…) from Install App, not a user or app-level token.",
        zh: "从 Install App 复制 Bot User OAuth Token（xoxb-…），不要用用户令牌或应用级令牌。",
      },
    );
  if (code === "missing_scope")
    return failing(
      {
        en: "Slack refused the call for a missing scope (missing_scope).",
        zh: "Slack 因缺少权限拒绝了调用（missing_scope）。",
      },
      MANIFEST_FIX,
    );
  return undefined;
}

/** Strips control, format and separator characters and caps the length of a Slack-provided name. */
function plain(s: unknown, max = 80): string | undefined {
  if (typeof s !== "string") return undefined;
  const t = s
    .replace(/[\p{C}\p{Zl}\p{Zp}]/gu, "")
    .trim()
    .slice(0, max);
  return t === "" ? undefined : t;
}

/** The connection config fields the checks read (the config as `channel@1` verify receives it). */
function tokens(args: SetupCheckArgs): { botToken?: string; appToken?: string } | undefined {
  if (args.target.kind !== "channel-connection") return undefined;
  const c = args.target.config;
  if (typeof c !== "object" || c === null) return {};
  const x = c as Record<string, unknown>;
  return {
    ...(typeof x.botToken === "string" && x.botToken !== "" && { botToken: x.botToken }),
    ...(typeof x.appToken === "string" && x.appToken !== "" && { appToken: x.appToken }),
  };
}

const NOT_A_CONNECTION = unknown({
  en: "This check applies to Slack channel connections only.",
  zh: "此检查只适用于 Slack 渠道连接。",
});
const NO_BOT_TOKEN = failing(
  { en: "No bot token is set on this connection.", zh: "这个渠道连接还没有填写机器人令牌。" },
  {
    en: "Install the app under Install App and copy the Bot User OAuth Token (xoxb-…) into the Bot token field.",
    zh: "在 Install App 安装应用，把 Bot User OAuth Token（xoxb-…）填进「机器人令牌」。",
  },
);

/** `bot-token`: `auth.test` with the connection's bot token. */
export function botTokenCheck(opts: SlackSetupCheckOptions): SetupCheckDefinition {
  return {
    place: "channel-connection",
    async run(args) {
      const t = tokens(args);
      if (t === undefined) return NOT_A_CONNECTION;
      if (t.botToken === undefined) return NO_BOT_TOKEN;
      const r = await slackCall(opts.apiUrl(), "auth.test", t.botToken, args.signal);
      if (r.kind !== "ok") {
        return (r.kind === "error" && botTokenRefused(r.code)) || notAnswered(r);
      }
      const problem = workspaceTokenProblem(r.body);
      if (problem !== undefined)
        return failing(
          {
            en: `${problem}.`,
            zh: "这个机器人令牌不是工作区令牌（来自组织级安装或企业 ID）。",
          },
          {
            en: "Install the app to one workspace (not org-wide) and copy that workspace's Bot User OAuth Token.",
            zh: "把应用安装到单个工作区（不要组织级安装），再复制该工作区的 Bot User OAuth Token。",
          },
        );
      if (typeof r.body.bot_id !== "string" || r.body.bot_id === "")
        return failing(
          {
            en: "Slack accepted the token, but it is not a bot token.",
            zh: "Slack 接受了该令牌，但它不是机器人令牌。",
          },
          {
            en: "Copy the Bot User OAuth Token (xoxb-…) from Install App into the Bot token field.",
            zh: "从 Install App 复制 Bot User OAuth Token（xoxb-…）填进「机器人令牌」。",
          },
        );
      const teamId = plain(r.body.team_id, 32) ?? "";
      const team = plain(r.body.team);
      const where = team !== undefined ? `${team} (${teamId})` : teamId;
      return {
        status: "ok",
        reason: {
          en: `Slack accepted the bot token for workspace ${where}.`,
          zh: `Slack 接受了工作区 ${where} 的机器人令牌。`,
        },
      };
    },
  };
}

/**
 * `bot-scopes`: the scopes Slack reports for the bot token (`x-oauth-scopes` on `auth.test`)
 * against {@link REQUIRED_BOT_SCOPES}; extra scopes are fine.
 */
export function botScopesCheck(opts: SlackSetupCheckOptions): SetupCheckDefinition {
  return {
    place: "channel-connection",
    async run(args) {
      const t = tokens(args);
      if (t === undefined) return NOT_A_CONNECTION;
      if (t.botToken === undefined)
        return unknown({
          en: "No bot token is set yet, so the scopes cannot be read.",
          zh: "还没有填写机器人令牌，无法读取权限。",
        });
      const r = await slackCall(opts.apiUrl(), "auth.test", t.botToken, args.signal);
      if (r.kind !== "ok") {
        if (r.kind === "error" && (REFUSED.has(r.code) || r.code === "not_allowed_token_type"))
          return unknown({
            en: `Slack refused the bot token (${r.code}), so the scopes cannot be read; see the bot token row.`,
            zh: `Slack 拒绝了机器人令牌（${r.code}），无法读取权限；请看「机器人令牌」一行。`,
          });
        return notAnswered(r);
      }
      const header = r.headers.get("x-oauth-scopes");
      if (header === null)
        return unknown({
          en: "Slack did not report the token's scopes; check again later.",
          zh: "Slack 没有返回令牌的权限，请稍后再检查。",
        });
      const granted = new Set(
        header
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== ""),
      );
      const missing = REQUIRED_BOT_SCOPES.filter((s) => !granted.has(s));
      if (missing.length > 0)
        return failing(
          {
            en: `The app is missing the bot scopes ${missing.join(", ")}.`,
            zh: `应用缺少机器人权限 ${missing.join("、")}。`,
          },
          MANIFEST_FIX,
        );
      return {
        status: "ok",
        reason: {
          en: `The bot token has all ${REQUIRED_BOT_SCOPES.length} scopes the manifest asks for.`,
          zh: `机器人令牌具备 manifest 要求的全部 ${REQUIRED_BOT_SCOPES.length} 项权限。`,
        },
      };
    },
  };
}

const APP_TOKEN_FIX: Text = {
  en: "Under Basic Information → App-Level Tokens choose Generate Token and Scopes, add the scope connections:write and copy the xapp-… token into the App-level token field.",
  zh: "在 Basic Information → App-Level Tokens 选择 Generate Token and Scopes，添加权限 connections:write，把 xapp-… 令牌填进「应用令牌」。",
};

/**
 * `app-token`: Socket Mode `apps.connections.open` with the connection's app-level token
 * (long connection mode only). Only the answer is read: the WebSocket URL is dropped unopened.
 */
export function appTokenCheck(opts: SlackSetupCheckOptions): SetupCheckDefinition {
  return {
    place: "channel-connection",
    async run(args) {
      const t = tokens(args);
      if (t === undefined) return NOT_A_CONNECTION;
      if (args.mode !== null && args.mode !== "long_connection")
        return unknown({
          en: "Webhook mode does not use an app-level token.",
          zh: "Webhook 模式不使用应用级令牌。",
        });
      if (t.appToken === undefined)
        return failing(
          {
            en: "No app-level token is set; Socket Mode needs one.",
            zh: "还没有填写应用令牌，Socket Mode 需要它。",
          },
          APP_TOKEN_FIX,
        );
      const r = await slackCall(opts.apiUrl(), "apps.connections.open", t.appToken, args.signal);
      if (r.kind === "ok")
        return {
          status: "ok",
          reason: {
            en: "Slack accepted the app-level token and offered a Socket Mode connection.",
            zh: "Slack 接受了应用令牌，并提供了 Socket Mode 连接。",
          },
        };
      if (r.kind === "error") {
        if (REFUSED.has(r.code))
          return failing(
            {
              en: `Slack refused the app-level token (${r.code}); it may have been revoked.`,
              zh: `Slack 拒绝了应用令牌（${r.code}），令牌可能已被撤销。`,
            },
            APP_TOKEN_FIX,
          );
        if (r.code === "not_allowed_token_type")
          return failing(
            {
              en: "The App-level token field holds a token of the wrong type (not_allowed_token_type).",
              zh: "「应用令牌」中的令牌类型不对（not_allowed_token_type）。",
            },
            APP_TOKEN_FIX,
          );
        if (r.code === "missing_scope")
          return failing(
            {
              en: "The app-level token lacks the scope connections:write (missing_scope).",
              zh: "应用令牌缺少权限 connections:write（missing_scope）。",
            },
            APP_TOKEN_FIX,
          );
      }
      return notAnswered(r);
    },
  };
}
