import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  type ConversationEvent,
  createConversation as createConv,
  createDb,
  createLocalAccount,
  createOrg,
  eventsOf,
  type KernelSchemaDb,
  kernelDb,
  postMessage,
  type KernelRequest as Req,
  SANDBOX_STARTED_NOTICE,
  login as session,
  startTestKernel,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
  type TestKernel,
  testKernelConfig,
  truncateTables,
  waitForTerminal,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDockerSandbox } from "../src/index.js";
import {
  buildTestImages,
  docker,
  dockerAvailable,
  type SocketProxy,
  startSocketProxy,
  type TestImages,
} from "./docker-env.js";

/**
 * Smoke test (M5 T9): a real kernel + model-fake + this plugin (through the socket proxy of
 * capybara-hq/core's docker/sandbox-proxy) run a few of the kernel's sandbox tool cases. The
 * installed kernel predates the `limits.network` contract, so the plugin gives the sandbox no
 * network (the safe direction; a kernel from the auto-mode release sends open-public). Skipped
 * without Docker.
 */

const PLUGIN_DIR = fileURLToPath(new URL("../", import.meta.url));
const SANDBOX_DOCKER = fileURLToPath(new URL("../src/index.ts", import.meta.url));
/** The scripted model provider (a devDependency): `tool:<key>:<json>` makes it call a tool. */
const MODEL_FAKE = "@capybara-hq/plugin-model-fake";

type ToolResultEvent = Extract<ConversationEvent, { type: "tool_result" }>;

