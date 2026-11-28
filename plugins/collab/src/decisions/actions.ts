import type { UiActionResult } from "@capybara-hq/plugin-sdk";
import {
  type AnswerPayload,
  gateNotifier,
  INBOX_ANSWER,
  resolveDecisionInbox,
} from "../decisions-queue.js";
import { answerDecision } from "../domain/decisions.js";
import { CollabError } from "../domain/errors.js";
import { emitting } from "../events/emitter.js";
import { agentAllowedFor } from "../tools/common.js";
import { type ActionDeps, registerAction } from "../ui/actions.js";

/** What the inbox answer needs of the UI action call: the org and the person who clicked. */
export interface AnswerCall {
  orgId: string;
  accountId: string;
  payload?: unknown;
}

function payloadOf(payload: unknown): AnswerPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.decisionId !== "string" || typeof p.optionId !== "string") return null;
  return { decisionId: p.decisionId, optionId: p.optionId };
}

/**
 * `inbox.answer`: a person answers a decision from an inbox button (the kernel calls it as the
 * person who clicked; at least once, so a repeated click answers nothing new). Emits the events
 * the answer owes and resolves the decision's other inbox items.
 */
export async function answerFromInbox(
  { ctx, db }: ActionDeps,
  call: AnswerCall,
): Promise<UiActionResult> {
  const payload = payloadOf(call.payload);
  if (!payload) {
    return { toast: { zh: "这个按钮已失效。", en: "This button is no longer valid." } };
  }
  const gates = gateNotifier(ctx, call.orgId);
  try {
    const out = await emitting(ctx, call.orgId, () =>
      answerDecision(
        db,
        call.orgId,
        call.accountId,
        payload.decisionId,
        {
          optionId: payload.optionId,
        },
        {
          agentAllowed: agentAllowedFor({ ctx, db }, call.orgId),
          onGateDecision: gates.onGateDecision,
        },
      ),
    );
    await gates.flush();
    await resolveDecisionInbox(ctx, call.orgId, out.decision);
    if (out.alreadyAnswered) {
      return { toast: { zh: "这个决策已经有答复了。", en: "This decision was already answered." } };
    }
    return { toast: { zh: "已答复。", en: "Answered." } };
  } catch (error) {
    if (error instanceof CollabError) {
      const zh =
        error.code === "forbidden"
          ? "只有被询问的人可以答复这个决策。"
          : error.code === "not_found"
            ? "找不到这个决策。"
            : "无法答复，请在事项页面查看。";
      return { toast: { zh, en: `Not answered: ${error.message}` } };
    }
    throw error;
  }
}

registerAction(INBOX_ANSWER, answerFromInbox);
