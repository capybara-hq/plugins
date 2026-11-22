import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { GenericContainer, Wait } from "testcontainers";

/**
 * The environment shared by the tests that need Docker: detects Docker / runsc, builds the test
 * images (tagged by content, built once and shared by the files and later runs), starts the socket
 * proxy (the plugin reaches Docker only through it; its config is test/sandbox-proxy/haproxy.cfg, a
 * copy of capybara-hq/core's docker/sandbox-proxy/haproxy.cfg) and removes what the tests left behind, by label. The plugin's
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

/** A tag that names the content of a build context: every file's path and bytes. */
async function contentTag(dir: string): Promise<string> {
  const h = createHash("sha256");
  const files = (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
    .sort();
  for (const f of files) {
    h.update(relative(dir, f))
      .update("\0")
      .update(await readFile(f))
      .update("\0");
  }
  return `test-${h.digest("hex").slice(0, 12)}`;
}

const imageExists = (image: string) =>
  run("docker", ["image", "inspect", image]).then(
    () => true,
    () => false,
  );

/**
 * Builds `image` from `dir` unless it exists. The test files run in separate worker processes and
 * all want the same images: a lock directory makes one of them build while the others wait, so a
 * cold run builds the (large) sandbox image once instead of once per file.
 */
async function ensureImage(image: string, dir: string): Promise<void> {
  if (await imageExists(image)) return;
  const lock = join(tmpdir(), `capybara-test-build-${image.replace(/[^a-zA-Z0-9-]/g, "-")}.lock`);
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch {
      // a lock left by a killed run expires after 30 minutes
      const age = await stat(lock).then(
        (s) => Date.now() - s.mtimeMs,
        () => 0,
      );
      if (age > 30 * 60_000) await rm(lock, { recursive: true, force: true });
      await new Promise((r) => setTimeout(r, 2000));
      if (await imageExists(image)) return;
    }
  }
  try {
    if (!(await imageExists(image))) {
      await run("docker", ["build", "-q", "-t", image, dir], { maxBuffer: 64 * 1024 * 1024 });
    }
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

/**
 * The sandbox image and the egress proxy image built from the plugin's Dockerfiles, tagged by
 * their content (`test-<sha256 of the build context>`): files and runs share them, and a run after
 * a change builds new tags. They are kept after the run (`remove` does nothing) for the next run;
 * clean up with `docker rmi` of the `capybara-sandbox*:test-*` tags.
 */
export async function buildTestImages(): Promise<TestImages> {
  const sandboxDir = `${pluginRoot}image`;
  const egressDir = `${pluginRoot}egress-proxy`;
  const sandboxImage = `capybara-sandbox:${await contentTag(sandboxDir)}`;
  const egressImage = `capybara-sandbox-egress:${await contentTag(egressDir)}`;
  await Promise.all([ensureImage(sandboxImage, sandboxDir), ensureImage(egressImage, egressDir)]);
  return { sandboxImage, egressImage, remove: async () => undefined };
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
