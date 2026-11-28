import type { UiActionResult, UiOrgActionArgs } from "@capybara-hq/plugin-sdk";
import { answerAsPerson } from "../decisions/actions.js";
import { decisionHooks } from "../decisions-queue.js";
import { isArchived, requireRole } from "../domain/access.js";
import { assign, assignIn } from "../domain/assignment.js";
import { type DecisionHooks, readdressOpen } from "../domain/decision-state.js";
import {
  answerersOf,
  cancelOpenDecisionsOfProject,
  GATE_APPROVE,
  GATE_REJECT,
} from "../domain/decisions.js";
import { ARCHIVED_TOAST, CollabError, type CollabErrorCode } from "../domain/errors.js";
import { comment, createItem, transition, updateItemIn } from "../domain/items.js";
import { addMember, createProject, removeMember, setFunction } from "../domain/projects.js";
import type { DefaultAssignmentRule, GateRule } from "../domain/workflow.js";
import { invalidateItems, notifying } from "../notify.js";
import type { ProjectRole } from "../store/types.js";
import { agentAllowedFor } from "../tools/common.js";
import {
  type ActionDeps,
  ActionPayloadError,
  payloadFields,
  registerAction,
} from "../ui/actions.js";
import { ITEM_QUERIES, type LocalText, type QueryName } from "./contract.js";

type Toast = { zh: string; en: string };
const text = (zh: string, en: string): Toast => ({ zh, en });

// capybara:allow-module-state read-only constant (results get copies)
const ITEMS: readonly QueryName[] = ITEM_QUERIES;
// capybara:allow-module-state read-only constant (results get copies)
const PROJECT_QUERIES: readonly QueryName[] = [
  "projects.list",
  "project.settings",
  ...ITEM_QUERIES,
];

/** What a person reads for each domain refusal (never the model-facing domain text). */
// capybara:allow-module-state read-only constant
const REFUSALS: Readonly<Record<CollabErrorCode, Toast>> = {
  not_found: text(
    "找不到这个项目或事项，可能已被删除，或你不是项目成员。",
    "This project or item does not exist, or you are not a member of its project.",
  ),
  forbidden: text("你没有权限执行这个操作。", "You are not allowed to do this."),
  invalid_input: text(
    "输入无效，请检查后重试。",
    "The input is not valid. Check it and try again.",
  ),
  version_conflict: text(
    "事项刚被其他人修改，已刷新，请再试一次。",
    "Someone changed the item at the same moment. It was refreshed; try again.",
  ),
  invalid_transition: text(
    "不能从当前状态移到这个状态。",
    "The item cannot move from its current status to this one.",
  ),
  gated: text("进入这个状态需要确认人确认。", "Entering this status needs its confirmer."),
  invalid_assignee: text(
    "负责人必须是项目的所有者或成员。",
    "The responsible person must be an owner or member of the project.",
  ),
  no_longer_assigned: text("你已不再负责这个事项。", "You no longer work on this item."),
  archived: ARCHIVED_TOAST,
};

/** Refusals an action words its own way. */
type Overrides = Partial<Record<CollabErrorCode, Toast>>;

function refusal(
  error: CollabError,
  overrides: Overrides = {},
  invalidate: readonly QueryName[] = ITEMS,
): UiActionResult {
  const toast = overrides[error.code] ?? REFUSALS[error.code];
  // Whatever refused, the page refetches: what it shows may be what made the action fail.
  return { toast, invalidate: [...invalidate] };
}

/** Runs an action body; a domain refusal becomes a toast. */
async function refusing(
  body: () => Promise<UiActionResult>,
  overrides: Overrides = {},
  invalidate: readonly QueryName[] = ITEMS,
): Promise<UiActionResult> {
  try {
    const out = await body();
    // A toast is a refusal: the page refetches what it shows.
    return "toast" in out && out.toast && !out.invalidate
      ? { ...out, invalidate: [...invalidate] }
      : out;
  } catch (error) {
    if (error instanceof CollabError) return refusal(error, overrides, invalidate);
    throw error;
  }
}

/** {@link refusing} for the project settings and member actions (their queries refetch). */
function refusingProject(
  body: () => Promise<UiActionResult>,
  overrides: Overrides = {},
): Promise<UiActionResult> {
  return refusing(body, overrides, PROJECT_QUERIES);
}

