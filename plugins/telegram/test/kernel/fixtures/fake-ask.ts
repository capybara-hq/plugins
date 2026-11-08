import { defineExtension, type ToolSpec } from "@capybara-hq/plugin-sdk";

/**
 * Test fixture: a tool that asks one single-select question (no "other" answer, so channels can
 * render the options as buttons), then returns the picked option. The builtin AskUserQuestion
 * always allows "other", which keeps its options off the card.
 */
const PICK: ToolSpec = {
  name: "pick",
  description: "Ask the user to pick a deploy target, then return it. Test fixture only.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  defaultPolicy: "allow",
};

export default defineExtension({
  name: "fake-ask",
  version: "0.1.0",
  sdk: "^0.1.0-rc.4",
  provides: [],
  permissions: { tools: ["pick"] },
  setup(ctx) {
    ctx.tools.register(PICK, async (_input, tctx) => {
      if (!tctx.resume) {
        return {
          kind: "input_required",
          form: {
            title: "Deploy target",
            fields: [
              {
                key: "target",
                label: "Target",
                schema: { type: "string", enum: ["staging", "production"] },
              },
            ],
          },
        };
      }
      const picked = tctx.resume.answer?.target;
      return { content: [{ type: "text", text: `Picked ${String(picked ?? "nothing")}` }] };
    });
  },
});
