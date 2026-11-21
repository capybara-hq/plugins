import type {
  SetupCheckArgs,
  SetupCheckDefinition,
  SetupCheckResult,
} from "@capybara-hq/plugin-sdk";
import {
  endpointsOf,
  type GoogleDeploymentConfig,
  type GoogleEndpoints,
  parseDeployment,
} from "./config.js";

/**
 * The platform setup checks of Sign in with Google (place `extension-deployment`, spec §4.6). Both
 * read-only, one request each, the kernel's `signal` on it, no retries. Results are fixed texts:
 * they never carry a secret, the client id, or any part of a response body; the only echoed value
 * is an OAuth error code matching {@link OAUTH_ERROR} or an HTTP status.
 */

/** The fixed authorization code the client probe sends (the kernel's connector probe uses it too). */
export const PROBE_CODE = "capybara-setup-probe";
/** The probe's redirect URI: Google refuses the invalid code before it compares redirect URIs. */
export const PROBE_REDIRECT_URI = "https://capybara-setup-probe.invalid/callback";
const OAUTH_ERROR = /^[a-z_]{1,64}$/;

const WRONG_PLACE: SetupCheckResult = {
  status: "unknown",
  reason: {
    en: "This check runs on the platform's Google page.",
    zh: "这项检查在平台的 Google 页面上运行。",
  },
};

type Loaded = { config: GoogleDeploymentConfig; endpoints: GoogleEndpoints } | SetupCheckResult;

/** The saved platform config of the check's target, or the result to return instead. */
function load(args: SetupCheckArgs): Loaded {
  if (args.target.kind !== "extension-deployment") return WRONG_PLACE;
  let config: GoogleDeploymentConfig;
  try {
    config = parseDeployment(args.target.config);
  } catch (e) {
    // parseDeployment's message names field paths and fixed texts only, never a value
    return {
      status: "failing",
      reason: { en: `${(e as Error).message}.`.slice(0, 300) },
      fix: {
        en: "Correct the listed fields of this page's config and save.",
        zh: "按提示修改本页配置中列出的字段并保存。",
      },
    };
  }
  return { config, endpoints: endpointsOf(config) };
}

/** `google-discovery`: Google's published OpenID configuration still names the plugin's endpoints. */
export function discoveryCheck(): SetupCheckDefinition {
  return {
    place: "extension-deployment",
    async run(args): Promise<SetupCheckResult> {
      const loaded = load(args);
      if ("status" in loaded) return loaded;
      const { endpoints } = loaded;
      let res: Response;
      try {
        res = await fetch(endpoints.discoveryUrl, {
          headers: { accept: "application/json" },
          redirect: "manual",
          signal: args.signal,
        });
      } catch {
        return unreachable("Google's OpenID configuration", "Google 的 OpenID 配置");
      }
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => {});
        return {
          status: "unknown",
          reason: {
            en: `Google's OpenID configuration answered HTTP ${res.status}; try again later.`,
            zh: `Google 的 OpenID 配置返回 HTTP ${res.status}；请稍后再试。`,
          },
        };
      }
      let doc: Record<string, unknown>;
      try {
        const parsed: unknown = await res.json();
        if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
        doc = parsed as Record<string, unknown>;
      } catch {
        return {
          status: "unknown",
          reason: {
            en: "Google's OpenID configuration is not readable JSON; try again later.",
            zh: "Google 的 OpenID 配置不是可读的 JSON；请稍后再试。",
          },
        };
      }
      const differing: string[] = [];
      if (typeof doc.issuer !== "string" || !endpoints.issuers.includes(doc.issuer)) {
        differing.push("issuer");
      }
      if (doc.authorization_endpoint !== endpoints.authorizationUrl) {
        differing.push("authorization_endpoint");
      }
      if (doc.token_endpoint !== endpoints.tokenUrl) differing.push("token_endpoint");
      if (doc.jwks_uri !== endpoints.jwksUrl) differing.push("jwks_uri");
      if (differing.length > 0) {
        const fields = differing.join(", ");
        return {
          status: "failing",
          reason: {
            en: `Google's published ${fields} differ from the ones the plugin uses.`,
            zh: `Google 公布的 ${fields} 与插件使用的不一致。`,
          },
          fix: {
            en: "Update the google plugin; Google's published endpoints changed.",
            zh: "请升级 google 插件；Google 公布的端点已经变化。",
          },
        };
      }
      return {
        status: "ok",
        reason: {
          en: "Google's published sign-in endpoints match the ones the plugin uses.",
          zh: "Google 公布的登录端点与插件使用的一致。",
        },
      };
    },
  };
}

