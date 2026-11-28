import type { ModelProvider, ModelRequest, ModelUsage } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { createDeepSeekProvider } from "../../src/index.js";
import { recordingNet } from "../fixtures.js";

/**
 * A summary-shaped request (the conversation plus a reply and a "summarize, do not call tools"
 * turn) with `toolChoice: "none"` reads the turn before it from the cache. DeepSeek renders an
 * explicit `tool_choice: "none"` without the tool definitions, so only the part before them was
 * read (live 2026-11-28); the plugin leaves it at auto and drops calls. DeepSeek's disk cache is
 * written asynchronously: the turn is repeated until it reads itself back before the summary.
 * Key: CAPYBARA_TEST_DEEPSEEK_API_KEY, falling back to CAPYBARA_TEST_OAICOMPAT_API_KEY.
 */
const KEY =
  process.env.CAPYBARA_TEST_DEEPSEEK_API_KEY ?? process.env.CAPYBARA_TEST_OAICOMPAT_API_KEY;
if (!KEY) {
  console.info(
    "[plugin-deepseek] CAPYBARA_TEST_DEEPSEEK_API_KEY not set: live toolChoice none cache test skipped",
  );
}

const MODEL = "deepseek-flash";
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

describe.skipIf(!KEY)("live toolChoice none keeps the cache", { timeout: 180_000 }, () => {
  it(`${MODEL}: write, then a summary-shaped request with toolChoice none reads the cache`, async () => {
    const p = createDeepSeekProvider({ netFetch: recordingNet().netFetch, apiKey: KEY ?? "" });
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
      `[plugin-deepseek] live toolChoice none: turn ${JSON.stringify(r1.usage)}, summary ${JSON.stringify(r2.usage)}`,
    );
    expect(r2.usage.cacheReadTokens).toBeGreaterThanOrEqual(total(r1.usage) * 0.9);
  });
});
