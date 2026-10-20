import type { ExternalIdentity, IdentitySource } from "@capybara-hq/plugin-sdk";
import { createLarkApi, type LarkApi } from "./api.js";
import { accountsBaseOf, apiBaseOf, LarkDeployment, type LarkDeploymentConfig } from "./config.js";
import { describeError } from "./errors.js";
import { tenantKeyOf } from "./tenant.js";

/**
 * 登录时向用户申请的权限：`contact:user.email:readonly`（用户信息里的 `email` 字段需要它）。scope 必须先在开发者
 * 后台为应用开通，否则用户授权时报 20027（README 写明）。
 */
export const LARK_LOGIN_SCOPES = "contact:user.email:readonly";
/** 单次请求（换 token、用户信息、企业信息）的超时；内核给的 signal（15 秒）同时生效。 */
const REQUEST_TIMEOUT_MS = 10_000;

const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
const isHttpUrl = (v: string) => /^https?:\/\//i.test(v);

/** 部署配置 → 登录所需字段；没配 appId / appSecret 时抛错（内核据此显示「登录方式不可用」）。 */
function loginConfig(config: unknown): LarkDeploymentConfig & { appId: string; appSecret: string } {
  const c = LarkDeployment.parse(config ?? {});
  if (c.appId === undefined || c.appSecret === undefined) {
    throw new Error(
      "Sign in with Lark is not configured: set appId and appSecret in the lark plugin deployment config",
    );
  }
  return { ...c, appId: c.appId, appSecret: c.appSecret };
}

/**
 * Lark 网页登录（`identity-source@1`，OAuth 2.0 授权码 + PKCE；文档均 2026-10-20 查阅）：
 *
 * - 授权页（https://open.larksuite.com/document/common-capabilities/sso/api/obtain-oauth-code ）：
 *   `GET https://accounts.larksuite.com/open-apis/authen/v1/authorize`，`client_id`（App ID）、`redirect_uri`（须在
 *   开发者后台「安全设置 → 重定向 URL」登记）、`scope`（空格分隔）、`state`（原样回传）、`code_challenge` /
 *   `code_challenge_method`（**支持 PKCE**，`S256` 或 `plain`）。用户同意后 302 回 `redirect_uri?code=…&state=…`，
 *   拒绝时 `error=access_denied`。授权码 5 分钟内有效、**只能用一次**。
 * - 换 token（https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/get-user-access-token ）：
 *   v2 OAuth 端点 `POST /open-apis/authen/v2/oauth/token`（RFC 6749），JSON 体 `grant_type=authorization_code`、
 *   `client_id`、`client_secret`、`code`、`redirect_uri`（网页应用必填，须与授权时**严格**一致，否则 20071）、
 *   `code_verifier`（用了 PKCE 时必填，不符 20049）。不需要先取 app_access_token。失败为 HTTP 4xx + `code`
 *   （20003 授权码无效、20065 已用过、20002 secret 错误…）。
 * - 用户信息（https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/authen-v1/user_info/get ）：
 *   `GET /open-apis/authen/v1/user_info`（Bearer user_access_token）→ `open_id`（应用内唯一）、`union_id`、
 *   `tenant_key`、`name`、`en_name`、`avatar_url` / `avatar_thumb`…、`email`（需 `contact:user.email:readonly`）、
 *   `enterprise_email`（需 `contact:user.employee:readonly`，且租户启用了 Lark 邮箱）。
 *
 * 选择：
 * - **用 PKCE**：内核给的 `codeChallenge`（S256）放进授权地址，换 token 时带 `codeVerifier`；旧内核不给时省略。
 * - **没有 id_token / nonce**（Lark 网页授权不是 OIDC），`nonce` 不用。防重放靠：内核的 state（单次有效、绑定浏览器
 *   Cookie、先取后删）+ 授权码单次有效且 5 分钟过期 + PKCE（授权码绑定本次发起的 verifier）+ client secret（机密
 *   客户端）+ `redirect_uri` 严格一致。用户信息只经 TLS 从开放平台取得，不经浏览器。
 * - **租户核对**：用户的 `tenant_key` 必须等于登录应用自己的租户（企业信息接口），否则拒绝——自建应用只给本租户
 *   的人用，这里再守一道。
 * - 身份键：`source = lark:<tenant_key>`、`tenantId = tenant_key`、`externalId = open_id`——与渠道入站的
 *   `sender.externalId`（事件的 `sender_id.open_id`）、通讯录的 `open_id` 相同，**前提是三处用同一个应用**
 *   （`open_id` 按应用区分）。
 * - **`emailVerified` 一律 false**：用户信息文档没有说明 `email` 或 `enterprise_email` 是否经过验证（`email` 是管理员
 *   或本人填写的资料；`enterprise_email` 只说「请先确保已启用 Lark 邮箱服务」）。内核只对受信任租户、已验证邮箱
 *   合并账号，这里不放宽。邮箱取 `email`，没有时取 `enterprise_email`。
 * 错误消息只带步骤与错误码，不带 client secret、授权码或令牌。
 */