/**
 * A UI write as the clicking person: the decision jobs it owes are queued inside it, its events
 * and assignment notices go out after the commit (`notifying`), then the decision follow-ups run
 * (`flush`) and the open pages of the org refresh.
 */
async function writing<T>(
  deps: ActionDeps,
  orgId: string,
  write: (hooks: DecisionHooks) => Promise<T>,
): Promise<T> {
  const follow = decisionHooks(deps.ctx, orgId);
  const out = await notifying(deps.ctx, orgId, () => write(follow.hooks));
  await follow.flush();
  await invalidateItems(deps.ctx, orgId);
  return out;
}

// --- payload reading -----------------------------------------------------------------------

type Payload = Record<string, unknown>;

function objectOf(payload: unknown): Payload {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new ActionPayloadError("the payload must be an object");
  }
  return payload as Payload;
}

function reqString(p: Payload, name: string, max: number): string {
  const v = p[name];
  if (typeof v !== "string" || v.length > max) {
    throw new ActionPayloadError(`${name} is missing or too long`);
  }
  return v;
}

function optString(p: Payload, name: string, max: number): string | undefined {
  return p[name] === undefined ? undefined : reqString(p, name, max);
}

/** A string, null (clear) or undefined (keep). */
function nullableString(p: Payload, name: string, max: number): string | null | undefined {
  return p[name] === null ? null : optString(p, name, max);
}

function reqVersion(p: Payload): number {
  const v = p.version;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw new ActionPayloadError("version is missing or malformed");
  }
  return v;
}

function optPriority(p: Payload): number | undefined {
  const v = p.priority;
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 4) {
    throw new ActionPayloadError("priority must be 0 to 4");
  }
  return v;
}

function optLabels(p: Payload): string[] | undefined {
  const v = p.labels;
  if (v === undefined) return undefined;
  if (
    !Array.isArray(v) ||
    v.length > 50 ||
    v.some((l) => typeof l !== "string" || l.length > 200)
  ) {
    throw new ActionPayloadError("labels must be a list of strings");
  }
  return v as string[];
}

function optBool(p: Payload, name: string): boolean | undefined {
  const v = p[name];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw new ActionPayloadError(`${name} must be a boolean`);
  return v;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPTION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
// capybara:allow-module-state read-only constant
const ROLES: readonly ProjectRole[] = ["owner", "member", "guest"];
/** Long enough for any kernel id (accounts, agents). */
const ID_MAX = 256;

function optUuid(p: Payload, name: string): string | undefined {
  const v = p[name];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !UUID.test(v)) throw new ActionPayloadError(`${name} is malformed`);
  return v;
}

// --- shared checks -------------------------------------------------------------------------

const AGENT_REFUSED = text(
  "负责人不能使用这个智能体，请选择负责人可用的智能体。",
  "The responsible person cannot use this agent. Pick one of the agents they may use.",
);

async function agentUsable(
  deps: ActionDeps,
  orgId: string,
  accountId: string,
  agentId: string,
): Promise<boolean> {
  return agentAllowedFor(deps, orgId)(accountId, agentId);
}

/** The viewer's write access to an item's project, checked before any kernel lookup. */
async function requireItemWrite(
  deps: ActionDeps,
  orgId: string,
  accountId: string,
  itemId: string,
) {
  const item = await deps.db
    .selectFrom("items")
    .select("project_id")
    .where("org_id", "=", orgId)
    .where("id", "=", itemId)
    .executeTakeFirst();
  if (!item) throw new CollabError("not_found", "Item not found.");
  await requireRole(deps.db, orgId, accountId, item.project_id, "write");
}

/** Display names of accounts joined for a toast ("、" in zh, ", " in en). */
async function namesFor(
  deps: ActionDeps,
  orgId: string,
  accountIds: string[],
): Promise<{ zh: string; en: string }> {
  const names: string[] = [];
  for (const id of accountIds) names.push(await personName(deps, orgId, id));
  return { zh: names.join("、"), en: names.join(", ") };
}

