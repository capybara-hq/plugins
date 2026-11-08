import {
  isModelError,
  type ModelInfo,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
  validateEmbedResult,
} from "@capybara-hq/plugin-sdk";
import {
  describeModelProviderConformance,
  type FakeModelServer,
  type FakeResponse,
  startFakeModelServer,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NOT_ACTIVATED_HINT } from "../src/errors.js";
import { createArkProvider } from "../src/index.js";
import { buildRequest } from "../src/map-request.js";
import {
  arkRoutes,
  DEEPSEEK,
  EMBED,
  errorJson,
  SEED,
  sseChat,
  usageOf,
  vectorFor,
} from "./fixtures.js";

const PLUGIN = "ark";

describeModelProviderConformance("ark (fixtures, seed)", async () => {
  const server = await startFakeModelServer(arkRoutes());
  return {
    contract: 2,
    plugin: PLUGIN,
    provider: createArkProvider({ apiKey: "ark-fixture", baseUrl: `${server.url}/api/v3` }),
    model: SEED,
    expect: { thinking: true, caching: false, embedding: { model: EMBED, dimensions: 1024 } },
    teardown: () => server.stop(),
  };
});

describeModelProviderConformance("ark (fixtures, deepseek)", async () => {
  const server = await startFakeModelServer(arkRoutes());
  return {
    contract: 2,
    plugin: PLUGIN,
    provider: createArkProvider({ apiKey: "ark-fixture", baseUrl: `${server.url}/api/v3` }),
    model: DEEPSEEK,
    expect: { thinking: true, caching: true },
    teardown: () => server.stop(),
  };
});

// ---- helpers ----
const req = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  model: SEED,
  system: [{ text: "Be brief.", cache: false }],
  messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
  tools: [],
  maxOutputTokens: 256,
  params: {},
  ...over,
});

async function drain(
  p: ModelProvider,
  r: ModelRequest,
  opts: { signal?: AbortSignal; config?: unknown } = {},
): Promise<ModelStreamEvent[]> {
  const out: ModelStreamEvent[] = [];
  for await (const e of p.stream(r, {
    signal: opts.signal ?? new AbortController().signal,
    ...(opts.config !== undefined ? { config: opts.config } : {}),
  })) {
    out.push(e);
  }
  return out;
}

async function streamError(p: ModelProvider, r: ModelRequest = req(), config?: unknown) {
  try {
    await drain(p, r, config !== undefined ? { config } : {});
  } catch (e) {
    return e;
  }
  throw new Error("expected stream to throw");
}

const complete = (events: ModelStreamEvent[]) => {
  const done = events.at(-1);
  if (done?.type !== "message_complete") throw new Error("expected message_complete last");
  return done;
};
const kindOf = (e: unknown) => (isModelError(e) ? e.kind : `not a ModelError: ${String(e)}`);

