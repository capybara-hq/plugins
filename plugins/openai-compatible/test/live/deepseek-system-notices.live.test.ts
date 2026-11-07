import type { ModelMessage, ModelRequest, ModelStreamEvent } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { createOpenAICompatibleProvider } from "../../src/index.js";

// Pins that mid-conversation system notices (sub-agent deliveries, background task notices) stay
// in position on DeepSeek. Sent as in-place role system messages, deepseek-v4-pro does not see
// them after its own "Got A. Waiting for B." turn (it answers NOTHING: 0/6 runs right, 2026-11-07,
// thinking on and off); as `[system] ` user turns it quotes both B notices (6/6). The question
// does not ask for "the message right before" this one: the API appears to join consecutive user
// messages, so the notices and the question read as one turn. Runs only against a deepseek
// endpoint: CAPYBARA_TEST_OAICOMPAT_BASE_URL / _API_KEY / _MODEL with _DIALECT=deepseek.
const LIVE = {
  baseUrl: process.env.CAPYBARA_TEST_OAICOMPAT_BASE_URL,
  apiKey: process.env.CAPYBARA_TEST_OAICOMPAT_API_KEY,
  model: process.env.CAPYBARA_TEST_OAICOMPAT_MODEL,
  dialect: process.env.CAPYBARA_TEST_OAICOMPAT_DIALECT,
};
const ready = Boolean(LIVE.baseUrl && LIVE.apiKey && LIVE.model && LIVE.dialect === "deepseek");
if (!ready) {
  console.info(
    "[plugin-openai-compatible] CAPYBARA_TEST_OAICOMPAT_* not set for a deepseek endpoint: live system notice position test skipped",
  );
}

const text = (t: string) => [{ type: "text" as const, text: t }];

const history: ModelMessage[] = [
  {
    role: "user",
    content: text("Start sub-agents A and B, and tell me when both have reported back."),
  },
  { role: "assistant", content: text("Both sub-agents are running. Waiting for their reports.") },
  { role: "system", content: "Sub-agent A reported: the database migration plan is ready." },
  { role: "assistant", content: text("Got A. Waiting for B.") },
  { role: "system", content: "Sub-agent B reported: the API review found two issues." },
  { role: "system", content: "Sub-agent B completed with status success." },
  {
    role: "user",
    content: text(
      'Quote exactly every message that came after your message "Got A. Waiting for B.", excluding this question. If there are none, reply NOTHING.',
    ),
  },
];

describe.skipIf(!ready)(
  "live deepseek: mid-conversation system notices",
  { timeout: 120_000 },
  () => {
    // Built lazily: the describe body runs at collection even when skipped, and the SDK client
    // refuses an empty base URL.
    const provider = () =>
      createOpenAICompatibleProvider({
        endpoints: [
          {
            name: "live",
            baseUrl: LIVE.baseUrl ?? "",
            dialect: "deepseek",
            models: [
              {
                id: LIVE.model ?? "",
                contextWindow: 128_000,
                maxOutputTokens: 8192,
                reasoning: true,
              },
            ],
          },
        ],
        apiKeys: { live: LIVE.apiKey ?? "" },
      });

    // With tools declared, thinking-mode history turns carry reasoning_content (an empty placeholder
    // here) and the request has consecutive user messages; the API must accept both.
    it.each(["on", "off"])("keeps the notices in position (thinking %s)", async (thinking) => {
      const req: ModelRequest = {
        model: `live/${LIVE.model}`,
        system: [{ text: "You are a helpful assistant. Be brief.", cache: false }],
        messages: history,
        tools: [
          {
            name: "Agent",
            description: "Start a sub-agent.",
            inputSchema: { type: "object", properties: { task: { type: "string" } } },
          },
        ],
        toolChoice: "none",
        maxOutputTokens: 4000,
        params: { thinking },
      };
      const events: ModelStreamEvent[] = [];
      for await (const e of provider().stream(req, { signal: new AbortController().signal })) {
        events.push(e);
      }
      const done = events.at(-1);
      if (done?.type !== "message_complete") throw new Error("expected message_complete last");
      const answer = done.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      expect(answer).toContain("Sub-agent B reported");
      expect(answer).toContain("Sub-agent B completed");
    });
  },
);
