import { defineExtension, type ModelCallRequestHookPayload } from "@capybara-hq/plugin-sdk";

/**
 * Test fixture: records every chat model request of the orgs that enable it (an observe
 * `model.request` hook) on `globalThis.__requestSpy`, so an in-process kernel test can read the
 * request a run sent to the model.
 */

export interface SpiedRequest {
  conversationId: string;
  system: string[];
  tools: string[];
}

export function spiedRequests(): SpiedRequest[] {
  const g = globalThis as { __requestSpy?: SpiedRequest[] };
  g.__requestSpy ??= [];
  return g.__requestSpy;
}

export default defineExtension({
  name: "request-spy",
  version: "0.1.0",
  sdk: "^0.1.0-rc.19",
  provides: [],
  permissions: { hooks: ["model.request"] },
  setup(ctx) {
    ctx.hooks.on(
      "model.request",
      (payload) => {
        if (payload.purpose === "embedding") return;
        const p = payload as ModelCallRequestHookPayload;
        spiedRequests().push({
          conversationId: p.conversationId,
          system: [
            ...p.request.system.map((s) => s.text),
            ...p.request.messages.flatMap((m) => (m.role === "system" ? [m.content] : [])),
          ],
          tools: p.request.tools.map((t) => t.name),
        });
      },
      { mode: "observe" },
    );
  },
});
