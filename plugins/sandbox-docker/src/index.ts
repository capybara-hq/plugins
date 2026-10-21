import { definePlugin, SANDBOX_CAPABILITY } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import { createDockerSandbox } from "./provider.js";

export {
  createDockerSandbox,
  type DockerSandboxConfig,
  type DockerSandboxTestOptions,
  sandboxResourceNames,
} from "./provider.js";

const DOCKER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/**
 * 部署配置（一个部署一份）。strict：多出的键报错，所以只供测试用的选项（{@link DockerSandboxTestOptions}）
 * 不可能经插件配置打开。
 */
export const DeploymentConfig = z
  .object({
    /** Docker socket 代理地址（docker/sandbox-proxy）：`tcp://sandbox-proxy:2375` 或 `unix:///path`。 */
    endpoint: z.string().regex(/^(tcp:\/\/(\[[^\]]+\]|[^:/]+):\d{1,5}\/?|unix:\/\/\/.+)$/, {
      message: "endpoint must be tcp://host:port or unix:///path",
    }),
    /** 容器运行时：runc（默认）或 gVisor 的 runsc（需在 Docker 守护进程上登记）。 */
    runtime: z.enum(["runc", "runsc"]).default("runc"),
    /** 共用的沙箱网络名：egress 为 open 的沙箱与出站代理接在上面；不存在时自动创建（bridge、禁止容器互访）。 */
    network: z.string().regex(DOCKER_NAME).default("capybara-sandbox"),
    /** 出站代理镜像（plugins/sandbox-docker/egress-proxy/Dockerfile）。 */
    egressProxyImage: z.string().min(1).default("capybara-sandbox-egress:latest"),
    /** 工作区卷的驱动（支持 `size` 选项的驱动才能限制磁盘）；不填用 local（不限大小）。 */
    volumeDriver: z.string().min(1).optional(),
  })
  .strict();

/** `sandbox@1`：每个对话一个 Docker 容器，经 socket 代理访问 Docker，插件不挂 docker.sock。 */
export default definePlugin({
  name: "sandbox-docker",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [SANDBOX_CAPABILITY],
  // 只用部署配置与 Docker endpoint，不用任何需要声明的平台能力
  permissions: {},
  config: { deployment: DeploymentConfig },
  setup(ctx) {
    ctx.provide(
      SANDBOX_CAPABILITY,
      createDockerSandbox(ctx.config as z.output<typeof DeploymentConfig>),
    );
  },
});