async function statusName(
  deps: ActionDeps,
  orgId: string,
  itemId: string,
  key: string,
): Promise<LocalText> {
  const row = await deps.db
    .selectFrom("items as i")
    .innerJoin("item_types as t", (j) =>
      j.onRef("t.project_id", "=", "i.project_id").onRef("t.key", "=", "i.type"),
    )
    .innerJoin("statuses as s", "s.workflow_id", "t.workflow_id")
    .select(["s.name_zh", "s.name_en"])
    .where("i.org_id", "=", orgId)
    .where("i.id", "=", itemId)
    .where("s.key", "=", key)
    .executeTakeFirst();
  return row ? { zh: row.name_zh, en: row.name_en } : { zh: key, en: key };
}

async function personName(deps: ActionDeps, orgId: string, accountId: string): Promise<string> {
  try {
    const [p] = await deps.ctx.people.get({ orgId, accountIds: [accountId] });
    return p?.name ?? accountId;
  } catch {
    return accountId;
  }
}

// --- actions -------------------------------------------------------------------------------

/** `project.create`: the clicking person owns the new project. */
async function projectCreate(deps: ActionDeps, args: UiOrgActionArgs): Promise<UiActionResult> {
  const p = objectOf(args.payload);
  const key = reqString(p, "key", 10);
  const name = reqString(p, "name", 200);
  const description = optString(p, "description", 10_000);
  if (args.role === "guest") return { toast: REFUSALS.forbidden };
  return refusing(
    async () => {
      // Success answers only `invalidate` (a toast means refusal); the client knows the key.
      await createProject(
        deps.db,
        args.orgId,
        { accountId: args.accountId },
        { key, name, ...(description !== undefined ? { description } : {}) },
      );
      return { invalidate: ["projects.list"] };
    },
    {
      invalid_input: text(
        "项目标识须为 2–10 位大写字母或数字、以字母开头且未被使用，名称不能为空。",
        "The key must be 2–10 upper-case letters or digits, start with a letter and be unused; the name must not be empty.",
      ),
    },
  );
}

const ITEM_INPUT = text(
  "请检查标题（1–200 字）、描述、标签和父事项。",
  "Check the title (1–200 characters), description, labels and parent.",
);

/** `item.create`: the agent must be one the responsible person may use. */
async function itemCreate(deps: ActionDeps, args: UiOrgActionArgs): Promise<UiActionResult> {
  const p = objectOf(args.payload);
  const { projectId } = payloadFields(p, { projectId: "uuid" });
  const type = reqString(p, "type", 64);
  const title = reqString(p, "title", 1000);
  const description = optString(p, "description", 60_000);
  const parentId = optUuid(p, "parentId");
  const responsible = optString(p, "responsibleAccountId", ID_MAX);
  const agentId = optString(p, "agentId", ID_MAX);
  const priority = optPriority(p);
  const labels = optLabels(p);
  return refusing(
    async () => {
      await requireRole(deps.db, args.orgId, args.accountId, projectId, "write");
      if (agentId && !responsible) {
        return {
          toast: text(
            "选择智能体前请先选择负责人。",
            "Pick the responsible person before an agent.",
          ),
        };
      }
      if (responsible && agentId && !(await agentUsable(deps, args.orgId, responsible, agentId))) {
        return { toast: AGENT_REFUSED };
      }
      await writing(deps, args.orgId, (hooks) =>
        createItem(
          deps.db,
          args.orgId,
          { accountId: args.accountId },
          {
            projectId,
            type,
            title,
            ...(description !== undefined ? { description } : {}),
            ...(parentId ? { parentId } : {}),
            ...(responsible ? { responsibleAccountId: responsible } : {}),
            ...(agentId ? { executingAgentId: agentId } : {}),
            ...(priority !== undefined ? { priority } : {}),
            ...(labels ? { labels } : {}),
          },
          { agentAllowed: agentAllowedFor(deps, args.orgId), decisions: hooks },
        ),
      );
      return { invalidate: [...ITEMS] };
    },
    { invalid_input: ITEM_INPUT },
  );
}

/**
 * `item.update`: the item's own fields at the version the person saw, then (with
 * `responsibleAccountId`) the assignment at the version the update returned.
 */
