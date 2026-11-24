import { PUSH_LIMITS, platformOnly, secret, ui } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/** An APNs environment: which host a bundle's device tokens belong to. */
export const ApnsEnvironment = z.enum(["production", "sandbox"]);
export type ApnsEnvironment = z.infer<typeof ApnsEnvironment>;

/**
 * Deployment config (platform only, no org level): the token-based signing key from the Apple
 * Developer portal and the app builds it serves. `key` is the `.p8` file's PEM content (secret);
 * `keyId` and `teamId` are Apple's 10-character ids; each bundle names the environment its builds
 * register tokens in (development builds: `sandbox`).
 */
export const ApnsDeployment = platformOnly(
  z.object({
    key: ui(secret(z.string().min(1)), {
      label: { zh: "签名密钥（.p8）", en: "Signing key (.p8)" },
      help: {
        zh: "AuthKey_<Key ID>.p8 文件的完整内容，含 BEGIN 与 END 行（粘贴为一行也可以）。",
        en: "The whole content of the AuthKey_<Key ID>.p8 file, BEGIN and END lines included (pasted on one line is fine).",
      },
    }),
    keyId: ui(z.string().length(10), {
      label: { zh: "Key ID", en: "Key ID" },
      help: { zh: "签名密钥的 10 位 Key ID。", en: "The signing key's 10-character Key ID." },
    }),
    teamId: ui(z.string().length(10), {
      label: { zh: "Team ID", en: "Team ID" },
      help: {
        zh: "Apple 开发者团队的 10 位 Team ID。",
        en: "The 10-character Team ID of your Apple Developer team.",
      },
    }),
    bundles: ui(
      z
        .array(
          z.object({
            bundleId: ui(z.string().min(1).max(PUSH_LIMITS.appIdChars), {
              label: { zh: "Bundle ID", en: "Bundle ID" },
              placeholder: "com.example.capybara",
            }),
            environment: ui(ApnsEnvironment, {
              label: { zh: "环境", en: "Environment" },
              options: [
                { value: "production", label: { zh: "生产（production）", en: "Production" } },
                {
                  value: "sandbox",
                  label: { zh: "开发（sandbox）", en: "Sandbox" },
                  help: {
                    zh: "从 Xcode 安装的开发构建。",
                    en: "Development builds installed from Xcode.",
                  },
                },
              ],
            }),
          }),
        )
        .min(1),
      {
        label: { zh: "iOS 应用", en: "iOS apps" },
        help: {
          zh: "需要接收通知的每个应用构建及其 APNs 环境。",
          en: "Each app build that receives notifications, with its APNs environment.",
        },
        item: { title: "{bundleId}", addLabel: { zh: "添加应用", en: "Add app" } },
      },
    ),
  }),
);
export type ApnsDeployment = z.infer<typeof ApnsDeployment>;
