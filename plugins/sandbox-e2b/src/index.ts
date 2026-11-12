import { defineExtension, SANDBOX_EXTENSION_POINT, secret, ui } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import {
  createE2BSandbox,
  type E2BSandboxConfig,
  HOSTNAME_RE,
  publishedImage,
} from "./provider.js";

export {
  createE2BSandbox,
  decodeOutput,
  type E2BSandboxConfig,
  type E2BSandboxTestOptions,
  execArgs,
  exitCodeOf,
  IN_SANDBOX_GRACE_SECONDS,
  METADATA_NAME,
  type OpenEgress,
  publishedImage,
  templateAlias,
} from "./provider.js";

/** E2B 沙箱的最长存活时间（秒，Pro 套餐的连续运行上限 24 小时）。 */
const MAX_TIMEOUT_SECONDS = 86_400;

/**
 * The deployment config (one per deployment). Strict: extra keys are errors, so the test-only
 * options ({@link E2BSandboxTestOptions}) can never be set from plugin config, and the removed
 * `allowOpenEgress` fails with a pointer to `openEgress`.
 */
export const DeploymentConfig = z.strictObject(
  {
    /** E2B API key（`e2b_…`）。 */
    apiKey: ui(secret(z.string().min(1)), { label: { zh: "API 密钥", en: "API key" } }),
    /** 控制面 API 地址；不填为 `https://api.<domain>`。自托管 E2B 填自己的地址。 */
    apiUrl: ui(z.url({ protocol: /^https?$/ }).optional(), {
      label: { zh: "接口地址", en: "API URL" },
    }),
    /** 沙箱域名（envd 地址为 `https://49983-<沙箱 id>.<domain>`）；API 返回了沙箱自己的域名时以返回的为准。 */
    domain: ui(
      z
        .string()
        .regex(HOSTNAME_RE, {
          message: "domain must be a lowercase hostname such as e2b.app",
        })
        .default("e2b.app"),
      { label: { zh: "沙箱域名", en: "Sandbox domain" } },
    ),
    /**
     * Template name or id. Unset: the plugin builds the template `capybara-sandbox-<tag>` from the
     * published sandbox image on first use and reuses it (README "Template").
     */
    template: ui(z.string().min(1).optional(), { label: { zh: "模板", en: "Template" } }),
    /**
     * 沙箱的超时（秒，默认 3600）：到点 E2B 自动暂停（不是删除）沙箱，文件保留。内核每次用沙箱时把它往后推，
     * 长命令会按命令超时再加余量推后；空闲休眠与过期销毁由内核负责。
     */
    timeoutSeconds: ui(z.number().int().min(60).max(MAX_TIMEOUT_SECONDS).default(3600), {
      label: { zh: "沙箱超时", en: "Sandbox timeout" },
    }),
    /**
     * E2B 是否支持按域名的出站白名单（E2B 云：支持）。为 false 时（不支持的自托管版本）`allowlist` 退化为
     * `none` 并打告警。
     */
    domainAllowlist: ui(z.boolean().default(true), {
      label: { zh: "按域名出站白名单", en: "Domain egress allowlist" },
    }),
    /**
     * What `egress: "open"` (the `open` tier) does. E2B has no egress proxy of ours, so `"proxy"`
     * (default) and `"direct"` both mean `allow_internet_access: true` (E2B checks no destination
     * IP); `"off"` refuses open (README "Egress").
     */
    openEgress: ui(z.enum(["off", "proxy", "direct"]).default("proxy"), {
      label: { zh: "开放出站", en: "Open egress" },
      options: [
        {
          value: "off",
          label: { zh: "关闭", en: "Off" },
          help: { zh: "拒绝开放出站", en: "Refuse open egress" },
        },
        {
          value: "proxy",
          label: { zh: "开放", en: "On" },
          help: {
            zh: "允许访问互联网（E2B 不检查目标地址）",
            en: "Allow internet access (E2B checks no destination address)",
          },
        },
        {
          value: "direct",
          label: { zh: "直连", en: "Direct" },
          help: { zh: "在 E2B 上与「开放」相同", en: "Same as On on E2B" },
        },
      ],
    }),
  },
  {
    // the old key fails with a pointer to its replacement (pre-0.1.0: no compatibility layer)
    error: (iss) =>
      iss.code === "unrecognized_keys" && iss.keys.includes("allowOpenEgress")
        ? 'allowOpenEgress was replaced by openEgress: "off" | "proxy" | "direct" (default "proxy"); use openEgress: "off" for allowOpenEgress: false'
        : undefined,
  },
);

/**
 * The provider config from the deployment config: the template, when not set, is built from the
 * image published with `version` (the extension manifest's version, kept equal to package.json by
 * `capybara-plugin sync-versions`; sandbox-docker shares it, a changesets `fixed` group).
 */
export function providerConfig(
  c: z.output<typeof DeploymentConfig>,
  version: string = plugin.version,
): E2BSandboxConfig {
  return { ...c, defaultImage: publishedImage(version) };
}

/**
 * `sandbox@2`: one E2B sandbox per device. The file system is the sandbox kept paused
 * without memory; an instance is the same sandbox resumed (connect), dropped again by pausing.
 */
const plugin = defineExtension({
  name: "sandbox-e2b",
  version: "0.1.0-rc.11",
  sdk: "^0.1.0-rc.3",
  provides: [SANDBOX_EXTENSION_POINT],
  // 只用部署配置与 E2B 的 API，不用任何需要声明的平台能力
  permissions: {},
  config: { deployment: DeploymentConfig },
  setup(ctx) {
    ctx.provide(
      SANDBOX_EXTENSION_POINT,
      createE2BSandbox(providerConfig(ctx.config as z.output<typeof DeploymentConfig>), {
        log: ctx.log,
        signal: ctx.signal,
      }),
    );
  },
});
export default plugin;