async function itemUpdate(deps: ActionDeps, args: UiOrgActionArgs): Promise<UiActionResult> {
  const p = objectOf(args.payload);
  const { itemId } = payloadFields(p, { itemId: "uuid" });
  const version = reqVersion(p);
  const title = optString(p, "title", 1000);
  const description = optString(p, "description", 60_000);
  const priority = optPriority(p);
  const labels = optLabels(p);
  const parentId = p.parentId === null ? null : optUuid(p, "parentId");
  const responsible = optString(p, "responsibleAccountId", ID_MAX);
  const agentId = p.agentId === null ? null : optString(p, "agentId", ID_MAX);
  if (agentId !== undefined && responsible === undefined) {
    throw new ActionPayloadError("agentId needs responsibleAccountId");
  }
  return refusing(
    async () => {
      await requireItemWrite(deps, args.orgId, args.accountId, itemId);
      if (responsible && agentId && !(await agentUsable(deps, args.orgId, responsible, agentId))) {
        return { toast: AGENT_REFUSED, invalidate: [...ITEMS] };
      }
      // One transaction: a refused assignment leaves the fields unsaved too.
      await writing(deps, args.orgId, (hooks) =>
        deps.db.transaction().execute(async (tx) => {
          const actor = { accountId: args.accountId };
          const updated = await updateItemIn(tx, args.orgId, actor, itemId, version, {
            ...(title !== undefined ? { title } : {}),
            ...(description !== undefined ? { description } : {}),
            ...(priority !== undefined ? { priority } : {}),
            ...(labels !== undefined ? { labels } : {}),
            ...(parentId !== undefined ? { parentId } : {}),
          });
          if (responsible === undefined) return updated;
          // The assignment follows at whatever version the update left (no client arithmetic).
          return assignIn(
            tx,
            args.orgId,
            actor,
            itemId,
            updated.version,
            { responsibleAccountId: responsible, executingAgentId: agentId ?? null },
            hooks,
          );
        }),
      );
      return { invalidate: [...ITEMS] };
    },
    { invalid_input: ITEM_INPUT },
  );
}

/**
 * `item.move`: a drop on another column. Into a gated column the confirmer's drop moves the
 * item; anyone else's asks the confirmer (a gate decision) and the item stays.
 */
async function itemMove(deps: ActionDeps, args: UiOrgActionArgs): Promise<UiActionResult> {
  const p = objectOf(args.payload);
  const { itemId } = payloadFields(p, { itemId: "uuid" });
  const version = reqVersion(p);
  const to = reqString(p, "to", 64);
  return refusing(async () => {
    const out = await writing(deps, args.orgId, (hooks) =>
      transition(deps.db, args.orgId, { accountId: args.accountId }, itemId, version, to, {
        agentAllowed: agentAllowedFor(deps, args.orgId),
        decisions: hooks,
        requestGate: true,
      }),
    );
    if ("item" in out) return { invalidate: [...ITEMS] };
    const name = await statusName(deps, args.orgId, itemId, to);
    const item = await deps.db
      .selectFrom("items")
      .selectAll()
      .where("org_id", "=", args.orgId)
      .where("id", "=", itemId)
      .executeTakeFirstOrThrow();
    const confirmers = await answerersOf(deps.db, args.orgId, out.gate, item);
    const names = await namesFor(deps, args.orgId, confirmers);
    return {
      toast: text(
        `移到「${name.zh}」需要确认，已请 ${names.zh} 确认。`,
        `Moving to "${name.en}" needs confirmation; asked ${names.en}.`,
      ),
      invalidate: [...ITEMS],
    };
  });
}

/** `item.assign`: the clicking person is the consent; the agent must be usable by the person. */
async function itemAssign(deps: ActionDeps, args: UiOrgActionArgs): Promise<UiActionResult> {
  const p = objectOf(args.payload);
  const { itemId, responsibleAccountId } = payloadFields(p, {
    itemId: "uuid",
    responsibleAccountId: "id",
  });
  const version = reqVersion(p);
  const agentId = p.agentId === null ? null : reqString(p, "agentId", ID_MAX);
  return refusing(async () => {
    await requireItemWrite(deps, args.orgId, args.accountId, itemId);
    if (agentId && !(await agentUsable(deps, args.orgId, responsibleAccountId, agentId))) {
      return { toast: AGENT_REFUSED };
    }
    await writing(deps, args.orgId, (hooks) =>
      assign(
        deps.db,
        args.orgId,
        { accountId: args.accountId },
        itemId,
        version,
        { responsibleAccountId, executingAgentId: agentId },
        hooks,
      ),
    );
    return { invalidate: [...ITEMS] };
  });
}

