import type { ExternalIdentity, IdentitySource } from "@capybara-hq/plugin-sdk";
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";
import { SLACK_ISSUER, SlackDeployment, type SlackDeploymentConfig } from "./config.js";

/** Sign in with Slack 申请的 scope（https://docs.slack.dev/authentication/sign-in-with-slack/ ，2026-10-20 查阅）。 */
export const SLACK_OIDC_SCOPES = "openid email profile";
/** Slack 在 ID token / userInfo 里用的命名空间声明。 */
const TEAM_CLAIM = "https://slack.com/team_id";
const USER_CLAIM = "https://slack.com/user_id";
/** 单次请求（换 token、userInfo、取 JWKS）的超时；内核给的 signal（15 秒）同时生效。 */
const REQUEST_TIMEOUT_MS = 10_000;

type Claims = Record<string, unknown>;

const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
const isHttpUrl = (v: string) => /^https?:\/\//i.test(v);

/** 部署配置 → 登录所需字段；没配 client id / secret 时抛错（内核据此显示「登录方式不可用」）。 */
function loginConfig(config: unknown): SlackDeploymentConfig & {
  clientId: string;
  clientSecret: string;
} {
  const c = SlackDeployment.parse(config ?? {});
  if (c.clientId === undefined || c.clientSecret === undefined) {
    throw new Error(
      "Sign in with Slack is not configured: set clientId and clientSecret in the slack plugin deployment config",
    );
  }
  return { ...c, clientId: c.clientId, clientSecret: c.clientSecret };
}

/** POST 一个 Slack Web API 方法（表单），返回 `ok: true` 的响应体；失败只带错误码 / HTTP 状态。 */
async function slackPost(
  apiUrl: string,
  method: string,
  form: Record<string, string>,
  signal: AbortSignal,
  token?: string,
): Promise<Claims> {
  let res: Response;
  try {
    res = await fetch(new URL(method, apiUrl), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(token !== undefined && { authorization: `Bearer ${token}` }),
      },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
  } catch {
    throw new Error(`Slack ${method} failed: network error`);
  }
  if (res.status !== 200) {
    await res.body?.cancel();
    throw new Error(`Slack ${method} failed: HTTP ${res.status}`);
  }
  const body = (await res.json().catch(() => undefined)) as Claims | undefined;
  if (body?.ok !== true) {
    throw new Error(`Slack ${method} failed: ${str(body?.error) ?? "malformed response"}`);
  }
  return body;
}

/**
 * Sign in with Slack（`identity-source@1`，OpenID Connect；
 * https://docs.slack.dev/authentication/sign-in-with-slack/ ，2026-10-20 查阅）。
 *
 * - 授权：`<openidUrl>openid/connect/authorize`，`response_type=code`、`scope=openid email profile`、
 *   `client_id`、`redirect_uri`、`state`、`nonce`。
 * - **不用 PKCE**：Slack 的 OIDC 文档与 discovery（`/.well-known/openid-configuration`）都没有声明 PKCE；
 *   Slack 的 PKCE（https://docs.slack.dev/authentication/using-pkce ）只针对 `oauth.v2.*`，且启用后应用
 *   不可逆地变成公开客户端。故忽略内核给的 `codeChallenge` / `codeVerifier`；防护靠内核的 state（单次有效、
 *   绑定浏览器 Cookie）、nonce 与 client secret（机密客户端，`client_secret_post`）。
 * - 回调：`openid.connect.token` 用授权码换 access token 与 `id_token`；**校验 ID token**（jose：JWKS
 *   `<openidUrl>openid/connect/keys` 验 RS256 签名、`iss = https://slack.com`、`aud = clientId`、`exp`，
 *   再核对 `nonce`）；再用 access token 调 `openid.connect.userInfo` 取资料，其用户 / 工作区必须与 ID token 一致。
 * - 身份键：`source = slack:<team_id>`、`externalId` = Slack user id（`https://slack.com/user_id`，即渠道入站的
 *   发言人 id、`users.list` 的 `id`），`tenantId` = team id——与渠道、通讯录同一个键。
 * - `emailVerified` 取 Slack 的 `email_verified`（必须是 true 才算）。
 * 错误消息只带错误码，不带 client secret、授权码或令牌。
 */
export function createSlackIdentitySource(): IdentitySource {
  /** 每个 JWKS 地址一个远程密钥集（jose 自带缓存与冷却；纯性能缓存，随实例存在）。 */
  const jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
  const keySet = (openidUrl: string) => {
    const url = new URL("openid/connect/keys", openidUrl).toString();
    let set = jwks.get(url);
    if (!set) {
      set = createRemoteJWKSet(new URL(url), { timeoutDuration: REQUEST_TIMEOUT_MS });
      jwks.set(url, set);
    }
    return set;
  };

  return {
    label: { zh: "Slack", en: "Slack" },

    authorizeUrl({ config, redirectUri, state, nonce }) {
      const c = loginConfig(config);
      const u = new URL("openid/connect/authorize", c.openidUrl);
      u.searchParams.set("response_type", "code");
      u.searchParams.set("scope", SLACK_OIDC_SCOPES);
      u.searchParams.set("client_id", c.clientId);
      u.searchParams.set("redirect_uri", redirectUri);
      u.searchParams.set("state", state);
      u.searchParams.set("nonce", nonce);
      return u.toString();
    },

    async callback({ config, redirectUri, query, nonce, signal }): Promise<ExternalIdentity> {
      const c = loginConfig(config);
      if (query.error !== undefined) {
        throw new Error(`Slack authorization failed: ${query.error.slice(0, 100)}`);
      }
      const code = query.code;
      if (code === undefined || code === "") throw new Error("Slack authorization code missing");

      const token = await slackPost(
        c.apiUrl,
        "openid.connect.token",
        {
          client_id: c.clientId,
          client_secret: c.clientSecret,
          code,
          redirect_uri: redirectUri,
        },
        signal,
      );
      const accessToken = str(token.access_token);
      const idToken = str(token.id_token);
      if (!accessToken || !idToken) {
        throw new Error("Slack openid.connect.token failed: no access_token / id_token");
      }

      let claims: JWTPayload;
      try {
        claims = (
          await jwtVerify(idToken, keySet(c.openidUrl), {
            issuer: SLACK_ISSUER,
            audience: c.clientId,
            algorithms: ["RS256"],
          })
        ).payload;
      } catch (e) {
        throw new Error(`Slack ID token rejected: ${(e as Error).message}`);
      }
      signal.throwIfAborted();
      if (claims.nonce !== nonce) throw new Error("Slack ID token rejected: nonce mismatch");
      const teamId = str(claims[TEAM_CLAIM]);
      const userId = str(claims[USER_CLAIM]) ?? str(claims.sub);
      if (!teamId || !userId) throw new Error("Slack ID token rejected: no team / user id");

      const info = await slackPost(c.apiUrl, "openid.connect.userInfo", {}, signal, accessToken);
      const infoUser = str(info[USER_CLAIM]) ?? str(info.sub);
      if (infoUser !== userId || str(info[TEAM_CLAIM]) !== teamId) {
        throw new Error("Slack userInfo does not match the ID token (user / team)");
      }

      const email = str(info.email);
      const picture = str(info.picture);
      return {
        source: `slack:${teamId}`,
        externalId: userId,
        tenantId: teamId,
        ...(email !== undefined && { email }),
        emailVerified: email !== undefined && info.email_verified === true,
        displayName: str(info.name) ?? str(info.given_name) ?? userId,
        ...(picture !== undefined && isHttpUrl(picture) && { avatarUrl: picture }),
      };
    },
  };
}