export function createLarkIdentitySource(): IdentitySource {
  /** 每个开放平台根地址一个客户端（tenant token 缓存；纯性能缓存，随实例存在）。 */
  const apis = new Map<string, LarkApi>();
  const apiOf = (base: string) => {
    let a = apis.get(base);
    if (!a) {
      a = createLarkApi({ baseUrl: base, timeoutMs: REQUEST_TIMEOUT_MS });
      apis.set(base, a);
    }
    return a;
  };

  return {
    label: { zh: "Lark", en: "Lark" },

    authorizeUrl({ config, redirectUri, state, codeChallenge, codeChallengeMethod }) {
      const c = loginConfig(config);
      const u = new URL(`${accountsBaseOf(c)}/open-apis/authen/v1/authorize`);
      u.searchParams.set("client_id", c.appId);
      u.searchParams.set("redirect_uri", redirectUri);
      u.searchParams.set("scope", LARK_LOGIN_SCOPES);
      u.searchParams.set("state", state);
      if (codeChallenge !== undefined) {
        u.searchParams.set("code_challenge", codeChallenge);
        u.searchParams.set("code_challenge_method", codeChallengeMethod ?? "S256");
      }
      return u.toString();
    },

    async callback({
      config,
      redirectUri,
      query,
      signal,
      codeVerifier,
    }): Promise<ExternalIdentity> {
      const c = loginConfig(config);
      if (query.error !== undefined) {
        throw new Error(`Lark authorization failed: ${query.error.slice(0, 100)}`);
      }
      const code = query.code;
      if (code === undefined || code === "") throw new Error("Lark authorization code missing");
      const api = apiOf(apiBaseOf(c));

      let accessToken: string | undefined;
      try {
        const r = await api.raw<{ access_token?: unknown }>("/open-apis/authen/v2/oauth/token", {
          method: "POST",
          body: {
            grant_type: "authorization_code",
            client_id: c.appId,
            client_secret: c.appSecret,
            code,
            redirect_uri: redirectUri,
            ...(codeVerifier !== undefined && { code_verifier: codeVerifier }),
          },
          signal,
          oauth: true,
        });
        accessToken = str(r.access_token);
      } catch (e) {
        signal.throwIfAborted();
        throw describeError(e, "OAuth token exchange");
      }
      if (accessToken === undefined) {
        throw new Error("Lark OAuth token exchange failed: no access_token");
      }

      let info: Record<string, unknown>;
      try {
        const r = await api.raw<{ data?: unknown }>("/open-apis/authen/v1/user_info", {
          signal,
          bearer: accessToken,
        });
        info =
          typeof r.data === "object" && r.data !== null ? (r.data as Record<string, unknown>) : {};
      } catch (e) {
        signal.throwIfAborted();
        throw describeError(e, "user info");
      }
      const openId = str(info.open_id);
      const tenantKey = str(info.tenant_key);
      if (openId === undefined || tenantKey === undefined) {
        throw new Error("Lark user info has no open_id / tenant_key");
      }

      const appTenant = await tenantKeyOf(api, { appId: c.appId, appSecret: c.appSecret }, signal);
      if (tenantKey !== appTenant) {
        throw new Error(
          `Lark user belongs to tenant ${tenantKey}, not the login app's tenant ${appTenant}`,
        );
      }

      const email = str(info.email) ?? str(info.enterprise_email);
      const avatar = str(info.avatar_url) ?? str(info.avatar_thumb);
      return {
        source: `lark:${tenantKey}`,
        externalId: openId,
        tenantId: tenantKey,
        ...(email !== undefined && { email }),
        emailVerified: false,
        displayName: str(info.name) ?? str(info.en_name) ?? openId,
        ...(avatar !== undefined && isHttpUrl(avatar) && { avatarUrl: avatar }),
      };
    },
  };
}