// ---- stream edge cases and errors ----
describe("ark: stream edge cases and errors", () => {
  let server: FakeModelServer;
  let next: () => FakeResponse;
  const provider = () =>
    createArkProvider({ apiKey: "ark-fixture", baseUrl: `${server.url}/api/v3` });
  const usage = usageOf({ total: 5, output: 1 });

  beforeAll(async () => {
    server = await startFakeModelServer(() => next());
  });
  afterAll(async () => {
    await server?.stop();
  });

  it("accumulates reasoning, encrypted_content, text and tool calls; usage subtracts cache reads", async () => {
    next = () =>
      sseChat({
        model: SEED,
        reasoning: "Think twice.",
        encrypted: "djE-secret",
        text: "Checking both.",
        toolCalls: [
          { id: "call_a", name: "get_weather", args: '{"city":"Paris"}' },
          { id: "call_b", name: "get_weather", args: '{"city":"Rome"}' },
        ],
        finish: "tool_calls",
        usage: usageOf({ total: 100, cached: 64, output: 20 }),
      });
    const events = await drain(provider(), req());
    expect(server.requests.at(-1)?.path).toBe("/api/v3/chat/completions");
    const done = complete(events);
    expect(done.stopReason).toBe("tool_use");
    expect(events.flatMap((e) => (e.type === "thinking_delta" ? [e.text] : [])).join("")).toBe(
      "Think twice.",
    );
    expect(done.content).toEqual([
      {
        type: "thinking",
        text: "Think twice.",
        opaque: {
          provider: "ark",
          model: SEED,
          data: { field: "reasoning_content", encrypted_content: "djE-secret" },
        },
      },
      { type: "text", text: "Checking both." },
      { type: "tool_call", id: "call_a", name: "get_weather", input: { city: "Paris" } },
      { type: "tool_call", id: "call_b", name: "get_weather", input: { city: "Rome" } },
    ]);
    expect(done.usage).toEqual({
      inputTokens: 36,
      outputTokens: 20,
      cacheReadTokens: 64,
      cacheWriteTokens: 0,
    });
    // the next turn to the same model carries the encrypted_content back
    const replay = buildRequest(
      req({ messages: [...req().messages, { role: "assistant", content: done.content }] }),
    );
    expect(replay.messages[2]).toMatchObject({ encrypted_content: "djE-secret" });
  });

  it("a not-activated model's 404 carries the activation hint", async () => {
    next = () =>
      errorJson(404, {
        code: "InvalidEndpointOrModel.NotFound",
        message: "The model or endpoint x does not exist or you do not have access to it.",
        type: "Not Found",
      });
    const e = await streamError(provider());
    expect(kindOf(e)).toBe("invalid_request");
    expect(isModelError(e) && e.message).toContain("activated for this account in the Ark console");
  });

  it("completes with zero usage and a warning when no usage chunk arrives", async () => {
    const warnings: string[] = [];
    const p = createArkProvider({
      apiKey: "ark-fixture",
      baseUrl: `${server.url}/api/v3`,
      log: { warn: (msg) => warnings.push(msg) },
    });
    next = () => sseChat({ model: SEED, text: "Hi", finish: "stop" });
    const done = complete(await drain(p, req()));
    expect(done.content).toEqual([{ type: "text", text: "Hi" }]);
    expect(done.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(warnings).toEqual(["ark: the stream ended without a usage chunk"]);
  });

  it("keeps an encrypted_content that comes without reasoning text", async () => {
    next = () => sseChat({ model: SEED, encrypted: "djE-only", text: "Hi", finish: "stop", usage });
    const done = complete(await drain(provider(), req()));
    expect(done.content[0]).toEqual({
      type: "thinking",
      text: "",
      opaque: {
        provider: "ark",
        model: SEED,
        data: { field: "reasoning_content", encrypted_content: "djE-only" },
      },
    });
  });

  it("finish_reason: length -> max_tokens (partial tool calls dropped), content_filter -> refusal", async () => {
    next = () =>
      sseChat({
        model: SEED,
        text: "Partial",
        toolCalls: [{ id: "call_x", name: "t", args: '{"a":' }],
        finish: "length",
        usage,
      });
    const d1 = complete(await drain(provider(), req()));
    expect(d1.stopReason).toBe("max_tokens");
    expect(d1.content).toEqual([{ type: "text", text: "Partial" }]);
    next = () => sseChat({ model: SEED, finish: "content_filter", usage });
    expect(complete(await drain(provider(), req())).stopReason).toBe("refusal");
  });

  it("a stream cut after some text -> network, never a message_complete", async () => {
    next = () => sseChat({ model: SEED, text: "cut short", finish: null, omitDone: true });
    const seen: ModelStreamEvent[] = [];
    let err: unknown;
    try {
      for await (const e of provider().stream(req(), { signal: new AbortController().signal }))
        seen.push(e);
    } catch (e) {
      err = e;
    }
    expect(kindOf(err)).toBe("network");
    expect(seen.some((e) => e.type === "text_delta")).toBe(true);
    expect(seen.some((e) => e.type === "message_complete")).toBe(false);
  });

  it("a mid-stream error event -> its kind, never a message_complete", async () => {
    next = () =>
      sseChat({
        model: SEED,
        text: "partial",
        finish: "stop",
        usage,
        midStreamError: { code: "ServerOverloaded", message: "busy", type: "TooManyRequests" },
      });
    expect(kindOf(await streamError(provider()))).toBe("overloaded");
    next = () =>
      sseChat({
        model: SEED,
        text: "partial",
        finish: "stop",
        usage,
        midStreamError: { code: "Weird", message: "?" },
      });
    expect(kindOf(await streamError(provider()))).toBe("server");
  });

  it("malformed tool_calls arguments -> invalid_request", async () => {
    next = () =>
      sseChat({
        model: SEED,
        toolCalls: [{ id: "call_bad", name: "get_weather", args: '{"city": Paris' }],
        finish: "tool_calls",
        usage,
      });
    expect(kindOf(await streamError(provider()))).toBe("invalid_request");
  });

  it("aborted signal -> aborted", async () => {
    next = () => ({ stall: true });
    const ac = new AbortController();
    const p = drain(provider(), req(), { signal: ac.signal }).catch((e: unknown) => e);
    setTimeout(() => ac.abort(), 50);
    expect(kindOf(await p)).toBe("aborted");
  });

  describe("HTTP errors", () => {
    it.each([
      [400, "InvalidParameter", "invalid_request"],
      [400, "context_length_exceeded", "context_overflow"],
      // a tampered encrypted_content (the API may also ignore it, live 2026-11-08)
      [400, "InvalidParameter.InvalidSignature", "invalid_request"],
      [401, "AuthenticationError", "auth"],
      [403, "AccountOverdueError", "auth"],
      [404, "InvalidEndpointOrModel.NotFound", "invalid_request"],
      [429, "RateLimitExceeded.EndpointRPMExceeded", "rate_limited"],
      [429, "ModelAccountTpmRateLimitExceeded", "rate_limited"],
      [429, "QuotaExceeded", "auth"],
      [429, "SetLimitExceeded", "auth"],
      [429, "ServerOverloaded", "overloaded"],
      [500, "InternalServiceError", "server"],
      [503, "ServiceUnavailable", "overloaded"],
    ])("%s %s -> %s", async (status, code, kind) => {
      next = () => errorJson(status, { code, message: "boom" });
      expect(kindOf(await streamError(provider()))).toBe(kind);
    });

    it("429 carries retry-after as retryAfterMs", async () => {
      next = () =>
        errorJson(
          429,
          { code: "RateLimitExceeded.EndpointRPMExceeded", message: "slow" },
          { "retry-after": "7" },
        );
      const e = await streamError(provider());
      expect(isModelError(e) && e.retryAfterMs).toBe(7000);
    });
  });

  describe("per-call config", () => {
    it("no key in opts.config nor defaults -> auth before any request", async () => {
      const before = server.requests.length;
      const e = await streamError(createArkProvider({ baseUrl: `${server.url}/api/v3` }));
      expect(kindOf(e)).toBe("auth");
      expect(server.requests.length).toBe(before);
    });

    it("an org config without a key never falls back to the setup key", async () => {
      const before = server.requests.length;
      const e = await streamError(provider(), req(), { region: "cn-shanghai" });
      expect(kindOf(e)).toBe("auth");
      expect(server.requests.length).toBe(before);
    });

    it("an org key in opts.config is the one sent", async () => {
      next = () => sseChat({ model: SEED, text: "ok", finish: "stop", usage });
      await drain(provider(), req(), { config: { apiKey: "ark-org" } });
      expect(server.requests.at(-1)?.headers.authorization).toBe("Bearer ark-org");
      await drain(provider(), req());
      expect(server.requests.at(-1)?.headers.authorization).toBe("Bearer ark-fixture");
    });

    it("an invalid opts.config -> invalid_request", async () => {
      expect(kindOf(await streamError(provider(), req(), { apiKey: "k", region: "mars-1" }))).toBe(
        "invalid_request",
      );
    });
  });
});

// ---- embeddings ----
describe("ark: embed", () => {
  let server: FakeModelServer;
  let next: (body: unknown) => FakeResponse;
  const provider = () =>
    createArkProvider({ apiKey: "ark-fixture", baseUrl: `${server.url}/api/v3` });
  const info = {
    dimensions: [1024, 2048],
    defaultDimensions: 2048,
    maxInputTokens: 131072,
    maxBatch: 1,
  };
  const signal = () => new AbortController().signal;

  beforeAll(async () => {
    const routes = arkRoutes();
    server = await startFakeModelServer((r) =>
      r.path === "/api/v3/embeddings/multimodal" ? next(r.body) : routes(r),
    );
  });
  afterAll(async () => {
    await server?.stop();
  });

  it("sends one text input per request and returns the vectors in input order", async () => {
    const routes = arkRoutes();
    next = (body) =>
      routes({
        path: "/api/v3/embeddings/multimodal",
        body,
        headers: { authorization: "Bearer ark-fixture" },
      });
    const before = server.requests.length;
    const input = ["alpha", "bravo", "charlie"];
    const r = { model: EMBED, input, dimensions: 1024 };
    const res = await provider().embed?.(r, { signal: signal() });
    if (res === undefined) throw new Error("embed missing");
    const sent = server.requests.slice(before);
    expect(sent.map((s) => s.body)).toEqual(
      input.map((text) => ({
        model: EMBED,
        input: [{ type: "text", text }],
        dimensions: 1024,
        encoding_format: "float",
      })),
    );
    expect(res.vectors).toEqual(input.map((t) => vectorFor(t, 1024)));
    expect(res.usage.inputTokens).toBe(15);
    expect(validateEmbedResult(r, info, res)).toBeNull();
  });

  it("omits dimensions for the default and maps inputType to the instruction templates", async () => {
    const routes = arkRoutes();
    next = (body) =>
      routes({
        path: "/api/v3/embeddings/multimodal",
        body,
        headers: { authorization: "Bearer ark-fixture" },
      });
    const before = server.requests.length;
    await provider().embed?.(
      { model: EMBED, input: ["q"], inputType: "query" },
      { signal: signal() },
    );
    await provider().embed?.(
      { model: EMBED, input: ["d"], inputType: "document" },
      { signal: signal() },
    );
    const [q, d] = server.requests.slice(before).map((s) => s.body as Record<string, unknown>);
    expect(q).not.toHaveProperty("dimensions");
    expect(q?.instructions).toBe(
      "Target_modality: text.\nInstruction:Given a query, retrieve the most relevant passages\nQuery:",
    );
    expect(d?.instructions).toBe("Instruction:Compress the text into one word.\nQuery:");
  });

  it("refuses an unsupported dimension or an unknown model before any request", async () => {
    const before = server.requests.length;
    const e1 = await provider()
      .embed?.({ model: EMBED, input: ["a"], dimensions: 512 }, { signal: signal() })
      .catch((e: unknown) => e);
    expect(kindOf(e1)).toBe("invalid_request");
    const e2 = await provider()
      .embed?.({ model: SEED, input: ["a"] }, { signal: signal() })
      .catch((e: unknown) => e);
    expect(kindOf(e2)).toBe("invalid_request");
    // a prototype member is not a bundled model
    const e3 = await provider()
      .embed?.({ model: "constructor", input: ["a"] }, { signal: signal() })
      .catch((e: unknown) => e);
    expect(kindOf(e3)).toBe("invalid_request");
    expect(server.requests.length).toBe(before);
  });

  it("maps errors and a wrong-size vector", async () => {
    next = () =>
      errorJson(
        429,
        { code: "RateLimitExceeded.EndpointTPMExceeded", message: "slow" },
        { "retry-after": "1" },
      );
    const e = await provider()
      .embed?.({ model: EMBED, input: ["a"] }, { signal: signal() })
      .catch((x: unknown) => x);
    expect(kindOf(e)).toBe("rate_limited");
    expect(isModelError(e) && e.retryAfterMs).toBe(1000);
    next = () =>
      errorJson(401, { code: "AuthenticationError", message: "bad", type: "Unauthorized" });
    const a = await provider()
      .embed?.({ model: EMBED, input: ["a"] }, { signal: signal() })
      .catch((x: unknown) => x);
    expect(kindOf(a)).toBe("auth");
    next = () => ({
      status: 200,
      json: { object: "list", data: { embedding: [0.1, 0.2] }, usage: { total_tokens: 1 } },
    });
    const s = await provider()
      .embed?.({ model: EMBED, input: ["a"] }, { signal: signal() })
      .catch((x: unknown) => x);
    expect(kindOf(s)).toBe("server");
  });

  it("an org config without a key is auth with no request", async () => {
    const before = server.requests.length;
    const e = await provider()
      .embed?.({ model: EMBED, input: ["a"] }, { signal: signal(), config: {} })
      .catch((x: unknown) => x);
    expect(kindOf(e)).toBe("auth");
    expect(server.requests.length).toBe(before);
  });

  it("an aborted signal -> aborted", async () => {
    next = () => ({ stall: true });
    const ac = new AbortController();
    const p = provider()
      .embed?.({ model: EMBED, input: ["a"] }, { signal: ac.signal })
      .catch((x: unknown) => x);
    setTimeout(() => ac.abort(), 50);
    expect(kindOf(await p)).toBe("aborted");
  });
});

// ---- live mode ----
// Keys live in ~/.capybara-test.env; `_CHAT_MODEL` / `_EMBED_MODEL` are optional: unset, the models
// come from the account's list, the first ones that answer (at most 5 tried each).
const LIVE_KEY = process.env.CAPYBARA_TEST_ARK_API_KEY;
const LIVE_REGION = process.env.CAPYBARA_TEST_ARK_REGION;
const LIVE_AK = process.env.CAPYBARA_TEST_ARK_ACCESS_KEY_ID;
const LIVE_SK = process.env.CAPYBARA_TEST_ARK_SECRET_ACCESS_KEY;

interface LivePick {
  provider: ModelProvider;
  chat: ModelInfo | null;
  embed: ModelInfo | null;
  reasons: string[];
}

/**
 * Only access / not-activated failures move to the next candidate (403, or the 404 NotFound that
 * carries the activation hint); anything else, a 400 from a mapping regression included, fails.
 */
const nextCandidate = (e: unknown) =>
  isModelError(e) &&
  (e.kind === "auth" || (e.kind === "invalid_request" && e.message.includes(NOT_ACTIVATED_HINT)));

async function pickLive(): Promise<LivePick> {
  const provider = createArkProvider({
    apiKey: LIVE_KEY ?? "",
    ...(LIVE_REGION === "cn-beijing" || LIVE_REGION === "cn-shanghai"
      ? { region: LIVE_REGION }
      : {}),
  });
  const models = await provider.listModels();
  const reasons: string[] = [];
  const wantChat = process.env.CAPYBARA_TEST_ARK_CHAT_MODEL;
  const chats = models.filter((m) => (m.kind ?? "chat") === "chat" && m.capabilities.reasoning);
  // a seed model returns encrypted_content: the replay the plugin exists for
  const ordered = wantChat
    ? chats.filter((m) => m.id === wantChat)
    : [
        ...chats.filter((m) => m.id.startsWith("doubao-seed-2")),
        ...chats.filter((m) => !m.id.startsWith("doubao-seed-2")),
      ];
  let chat: ModelInfo | null = null;
  for (const m of ordered.slice(0, 5)) {
    try {
      const thinkingKnob = m.parameters.some((p) => p.key === "thinking");
      await drain(
        provider,
        req({ model: m.id, maxOutputTokens: 64, params: thinkingKnob ? { thinking: "off" } : {} }),
      );
      chat = m;
      break;
    } catch (e) {
      if (!nextCandidate(e)) throw e;
      reasons.push(`${m.id}: ${String((e as Error).message)}`);
    }
  }
  const wantEmbed = process.env.CAPYBARA_TEST_ARK_EMBED_MODEL;
  const embeds = models.filter((m) => m.kind === "embedding" && (!wantEmbed || m.id === wantEmbed));
  let embed: ModelInfo | null = null;
  for (const m of embeds.slice(0, 5)) {
    try {
      await provider.embed?.(
        { model: m.id, input: ["ping"] },
        { signal: new AbortController().signal },
      );
      embed = m;
      break;
    } catch (e) {
      if (!nextCandidate(e)) throw e;
      reasons.push(`${m.id}: ${String((e as Error).message)}`);
    }
  }
  return { provider, chat, embed, reasons };
}

if (!LIVE_KEY) console.info("[plugin-ark] CAPYBARA_TEST_ARK_API_KEY not set: live tests skipped");
const live = LIVE_KEY ? await pickLive() : null;
if (live && (live.chat === null || live.embed === null)) {
  console.info(
    `[plugin-ark] live: no usable ${live.chat === null ? "chat" : "embedding"} model (${live.reasons.join("; ")})`,
  );
}

describe.skipIf(!live?.chat)("live", { timeout: 120_000 }, () => {
  describeModelProviderConformance(`ark (live, ${live?.chat?.id})`, async () => ({
    contract: 2,
    plugin: PLUGIN,
    provider: live?.provider as ModelProvider,
    model: live?.chat?.id ?? "",
    expect: {
      thinking: true,
      caching: live?.chat?.capabilities.caching ?? false,
      ...(live?.embed?.embedding
        ? {
            embedding: {
              model: live.embed.id,
              dimensions: live.embed.embedding.dimensions[0] ?? 1024,
            },
          }
        : {}),
    },
    // 2000 was not cached on deepseek-v4-flash-ga live (2026-11-08); 8000 was
    cachePrefixTokens: 8000,
    teardown: async () => {},
  }));

  it("live: a two-turn tool call replays the thinking to the same model", async () => {
    const provider = live?.provider as ModelProvider;
    const model = live?.chat?.id ?? "";
    const tools = [
      {
        name: "get_weather",
        description: "Get the weather for a city",
        inputSchema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ];
    const first = req({
      model,
      tools,
      maxOutputTokens: 4000,
      params: { thinking: "on" },
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "What is the weather in Paris? Use the tool." }],
        },
      ],
    });
    const d1 = complete(await drain(provider, first));
    const call = d1.content.find((b) => b.type === "tool_call");
    expect(call).toBeDefined();
    if (call?.type !== "tool_call") return;
    const second: ModelRequest = {
      ...first,
      messages: [
        ...first.messages,
        { role: "assistant", content: d1.content },
        {
          role: "user",
          content: [
            { type: "tool_result", callId: call.id, content: "Sunny, 22C", isError: false },
          ],
        },
      ],
    };
    const thinking = d1.content.find((b) => b.type === "thinking");
    const enc = (thinking?.opaque?.data as { encrypted_content?: string } | undefined)
      ?.encrypted_content;
    console.info(
      `[plugin-ark] live ${model}: encrypted_content ${enc ? `present (${enc.length} chars)` : "absent"}`,
    );
    if (enc) expect(buildRequest(second).messages[2]).toMatchObject({ encrypted_content: enc });
    const d2 = complete(await drain(provider, second));
    expect(d2.content.some((b) => b.type === "text" && /22/.test(b.text))).toBe(true);
  });

  it("live: the list carries the account's chat and embedding models", async () => {
    const provider = live?.provider as ModelProvider;
    const models = await provider.listModels();
    expect(models.length).toBeGreaterThan(5);
    expect(models.some((m) => m.kind === "embedding")).toBe(true);
  });

  it.skipIf(!LIVE_AK || !LIVE_SK)(
    "live: management keys list the account's endpoints",
    async () => {
      const warnings: string[] = [];
      const region = LIVE_REGION === "cn-shanghai" ? "cn-shanghai" : "cn-beijing";
      const provider = createArkProvider({
        apiKey: LIVE_KEY ?? "",
        region,
        management: { accessKeyId: LIVE_AK ?? "", secretAccessKey: LIVE_SK ?? "" },
        log: { warn: (msg) => warnings.push(msg) },
      });
      const models = await provider.listModels();
      const endpoints = models.filter((m) => m.id.startsWith("ep-"));
      console.info(
        `[plugin-ark] live: ${endpoints.length} endpoint(s) listed (${endpoints.map((m) => m.displayName).join("; ")}); ${warnings.length} warning(s): ${[...new Set(warnings)].join("; ")}`,
      );
      expect(warnings).not.toContain(
        "ark: listing inference endpoints failed; listing the models only",
      );
      expect(endpoints.length).toBeGreaterThan(0);
      // an endpoint answers like its foundation model
      const ep = endpoints[0];
      if (ep === undefined) return;
      const done = complete(
        await drain(provider, req({ model: ep.id, maxOutputTokens: 64, params: {} })),
      );
      expect(done.content.some((b) => b.type === "text")).toBe(true);
    },
  );
});
