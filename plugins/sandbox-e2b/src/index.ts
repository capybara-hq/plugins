import { defineExtension, SANDBOX_EXTENSION_POINT, secret } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import { createE2BSandbox, HOSTNAME_RE } from "./provider.js";

export {
  createE2BSandbox,
  decodeOutput,
  type E2BSandboxConfig,
  type E2BSandboxTestOptions,
  execArgs,
  exitCodeOf,
  IN_SANDBOX_GRACE_SECONDS,
  METADATA_NAME,
} from "./provider.js";

/** E2B 沙箱的最长存活时间（秒，Pro 套餐的连续运行上限 24 小时）。 */
const MAX_TIMEOUT_SECONDS = 86_400;

/**
 * 部署配置（一个部署一份）。strict：多出的键报错，所以只供测试用的选项（{@link E2BSandboxTestOptions}）
 * 不可能经插件配置打开。
 */
export const DeploymentConfig = z
  .object({
    /** E2B API key（`e2b_…`）。 */
    apiKey: secret(z.string().min(1)),
    /** 控制面 API 地址；不填为 `https://api.<domain>`。自托管 E2B 填自己的地址。 */
    apiUrl: z.url({ protocol: /^https?$/ }).optional(),
    /** 沙箱域名（envd 地址为 `https://49983-<沙箱 id>.<domain>`）；API 返回了沙箱自己的域名时以返回的为准。 */
    domain: z
      .string()
      .regex(HOSTNAME_RE, {
        message: "domain must be a lowercase hostname such as e2b.app",
      })
      .default("e2b.app"),
    /** 模板名或 id：由 plugins/sandbox-docker/image/Dockerfile 构建（见 README）。 */
    template: z.string().min(1),
    /**
     * 沙箱的超时（秒，默认 3600）：到点 E2B 自动暂停（不是删除）沙箱，文件保留。内核每次用沙箱时把它往后推，
     * 长命令会按命令超时再加余量推后；空闲休眠与过期销毁由内核负责。
     */
    timeoutSeconds: z.number().int().min(60).max(MAX_TIMEOUT_SECONDS).default(3600),
    /**
     * E2B 是否支持按域名的出站白名单（E2B 云：支持）。为 false 时（不支持的自托管版本）`allowlist` 退化为
     * `none` 并打告警。
     */
    domainAllowlist: z.boolean().default(true),
    /** 允许 `sandbox.limits.egress = "open"`（默认 false）。为 false 时 `create` 收到 open 直接报错。 */
    allowOpenEgress: z.boolean().default(false),
  })
  .strict();

/** `sandbox@1`：每个对话一个 E2B 沙箱，休眠用 E2B 的 pause，恢复用 connect。 */
export default defineExtension({
  name: "sandbox-e2b",
  version: "0.1.0-rc.0",
  sdk: "^0.1.0-rc.0",
  provides: [SANDBOX_EXTENSION_POINT],
  // 只用部署配置与 E2B 的 API，不用任何需要声明的平台能力
  permissions: {},
  config: { deployment: DeploymentConfig },
  setup(ctx) {
    ctx.provide(
      SANDBOX_EXTENSION_POINT,
      createE2BSandbox(ctx.config as z.output<typeof DeploymentConfig>, { log: ctx.log }),
    );
  },
});
