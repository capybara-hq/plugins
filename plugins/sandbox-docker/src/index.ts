import { defineExtension, SANDBOX_EXTENSION_POINT, ui } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import { createDockerSandbox, type DockerSandboxConfig, publishedImages } from "./provider.js";

export {
  createDockerSandbox,
  type DockerSandboxConfig,
  type DockerSandboxProvider,
  type DockerSandboxTestOptions,
  decodeOutput,
  execArgv,
  IN_SANDBOX_GRACE_SECONDS,
  publishedImages,
  sandboxResourceNames,
} from "./provider.js";

/** The socket proxy only admits network names starting with `cap`. */
const NETWORK_NAME = /^cap[a-zA-Z0-9_.-]*$/;

/**
 * The deployment config (one per deployment). Strict: extra keys are errors, so the test-only
 * options ({@link DockerSandboxTestOptions}) can never be turned on through the plugin config.
 */
export const DeploymentConfig = z
  .object({
    /** Docker socket proxy address (docker/sandbox-proxy): `tcp://sandbox-proxy:2375` or `unix:///path`. */
    endpoint: ui(
      z.string().regex(/^(tcp:\/\/(\[[^\]]+\]|[^:/]+):\d{1,5}\/?|unix:\/\/\/.+)$/, {
        message: "endpoint must be tcp://host:port or unix:///path",
      }),
      { label: { zh: "Docker 代理地址", en: "Docker proxy endpoint" } },
    ),
    /** Container runtime: runc (default) or gVisor's runsc (registered in the Docker daemon). */
    runtime: ui(z.enum(["runc", "runsc"]).default("runc"), {
      label: { zh: "容器运行时", en: "Container runtime" },
    }),
    /**
     * The shared sandbox network: every egress proxy joins it for its outbound leg; created as a
     * bridge with container-to-container traffic disabled when it does not exist. It must start
     * with `cap` (the socket proxy only admits such network names).
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
    /** Driver of the workspace volume (only a driver with a `size` option limits disk); unset = local. */
    volumeDriver: ui(z.string().min(1).optional(), {
      label: { zh: "卷驱动", en: "Volume driver" },
    }),
    /**
     * Refuse the open public network (default `false`): locked-down deployments refuse every
     * `create` / `update` whose effective network is `open-public`, with an error naming this
     * setting. The org's cloud network then has to be the allowlist.
     */
    refuseOpenNetwork: ui(z.boolean().default(false), {
      label: { zh: "拒绝开放网络", en: "Refuse open network" },
      help: {
        zh: "开启后，有效网络为开放（任意公网主机、挡住内网与本机地址）的设备无法创建或更新，错误会指出本设置；适合只允许白名单的部署。",
        en: "When on, a device whose effective network is open-public (any public host, private and loopback addresses refused) cannot be created or updated; the error names this setting. For deployments that only allow the allowlist.",
      },
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
 * `sandbox@2`: per device, a file system of two Docker volumes and an instance (container +
 * egress proxy + network) attached to it; Docker only through the socket proxy, the plugin never
 * mounts docker.sock.
 */
const plugin = defineExtension({
  name: "sandbox-docker",
  version: "0.1.0-rc.13",
  // The network contract (`limits.mode` / `limits.network`) is the SDK's from rc.22 on; a kernel
  // that predates it gets no network (the safe direction).
  sdk: "^0.1.0-rc.22",
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