/** `item.comment`. */
async function itemComment(deps: ActionDeps, args: UiOrgActionArgs): Promise<UiActionResult> {
  const p = objectOf(args.payload);
  const { itemId } = payloadFields(p, { itemId: "uuid" });
  const body = reqString(p, "body", 20_000);
  return refusing(
    async () => {
      await writing(deps, args.orgId, () =>
        comment(deps.db, args.orgId, { accountId: args.accountId }, itemId, body),
      );
      return { invalidate: ["item.activity", "item.detail"] };
    },
    {
      invalid_input: text(
        "评论不能为空，最多 20000 字。",
        "A comment must not be empty and at most 20000 characters.",
      ),
    },
  );
}

/** `gate.confirm`: answers the gate decision (approve moves the item; confirmers only). */
async function gateConfirm(deps: ActionDeps, args: UiOrgActionArgs): Promise<UiActionResult> {
  const p = objectOf(args.payload);
  const { decisionId } = payloadFields(p, { decisionId: "uuid" });
  const approve = optBool(p, "approve");
  if (approve === undefined) throw new ActionPayloadError("approve is missing");
  const row = await deps.db
    .selectFrom("decisions")
    .select("kind")
    .where("org_id", "=", args.orgId)
    .where("id", "=", decisionId)
    .executeTakeFirst();
  if (row?.kind !== "gate") {
    return {
      toast: text("找不到这个确认请求。", "This confirmation request does not exist."),
      invalidate: [...ITEMS],
    };
  }
  const out = await answerAsPerson(
    deps,
    args,
    decisionId,
    {
      optionId: approve ? GATE_APPROVE : GATE_REJECT,
    },
    { quietSuccess: true },
  );
  return { ...out, invalidate: [...ITEMS] };
}

/** `decision.answer`: an option, free text or both (the addressee only). */
async function decisionAnswer(deps: ActionDeps, args: UiOrgActionArgs): Promise<UiActionResult> {
  const p = objectOf(args.payload);
  const { decisionId } = payloadFields(p, { decisionId: "uuid" });
  const optionId = optString(p, "optionId", 32);
  if (optionId !== undefined && !OPTION_ID.test(optionId)) {
    throw new ActionPayloadError("optionId is malformed");
  }
  const answerText = optString(p, "text", 4000);
  const out = await answerAsPerson(
    deps,
    args,
    decisionId,
    {
      ...(optionId !== undefined ? { optionId } : {}),
      ...(answerText !== undefined ? { text: answerText } : {}),
    },
    { quietSuccess: true },
  );
  return { ...out, invalidate: [...ITEMS] };
}

// capybara:allow-module-state read-only constant
const GATE_RULES: ReadonlySet<string> = new Set([
  "requester",
  "responsible",
  "owner",
  "member",
  "function",
]);

function gateRuleOf(v: unknown): GateRule | null {
  if (v === null) return null;
  const o = objectOf(v);
  const confirmer = o.confirmer;
  if (typeof confirmer !== "string" || !GATE_RULES.has(confirmer)) {
    throw new ActionPayloadError("gate.confirmer is not valid");
  }
  if (confirmer === "member") return { confirmer, accountId: reqString(o, "accountId", ID_MAX) };
  if (confirmer === "function") {
    const label = reqString(o, "functionLabel", 50).trim();
    if (!label) throw new ActionPayloadError("gate.functionLabel is empty");
    return { confirmer, functionLabel: label };
  }
  return { confirmer } as GateRule;
}

function assignmentRuleOf(v: unknown): DefaultAssignmentRule | null {
  if (v === null) return null;
  const o = objectOf(v);
  const accountId = optString(o, "accountId", ID_MAX);
  const functionLabel = optString(o, "functionLabel", 50)?.trim();
  const agentId = optString(o, "agentId", ID_MAX);
  const memberAgent = optBool(o, "memberAgent");
  if (!accountId && !functionLabel) {
    throw new ActionPayloadError("defaultAssignment needs accountId or functionLabel");
  }
  return {
    ...(accountId ? { accountId } : { functionLabel: functionLabel as string }),
    ...(agentId ? { agentId } : {}),
    ...(memberAgent ? { memberAgent } : {}),
  };
}

