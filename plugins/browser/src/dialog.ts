// browser_dialog (dialogs spec §5): answers one pending page dialog by its id and quoted message,
// so an approval covers exactly the dialog it shows and an approval given later never answers a
// newer one. The daemon verifies both; an HTTP sign-in is never answered here (only the person
// types credentials, in the panel).
import type { ToolHandler, ToolSpec } from "@capybara-hq/plugin-sdk";
import { DIALOG_QUOTE_CHARS } from "../daemon/protocol.js";
import { type BrowserDeps, runRequest, TOOL_TIMEOUT_MS, toResult } from "./browser.js";

const DIALOG: ToolSpec = {
  name: "browser_dialog",
  title: "Answer a page dialog",
  description:
    "Answer the dialog a page shows (a confirm, a prompt, or a leave-page question): pass the " +
    "dialogId and the message exactly as a browser tool result quoted them, and accept or " +
    "dismiss. Accepting can delete, pay or leave unsaved changes, so dismiss when unsure. For a " +
    "prompt, text is the answer to type (accept without text takes the default value). An HTTP " +
    "sign-in request can only be dismissed here: call browser_handoff so the user signs in, and " +
    "never ask for passwords in the chat.",
  inputSchema: {
    type: "object",
    properties: {
      dialogId: {
        type: "string",
        description: 'The dialog id from the tool result, e.g. "d3".',
      },
      message: {
        type: "string",
        maxLength: DIALOG_QUOTE_CHARS + 50,
        description: "The dialog's message exactly as the tool result quoted it.",
      },
      action: {
        type: "string",
        enum: ["accept", "dismiss"],
        description: "accept (OK, leave) or dismiss (Cancel, stay).",
      },
      text: { type: "string", description: "For a prompt: the text to answer with." },
    },
    required: ["dialogId", "message", "action"],
    additionalProperties: false,
  },
  keyArgs: ["action", "message", "text"],
  defaultPolicy: "ask",
  // any tool may start the device first (see TOOL_TIMEOUT_MS)
  timeoutMs: TOOL_TIMEOUT_MS,
};

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Registers browser_dialog. */
export function registerDialogTool(
  ctx: { tools: { register(spec: ToolSpec, handler: ToolHandler): void } },
  deps: BrowserDeps,
): void {
  ctx.tools.register(DIALOG, async (input, call) => {
    const i = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
    const text = str(i.text);
    return toResult(
      await runRequest(deps, call, {
        op: "dialog",
        dialogId: str(i.dialogId) ?? "",
        message: str(i.message) ?? "",
        action: i.action === "accept" ? "accept" : "dismiss",
        ...(text === undefined ? {} : { text }),
      }),
    );
  });
}
