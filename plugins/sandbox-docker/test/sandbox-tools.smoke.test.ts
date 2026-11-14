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
 * installed kernel sends the `limits.network` contract, and the org default is `open-public`:
 * the sandbox reaches the network through its egress proxy, which refuses private and metadata
 * addresses. Skipped without Docker.
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

    async function sandboxConversation(): Promise<{ id: string; device: string }> {
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
      const { device_id: device } = await db
        .selectFrom("conversations")
        .select("device_id")
        .where("id", "=", conv)
        .executeTakeFirstOrThrow();
      if (device === null) throw new Error("the conversation has no device");
      devices.add(device);
      return { id: conv, device };
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
      const { id: conv, device } = await sandboxConversation();
      const r = await call(
        conv,
        "Bash",
        { description: "Test step", command: "pwd && id -un && echo proxy=$HTTPS_PROXY" },
        1,
      );
      expect(r.isError, why(r.content)).toBe(false);
      expect(r.content.startsWith(SANDBOX_STARTED_NOTICE)).toBe(true);
      // the org default is open-public: the sandbox's only exit is its egress proxy
      expect(r.content).toMatch(
        new RegExp(`/workspace\\nsandbox\\nproxy=http://cap-device-${device}-egress:3128\\n`),
      );
      // the proxy refuses the metadata address by resolved IP
      const blocked = await call(
        conv,
        "Bash",
        {
          description: "Test step",
          command:
            "curl -s -o /tmp/meta-response -w '%{http_code}' --max-time 15 http://169.254.169.254/latest/meta-data/",
        },
        2,
      );
      expect(blocked.isError, blocked.content).toBe(false);
      expect(blocked.content).toMatch(/^403$/m);

      const w = await call(
        conv,
        "Write",
        { file_path: "/workspace/src/a.txt", content: "alpha\nbeta\ngamma\n" },
        3,
      );
      expect(w.isError, w.content).toBe(false);
      const e = await call(
        conv,
        "Edit",
        { file_path: "/workspace/src/a.txt", old_string: "beta", new_string: "BETA" },
        4,
      );
      expect(e.isError, e.content).toBe(false);
      const rd1 = await call(conv, "Read", { file_path: "/workspace/src/a.txt" }, 5);
      expect(rd1.content).toContain("2\tBETA");
      const g = await call(conv, "Glob", { pattern: "**/*.txt" }, 6);
      expect(g.content).toContain("/workspace/src/a.txt");
      const gr = await call(
        conv,
        "Grep",
        { pattern: "beta", "-i": true, output_mode: "content", "-n": true },
        7,
      );
      expect(gr.content).toContain("/workspace/src/a.txt:2:BETA");
      // /skills is a read-only mount (a write would pass command review as an ask; the mount
      // table shows the property without one)
      const ro = await call(
        conv,
        "Bash",
        { description: "Test step", command: "grep ' /skills ' /proc/mounts" },
        8,
      );
      expect(ro.isError, ro.content).toBe(false);
      expect(ro.content).toContain(" ro,");
    });

    it("a timed-out command is stopped and the sandbox stays usable", async () => {
      const { id: conv } = await sandboxConversation();
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
