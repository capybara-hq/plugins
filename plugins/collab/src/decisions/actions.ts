import type { UiActionResult } from "@capybara-hq/plugin-sdk";
import { decisionHooks, INBOX_ANSWER } from "../decisions-queue.js";
import { type AnswerResult, answerDecision, type DecisionAnswer } from "../domain/decisions.js";
import { ARCHIVED_TOAST, CollabError } from "../domain/errors.js";
import { invalidateItems, notifying } from "../notify.js";
import { agentAllowedFor } from "../tools/common.js";
import { type ActionDeps, payloadFields, registerAction } from "../ui/actions.js";

/** What the inbox answer needs of the UI action call: the org and the person who clicked. */
export interface AnswerCall {
  orgId: string;
  accountId: string;
  payload?: unknown;
}

/** An option id as decisions store them (see `OPTION_ID` in the domain). */
const OPTION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
/** A concurrent change of the item is retried this many times before the person is told. */
const ATTEMPTS = 2;

type Toast = { toast: { zh: string; en: string } };
const toast = (zh: string, en: string): Toast => ({ toast: { zh, en } });

/** What a person reads after a click: never the model-facing domain text. */
function outcomeToast(out: AnswerResult): Toast {
  if (out.outcome === "answered") return toast("已答复。", "Answered.");
  if (out.outcome === "archived") return { toast: { ...ARCHIVED_TOAST } };
  if (out.outcome === "disallowed") {
    return toast(
      "工作流已更改，这一步已不再允许，确认请求已取消。",
      "The workflow changed and this move is no longer allowed; the request was canceled.",
    );
  }
  if (out.outcome === "superseded" || out.decision.state === "canceled") {
    return toast("事项已进入其他状态。", "The item moved on.");
  }
  if (out.decision.state === "expired") return toast("这个决策已过期。", "This decision expired.");
  return toast("这个决策已经有答复了。", "This decision was already answered.");
}

async function refusalToast(
  { db }: ActionDeps,
  orgId: string,
  decisionId: string,
  error: CollabError,
): Promise<Toast> {
  switch (error.code) {
    case "forbidden": {
      const row = await db
        .selectFrom("decisions")
        .select("kind")
        .where("org_id", "=", orgId)
        .where("id", "=", decisionId)
        .executeTakeFirst();
      return row?.kind === "gate"
        ? toast("只有确认人可以处理这个确认请求。", "Only its confirmer can answer this request.")
        : toast(
            "只有被询问的人可以答复这个决策。",
            "Only the person asked can answer this decision.",
          );
    }
    case "not_found":
      return toast("找不到这个决策。", "This decision no longer exists.");
    case "version_conflict":
      return toast("事项刚被修改，请重试。", "The item changed at the same moment. Try again.");
    case "gated":
    case "invalid_transition":
      return toast(
        "无法移动事项，请在事项页面处理。",
        "The item could not be moved. Open it on its page.",
      );
    case "archived":
      return { toast: { ...ARCHIVED_TOAST } };
    case "invalid_input":
      return toast(
        "请选择一个选项，或写下答复（最多 2000 字）。",
        "Pick one of the options, or write an answer (at most 2000 characters).",
      );
    default:
      return toast("无法答复，请在事项页面查看。", "Could not answer. Open the item's page.");
  }
}

/**
 * A person answers a decision (inbox buttons and the item pages): emits the events the answer
 * owes and resolves the decision's inbox items (queued in the write as well). A concurrent change
 * of the item is retried once; every outcome and refusal is a zh/en toast written for people.
 */
export async function answerAsPerson(
  { ctx, db }: ActionDeps,
  call: { orgId: string; accountId: string },
  decisionId: string,
  answer: DecisionAnswer,
  /** Page actions answer success with no toast (a toast means refusal); inbox buttons keep it. */
  opts: { quietSuccess?: boolean } = {},
): Promise<UiActionResult> {
  for (let attempt = 1; ; attempt++) {
    const follow = decisionHooks(ctx, call.orgId);
    try {
      const out = await notifying(ctx, call.orgId, () =>
        answerDecision(db, call.orgId, call.accountId, decisionId, answer, {
          agentAllowed: agentAllowedFor({ ctx, db }, call.orgId),
          decisions: follow.hooks,
        }),
      );
      await follow.flush();
      if (out.outcome !== "closed") await invalidateItems(ctx, call.orgId);
      if (opts.quietSuccess && out.outcome === "answered") return {};
      return outcomeToast(out);
    } catch (error) {
      if (!(error instanceof CollabError)) throw error;
      if (error.code === "version_conflict" && attempt < ATTEMPTS) continue;
      return refusalToast({ ctx, db }, call.orgId, decisionId, error);
    }
  }
}

/**
 * `inbox.answer`: a person answers a decision from an inbox button (the kernel calls it as the
 * person who clicked; at least once, so a repeated click answers nothing new).
 */
async function answerFromInbox(deps: ActionDeps, call: AnswerCall): Promise<UiActionResult> {
  const { decisionId, optionId } = payloadFields(call.payload, {
    decisionId: "uuid",
    optionId: "id",
  });
  if (!OPTION_ID.test(optionId))
    return toast("这个按钮已失效。", "This button is no longer valid.");
  return answerAsPerson(deps, call, decisionId, { optionId });
}

registerAction(INBOX_ANSWER, answerFromInbox);
