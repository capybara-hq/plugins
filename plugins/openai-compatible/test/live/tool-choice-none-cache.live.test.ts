import type { ModelProvider, ModelRequest, ModelUsage } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { createOpenAICompatibleProvider } from "../../src/index.js";

/**
 * A summary-shaped request (the conversation plus a reply and a "summarize, do not call tools"
 * turn) with `toolChoice: "none"` reads the turn before it from the cache, on the dialects whose
 * services render an explicit `tool_choice: "none"` without the tool definitions (deepseek, qwen:
 * live 2026-11-28); the plugin leaves it at auto and drops calls there. A cache written
 * asynchronously (DeepSeek's disk cache) is awaited by repeating the turn until it reads itself
 * back. Runs with CAPYBARA_TEST_OAICOMPAT_BASE_URL / _API_KEY / _MODEL and _DIALECT deepseek or
 * qwen (DashScope: https://dashscope.aliyuncs.com/compatible-mode/v1).
 */
const LIVE = {
  baseUrl: process.env.CAPYBARA_TEST_OAICOMPAT_BASE_URL,
  apiKey: process.env.CAPYBARA_TEST_OAICOMPAT_API_KEY,
  model: process.env.CAPYBARA_TEST_OAICOMPAT_MODEL,
  dialect: process.env.CAPYBARA_TEST_OAICOMPAT_DIALECT,
};
const dialect = LIVE.dialect === "deepseek" || LIVE.dialect === "qwen" ? LIVE.dialect : undefined;
const ready = Boolean(LIVE.baseUrl && LIVE.apiKey && LIVE.model && dialect);
if (!ready) {
  console.info(
    "[plugin-openai-compatible] CAPYBARA_TEST_OAICOMPAT_* not set for a deepseek or qwen endpoint: live toolChoice none cache test skipped",
  );
}

const MODEL = `live/${LIVE.model}`;
const total = (u: ModelUsage) => u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;

async function call(
  p: ModelProvider,
  req: ModelRequest,
): Promise<{ text: string; usage: ModelUsage }> {
  for await (const e of p.stream(req, { signal: AbortSignal.timeout(120_000) })) {
    if (e.type === "message_complete") {
      return {
        text: e.content.map((b) => (b.type === "text" ? b.text : "")).join(""),
        usage: e.usage,
      };
    }
  }
  throw new Error("no message_complete");
}

function toolTurn(nonce: string): ModelRequest {
  const lines = (tag: string, n: number) =>
    Array.from(
      { length: n },
      (_, i) => `${tag} ${i}: item ${i * 7} has code ${tag}-${i} (${nonce}).`,
    ).join("\n");
  return {
    model: MODEL,
    system: [{ text: `You answer in a few words.\n${lines("Rule", 60)}`, cache: true }],
    messages: [
      { role: "user", content: [{ type: "text", text: `${lines("Fact", 40)}\nWhat is item 14?` }] },
    ],
    tools: ["read_file", "search", "run_command"].map((name, i) => ({
      name,
      description: `${name} (${nonce}).\n${lines(`Tool${i}`, 15)}`,
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    })),
    maxOutputTokens: 200,
    params: { thinking: "off" },
  };
}

describe.skipIf(!ready)("live toolChoice none keeps the cache", { timeout: 180_000 }, () => {
  it(`${dialect} ${LIVE.model}: write, then a summary-shaped request with toolChoice none reads the cache`, async () => {
    const p = createOpenAICompatibleProvider({
      endpoints: [
        {
          name: "live",
          baseUrl: LIVE.baseUrl ?? "",
          dialect: dialect ?? "deepseek",
          models: [
            {
              id: LIVE.model ?? "",
              contextWindow: 128_000,
              maxOutputTokens: 8192,
              reasoning: true,
              caching: true,
            },
          ],
        },
      ],
      apiKeys: { live: LIVE.apiKey ?? "" },
    });
    const turn = toolTurn(Math.random().toString(36).slice(2));
    const r1 = await call(p, turn);
    // wait condition, not a sleep: the turn reads itself back once its entry is written
    let warm = 0;
    for (let i = 0; i < 10 && warm < total(r1.usage) * 0.9; i++) {
      warm = (await call(p, turn)).usage.cacheReadTokens;
    }
    expect(warm).toBeGreaterThanOrEqual(total(r1.usage) * 0.9);
    const r2 = await call(p, {
      ...turn,
      messages: [
        ...turn.messages,
        {
          role: "assistant",
          content: [{ type: "text", text: r1.text || "Item 14 has code Fact-2." }],
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Stop the task. Do not call tools. Write a two-sentence summary of the conversation above.",
            },
          ],
        },
      ],
      toolChoice: "none",
    });
    console.info(
      `[plugin-openai-compatible] live toolChoice none ${dialect}: turn ${JSON.stringify(r1.usage)}, summary ${JSON.stringify(r2.usage)}`,
    );
    expect(r2.usage.cacheReadTokens).toBeGreaterThanOrEqual(total(r1.usage) * 0.9);
  });
});
