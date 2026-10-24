import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDockerSandbox } from "../../../../../plugins/sandbox-docker/src/index.js";
import {
  buildTestImages,
  docker,
  dockerAvailable,
  type SocketProxy,
  startSocketProxy,
  type TestImages,
} from "../../../../../plugins/sandbox-docker/test/docker-env.js";
import type { ConversationEvent } from "../../../src/conversations/events.js";
import { type KernelDb, kernelDb } from "../../../src/db/kernel-schema.js";
import { createDb } from "../../../src/db/pool.js";
import { AccountsService } from "../../../src/identity/accounts.js";
import type { Kernel } from "../../../src/kernel.js";
import { createLogger } from "../../../src/log.js";
import { truncateTables } from "../../helpers/db.js";
import { MODEL_FAKE } from "../../helpers/model-plugins.js";
import {
  createConv,
  createOrg,
  eventsOf,
  PW,
  postMessage,
  type Req,
  runConfig,
  session,
  startKernel,
  waitForTerminal,
} from "../../helpers/runs.js";

/**
 * M5 T9 冒烟：真实内核 + model-fake + 真实的 sandbox-docker 插件（经 docker/sandbox-proxy 的 socket 代理），
 * 跑一小组 T8 的沙箱工具用例（出站用默认的 allowlist，顺带走一遍出站代理的创建）。没有 Docker 时跳过。
 */

const SANDBOX_DOCKER = fileURLToPath(
  new URL("../../../../../plugins/sandbox-docker/src/index.ts", import.meta.url),
);

const SANDBOX_TOOLS = [
  "sandbox_bash",
  "sandbox_read",
  "sandbox_write",
  "sandbox_edit",
  "sandbox_glob",
  "sandbox_grep",
];

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
    let db: KernelDb;
    let destroyDb: () => Promise<void>;
    let k: Kernel;
    let owner: Req;
    let orgId: string;
    const conversations: string[] = [];
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
      k = await startKernel(
        runConfig(
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
        // startKernel's options leave the logger out (silent by default); this file wants warnings
        {
          logger: createLogger("warn", { write: (line) => warnings.push(line) }),
        } as Parameters<typeof startKernel>[1],
      );
    }, 600_000);

    afterAll(async () => {
      await k?.stop();
      if (proxy) {
        const p = createDockerSandbox({
          endpoint: proxy.endpoint,
          runtime: "runc",
          network,
          egressProxyImage: images.egressImage,
        });
        for (const c of conversations) {
          await p.destroyByName?.(`cap-${c}`, AbortSignal.timeout(60_000)).catch(() => undefined);
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
      await new AccountsService(db).createLocal({ login: "owner", password: PW, displayName: "O" });
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
            tools: SANDBOX_TOOLS.map((name) => ({ kind: "builtin", name })),
          },
          visibility: "org",
        },
      });
      expect(res.statusCode, res.body).toBe(201);
      const agentId = (res.json() as { agent: { id: string } }).agent.id;
      const conv = await createConv(owner, orgId, agentId);
      conversations.push(conv);
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
        "sandbox_bash",
        { command: "pwd && id -un && echo $HTTPS_PROXY" },
        1,
      );
      expect(r.isError, why(r.content)).toBe(false);
      expect(r.content).toMatch(/^Sandbox started/);
      expect(r.content).toMatch(/\/workspace\nsandbox\nhttp:\/\/cap-[0-9a-f-]+-egress:3128/);

      const w = await call(
        conv,
        "sandbox_write",
        { path: "/workspace/src/a.txt", content: "alpha\nbeta\ngamma\n" },
        2,
      );
      expect(w.isError, w.content).toBe(false);
      const e = await call(
        conv,
        "sandbox_edit",
        { path: "/workspace/src/a.txt", oldText: "beta", newText: "BETA" },
        3,
      );
      expect(e.isError, e.content).toBe(false);
      const rd1 = await call(conv, "sandbox_read", { path: "/workspace/src/a.txt" }, 4);
      expect(rd1.content).toContain("2\tBETA");
      const g = await call(conv, "sandbox_glob", { pattern: "**/*.txt" }, 5);
      expect(g.content).toContain("/workspace/src/a.txt");
      const gr = await call(conv, "sandbox_grep", { pattern: "beta", ignoreCase: true }, 6);
      expect(gr.content).toContain("/workspace/src/a.txt:2:BETA");
      // /skills 对命令只读
      const ro = await call(conv, "sandbox_bash", { command: "touch /skills/x" }, 7);
      expect(ro.content).toContain("Read-only file system");
    });

    it("a timed-out command is stopped and the sandbox stays usable", async () => {
      const conv = await sandboxConversation();
      const t0 = Date.now();
      const r = await call(conv, "sandbox_bash", { command: "sleep 60", timeoutSeconds: 1 }, 1);
      expect(Date.now() - t0).toBeLessThan(45_000);
      expect(r.isError).toBe(true);
      expect(r.content, why(r.content)).toContain("timedOut");
      const ok = await call(
        conv,
        "sandbox_bash",
        { command: "ps -eo args | grep -c '^sleep 60' || true" },
        2,
      );
      expect(ok.isError, ok.content).toBe(false);
      expect(ok.content).toMatch(/^0$/m);
    });
  },
);