const RECOPY_FIX = {
  en: "Copy the client ID and secret again from Google Auth Platform → Clients (a Web application client); the secret is shown only when created or reset.",
  zh: "从 Google Auth Platform → 客户端重新复制（Web 应用类型）客户端的 ID 和密钥；密钥只在创建或重置时显示。",
};

/**
 * `google-client`: the saved client ID and secret authenticate at Google's token endpoint. One form
 * POST of a fixed invalid code with `client_secret_post`: `invalid_grant` means Google accepted the
 * client and refused the code (ok); `invalid_client` / `unauthorized_client` / 401 mean the client
 * is wrong (failing); anything else is unknown, a 2xx included (its body is dropped unread, nothing
 * is stored). The secret authenticates the request as login does and never reaches the result.
 */
export function clientCheck(): SetupCheckDefinition {
  return {
    place: "extension-deployment",
    async run(args): Promise<SetupCheckResult> {
      const loaded = load(args);
      if ("status" in loaded) return loaded;
      const { config, endpoints } = loaded;
      if (config.clientId === undefined) {
        return {
          status: "failing",
          reason: { en: "No client ID is saved.", zh: "还没有保存客户端 ID。" },
          fix: {
            en: "Create a Web application client in Google Auth Platform → Clients and paste its ID and secret into this page's config.",
            zh: "在 Google Auth Platform → 客户端中创建 Web 应用类型的客户端，把它的 ID 和密钥填入本页配置。",
          },
        };
      }
      if (config.clientSecret === undefined) {
        return {
          status: "failing",
          reason: { en: "No client secret is saved.", zh: "还没有保存客户端密钥。" },
          fix: {
            en: "Paste the secret of the same Web application client into this page's config.",
            zh: "把同一个 Web 应用客户端的密钥填入本页配置。",
          },
        };
      }
      let res: Response;
      try {
        res = await fetch(endpoints.tokenUrl, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json",
          },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code: PROBE_CODE,
            redirect_uri: PROBE_REDIRECT_URI,
            client_id: config.clientId,
            client_secret: config.clientSecret,
          }).toString(),
          redirect: "manual",
          signal: args.signal,
        });
      } catch {
        return unreachable("Google's token endpoint", "Google 的令牌端点");
      }
      if (res.status >= 200 && res.status < 300) {
        await res.body?.cancel().catch(() => {});
        return unexpected(`HTTP ${res.status}`);
      }
      let code: string | undefined;
      try {
        const body = (await res.json()) as { error?: unknown } | null;
        code =
          typeof body?.error === "string" && OAUTH_ERROR.test(body.error) ? body.error : undefined;
      } catch {
        code = undefined;
      }
      if (code === "invalid_grant") {
        return {
          status: "ok",
          reason: {
            en: "Google accepted the client ID and secret.",
            zh: "Google 接受了这个客户端 ID 和密钥。",
          },
        };
      }
      if (code === "invalid_client" || code === "unauthorized_client" || res.status === 401) {
        const shown = code ?? `HTTP ${res.status}`;
        return {
          status: "failing",
          reason: {
            en: `Google refused the client ID and secret (${shown}).`,
            zh: `Google 拒绝了这个客户端 ID 和密钥（${shown}）。`,
          },
          fix: RECOPY_FIX,
        };
      }
      return unexpected(code ?? `HTTP ${res.status}`);
    },
  };
}

function unreachable(en: string, zh: string): SetupCheckResult {
  return {
    status: "unknown",
    reason: { en: `Could not reach ${en}; try again later.`, zh: `无法连接${zh}；请稍后再试。` },
  };
}

function unexpected(shown: string): SetupCheckResult {
  return {
    status: "unknown",
    reason: {
      en: `Google's token endpoint gave an unexpected answer (${shown}); try again later.`,
      zh: `Google 的令牌端点返回了意外的结果（${shown}）；请稍后再试。`,
    },
  };
}