/** The project's active (non-guest) members, by account id, with their function labels. */
async function activeMembers(deps: ActionDeps, orgId: string, projectId: string) {
  const rows = await deps.db
    .selectFrom("project_members")
    .select(["account_id", "function_label"])
    .where("org_id", "=", orgId)
    .where("project_id", "=", projectId)
    .where("role", "!=", "guest")
    .execute();
  return new Map(rows.map((r) => [r.account_id, r.function_label]));
}

/** A rule's JSON with sorted keys (jsonb reorders keys, the action builds them its own way). */
function ruleKey(rule: unknown): string {
  if (rule === null || rule === undefined) return "null";
  const o = rule as Record<string, unknown>;
  return JSON.stringify(
    Object.keys(o)
      .sort()
      .map((k) => [k, o[k]]),
  );
}
const sameRule = (a: unknown, b: unknown) => ruleKey(a) === ruleKey(b);

const KERNEL_UNAVAILABLE = text(
  "暂时无法核对成员或智能体，请稍后再试。",
  "Members or agents could not be checked right now. Try again shortly.",
);

/**
 * Why a gate or default assignment that changed names a target that cannot work, or null: a
 * named person must be an active non-guest member; an agent must be one the named member (or
 * every member with the label) may use. Unchanged rules are not checked again; people are read
 * in one call; a failed kernel read refuses the save.
 */
async function invalidRuleTarget(
  deps: ActionDeps,
  orgId: string,
  projectId: string,
  statuses: {
    type: string;
    key: string;
    gate?: GateRule | null;
    defaultAssignment?: DefaultAssignmentRule | null;
  }[],
): Promise<Toast | null> {
  const stored = await deps.db
    .selectFrom("statuses as s")
    .innerJoin("item_types as t", (j) =>
      j.onRef("t.workflow_id", "=", "s.workflow_id").onRef("t.org_id", "=", "s.org_id"),
    )
    .select(["t.key as type", "s.key", "s.gate", "s.default_assignment"])
    .where("s.org_id", "=", orgId)
    .where("t.project_id", "=", projectId)
    .execute();
  const before = new Map(stored.map((r) => [`${r.type}/${r.key}`, r]));
  const gates: GateRule[] = [];
  const rules: DefaultAssignmentRule[] = [];
  for (const s of statuses) {
    const old = before.get(`${s.type}/${s.key}`);
    if (s.gate && !sameRule(s.gate, old?.gate)) gates.push(s.gate);
    if (s.defaultAssignment && !sameRule(s.defaultAssignment, old?.default_assignment)) {
      rules.push(s.defaultAssignment);
    }
  }
  if (gates.length === 0 && rules.length === 0) return null;
  const members = await activeMembers(deps, orgId, projectId);
  const named = [
    ...gates.flatMap((g) => (g.confirmer === "member" ? [g.accountId] : [])),
    ...rules.flatMap((r) => (r.accountId ? [r.accountId] : [])),
  ];
  const memberRefused = text(
    "确认人或默认负责人必须是项目的所有者或成员。",
    "A confirmer or default assignee must be an owner or member of the project.",
  );
  if (named.some((id) => !members.has(id))) return memberRefused;
  if (named.length > 0) {
    let people: { id: string; active: boolean }[];
    try {
      people = await deps.ctx.people.get({ orgId, accountIds: [...new Set(named)] });
    } catch (err) {
      deps.ctx.log.warn("collab could not read people for project settings", { orgId, err });
      return KERNEL_UNAVAILABLE;
    }
    const active = new Set(people.filter((p) => p.active).map((p) => p.id));
    if (named.some((id) => !active.has(id))) return memberRefused;
  }
  for (const rule of rules) {
    if (!rule.agentId) continue;
    const who = rule.accountId
      ? [rule.accountId]
      : [...members].filter(([, label]) => label === rule.functionLabel).map(([id]) => id);
    for (const id of who) {
      let usable: { id: string }[];
      try {
        usable = await deps.ctx.agents.usableBy({ orgId, accountId: id });
      } catch (err) {
        deps.ctx.log.warn("collab could not read usable agents for project settings", {
          orgId,
          err,
        });
        return KERNEL_UNAVAILABLE;
      }
      if (!usable.some((a) => a.id === rule.agentId)) {
        return text(
          "默认负责人不能使用这个智能体，请选择他可用的智能体。",
          "The default assignee cannot use this agent. Pick one of the agents they may use.",
        );
      }
    }
  }
  return null;
}

