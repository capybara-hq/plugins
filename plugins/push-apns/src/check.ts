import type {
  SetupCheckDefinition,
  SetupCheckResult,
  SetupCheckText,
} from "@capybara-hq/plugin-sdk";
import { ApnsDeployment, type ApnsEnvironment } from "./config.js";
import {
  ApnsKeyError,
  type ApnsKv,
  cachedProviderToken,
  loadSigningKey,
  signProviderToken,
} from "./jwt.js";
import {
  APPLE_ORIGINS,
  type ApnsAnswer,
  type ApnsNet,
  apnsHeaders,
  apnsRequest,
  errorCode,
  openApnsSession,
} from "./send.js";

/** A device token APNs never issued: it verifies the provider token, then refuses the device. */
const ZERO_TOKEN = "0".repeat(64);

const FIX_KEY: SetupCheckText = {
  en:
    "Save the whole content of the AuthKey_<Key ID>.p8 file as key, BEGIN and END lines included, " +
    "with that key's Key ID and your Team ID (Apple Developer > Certificates, Identifiers & " +
    "Profiles > Keys); the key must have Apple Push Notifications service enabled.",
  zh:
    "把 AuthKey_<Key ID>.p8 文件的完整内容（含 BEGIN 与 END 行）保存为 key，并填写该密钥的 Key ID 与你的 Team ID" +
    "（Apple Developer > Certificates, Identifiers & Profiles > Keys）；该密钥需启用 Apple Push Notifications service。",
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const code = (reason: string | undefined) =>
  reason !== undefined && /^[A-Za-z]{1,64}$/.test(reason) ? reason : "no reason";

/**
 * The platform setup check `apns-credentials` (place `extension-deployment`): reads the signing
 * key, signs a provider token (or reuses the shared one; it never writes), and posts to the
 * all-zero device token once per configured environment. APNs answers 400 `BadDeviceToken` only
 * after it accepted the provider token, so that is `ok`; a 403 is `failing` with the APNs reason
 * code; anything else is `unknown`. Nothing is delivered. The result never names the key.
 */
export function apnsCredentialsCheck(deps: {
  kv: Pick<ApnsKv, "get">;
  net?: ApnsNet;
  now?: () => number;
}): SetupCheckDefinition {
  const net = deps.net ?? { origin: (env: ApnsEnvironment) => APPLE_ORIGINS[env] };
  const now = deps.now ?? Date.now;
  return {
    place: "extension-deployment",
    async run(args): Promise<SetupCheckResult> {
      const parsed = ApnsDeployment.safeParse(
        args.target.kind === "extension-deployment" ? args.target.config : args.config,
      );
      if (!parsed.success) {
        return {
          status: "failing",
          reason: {
            en: "The deployment config is incomplete: it needs key, keyId, teamId and at least one bundle.",
            zh: "部署配置不完整：需要 key、keyId、teamId 和至少一个 bundle。",
          },
          fix: FIX_KEY,
        };
      }
      const cfg = parsed.data;
      let jwt: string;
      try {
        jwt =
          (await cachedProviderToken(deps.kv, cfg).catch(() => null)) ??
          signProviderToken(loadSigningKey(cfg.key), { ...cfg, nowMs: now() });
      } catch (error) {
        if (!(error instanceof ApnsKeyError)) throw error;
        return {
          status: "failing",
          reason: {
            en: "The key is not a valid APNs .p8 signing key (an EC P-256 private key in PEM).",
            zh: "key 不是有效的 APNs .p8 签名密钥（PEM 格式的 EC P-256 私钥）。",
          },
          fix: FIX_KEY,
        };
      }

      // one bundle per environment: APNs checks the provider token per host
      const probes = new Map<ApnsEnvironment, string>();
      for (const b of cfg.bundles)
        if (!probes.has(b.environment)) probes.set(b.environment, b.bundleId);
      const outcomes: SetupCheckResult[] = [];
      for (const [env, bundleId] of probes) {
        outcomes.push(await probe(env, bundleId, jwt, args.signal));
      }
      return (
        outcomes.find((o) => o.status === "failing") ??
        outcomes.find((o) => o.status === "unknown") ?? {
          status: "ok",
          reason: {
            en: clip(
              `APNs accepted the signing key (${[...probes].map(([e, b]) => `${b}, ${e}`).join("; ")}).`,
              300,
            ),
            zh: clip(
              `APNs 接受了该签名密钥（${[...probes].map(([e, b]) => `${b}，${e}`).join("；")}）。`,
              300,
            ),
          },
        }
      );
    },
  };

  async function probe(
    env: ApnsEnvironment,
    bundleId: string,
    jwt: string,
    signal: AbortSignal,
  ): Promise<SetupCheckResult> {
    const where = clip(`${bundleId}, ${env}`, 120);
    const session = openApnsSession(net.origin(env), net);
    let answer: ApnsAnswer;
    try {
      answer = await apnsRequest(session, {
        path: `/3/device/${ZERO_TOKEN}`,
        headers: apnsHeaders({ jwt, bundleId, collapseId: "", nowMs: now() }),
        body: JSON.stringify({ aps: { alert: { title: "", body: "" } } }),
        signal,
      });
    } catch (error) {
      return {
        status: "unknown",
        reason: {
          en: `Could not reach APNs (${where}): ${errorCode(error)}.`,
          zh: `无法连接 APNs（${where}）：${errorCode(error)}。`,
        },
      };
    } finally {
      session.destroy();
    }
    if (answer.status === 400 && answer.reason === "BadDeviceToken") {
      return { status: "ok" };
    }
    if (answer.status === 403) {
      return {
        status: "failing",
        reason: {
          en: `APNs refused the signing key (${where}): 403 ${code(answer.reason)}.`,
          zh: `APNs 拒绝了该签名密钥（${where}）：403 ${code(answer.reason)}。`,
        },
        fix: FIX_KEY,
      };
    }
    return {
      status: "unknown",
      reason: {
        en: `APNs gave an unexpected answer (${where}): ${answer.status} ${code(answer.reason)}.`,
        zh: `APNs 返回了意外的结果（${where}）：${answer.status} ${code(answer.reason)}。`,
      },
    };
  }
}
