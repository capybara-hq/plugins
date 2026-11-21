import type { SetupCheckDefinition, SetupCheckResult } from "@capybara-hq/plugin-sdk";
import { parseServiceAccount } from "./config.js";
import { exchangeToken, FCM_ENDPOINTS, type FcmEndpoints } from "./oauth.js";

/**
 * The platform setup check `fcm-credentials` (place `extension-deployment`): one JWT bearer token
 * exchange with the saved service account, nothing else. It caches nothing and sends nothing
 * (a check never writes). `ok` when Google issues an access token; `failing` when the config has
 * no usable service account or Google refuses it (`invalid_grant`, `invalid_client`,
 * `unauthorized_client`); `unknown` otherwise (outage, rate limit, abort). Results name fields and
 * OAuth error codes only, never a value of the service account.
 */
export function credentialsCheck(endpoints: FcmEndpoints = FCM_ENDPOINTS): SetupCheckDefinition {
  return {
    place: "extension-deployment",
    async run({ target, signal }): Promise<SetupCheckResult> {
      if (target.kind !== "extension-deployment") {
        return {
          status: "unknown",
          reason: { en: "This check runs on the platform's push-fcm page." },
        };
      }
      const cfg = (target.config ?? {}) as { serviceAccount?: unknown };
      if (typeof cfg.serviceAccount !== "string" || cfg.serviceAccount === "") {
        return {
          status: "failing",
          reason: { en: "No service account key is saved.", zh: "还没有保存服务账号密钥。" },
          fix: {
            en: "Paste the service account key file from the Firebase console into serviceAccount and save.",
            zh: "把 Firebase 控制台下载的服务账号密钥文件粘贴到 serviceAccount 并保存。",
          },
        };
      }
      const sa = parseServiceAccount(cfg.serviceAccount);
      if ("problem" in sa) {
        return {
          status: "failing",
          reason: { en: `The saved service account is not usable: ${sa.problem}.` },
          fix: {
            en: "Paste the whole key file from Firebase console → Project settings → Service accounts → Generate new private key.",
          },
        };
      }
      const r = await exchangeToken(sa, endpoints, signal);
      if (r.ok) {
        return {
          status: "ok",
          reason: {
            en: "Google accepted the service account and issued an access token for Firebase Cloud Messaging.",
            zh: "Google 接受了这个服务账号，并签发了 Firebase Cloud Messaging 的访问令牌。",
          },
        };
      }
      if (r.kind === "auth") {
        return {
          status: "failing",
          reason: {
            en: `Google refused the service account${r.code === undefined ? "" : ` (${r.code})`}.`,
            zh: `Google 拒绝了这个服务账号${r.code === undefined ? "" : `（${r.code}）`}。`,
          },
          fix: {
            en: "Generate a new private key for the service account in the Firebase console and save it; also check that this server's clock is correct.",
            zh: "在 Firebase 控制台为服务账号生成新的私钥并保存；同时确认服务器时钟准确。",
          },
        };
      }
      return {
        status: "unknown",
        reason: { en: `Could not verify the service account now: ${r.message}.` },
      };
    },
  };
}