/** `settings.save` (project owners): name, description, archive flag, gates, handoffs. */
async function settingsSave(deps: ActionDeps, args: UiOrgActionArgs): Promise<UiActionResult> {
  const p = objectOf(args.payload);
  const { projectId } = payloadFields(p, { projectId: "uuid" });
  const name = optString(p, "name", 200)?.trim();
  const description = optString(p, "description", 10_000);
  const archived = optBool(p, "archived");
  const rawStatuses = p.statuses;
  if (rawStatuses !== undefined && (!Array.isArray(rawStatuses) || rawStatuses.length > 200)) {
    throw new ActionPayloadError("statuses must be a list");
  }
  const statuses = ((rawStatuses as unknown[] | undefined) ?? []).map((raw) => {
    const s = objectOf(raw);
    return {
      type: reqString(s, "type", 64),
      key: reqString(s, "key", 64),
      ...("gate" in s ? { gate: gateRuleOf(s.gate) } : {}),
      ...("defaultAssignment" in s
        ? { defaultAssignment: assignmentRuleOf(s.defaultAssignment) }
        : {}),
    };
  });
  if (name !== undefined && !name) {
    return { toast: text("项目名称不能为空。", "The project name must not be empty.") };
  }
  // An archived project takes only the save that unarchives it (with any other changes).
  const unarchive = archived === false;
  return refusingProject(async () => {
    await requireRole(deps.db, args.orgId, args.accountId, projectId, "owner", {
      allowArchived: unarchive,
    });
    const invalidTarget = await invalidRuleTarget(deps, args.orgId, projectId, statuses);
    if (invalidTarget) return { toast: invalidTarget, invalidate: [...PROJECT_QUERIES] };
    await writing(deps, args.orgId, (hooks) =>
      deps.db.transaction().execute(async (tx) => {
        await requireRole(tx, args.orgId, args.accountId, projectId, "owner", {
          allowArchived: unarchive,
        });
        const set = {
          ...(name !== undefined ? { name } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(archived !== undefined ? { archived } : {}),
        };
        const wasArchived = await isArchived(tx, args.orgId, projectId);
        if (Object.keys(set).length > 0) {
          await tx
            .updateTable("projects")
            .set(set)
            .where("org_id", "=", args.orgId)
            .where("id", "=", projectId)
            .execute();
        }
        // Archiving makes the project read-only: its open decisions are canceled (inbox items
        // resolved, askers told), so no reminder or escalation fires afterwards.
        if (archived === true && !wasArchived) {
          await cancelOpenDecisionsOfProject(
            tx,
            args.orgId,
            { accountId: args.accountId },
            projectId,
            hooks,
          );
        }
        let gatesChanged = false;
        for (const s of statuses) {
          const type = await tx
            .selectFrom("item_types")
            .select("workflow_id")
            .where("org_id", "=", args.orgId)
            .where("project_id", "=", projectId)
            .where("key", "=", s.type)
            .executeTakeFirst();
          if (!type?.workflow_id) {
            throw new CollabError("invalid_input", `Unknown item type "${s.type}".`);
          }
          const patch = {
            ...("gate" in s ? { gate: s.gate === null ? null : JSON.stringify(s.gate) } : {}),
            ...("defaultAssignment" in s
              ? {
                  default_assignment:
                    s.defaultAssignment === null ? null : JSON.stringify(s.defaultAssignment),
                }
              : {}),
          };
          if (Object.keys(patch).length === 0) continue;
          const done = await tx
            .updateTable("statuses")
            .set(patch)
            .where("org_id", "=", args.orgId)
            .where("workflow_id", "=", type.workflow_id)
            .where("key", "=", s.key)
            .executeTakeFirst();
          if (Number(done.numUpdatedRows) === 0) {
            throw new CollabError("invalid_input", `Unknown status "${s.key}".`);
          }
          if ("gate" in s) gatesChanged = true;
        }
        // A changed gate rule changes who confirms the open requests into that status.
        if (gatesChanged) await readdressOpen(tx, args.orgId, { projectId }, hooks);
      }),
    );
    return { invalidate: [...PROJECT_QUERIES] };
  });
}

/** `member.add` (project owners): an active org member joins the project, or changes role. */
async function memberAdd(deps: ActionDeps, args: UiOrgActionArgs): Promise<UiActionResult> {
  const p = objectOf(args.payload);
  const { projectId, accountId } = payloadFields(p, { projectId: "uuid", accountId: "id" });
  const role = p.role;
  if (typeof role !== "string" || !ROLES.includes(role as ProjectRole)) {
    throw new ActionPayloadError("role must be owner, member or guest");
  }
  const functionLabel = nullableString(p, "functionLabel", 50);
  return refusingProject(async () => {
    await requireRole(deps.db, args.orgId, args.accountId, projectId, "owner");
    const [person] = await deps.ctx.people.get({ orgId: args.orgId, accountIds: [accountId] });
    if (!person?.active) {
      return {
        toast: text(
          "只能添加组织中的在职成员。",
          "Only active members of the organization can be added.",
        ),
      };
    }
    await writing(deps, args.orgId, (hooks) =>
      addMember(
        deps.db,
        args.orgId,
        { accountId: args.accountId },
        projectId,
        accountId,
        { role: role as ProjectRole, ...(functionLabel !== undefined ? { functionLabel } : {}) },
        hooks,
      ),
    );
    return { invalidate: [...PROJECT_QUERIES] };
  });
}

/** `member.remove` (project owners): their open items go back to the project owner. */
async function memberRemove(deps: ActionDeps, args: UiOrgActionArgs): Promise<UiActionResult> {
  const { projectId, accountId } = payloadFields(args.payload, {
    projectId: "uuid",
    accountId: "id",
  });
  return refusingProject(async () => {
    await writing(deps, args.orgId, (hooks) =>
      removeMember(deps.db, args.orgId, { accountId: args.accountId }, projectId, accountId, hooks),
    );
    return { invalidate: [...PROJECT_QUERIES] };
  });
}

/**
 * `member.function`: the function label (project owners) and the default agent (owners, or the
 * member for themselves), which must be one the member may use.
 */
async function memberFunction(deps: ActionDeps, args: UiOrgActionArgs): Promise<UiActionResult> {
  const p = objectOf(args.payload);
  const { projectId, accountId } = payloadFields(p, { projectId: "uuid", accountId: "id" });
  const functionLabel = nullableString(p, "functionLabel", 50);
  const defaultAgentId = nullableString(p, "defaultAgentId", ID_MAX);
  return refusingProject(
    async () => {
      const self = accountId === args.accountId;
      const need = functionLabel !== undefined || !self ? "owner" : "write";
      await requireRole(deps.db, args.orgId, args.accountId, projectId, need);
      if (defaultAgentId && !(await agentUsable(deps, args.orgId, accountId, defaultAgentId))) {
        return {
          toast: text(
            "这位成员不能使用这个智能体，请选择他可用的智能体。",
            "This member cannot use that agent. Pick one of the agents they may use.",
          ),
        };
      }
      await writing(deps, args.orgId, (hooks) =>
        setFunction(
          deps.db,
          args.orgId,
          { accountId: args.accountId },
          projectId,
          accountId,
          {
            ...(functionLabel !== undefined ? { functionLabel } : {}),
            ...(defaultAgentId !== undefined ? { defaultAgentId } : {}),
          },
          hooks,
        ),
      );
      return { invalidate: [...PROJECT_QUERIES] };
    },
    {
      invalid_input: text("请修改职能或默认智能体。", "Change the function or the default agent."),
    },
  );
}

registerAction("project.create", projectCreate);
registerAction("item.create", itemCreate);
registerAction("item.update", itemUpdate);
registerAction("item.move", itemMove);
registerAction("item.assign", itemAssign);
registerAction("item.comment", itemComment);
registerAction("gate.confirm", gateConfirm);
registerAction("decision.answer", decisionAnswer);
registerAction("settings.save", settingsSave);
registerAction("member.add", memberAdd);
registerAction("member.remove", memberRemove);
registerAction("member.function", memberFunction);
