import { defineExtension, SANDBOX_EXTENSION_POINT, ui } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import { createDockerSandbox, type DockerSandboxConfig, publishedImages } from "./provider.js";

export {
  createDockerSandbox,
  type DockerSandboxConfig,
  type DockerSandboxTestOptions,
  decodeOutput,
  execArgv,
  IN_SANDBOX_GRACE_SECONDS,
  publishedImages,
  sandboxResourceNames,
} from "./provider.js";

/** socket 代理只放行 cap 开头的网络名。 */
const NETWORK_NAME = /^cap[a-zA-Z0-9_.-]*$/;

/**
 * 部署配置（一个部署一份）。strict：多出的键报错，所以只供测试用的选项（{@link DockerSandboxTestOptions}）
 * 不可能经插件配置打开。
 */
export const DeploymentConfig = z
  .object({
    /** Docker socket 代理地址（docker/sandbox-proxy）：`tcp://sandbox-proxy:2375` 或 `unix:///path`。 */
    endpoint: ui(
      z.string().regex(/^(tcp:\/\/(\[[^\]]+\]|[^:/]+):\d{1,5}\/?|unix:\/\/\/.+)$/, {
        message: "endpoint must be tcp://host:port or unix:///path",
      }),
      { label: { zh: "Docker 代理地址", en: "Docker proxy endpoint" } },
    ),
    /** 容器运行时：runc（默认）或 gVisor 的 runsc（需在 Docker 守护进程上登记）。 */
    runtime: ui(z.enum(["runc", "runsc"]).default("runc"), {
      label: { zh: "容器运行时", en: "Container runtime" },
    }),
    /**
     * 共用的沙箱网络名：egress 为 open 的沙箱与出站代理接在上面；不存在时自动创建（bridge、禁止容器互访）。
     * 须以 `cap` 开头（socket 代理只放行这样的网络名）。
     */
    network: ui(
      z
        .string()
        .regex(NETWORK_NAME, {
          message: "network must start with 'cap' (the socket proxy only allows cap* networks)",
        })
        .default("capybara-sandbox"),
      { label: { zh: "沙箱网络", en: "Sandbox network" } },
    ),
    /**
     * Egress proxy image (plugins/sandbox-docker/egress-proxy/Dockerfile). Unset: the image
     * published with this plugin's version, `ghcr.io/capybara-hq/capybara-sandbox-egress:<version>`.
     */
    egressProxyImage: ui(z.string().min(1).optional(), {
      label: { zh: "出站代理镜像", en: "Egress proxy image" },
      help: {
        zh: "留空则用随本插件版本发布的镜像 ghcr.io/capybara-hq/capybara-sandbox-egress:<插件版本>；离线部署填自己构建的镜像。",
        en: "Empty: the image published with this plugin's version, ghcr.io/capybara-hq/capybara-sandbox-egress:<plugin version>. Set it to your own build for an offline deployment.",
      },
      placeholder: "ghcr.io/capybara-hq/capybara-sandbox-egress:<plugin version>",
    }),
    /** 工作区卷的驱动（支持 `size` 选项的驱动才能限制磁盘）；不填用 local（不限大小）。 */
    volumeDriver: ui(z.string().min(1).optional(), {
      label: { zh: "卷驱动", en: "Volume driver" },
    }),
    /**
     * 允许 `sandbox.limits.egress = "open"`（默认 false）。open 的沙箱能访问宿主机网络能访问的一切
     * （宿主机上的服务、内网、云元数据地址），只在可信环境打开。
     */
    allowOpenEgress: ui(z.boolean().default(false), {
      label: { zh: "允许开放出站", en: "Allow open egress" },
    }),
  })
  .strict();

/**
 * The provider config from the deployment config: images not set fall back to the ones published
 * with `version` (the extension manifest's version, kept equal to package.json by
 * `capybara-plugin sync-versions`).
 */
export function providerConfig(
  c: z.output<typeof DeploymentConfig>,
  version: string = plugin.version,
): DockerSandboxConfig {
  const images = publishedImages(version);
  return {
    ...c,
    egressProxyImage: c.egressProxyImage ?? images.egress,
    defaultImage: images.sandbox,
  };
}

/**
 * `sandbox@2`: per environment, a file system of two Docker volumes and an instance (container +
 * egress proxy + network) attached to it; Docker only through the socket proxy, the plugin never
 * mounts docker.sock.
 */
const plugin = defineExtension({
  name: "sandbox-docker",
  version: "0.1.0-rc.2",
  sdk: "^0.1.0-rc.3",
  provides: [SANDBOX_EXTENSION_POINT],
  // 只用部署配置与 Docker endpoint，不用任何需要声明的平台能力
  permissions: {},
  config: { deployment: DeploymentConfig },
  setup(ctx) {
    ctx.provide(
      SANDBOX_EXTENSION_POINT,
      createDockerSandbox(
        providerConfig(ctx.config as z.output<typeof DeploymentConfig>),
        {},
        ctx.log,
      ),
    );
  },
});

export default plugin;
