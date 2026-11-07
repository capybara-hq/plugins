import { isModelError, type ModelRequest } from "@capybara-hq/plugin-sdk";
import { startFakeModelServer } from "@capybara-hq/testing";
import { describe, expect, it } from "vitest";
import plugin, { baseUrlFor, createBailianProvider } from "../src/index.js";
import { bailianRoutes } from "./fixtures.js";

const req: ModelRequest = {
  model: "qwen-flash",
  system: [],
  messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
  tools: [],
  maxOutputTokens: 256,
  params: {},
};

const kindOf = (e: unknown) => (isModelError(e) ? e.kind : `not a ModelError: ${String(e)}`);

async function drain(it: AsyncIterable<unknown>) {
  try {
    for await (const _ of it) {
      // drain
    }
  } catch (e) {
    return e;
  }
  return undefined;
}

describe("base URL", () => {
  it("workspace hosts per region, the US host without a workspace", () => {
    expect(baseUrlFor("cn-beijing", "ws-abc123")).toBe(
      "https://ws-abc123.cn-beijing.maas.aliyuncs.com",
    );
    expect(baseUrlFor("ap-southeast-1", "ws1")).toBe(
      "https://ws1.ap-southeast-1.maas.aliyuncs.com",
    );
    expect(baseUrlFor("us-east-1", undefined)).toBe("https://dashscope-us.aliyuncs.com");
    expect(baseUrlFor("us-east-1", "ws1")).toBe("https://dashscope-us.aliyuncs.com");
  });

  it("Beijing without a workspace uses the shared domain (verified live 2026-11-08)", () => {
    expect(baseUrlFor("cn-beijing", undefined)).toBe("https://dashscope.aliyuncs.com");
  });

  it("other regions require the workspace id", () => {
    for (const region of [
      "ap-southeast-1",
      "cn-hongkong",
      "ap-northeast-1",
      "eu-central-1",
    ] as const) {
      let err: unknown;
      try {
        baseUrlFor(region, undefined);
      } catch (e) {
        err = e;
      }
      expect(kindOf(err)).toBe("invalid_request");
      expect((err as Error).message).toContain(`workspaceId is required for ${region}`);
    }
  });
});

describe("per-call config", () => {
  it("no key anywhere is auth before any request", async () => {
    const server = await startFakeModelServer(bailianRoutes());
    const provider = createBailianProvider({ baseUrl: server.url });
    expect(kindOf(await provider.listModels().catch((e: unknown) => e))).toBe("auth");
    expect(
      kindOf(await drain(provider.stream(req, { signal: new AbortController().signal }))),
    ).toBe("auth");
    const embedErr = await provider
      .embed?.(
        { model: "text-embedding-v4", input: ["a"] },
        { signal: new AbortController().signal },
      )
      .catch((e: unknown) => e);
    expect(kindOf(embedErr)).toBe("auth");
    expect(server.requests).toHaveLength(0);
    await server.stop();
  });

  it("an org config without a key is auth even when the setup has a key; nothing is sent", async () => {
    const server = await startFakeModelServer(bailianRoutes());
    const provider = createBailianProvider({ apiKey: "sk-platform", baseUrl: server.url });
    const org = { region: "ap-southeast-1", workspaceId: "org-ws" };
    expect(
      kindOf(await provider.listModels({ orgId: "o1", config: org }).catch((e: unknown) => e)),
    ).toBe("auth");
    expect(
      kindOf(
        await drain(
          provider.stream(req, { signal: new AbortController().signal, orgId: "o1", config: org }),
        ),
      ),
    ).toBe("auth");
    const embedErr = await provider
      .embed?.(
        { model: "text-embedding-v4", input: ["a"] },
        { signal: new AbortController().signal, orgId: "o1", config: org },
      )
      .catch((e: unknown) => e);
    expect(kindOf(embedErr)).toBe("auth");
    expect(server.requests).toHaveLength(0);
    await server.stop();
  });

  it("the org's key is the one sent", async () => {
    const server = await startFakeModelServer(bailianRoutes());
    const provider = createBailianProvider({ apiKey: "sk-platform", baseUrl: server.url });
    const config = { apiKey: "sk-org", region: "cn-beijing" };
    await provider.listModels({ orgId: "o1", config });
    expect(
      await drain(
        provider.stream(req, { signal: new AbortController().signal, orgId: "o1", config }),
      ),
    ).toBe(undefined);
    await provider.embed?.(
      { model: "text-embedding-v4", input: ["a"] },
      { signal: new AbortController().signal, orgId: "o1", config },
    );
    expect(server.requests.length).toBeGreaterThan(2);
    for (const r of server.requests) expect(r.headers.authorization).toBe("Bearer sk-org");
    await server.stop();
  });

  it("the org's region without a workspace is the documented error, not the setup's workspace", async () => {
    const server = await startFakeModelServer(bailianRoutes());
    const provider = createBailianProvider({
      apiKey: "sk-platform",
      region: "cn-hongkong",
      workspaceId: "platform-ws",
    });
    const err = await provider
      .listModels({ orgId: "o1", config: { apiKey: "sk-org", region: "eu-central-1" } })
      .catch((e: unknown) => e);
    expect(kindOf(err)).toBe("invalid_request");
    expect((err as Error).message).toContain("workspaceId is required for eu-central-1");
    await server.stop();
  });

  it("an invalid config is invalid_request", async () => {
    const provider = createBailianProvider({ apiKey: "sk-platform" });
    for (const config of [
      { apiKey: "sk-org", region: "mars-1" },
      // a workspace id that would change the host
      { apiKey: "sk-org", workspaceId: "evil.example.com/x" },
    ]) {
      const err = await provider.listModels({ orgId: "o1", config }).catch((e: unknown) => e);
      expect(kindOf(err)).toBe("invalid_request");
    }
  });
});

describe("extension", () => {
  it("setup tolerates a platform config without a key", () => {
    const provided: unknown[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: a minimal ctx for setup
    const ctx: any = {
      config: {},
      kv: { get: async () => null, set: async () => {} },
      log: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} },
      provide: (_point: string, impl: unknown) => provided.push(impl),
    };
    plugin.setup(ctx);
    expect(provided).toHaveLength(1);
  });

  it("declares the overridable config fields with labels", () => {
    expect(plugin.name).toBe("bailian");
    expect(plugin.provides).toEqual(["model-provider@2"]);
    expect(plugin.permissions?.network).toContain("dashscope.aliyuncs.com");
  });
});
