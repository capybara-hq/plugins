import {
  DEVICE_PROVIDER_EXTENSION_POINT,
  defineExtension,
  platformOnly,
  ui,
} from "@capybara-hq/plugin-sdk";
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

/** An IPv4 or IPv6 CIDR (`203.0.113.0/24`, `2001:db8::/32`); a single address is `/32` or `/128`. */
const isCidr = (v: string) => z.cidrv4().safeParse(v).success || z.cidrv6().safeParse(v).success;

/**
 * The deployment config (one per deployment). Strict: extra keys are errors, so the test-only
 * options ({@link DockerSandboxTestOptions}) can never be turned on through the plugin config.
 */
export const DeploymentConfig = platformOnly(
  z
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
       * Egress proxy image (plugins/device-docker/egress-proxy/Dockerfile). Unset: the image
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
       * The deployment's own addresses (its public or corporate ranges, IPv4 / IPv6 CIDRs) the
       * egress proxy refuses in every mode, on top of the private, loopback, link-local, CGNAT,
       * metadata and reserved ranges it always refuses (README "Network and egress").
       */
      deniedCidrs: ui(
        z
          .array(
            z.string().refine(isCidr, {
              message:
                "deniedCidrs entries must be IPv4 or IPv6 CIDRs such as 203.0.113.0/24 or 2001:db8::/32",
            }),
          )
          .max(256)
          .optional(),
        {
          label: { zh: "额外拒绝的地址段", en: "Extra denied address ranges" },
          help: {
            zh: "部署自身的公网或办公网地址段（CIDR，如 203.0.113.0/24）；出站代理在所有模式下都拒绝连接这些地址，另外始终拒绝内网、本机、链路本地、CGNAT 与云元数据地址。",
            en: "The deployment's own public or corporate ranges (CIDRs such as 203.0.113.0/24); the egress proxy refuses them in every mode, on top of the private, loopback, link-local, CGNAT and cloud metadata addresses it always refuses.",
          },
        },
      ),
      /**
       * Refuse the open public network (default `false`): locked-down deployments refuse every
       * `create` / `update` whose effective network is `open-public`, with an error naming this
       * setting, and an existing open-public instance answers `gone` on resume / auto-start (the
       * kernel recreates it under the rule). The org's cloud network then has to be the allowlist.
       */
      refuseOpenNetwork: ui(z.boolean().default(false), {
        label: { zh: "拒绝开放网络", en: "Refuse open network" },
        help: {
          zh: "开启后，有效网络为开放（任意公网主机、挡住内网与本机地址）的设备无法创建或更新，错误会指出本设置；适合只允许白名单的部署。",
          en: "When on, a device whose effective network is open-public (any public host, private and loopback addresses refused) cannot be created or updated; the error names this setting. For deployments that only allow the allowlist.",
        },
      }),
    })
    .strict(),
);

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
    version,
  };
}

/**
 * `device-provider@1`: per device, a file system of two Docker volumes and an instance (container +
 * egress proxy + network) attached to it; Docker only through the socket proxy, the plugin never
 * mounts docker.sock.
 */
const plugin = defineExtension({
  name: "device-docker",
  version: "0.1.0-rc.27",
  // device-provider@1 (report, networkAllowlist, scopes with projectRoot / writeRoots) is the
  // rc.51 SDK's.
  sdk: "^0.1.0-rc.64",
  provides: [DEVICE_PROVIDER_EXTENSION_POINT],
  // Only the deployment config and the Docker endpoint: no platform capability to declare
  permissions: {},
  config: { deployment: DeploymentConfig },
  setup(ctx) {
    ctx.provide(
      DEVICE_PROVIDER_EXTENSION_POINT,
      createDockerSandbox(
        providerConfig(ctx.config as z.output<typeof DeploymentConfig>),
        {},
        ctx.log,
      ),
    );
  },
});

export default plugin;
