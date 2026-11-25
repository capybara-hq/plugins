// browser_handoff (browser use spec §9): the agent asks the person to do something in the browser
// (sign in, solve a challenge). The kernel shows the question card in the conversation and opens
// the browser panel on the person's conversation page (`InputRequired.open`), and the daemon's
// handoff notice gives every open panel a banner with 完成 / 取消 that answers it through
// /ui/handoff-answer. The wait is the kernel's resumable InputRequired.
import {
  type InputRequired,
  ToolError,
  type ToolHandler,
  type ToolSpec,
} from "@capybara-hq/plugin-sdk";
import { HANDOFF_MAX_CHARS } from "../daemon/protocol.js";
import { assertOwner, type BrowserDeps, runRequest, toResult } from "./browser.js";
import { HANDOFF_FORM } from "./i18n.js";

/** The browser panel (the `conversation.panel` contribution in the manifest). */
const PANEL = "browser";

/** The longest handoff message (the question card's title and the panel banner). */
const MESSAGE_MAX = Math.min(2000, HANDOFF_MAX_CHARS);

const HANDOFF: ToolSpec = {
  name: "browser_handoff",
  title: "Hand the browser to the user",
  description:
    "Ask the user to do something in the browser themselves, such as signing in, entering a " +
    "one-time code or solving a CAPTCHA, and wait until they hand it back. The message tells " +
    "them what to do; they answer Done or Cancel. Returns the page state afterwards. Use it " +
    "when a step needs the user's credentials or judgment; never ask for passwords in the chat.",
  inputSchema: {
    type: "object",
    properties: {
      message: {
        type: "string",
        maxLength: MESSAGE_MAX,
        description: 'What the user should do, e.g. "Please sign in to your GitHub account."',
      },
    },
    required: ["message"],
    additionalProperties: false,
  },
  keyArgs: ["message"],
  defaultPolicy: "allow",
};

/** The handler of browser_handoff. */
export function handoffHandler(deps: BrowserDeps): ToolHandler {
  return async (input, call) => {
    const raw = (input as { message?: unknown } | null)?.message;
    if (typeof raw !== "string" || raw.trim() === "")
      throw new ToolError("browser_handoff needs a message for the user; pass one and retry.");
    const message = raw.slice(0, MESSAGE_MAX);
    if (call.resume === undefined) {
      // the notice also starts the service, so the panel has a browser to show
      await runRequest(deps, call, { op: "handoff_notice", callId: call.callId, message });
      const asked: InputRequired = {
        kind: "input_required",
        form: {
          title: message,
          fields: [
            {
              key: "done",
              label: HANDOFF_FORM.label,
              description: HANDOFF_FORM.description,
              schema: { type: "boolean" },
              required: true,
            },
          ],
        },
        state: { handoff: 1 },
        // the person's conversation page opens the panel, where they do it
        open: { contribution: PANEL },
      };
      return asked;
    }
    // the banner goes either way; a failed clear never hides the person's answer (a device that
    // is gone fails the snapshot below with its own error)
    assertOwner(call);
    const answer = call.resume.answer;
    const done = answer !== null && answer.done === true;
    // Done also hands the browser back: a takeover the person still holds would refuse the
    // snapshot below (and Done means they are finished with the browser)
    await runRequest(deps, call, {
      op: "handoff_clear",
      callId: call.callId,
      ...(done ? { handback: true } : {}),
    }).catch((e: unknown) => {
      if (!(e instanceof ToolError)) throw e;
    });
    if (!done)
      throw new ToolError(
        "The user cancelled the handoff; ask the user how to continue, or try another approach.",
      );
    return toResult(await runRequest(deps, call, { op: "snapshot" }));
  };
}

/** Registers browser_handoff. */
export function registerHandoffTool(
  ctx: { tools: { register(spec: ToolSpec, handler: ToolHandler): void } },
  deps: BrowserDeps,
): void {
  ctx.tools.register(HANDOFF, handoffHandler(deps));
}
