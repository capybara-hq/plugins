import { execFile, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { GenericContainer, Wait } from "testcontainers";

/**
 * The environment shared by the tests that need Docker: detects Docker / runsc, builds the test
 * images (unique tags, removed at the end), starts the socket proxy (the plugin reaches Docker only
 * through it; its config is test/sandbox-proxy/haproxy.cfg, a copy of capybara-hq/core's
 * docker/sandbox-proxy/haproxy.cfg) and removes what the tests left behind, by label. The plugin's
 * kernel-level smoke tests (sandbox-tools.smoke.test.ts, sandbox-artifacts.dual.test.ts) use it too.
 */

const run = promisify(execFile);

const pluginRoot = fileURLToPath(new URL("../", import.meta.url));

/** Docker is usable here (`docker info` succeeds). */
export const dockerAvailable =
  process.env.CAPYBARA_TEST_NO_DOCKER !== "1" &&
  spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { stdio: "ignore" }).status === 0;

/** The Docker daemon has the gVisor runtime runsc registered. */
export const runscAvailable =
  dockerAvailable &&
  spawnSync("docker", ["info", "--format", "{{json .Runtimes}}"], {
    encoding: "utf8",
  }).stdout.includes('"runsc"');

/** The socket proxy image (the same as core's docker/compose.yaml, pinned by digest). */
export const SOCKET_PROXY_IMAGE =
  "haproxy:3.2-alpine@sha256:254e6370f01cd654e0744edf607c67f33777c1b6a9dc0d4b28bcba7171460122";

/** The label key on every test resource (its value is the id of this run). */
export const TEST_LABEL = "dev.capybara.test";

export interface TestImages {
  sandboxImage: string;
  egressImage: string;
  remove(): Promise<void>;
}

/** 用插件里的 Dockerfile 构建沙箱镜像与出站代理镜像（唯一标签；层有缓存，重复构建很快）。 */
export async function buildTestImages(): Promise<TestImages> {
  const tag = `test-${randomUUID().slice(0, 8)}`;
  const sandboxImage = `capybara-sandbox:${tag}`;
  const egressImage = `capybara-sandbox-egress:${tag}`;
  const opts = { maxBuffer: 64 * 1024 * 1024 };
  await Promise.all([
    run("docker", ["build", "-q", "-t", sandboxImage, `${pluginRoot}image`], opts),
    run("docker", ["build", "-q", "-t", egressImage, `${pluginRoot}egress-proxy`], opts),
  ]);
  return {
    sandboxImage,
    egressImage,
    remove: async () => {
      await run("docker", ["rmi", sandboxImage, egressImage]).catch(() => undefined);
    },
  };
}

export interface SocketProxy {
  /** `tcp://host:port`。 */
  endpoint: string;
  stop(): Promise<void>;
}

/**
 * Starts the socket proxy (the only container that mounts docker.sock) with this directory's copy
 * of capybara-hq/core's docker/sandbox-proxy/haproxy.cfg
 * (https://github.com/capybara-hq/core/tree/main/docker/sandbox-proxy). No check in this
 * repository keeps the copy identical; core's `check:bootstrap --network` (rule
 * `bootstrap-haproxy`) will compare it with core's file.
 */
export async function startSocketProxy(): Promise<SocketProxy> {
  const c = await new GenericContainer(SOCKET_PROXY_IMAGE)
    .withUser("root")
    .withBindMounts([
      { source: "/var/run/docker.sock", target: "/var/run/docker.sock", mode: "rw" },
    ])
    .withCopyFilesToContainer([
      {
        source: `${pluginRoot}test/sandbox-proxy/haproxy.cfg`,
        target: "/usr/local/etc/haproxy/haproxy.cfg",
      },
    ])
    .withExposedPorts(2375)
    .withWaitStrategy(Wait.forListeningPorts())
    .start();
  return {
    endpoint: `tcp://${c.getHost()}:${c.getMappedPort(2375)}`,
    stop: async () => {
      await c.stop();
    },
  };
}

/** 删掉带 `dev.capybara.test=<runId>` 标签的容器、网络与卷。 */
export async function cleanupTestResources(runId: string): Promise<void> {
  const filter = `label=${TEST_LABEL}=${runId}`;
  const ids = async (args: string[]) =>
    (await run("docker", [...args, "--filter", filter]).catch(() => ({ stdout: "" }))).stdout
      .split("\n")
      .filter((s) => s !== "");
  const containers = await ids(["ps", "-aq"]);
  if (containers.length > 0)
    await run("docker", ["rm", "-f", ...containers]).catch(() => undefined);
  const networks = await ids(["network", "ls", "-q"]);
  if (networks.length > 0)
    await run("docker", ["network", "rm", ...networks]).catch(() => undefined);
  const volumes = await ids(["volume", "ls", "-q"]);
  if (volumes.length > 0)
    await run("docker", ["volume", "rm", "-f", ...volumes]).catch(() => undefined);
}

/** `docker <args>` 的输出（测试里检查容器状态用）。 */
export async function docker(...args: string[]): Promise<string> {
  return (await run("docker", args)).stdout;
}
