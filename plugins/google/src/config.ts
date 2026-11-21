import { secret, ui } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/** Google's OpenID Connect endpoints, as the plugin uses them. */
export interface GoogleEndpoints {
  authorizationUrl: string;
  tokenUrl: string;
  jwksUrl: string;
  /** The accepted `iss` values of an ID token. */
  issuers: string[];
  discoveryUrl: string;
}

/**
 * Google's endpoints (https://accounts.google.com/.well-known/openid-configuration, read
 * 2026-11-22). Fixed constants: `authorizeUrl` is synchronous, so nothing is fetched at login; the
 * `google-discovery` setup check fails when Google ever publishes different ones. Google says `iss`
 * is "always https://accounts.google.com or accounts.google.com"
 * (https://developers.google.com/identity/openid-connect/openid-connect), so both are accepted.
 */
export const GOOGLE_ENDPOINTS: Readonly<GoogleEndpoints> = Object.freeze({
  authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
  issuers: Object.freeze(["https://accounts.google.com", "accounts.google.com"]) as string[],
  discoveryUrl: "https://accounts.google.com/.well-known/openid-configuration",
});

/** A hostname: dot-separated labels of letters, digits and inner hyphens, a letter TLD. */
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** Consumer mail domains: their accounts carry no `hd`, so listing them would lock everyone out. */
const CONSUMER_DOMAINS = new Set(["gmail.com", "googlemail.com"]); // capybara:allow-module-state read-only constant

/** An endpoint override: `https:`, or plain http only on the loopback host (tests). */
const endpointUrl = z.string().refine(
  (v) => {
    let u: URL;
    try {
      u = new URL(v);
    } catch {
      return false;
    }
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost");
  },
  { message: "must be an https URL (plain http only for 127.0.0.1 / localhost)" },
);

const domain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(HOSTNAME, "must be a domain name such as example.com")
  .refine((d) => !CONSUMER_DOMAINS.has(d), {
    message:
      "gmail.com accounts have no hosted domain; leave allowedDomains empty and set allowConsumerAccounts instead",
  });

/**
 * Deployment config (platform only: `identity-source@1` runs before any org is known, so no field
 * carries an org level). Invalid config never fails startup: `authorizeUrl` throws and the login
 * page shows the source as unavailable.
 */
export const GoogleDeployment = z.object({
  clientId: ui(z.string().trim().min(1).optional(), {
    label: { zh: "客户端 ID", en: "Client ID" },
    help: {
      zh: "Google Auth Platform → 客户端里「Web 应用」类型客户端的 ID（以 .apps.googleusercontent.com 结尾）。",
      en: "The ID of a Web application client in Google Auth Platform → Clients (ends in .apps.googleusercontent.com).",
    },
    placeholder: "1234567890-abc.apps.googleusercontent.com",
  }),
  clientSecret: ui(secret(z.string().trim().min(1)), {
    label: { zh: "客户端密钥", en: "Client secret" },
    help: {
      zh: "同一个客户端的密钥；只在创建或重置时显示。",
      en: "The secret of the same client; Google shows it only when it is created or reset.",
    },
  }).optional(),
  allowedDomains: ui(
    z
      .array(domain)
      .max(50)
      .transform((list) => [...new Set(list)])
      .default([]),
    {
      label: { zh: "允许的 Google Workspace 域", en: "Allowed Google Workspace domains" },
      help: {
        zh: "Workspace 或 Cloud Identity 的主域（ID token 里的 hd）。填写后只有这些域的账号能登录；留空则任何 Workspace 域都能登录（个人账号看下一项）。推荐填写。",
        en: "Primary domains of Google Workspace or Cloud Identity (the hd claim of the ID token). When set, only accounts of these domains can sign in; when empty, any Workspace domain can (consumer accounts: see the next field). Recommended.",
      },
      widget: "tags",
      placeholder: "example.com",
    },
  ),
  allowConsumerAccounts: ui(z.boolean().default(false), {
    label: { zh: "允许个人 Google 账号", en: "Allow consumer Google accounts" },
    help: {
      zh: "只在「允许的域」为空时生效。打开后，不属于任何 Workspace 的 Google 账号（如 @gmail.com）也能登录；任何人都能注册这样的账号。",
      en: "Only read when the allowed domains are empty. When on, Google accounts outside any Workspace (such as @gmail.com) can sign in too; anyone can create such an account.",
    },
    widget: "switch",
  }),
  endpoints: ui(
    z
      .object({
        authorizationUrl: endpointUrl,
        tokenUrl: endpointUrl,
        jwksUrl: endpointUrl,
        issuers: z.array(z.string().min(1).max(200)).min(1).max(5),
        discoveryUrl: endpointUrl,
      })
      .partial()
      .optional(),
    {
      label: { zh: "Google 端点", en: "Google endpoints" },
      help: {
        zh: "只用于测试或出口代理；留空即使用 Google 的端点。",
        en: "Only for tests or egress proxies; leave empty to use Google's endpoints.",
      },
      advanced: true,
    },
  ),
});
export type GoogleDeploymentConfig = z.infer<typeof GoogleDeployment>;

/** What a login needs, with the client present and the endpoints merged over Google's. */
export interface GoogleLoginConfig {
  clientId: string;
  clientSecret: string;
  allowedDomains: string[];
  allowConsumerAccounts: boolean;
  endpoints: GoogleEndpoints;
}

/** The parsed deployment config, or an English error naming field paths only (never a value). */
export function parseDeployment(config: unknown): GoogleDeploymentConfig {
  const r = GoogleDeployment.safeParse(config ?? {});
  if (!r.success) {
    const problems = r.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.code === "custom" ? i.message : i.code}`)
      .join("; ");
    throw new Error(`The google plugin's platform config is invalid: ${problems}`);
  }
  return r.data;
}

/** The merged endpoints of a parsed config. */
export function endpointsOf(config: Pick<GoogleDeploymentConfig, "endpoints">): GoogleEndpoints {
  const o = config.endpoints ?? {};
  return {
    authorizationUrl: o.authorizationUrl ?? GOOGLE_ENDPOINTS.authorizationUrl,
    tokenUrl: o.tokenUrl ?? GOOGLE_ENDPOINTS.tokenUrl,
    jwksUrl: o.jwksUrl ?? GOOGLE_ENDPOINTS.jwksUrl,
    issuers: [...(o.issuers ?? GOOGLE_ENDPOINTS.issuers)],
    discoveryUrl: o.discoveryUrl ?? GOOGLE_ENDPOINTS.discoveryUrl,
  };
}

/** Deployment config -> login config; throws when the client is missing or the config invalid. */
export function loginConfig(config: unknown): GoogleLoginConfig {
  const c = parseDeployment(config);
  if (c.clientId === undefined || c.clientSecret === undefined) {
    throw new Error(
      "Sign in with Google is not configured: set clientId and clientSecret in the google plugin's platform config",
    );
  }
  return {
    clientId: c.clientId,
    clientSecret: c.clientSecret,
    allowedDomains: c.allowedDomains,
    allowConsumerAccounts: c.allowConsumerAccounts,
    endpoints: endpointsOf(c),
  };
}