describe.skipIf(!dockerAvailable)(
  "sandbox tools on the Docker sandbox plugin",
  { timeout: 90_000 },
  () => {
    const network = `capybara-sandbox-test-${randomUUID().slice(0, 8)}`;
    let pgc: TestContainer;
    let rd: TestContainer;
    let images: TestImages;
    let proxy: SocketProxy;
    let db: KernelSchemaDb;
    let destroyDb: () => Promise<void>;
    let k: TestKernel;
    let owner: Req;
    let orgId: string;
    /** The devices the conversations work in (`cap-device-<id>`), removed with their volumes. */
    const devices = new Set<string>();
    // Kernel warnings (the pipeline logs the real cause of a failed tool call, which the model only
    // sees as "failed (DockerApiError)"). This test failed once under full-suite load without a
    // reproduction (M-11), so failures print them instead of only the tool's generic text.
    const warnings: string[] = [];
    const why = (content: string) =>
      [content, ...warnings.filter((l) => l.includes("tool call failed"))].join("\n");

    beforeAll(async () => {
      [pgc, rd, images, proxy] = await Promise.all([
        startTestPostgres(),
        startTestRedis(),
        buildTestImages(),
        startSocketProxy(),
      ]);
      const raw = createDb(pgc.url, 3);
      db = kernelDb(raw);
      destroyDb = () => raw.destroy();
      k = await startTestKernel(
        testKernelConfig(
          { pg: pgc.url, redis: rd.url },
          {
            roles: ["api", "worker"],
            extensions: [MODEL_FAKE, SANDBOX_DOCKER],
            extensionConfig: {
              "sandbox-docker": {
                endpoint: proxy.endpoint,
                network,
                egressProxyImage: images.egressImage,
              },
            },
            sandbox: { image: images.sandboxImage, limits: { memoryMb: 512 } },
          },
        ),
        // this file wants the warnings
        { resolveFrom: PLUGIN_DIR, log: { level: "warn", write: (line) => warnings.push(line) } },
      );
      // a cold run builds the sandbox image (about 1.5 GB) once, shared by the files
    }, 1_200_000);

    afterAll(async () => {
      await k?.close();
      if (proxy) {
        const p = createDockerSandbox({
          endpoint: proxy.endpoint,
          runtime: "runc",
          network,
          egressProxyImage: images.egressImage,
        });
        for (const e of devices) {
          const name = `cap-device-${e}`;
          await p.destroyByName(name, AbortSignal.timeout(60_000)).catch(() => undefined);
          await p.destroyFileSystemByName(name, AbortSignal.timeout(60_000)).catch(() => undefined);
        }
      }
      await docker("network", "rm", network).catch(() => undefined);
      await destroyDb?.();
      await Promise.all([pgc?.stop(), rd?.stop(), proxy?.stop()]);
      await images?.remove();
    }, 120_000);

    beforeEach(async () => {
      await truncateTables(
        db,
        "capybara.sandboxes, capybara.tool_outputs, capybara.conversation_events, capybara.runs, capybara.conversations, capybara.agent_versions, capybara.agent_members, capybara.agents, capybara.memberships, capybara.orgs, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
      );
      await createLocalAccount(db, "owner", "O");
      owner = await session(k, "owner");
      orgId = await createOrg(owner);
    });

    async function sandboxConversation(): Promise<string> {
      const res = await owner({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/agents`,
        payload: {
          definition: {
            name: "Coder",
            instructions: "Use the sandbox.",
            model: { provider: "model-fake", model: "fake-1" },
            disabledTools: [],
          },
          visibility: "org",
        },
      });
      expect(res.statusCode, res.body).toBe(201);
      const agentId = (res.json() as { agent: { id: string } }).agent.id;
      const conv = await createConv(owner, orgId, agentId);
      const { device_id: env } = await db
        .selectFrom("conversations")
        .select("device_id")
        .where("id", "=", conv)
        .executeTakeFirstOrThrow();
      if (env !== null) devices.add(env);
      return conv;
    }

    async function call(convId: string, key: string, input: unknown, n: number) {
      await postMessage(owner, orgId, convId, `tool:${key}:${JSON.stringify(input)}`);
      await waitForTerminal(db, convId, n, 60_000);
      const results = (await eventsOf(db, convId)).filter(
        (e): e is ToolResultEvent => e.type === "tool_result",
      );
      const r = results.at(-1) as ToolResultEvent;
      expect(r.payload.toolKey).toBe(key);
      return r.payload;
    }

    it("bash, write / read / edit / glob / grep in a real container", async () => {
      const conv = await sandboxConversation();
      const r = await call(
        conv,
        "Bash",
        { description: "Test step", command: "pwd && id -un && echo proxy=$HTTPS_PROXY" },
        1,
      );
      expect(r.isError, why(r.content)).toBe(false);
      expect(r.content.startsWith(SANDBOX_STARTED_NOTICE)).toBe(true);
      // TODO(auto-mode upgrade): the installed @capybara-hq/testing rc.17 links kernel rc.25, which
      // predates auto mode and sends no `limits.network`; the plugin therefore gives this sandbox
      // no network and this asserts that safe fallback. When the repository upgrades to testing
      // rc.18 (kernel rc.29), the org default is open-public: change this to expect
      // `proxy=http://cap-device-<id>-egress:3128` and add a curl to a private / metadata address
      // that must be refused (403).
      expect(r.content).toMatch(/\/workspace\nsandbox\nproxy=\n/);

      const w = await call(
        conv,
        "Write",
        { file_path: "/workspace/src/a.txt", content: "alpha\nbeta\ngamma\n" },
        2,
      );
      expect(w.isError, w.content).toBe(false);
      const e = await call(
        conv,
        "Edit",
        { file_path: "/workspace/src/a.txt", old_string: "beta", new_string: "BETA" },
        3,
      );
      expect(e.isError, e.content).toBe(false);
      const rd1 = await call(conv, "Read", { file_path: "/workspace/src/a.txt" }, 4);
      expect(rd1.content).toContain("2\tBETA");
      const g = await call(conv, "Glob", { pattern: "**/*.txt" }, 5);
      expect(g.content).toContain("/workspace/src/a.txt");
      const gr = await call(
        conv,
        "Grep",
        { pattern: "beta", "-i": true, output_mode: "content", "-n": true },
        6,
      );
      expect(gr.content).toContain("/workspace/src/a.txt:2:BETA");
      // /skills is a read-only mount (a write would pass command review as an ask; the mount
      // table shows the property without one)
      const ro = await call(
        conv,
        "Bash",
        { description: "Test step", command: "grep ' /skills ' /proc/mounts" },
        7,
      );
      expect(ro.isError, ro.content).toBe(false);
      expect(ro.content).toContain(" ro,");
    });

    it("a timed-out command is stopped and the sandbox stays usable", async () => {
      const conv = await sandboxConversation();
      const t0 = Date.now();
      const r = await call(
        conv,
        "Bash",
        { description: "Test step", command: "sleep 60", timeout: 1000 },
        1,
      );
      expect(Date.now() - t0).toBeLessThan(45_000);
      expect(r.isError).toBe(true);
      expect(r.content, why(r.content)).toContain("timedOut");
      const ok = await call(
        conv,
        "Bash",
        { description: "Test step", command: "ps -eo args | grep -c '^sleep 60' || true" },
        2,
      );
      expect(ok.isError, ok.content).toBe(false);
      expect(ok.content).toMatch(/^0$/m);
    });
  },
);
