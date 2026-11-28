import type { ExtensionContext, JsonValue, UiQueryArgs } from "@capybara-hq/plugin-sdk";
import { type Expression, type ExpressionBuilder, type SqlBool, sql } from "kysely";
import { AGENT_ITEMS, ITEM_PANEL, ITEM_PROPERTIES, PROJECTS } from "../constants.js";
import { roleIn } from "../domain/access.js";
import { currentAddressee } from "../domain/decision-state.js";
import { isWatching } from "../domain/internal.js";
import { DEFAULT_TYPES } from "../domain/seed.js";
import type { DefaultAssignmentRule, GateRule } from "../domain/workflow.js";
import { type CollabDb, collabDb } from "../store/db.js";
import type {
  CollabDatabase,
  Decision,
  Item,
  Project,
  ProjectRole,
  Status,
} from "../store/types.js";
import {
  ACTIVITY_PAGE_SIZE,
  type ActivityEntry,
  type AgentItemsResult,
  type AgentRef,
  type AgentsUsableResult,
  type ArtifactRow,
  BOARD_MAX_CARDS,
  type BoardCard,
  type DecisionRow,
  ITEMS_MAX_PAGE_SIZE,
  type ItemActivityResult,
  type ItemByConversationResult,
  type ItemCommentResult,
  type ItemConversationsResult,
  type ItemDetailResult,
  type ItemFilter,
  type ItemLinkRow,
  type ItemRef,
  type ItemRow,
  type ItemSortField,
  type ItemTypeInfo,
  type MemberRow,
  type NotFound,
  type PeopleSearchResult,
  type PersonRef,
  type Priority,
  type ProjectBoardResult,
  type ProjectHeader,
  type ProjectItemsResult,
  type ProjectSettingsResult,
  type ProjectsListResult,
  type StatusInfo,
} from "./contract.js";
import { Directory } from "./people.js";

/** What a query handler needs. */
export interface QueryDeps {
  ctx: Pick<ExtensionContext, "people" | "agents" | "conversations" | "log">;
  db: CollabDb;
}

/** The org call position of a query (the parts of `UiQueryArgs` the handlers read). */
export type QueryCall = Pick<
  UiQueryArgs,
  "orgId" | "accountId" | "role" | "query" | "params" | "conversationId" | "agentId"
>;

const NOT_FOUND: NotFound = { notFound: true };
const ITEM_KEY = /^([A-Z][A-Z0-9]{1,9})-([1-9][0-9]{0,8})$/;
const PROJECT_KEY = /^[A-Z][A-Z0-9]{1,9}$/;
/** Closed decisions an item page lists besides the open ones. */
const CLOSED_DECISIONS = 20;
/** Open items an agent section lists. */
const AGENT_ITEMS_MAX = 100;
/** Candidate items checked when resolving a conversation's item. */
const CONVERSATION_CANDIDATES = 5;

/**
 * What a query result may weigh (UTF-8 JSON). The host allows 1 MB; the rest is headroom for the
 * envelope. Lists stop adding entries when the next one would not fit and say so (`truncated`,
 * or a cursor).
 */
const RESULT_BUDGET_BYTES = 900 * 1024;
/** Comment bodies in the activity list are cut here (`clipped`; `item.comment` has the rest). */
const COMMENT_CLIP_CHARS = 4000;

/** The bytes left for one result. */
class Budget {
  private left: number;
  constructor(bytes = RESULT_BUDGET_BYTES) {
    this.left = bytes;
  }
  /** Charges `value`'s JSON size; false (and nothing charged) when it does not fit. */
  take(value: unknown): boolean {
    const bytes = Buffer.byteLength(JSON.stringify(value) ?? "", "utf8") + 1;
    if (bytes > this.left) return false;
    this.left -= bytes;
    return true;
  }
}

/** Adds entries while they fit; returns whether any was left out. */
function fill<T>(budget: Budget, from: T[], into: T[]): boolean {
  for (const entry of from) {
    if (!budget.take(entry)) return true;
    into.push(entry);
  }
  return false;
}

function clipChars(text: string, max: number): { text: string; clipped: boolean } {
  const cps = [...text];
  return cps.length <= max
    ? { text, clipped: false }
    : { text: cps.slice(0, max).join(""), clipped: true };
}

/** A malformed query (the host answers it as a failed query). */
class QueryParamsError extends Error {}

type Params = Record<string, unknown>;

function paramsOf(value: JsonValue): Params {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new QueryParamsError("params must be an object");
  }
  return value as Params;
}

function str(p: Params, name: string): string {
  const v = p[name];
  if (typeof v !== "string") throw new QueryParamsError(`${name} must be a string`);
  return v;
}

function optStr(p: Params, name: string): string | undefined {
  const v = p[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new QueryParamsError(`${name} must be a string`);
  return v;
}

function optInt(p: Params, name: string): number | undefined {
  const v = p[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new QueryParamsError(`${name} must be an integer`);
  }
  return v;
}

function filterOf(p: Params): ItemFilter & { type?: string; status?: string; open?: boolean } {
  const raw = p.filter;
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new QueryParamsError("filter must be an object");
  }
  const f = raw as Params;
  const priority = optInt(f, "priority");
  if (priority !== undefined && (priority < 0 || priority > 4)) {
    throw new QueryParamsError("filter.priority must be 0 to 4");
  }
  const open = f.open;
  if (open !== undefined && typeof open !== "boolean") {
    throw new QueryParamsError("filter.open must be a boolean");
  }
  const out: ItemFilter & { type?: string; status?: string; open?: boolean } = {};
  for (const k of ["q", "responsible", "agent", "label", "type", "status"] as const) {
    const v = optStr(f, k);
    if (v !== undefined && v !== "") out[k] = v.slice(0, 200);
  }
  if (priority !== undefined) out.priority = priority as Priority;
  if (typeof open === "boolean") out.open = open;
  return out;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const isoOf = (d: Date): string => d.toISOString();

/** The project with the viewer's role, or null when it is missing or hidden from them. */
async function viewerProject(
  db: CollabDb,
  orgId: string,
  accountId: string,
  key: string,
): Promise<{ project: Project; role: ProjectRole } | null> {
  if (!PROJECT_KEY.test(key)) return null;
  const project = await db
    .selectFrom("projects")
    .selectAll()
    .where("org_id", "=", orgId)
    .where("key", "=", key)
    .executeTakeFirst();
  if (!project) return null;
  const role = await roleIn(db, orgId, accountId, project.id);
  return role ? { project, role } : null;
}

/** The item `<KEY>-<n>` with its project and the viewer's role, or null when missing or hidden. */
async function viewerItem(
  db: CollabDb,
  orgId: string,
  accountId: string,
  key: string,
): Promise<{ item: Item; project: Project; role: ProjectRole } | null> {
  const m = ITEM_KEY.exec(key);
  if (!m?.[1] || !m[2]) return null;
  const found = await viewerProject(db, orgId, accountId, m[1]);
  if (!found) return null;
  const item = await db
    .selectFrom("items")
    .selectAll()
    .where("org_id", "=", orgId)
    .where("project_id", "=", found.project.id)
    .where("number", "=", Number(m[2]))
    .executeTakeFirst();
  return item ? { item, ...found } : null;
}

/** The project's item types (creation order) and each type's statuses in board order. */
async function workflowsOf(
  db: CollabDb,
  orgId: string,
  projectId: string,
): Promise<{ types: ItemTypeInfo[]; statuses: Map<string, Status[]> }> {
  const typeRows = await db
    .selectFrom("item_types")
    .selectAll()
    .where("org_id", "=", orgId)
    .where("project_id", "=", projectId)
    .orderBy("created_at")
    .orderBy("key")
    .execute();
  const rows = await db
    .selectFrom("statuses as s")
    .innerJoin("item_types as t", (j) =>
      j.onRef("t.workflow_id", "=", "s.workflow_id").onRef("t.org_id", "=", "s.org_id"),
    )
    .selectAll("s")
    .select("t.key as type_key")
    .where("s.org_id", "=", orgId)
    .where("t.project_id", "=", projectId)
    .orderBy("s.position")
    .execute();
  const statuses = new Map<string, Status[]>();
  for (const { type_key, ...status } of rows) {
    const list = statuses.get(type_key) ?? [];
    list.push(status);
    statuses.set(type_key, list);
  }
  // Seeded types keep their seed order (one transaction: equal created_at), the rest by key.
  const seedOrder = (key: string) => {
    const i = DEFAULT_TYPES.findIndex((t) => t.key === key);
    return i === -1 ? DEFAULT_TYPES.length : i;
  };
  typeRows.sort(
    (a, b) =>
      a.created_at.getTime() - b.created_at.getTime() ||
      seedOrder(a.key) - seedOrder(b.key) ||
      a.key.localeCompare(b.key),
  );
  return {
    types: typeRows.map((t) => ({
      key: t.key,
      name: { zh: t.name_zh, en: t.name_en },
      icon: t.icon,
    })),
    statuses,
  };
}

function statusInfo(s: Status): StatusInfo {
  return {
    key: s.key,
    name: { zh: s.name_zh, en: s.name_en },
    category: s.category,
    next: s.next_keys ?? [],
    gate: (s.gate as GateRule | null) ?? null,
    defaultAssignment: (s.default_assignment as DefaultAssignmentRule | null) ?? null,
  };
}

function statusOf(statuses: Map<string, Status[]>, type: string, key: string): StatusInfo {
  const s = statuses.get(type)?.find((x) => x.key === key);
  return s
    ? statusInfo(s)
    : {
        key,
        name: { zh: key, en: key },
        category: "todo",
        next: [],
        gate: null,
        defaultAssignment: null,
      };
}

function header(project: Project, role: ProjectRole, dir: Directory): ProjectHeader {
  return {
    id: project.id,
    key: project.key,
    name: project.name,
    description: project.description,
    archived: project.archived,
    role,
    owner: dir.person(project.owner_account_id),
  };
}

function itemRef(
  item: Pick<Item, "id" | "number" | "title" | "type" | "status_key">,
  projectKey: string,
  statuses: Map<string, Status[]>,
): ItemRef {
  const s = statusOf(statuses, item.type, item.status_key);
  return {
    id: item.id,
    key: `${projectKey}-${item.number}`,
    title: item.title,
    statusKey: s.key,
    statusName: s.name,
    statusCategory: s.category,
  };
}

type ItemsEb = ExpressionBuilder<CollabDatabase, "items">;

/** The filter as SQL conditions on `items` (the viewer resolves "me"). */
function filterConds(eb: ItemsEb, f: ItemFilter, viewer: string): Expression<SqlBool>[] {
  const conds: Expression<SqlBool>[] = [];
  if (f.q) {
    const like = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const num = /^(?:[A-Z][A-Z0-9]{1,9}-)?([1-9][0-9]{0,8})$/i.exec(f.q.trim())?.[1];
    conds.push(
      eb.or([
        eb("items.title", "ilike", like),
        ...(num ? [eb("items.number", "=", Number(num))] : []),
      ]),
    );
  }
  if (f.responsible) {
    conds.push(
      eb("items.responsible_account_id", "=", f.responsible === "me" ? viewer : f.responsible),
    );
  }
  if (f.agent) conds.push(eb("items.executing_agent_id", "=", f.agent));
  if (f.label) conds.push(sql<SqlBool>`${f.label} = ANY(items.labels)`);
  if (f.priority !== undefined) conds.push(eb("items.priority", "=", f.priority));
  return conds;
}

/** Open decisions per item and the target of an open gate request, for a set of items. */
async function openDecisionStats(
  db: CollabDb,
  orgId: string,
  itemIds: string[],
): Promise<Map<string, { count: number; gate: string | null }>> {
  const stats = new Map<string, { count: number; gate: string | null }>();
  if (itemIds.length === 0) return stats;
  const rows = await db
    .selectFrom("decisions")
    .select(["item_id", "kind", "gate_target"])
    .where("org_id", "=", orgId)
    .where("state", "=", "open")
    .where("item_id", "in", itemIds)
    .execute();
  for (const r of rows) {
    const s = stats.get(r.item_id) ?? { count: 0, gate: null };
    s.count += 1;
    if (r.kind === "gate" && r.gate_target) s.gate = r.gate_target;
    stats.set(r.item_id, s);
  }
  return stats;
}

/** Decisions as the pages show them; `canAnswer` from the addressing rules of today. */
async function decisionRows(
  db: CollabDb,
  orgId: string,
  viewer: string,
  project: Project,
  item: Item,
  decisions: Decision[],
  dir: Directory,
): Promise<DecisionRow[]> {
  const out: DecisionRow[] = [];
  const addressing = new Map<string, { addressee: string; answerers: string[] }>();
  for (const d of decisions) {
    if (d.state === "open") {
      addressing.set(d.id, await currentAddressee(db, orgId, project, item, d));
    }
  }
  await dir.load(
    decisions.flatMap((d) => [
      d.asker.accountId,
      addressing.get(d.id)?.addressee ?? d.addressee_account_id,
      (d.answer as { accountId?: string } | null)?.accountId,
    ]),
  );
  for (const d of decisions) {
    const now = addressing.get(d.id);
    const answer = d.answer as { optionId?: string; text?: string; accountId?: string } | null;
    out.push({
      id: d.id,
      kind: d.kind,
      question: d.question,
      options: (d.options as { id: string; label: string }[]).map((o) => ({
        id: o.id,
        label: o.label,
      })),
      recommendation: (d.recommendation as { optionId: string; why: string } | null) ?? null,
      blocking: d.blocking,
      state: d.state,
      asker: await dir.actor(d.asker),
      addressee: dir.person(now?.addressee ?? d.addressee_account_id),
      answer: answer
        ? {
            optionId: answer.optionId ?? null,
            text: answer.text ?? null,
            by: dir.personOrNull(answer.accountId),
          }
        : null,
      gateTarget: d.gate_target,
      deadlineAt: iso(d.deadline_at),
      createdAt: isoOf(d.created_at),
      answeredAt: iso(d.answered_at),
      canAnswer: Boolean(now?.answerers.includes(viewer)),
    });
  }
  return out;
}

async function projectsList(deps: QueryDeps, call: QueryCall): Promise<ProjectsListResult> {
  const { db } = deps;
  const rows = await db
    .selectFrom("projects as p")
    .innerJoin("project_members as m", (j) =>
      j.onRef("m.project_id", "=", "p.id").onRef("m.org_id", "=", "p.org_id"),
    )
    .selectAll("p")
    .select("m.role")
    .select((eb) =>
      eb
        .selectFrom("items")
        .select((e) => e.fn.countAll<string>().as("n"))
        .whereRef("items.project_id", "=", "p.id")
        .where("items.org_id", "=", call.orgId)
        .where("items.closed_at", "is", null)
        .as("open_items"),
    )
    .where("p.org_id", "=", call.orgId)
    .where("m.account_id", "=", call.accountId)
    .orderBy("p.archived")
    .orderBy("p.name")
    .execute();
  const dir = new Directory(deps.ctx, call.orgId);
  await dir.load(rows.map((r) => r.owner_account_id));
  const projects: ProjectsListResult["projects"] = [];
  const truncated = fill(
    new Budget(),
    rows.map((r) => ({
      id: r.id,
      key: r.key,
      name: r.name,
      description: r.description,
      archived: r.archived,
      role: r.role,
      owner: dir.person(r.owner_account_id),
      openItems: Number(r.open_items ?? 0),
    })),
    projects,
  );
  return { projects, canCreate: call.role !== "guest", truncated };
}

async function projectBoard(
  deps: QueryDeps,
  call: QueryCall,
  p: Params,
): Promise<ProjectBoardResult | NotFound> {
  const { db } = deps;
  const found = await viewerProject(db, call.orgId, call.accountId, str(p, "project"));
  if (!found) return NOT_FOUND;
  const { project, role } = found;
  const { types, statuses } = await workflowsOf(db, call.orgId, project.id);
  const type = optStr(p, "type") ?? types[0]?.key;
  const columns = type ? statuses.get(type) : undefined;
  if (!type || !columns) return NOT_FOUND;
  const filter = filterOf(p);
  const rows = await db
    .selectFrom("items")
    .selectAll()
    .where("org_id", "=", call.orgId)
    .where("project_id", "=", project.id)
    .where("type", "=", type)
    .where((eb) => eb.and(filterConds(eb, filter, call.accountId)))
    // Open items first, then the newest closed ones.
    .orderBy(sql`closed_at IS NULL`, "desc")
    .orderBy("updated_at", "desc")
    .orderBy("number", "desc")
    .limit(BOARD_MAX_CARDS + 1)
    .execute();
  const truncated = rows.length > BOARD_MAX_CARDS;
  const items = rows.slice(0, BOARD_MAX_CARDS);
  const parentIds = [...new Set(items.map((i) => i.parent_id).filter((x): x is string => !!x))];
  const parents = parentIds.length
    ? await db
        .selectFrom("items")
        .select(["id", "number"])
        .where("org_id", "=", call.orgId)
        .where("id", "in", parentIds)
        .execute()
    : [];
  const parentKey = new Map(parents.map((x) => [x.id, `${project.key}-${x.number}`]));
  const stats = await openDecisionStats(
    db,
    call.orgId,
    items.map((i) => i.id),
  );
  const dir = new Directory(deps.ctx, call.orgId);
  await dir.load([project.owner_account_id, ...items.map((i) => i.responsible_account_id)]);
  await dir.prefetchAgents(items.map((i) => i.responsible_account_id));
  const all: BoardCard[] = [];
  for (const i of items) {
    all.push({
      id: i.id,
      key: `${project.key}-${i.number}`,
      title: i.title,
      statusKey: i.status_key,
      priority: i.priority as Priority,
      labels: i.labels,
      version: i.version,
      responsible: dir.personOrNull(i.responsible_account_id),
      agent: await dir.agent(i.responsible_account_id, i.executing_agent_id),
      agentState: i.agent_state,
      parentKey: i.parent_id ? (parentKey.get(i.parent_id) ?? null) : null,
      openDecisions: stats.get(i.id)?.count ?? 0,
      pendingGate: stats.get(i.id)?.gate ?? null,
      updatedAt: isoOf(i.updated_at),
    });
  }
  const head = {
    project: header(project, role, dir),
    types,
    type,
    columns: columns.map((s) => ({ ...statusInfo(s), locked: s.gate !== null })),
  };
  const budget = new Budget();
  budget.take(head);
  const cards: BoardCard[] = [];
  const cut = fill(budget, all, cards);
  return {
    ...head,
    cards,
    truncated: truncated || cut,
    canEdit: role !== "guest" && !project.archived,
  };
}

const SORT_COLUMNS: Record<ItemSortField, string> = {
  key: "number",
  title: "title",
  status: "status_key",
  priority: "priority",
  updated: "updated_at",
  created: "created_at",
};

async function projectItems(
  deps: QueryDeps,
  call: QueryCall,
  p: Params,
): Promise<ProjectItemsResult | NotFound> {
  const { db } = deps;
  const found = await viewerProject(db, call.orgId, call.accountId, str(p, "project"));
  if (!found) return NOT_FOUND;
  const { project, role } = found;
  const page = Math.max(1, optInt(p, "page") ?? 1);
  const pageSize = Math.min(ITEMS_MAX_PAGE_SIZE, Math.max(1, optInt(p, "pageSize") ?? 50));
  const rawSort = p.sort as { field?: unknown; dir?: unknown } | undefined;
  const field: ItemSortField =
    rawSort && typeof rawSort.field === "string" && rawSort.field in SORT_COLUMNS
      ? (rawSort.field as ItemSortField)
      : "updated";
  const dirSort = rawSort?.dir === "asc" ? "asc" : "desc";
  const filter = filterOf(p);
  const base = db
    .selectFrom("items")
    .where("org_id", "=", call.orgId)
    .where("project_id", "=", project.id)
    .where((eb) => {
      const conds = filterConds(eb, filter, call.accountId);
      if (filter.type) conds.push(eb("items.type", "=", filter.type));
      if (filter.status) conds.push(eb("items.status_key", "=", filter.status));
      if (filter.open === true) conds.push(eb("items.closed_at", "is", null));
      if (filter.open === false) conds.push(eb("items.closed_at", "is not", null));
      return eb.and(conds);
    });
  const total = await base
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .executeTakeFirstOrThrow();
  const rows = await base
    .selectAll()
    .orderBy(sql.ref(SORT_COLUMNS[field]), dirSort)
    .orderBy("number", "desc")
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .execute();
  const { types, statuses } = await workflowsOf(db, call.orgId, project.id);
  const dir = new Directory(deps.ctx, call.orgId);
  await dir.load([project.owner_account_id, ...rows.map((i) => i.responsible_account_id)]);
  await dir.prefetchAgents(rows.map((i) => i.responsible_account_id));
  const all: ItemRow[] = [];
  for (const i of rows) {
    const s = statusOf(statuses, i.type, i.status_key);
    all.push({
      id: i.id,
      key: `${project.key}-${i.number}`,
      type: i.type,
      title: i.title,
      statusKey: s.key,
      statusName: s.name,
      statusCategory: s.category,
      priority: i.priority as Priority,
      labels: i.labels,
      version: i.version,
      responsible: dir.personOrNull(i.responsible_account_id),
      agent: await dir.agent(i.responsible_account_id, i.executing_agent_id),
      agentState: i.agent_state,
      updatedAt: isoOf(i.updated_at),
      createdAt: isoOf(i.created_at),
    });
  }
  const head = {
    project: header(project, role, dir),
    types,
    total: Number(total.n),
    page,
    pageSize,
    canEdit: role !== "guest" && !project.archived,
  };
  const budget = new Budget();
  budget.take(head);
  const out: ItemRow[] = [];
  const truncated = fill(budget, all, out);
  return { ...head, rows: out, truncated };
}

async function itemDetail(
  deps: QueryDeps,
  call: QueryCall,
  p: Params,
): Promise<ItemDetailResult | NotFound> {
  const { db } = deps;
  const found = await viewerItem(db, call.orgId, call.accountId, str(p, "key"));
  if (!found) return NOT_FOUND;
  const { item, project, role } = found;
  const { types, statuses } = await workflowsOf(db, call.orgId, project.id);
  const related = db
    .selectFrom("items")
    .select(["id", "number", "title", "type", "status_key", "project_id"])
    .where("org_id", "=", call.orgId);
  const parent = item.parent_id
    ? await related.where("id", "=", item.parent_id).executeTakeFirst()
    : undefined;
  const children = await related
    .where("parent_id", "=", item.id)
    .orderBy("number")
    .limit(200)
    .execute();
  const linkRows = await db
    .selectFrom("item_links")
    .selectAll()
    .where("org_id", "=", call.orgId)
    .where((eb) => eb.or([eb("from_id", "=", item.id), eb("to_id", "=", item.id)]))
    .limit(200)
    .execute();
  const otherIds = linkRows.map((l) => (l.from_id === item.id ? l.to_id : l.from_id));
  const others = otherIds.length ? await related.where("id", "in", otherIds).execute() : [];
  // Linked items of other projects show only when the viewer sees that project too.
  const projectKeys = new Map<string, string>([[project.id, project.key]]);
  // Projects the viewer is not a member of are remembered too (one membership read each).
  const hidden = new Set<string>();
  for (const o of others) {
    if (projectKeys.has(o.project_id) || hidden.has(o.project_id)) continue;
    const role2 = await roleIn(db, call.orgId, call.accountId, o.project_id);
    if (!role2) {
      hidden.add(o.project_id);
      continue;
    }
    const pr = await db
      .selectFrom("projects")
      .select("key")
      .where("org_id", "=", call.orgId)
      .where("id", "=", o.project_id)
      .executeTakeFirst();
    if (pr) projectKeys.set(o.project_id, pr.key);
  }
  const workflowsByProject = new Map([[project.id, statuses]]);
  const links: ItemLinkRow[] = [];
  for (const l of linkRows) {
    const otherId = l.from_id === item.id ? l.to_id : l.from_id;
    const other = others.find((o) => o.id === otherId);
    const key = other ? projectKeys.get(other.project_id) : undefined;
    if (!other || !key) continue;
    let theirs = workflowsByProject.get(other.project_id);
    if (!theirs) {
      theirs = (await workflowsOf(db, call.orgId, other.project_id)).statuses;
      workflowsByProject.set(other.project_id, theirs);
    }
    links.push({
      kind: l.kind,
      direction: l.from_id === item.id ? "out" : "in",
      item: itemRef(other, key, theirs),
    });
  }
  const artifactRows = await db
    .selectFrom("artifacts")
    .selectAll()
    .where("org_id", "=", call.orgId)
    .where("item_id", "=", item.id)
    .orderBy("created_at", "desc")
    .limit(200)
    .execute();
  const open = await db
    .selectFrom("decisions")
    .selectAll()
    .where("org_id", "=", call.orgId)
    .where("item_id", "=", item.id)
    .where("state", "=", "open")
    .orderBy("created_at", "desc")
    .execute();
  const closed = await db
    .selectFrom("decisions")
    .selectAll()
    .where("org_id", "=", call.orgId)
    .where("item_id", "=", item.id)
    .where("state", "!=", "open")
    .orderBy("created_at", "desc")
    .limit(CLOSED_DECISIONS)
    .execute();
  const dir = new Directory(deps.ctx, call.orgId);
  await dir.load([
    project.owner_account_id,
    item.requester_account_id,
    item.responsible_account_id,
    ...artifactRows.map((a) => a.author.accountId),
  ]);
  const artifacts: ArtifactRow[] = [];
  for (const a of artifactRows) {
    artifacts.push({
      id: a.id,
      kind: a.kind,
      name: a.name,
      version: a.version,
      url: a.url,
      author: await dir.actor(a.author),
      createdAt: isoOf(a.created_at),
    });
  }
  const type = types.find((t) => t.key === item.type) ?? {
    key: item.type,
    name: { zh: item.type, en: item.type },
    icon: null,
  };
  const head = {
    project: header(project, role, dir),
    item: {
      id: item.id,
      key: `${project.key}-${item.number}`,
      type: item.type,
      title: item.title,
      description: item.description,
      statusKey: item.status_key,
      priority: item.priority as Priority,
      labels: item.labels,
      version: item.version,
      requester: dir.person(item.requester_account_id),
      responsible: dir.personOrNull(item.responsible_account_id),
      agent: await dir.agent(item.responsible_account_id, item.executing_agent_id),
      agentState: item.agent_state,
      agentStateAt: iso(item.agent_state_at),
      agentConversationId: item.agent_conversation_id,
      closedAt: iso(item.closed_at),
      createdAt: isoOf(item.created_at),
      updatedAt: isoOf(item.updated_at),
    },
    type,
    statuses: (statuses.get(item.type) ?? []).map(statusInfo),
    parent: parent ? itemRef(parent, project.key, statuses) : null,
    canEdit: role !== "guest" && !project.archived,
    watching: await isWatching(db, call.orgId, item.id, call.accountId),
  };
  // Open decisions first: they are what the page acts on.
  const allDecisions = await decisionRows(
    db,
    call.orgId,
    call.accountId,
    project,
    item,
    [...open, ...closed],
    dir,
  );
  const budget = new Budget();
  budget.take(head);
  const decisions: DecisionRow[] = [];
  const kept = {
    children: [] as ItemRef[],
    links: [] as ItemLinkRow[],
    artifacts: [] as ArtifactRow[],
  };
  let truncated = fill(budget, allDecisions, decisions);
  truncated =
    fill(
      budget,
      children.map((c) => itemRef(c, project.key, statuses)),
      kept.children,
    ) || truncated;
  truncated = fill(budget, links, kept.links) || truncated;
  truncated = fill(budget, artifacts, kept.artifacts) || truncated;
  return { ...head, ...kept, decisions, truncated };
}

/** Account and agent ids an activity entry's detail names (assignment pairs, addressees). */
function namedIn(detail: Record<string, unknown>): {
  people: string[];
  agents: [string | null, string][];
} {
  const people: string[] = [];
  const agents: [string | null, string][] = [];
  const visit = (v: unknown) => {
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    const acc = typeof o.accountId === "string" ? o.accountId : null;
    if (acc) people.push(acc);
    if (typeof o.agentId === "string") agents.push([acc, o.agentId]);
  };
  visit(detail);
  visit(detail.from);
  visit(detail.to);
  if (typeof detail.addressee === "string") people.push(detail.addressee);
  return { people, agents };
}

async function itemActivity(
  deps: QueryDeps,
  call: QueryCall,
  p: Params,
): Promise<ItemActivityResult | NotFound> {
  const { db } = deps;
  const found = await viewerItem(db, call.orgId, call.accountId, str(p, "key"));
  if (!found) return NOT_FOUND;
  const { item } = found;
  const before = optStr(p, "before");
  if (before !== undefined && !/^[0-9a-f-]{36}$/i.test(before)) {
    throw new QueryParamsError("before must be a cursor from an earlier page");
  }
  let q = db
    .selectFrom("activity")
    .selectAll()
    .where("org_id", "=", call.orgId)
    .where("item_id", "=", item.id);
  if (before) {
    // The cursor row's time as text keeps the microseconds a JS Date would drop.
    const cursor = await db
      .selectFrom("activity")
      .select(sql<string>`created_at::text`.as("t"))
      .where("org_id", "=", call.orgId)
      .where("item_id", "=", item.id)
      .where("id", "=", before)
      .executeTakeFirst();
    if (!cursor) return { entries: [], next: null };
    q = q.where(sql<SqlBool>`(created_at, id) < (${cursor.t}::timestamptz, ${before}::uuid)`);
  }
  const rows = await q
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .limit(ACTIVITY_PAGE_SIZE + 1)
    .execute();
  const page = rows.slice(0, ACTIVITY_PAGE_SIZE);
  const commentIds = page
    .filter((r) => r.kind === "commented" && typeof r.detail.commentId === "string")
    .map((r) => r.detail.commentId as string);
  const comments = commentIds.length
    ? await db
        .selectFrom("comments")
        // Only the clipped part leaves the database (bodies can be 20 000 characters).
        .select(["id", sql<string>`left(body, ${COMMENT_CLIP_CHARS + 1})`.as("body")])
        .where("org_id", "=", call.orgId)
        .where("id", "in", commentIds)
        .execute()
    : [];
  const bodies = new Map(comments.map((c) => [c.id, c.body]));
  const dir = new Directory(deps.ctx, call.orgId);
  await dir.load(page.flatMap((r) => [r.actor.accountId, ...namedIn(r.detail).people]));
  const entries: ActivityEntry[] = [];
  const budget = new Budget();
  let cutAt: string | null = null;
  for (const r of page) {
    const named = namedIn(r.detail);
    const people: Record<string, PersonRef> = {};
    for (const id of named.people) people[id] = dir.person(id);
    const agents: Record<string, AgentRef> = {};
    for (const [acc, id] of named.agents) {
      const a = await dir.agent(acc, id);
      if (a) agents[id] = a;
    }
    const raw = r.kind === "commented" ? bodies.get(String(r.detail.commentId)) : undefined;
    const body = raw === undefined ? undefined : clipChars(raw, COMMENT_CLIP_CHARS);
    const entry: ActivityEntry = {
      id: r.id,
      kind: r.kind,
      actor: await dir.actor(r.actor),
      at: isoOf(r.created_at),
      detail: r.detail,
      ...(body ? { comment: body.text, ...(body.clipped ? { clipped: true } : {}) } : {}),
      people,
      agents,
    };
    if (!budget.take(entry)) {
      // The page ends here; the next one starts after the last entry that fit.
      cutAt = entries.at(-1)?.id ?? null;
      break;
    }
    entries.push(entry);
  }
  const more = cutAt !== null || rows.length > ACTIVITY_PAGE_SIZE;
  return { entries, next: more ? (entries.at(-1)?.id ?? null) : null };
}

/** `item.comment`: one comment's full body (the activity list clips long ones). */
async function itemComment(
  deps: QueryDeps,
  call: QueryCall,
  p: Params,
): Promise<ItemCommentResult | NotFound> {
  const found = await viewerItem(deps.db, call.orgId, call.accountId, str(p, "key"));
  if (!found) return NOT_FOUND;
  const commentId = str(p, "commentId");
  if (!/^[0-9a-f-]{36}$/i.test(commentId)) return NOT_FOUND;
  const row = await deps.db
    .selectFrom("comments")
    .selectAll()
    .where("org_id", "=", call.orgId)
    .where("item_id", "=", found.item.id)
    .where("id", "=", commentId)
    .executeTakeFirst();
  if (!row) return NOT_FOUND;
  const dir = new Directory(deps.ctx, call.orgId);
  await dir.load([row.author.accountId]);
  return {
    id: row.id,
    body: row.body,
    author: await dir.actor(row.author),
    at: isoOf(row.created_at),
  };
}

async function itemConversations(
  deps: QueryDeps,
  call: QueryCall,
  p: Params,
): Promise<ItemConversationsResult | NotFound> {
  const found = await viewerItem(deps.db, call.orgId, call.accountId, str(p, "key"));
  if (!found) return NOT_FOUND;
  const list = await deps.ctx.conversations.bySubject({
    orgId: call.orgId,
    subject: { kind: "item", id: found.item.id },
  });
  const dir = new Directory(deps.ctx, call.orgId);
  await dir.load(list.map((c) => c.ownerAccountId));
  const conversations = [];
  for (const c of list) {
    conversations.push({
      id: c.id,
      owner: dir.person(c.ownerAccountId),
      agent: (await dir.agent(c.ownerAccountId, c.agentId)) as AgentRef,
      state: c.state,
      lastActivityAt: c.lastActivityAt,
    });
  }
  const kept: ItemConversationsResult["conversations"] = [];
  const truncated = fill(new Budget(), conversations, kept);
  return { conversations: kept, truncated };
}

async function projectSettings(
  deps: QueryDeps,
  call: QueryCall,
  p: Params,
): Promise<ProjectSettingsResult | NotFound> {
  const { db } = deps;
  const found = await viewerProject(db, call.orgId, call.accountId, str(p, "project"));
  if (!found) return NOT_FOUND;
  const { project, role } = found;
  const memberRows = await db
    .selectFrom("project_members")
    .selectAll()
    .where("org_id", "=", call.orgId)
    .where("project_id", "=", project.id)
    .orderBy("created_at")
    .execute();
  const dir = new Directory(deps.ctx, call.orgId);
  await dir.load([project.owner_account_id, ...memberRows.map((m) => m.account_id)]);
  await dir.prefetchAgents(memberRows.filter((m) => m.default_agent_id).map((m) => m.account_id));
  const members: MemberRow[] = [];
  for (const m of memberRows) {
    members.push({
      person: dir.person(m.account_id),
      role: m.role,
      functionLabel: m.function_label,
      defaultAgent: await dir.agent(m.account_id, m.default_agent_id),
      canSetAgent:
        !project.archived &&
        m.role !== "guest" &&
        (role === "owner" || (m.account_id === call.accountId && role === "member")),
    });
  }
  const { types, statuses } = await workflowsOf(db, call.orgId, project.id);
  const head = {
    project: header(project, role, dir),
    types: types.map((t) => ({ ...t, statuses: (statuses.get(t.key) ?? []).map(statusInfo) })),
    canEdit: role === "owner",
  };
  const budget = new Budget();
  budget.take(head);
  const kept: MemberRow[] = [];
  const truncated = fill(budget, members, kept);
  return { ...head, members: kept, truncated };
}

async function peopleSearch(
  deps: QueryDeps,
  call: QueryCall,
  p: Params,
): Promise<PeopleSearchResult | NotFound> {
  const query = (optStr(p, "query") ?? "").slice(0, 100);
  const limit = Math.min(50, Math.max(1, optInt(p, "limit") ?? 20));
  const projectKey = optStr(p, "project");
  if (projectKey === undefined) {
    // Adding someone to a project: org members, for anyone who owns a project or may create one.
    if (call.role === "guest") return NOT_FOUND;
    const people = await deps.ctx.people.search({ orgId: call.orgId, query, limit });
    return { people: people.map((x) => ({ id: x.id, name: x.name, avatar: x.avatar })) };
  }
  const found = await viewerProject(deps.db, call.orgId, call.accountId, projectKey);
  if (!found) return NOT_FOUND;
  const members = await deps.db
    .selectFrom("project_members")
    .select("account_id")
    .where("org_id", "=", call.orgId)
    .where("project_id", "=", found.project.id)
    .where("role", "!=", "guest")
    .execute();
  const dir = new Directory(deps.ctx, call.orgId);
  await dir.load(members.map((m) => m.account_id));
  const needle = query.toLowerCase();
  const people = members
    .map((m) => dir.person(m.account_id))
    .filter((x) => x.name.toLowerCase().includes(needle))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, limit);
  return { people };
}

async function agentsUsable(
  deps: QueryDeps,
  call: QueryCall,
  p: Params,
): Promise<AgentsUsableResult | NotFound> {
  const found = await viewerProject(deps.db, call.orgId, call.accountId, str(p, "project"));
  if (!found) return NOT_FOUND;
  const accountId = str(p, "accountId");
  // Only for someone who may be responsible here, and only to a viewer who may assign.
  const target = await roleIn(deps.db, call.orgId, accountId, found.project.id);
  if (found.role === "guest" || !target || target === "guest") return { agents: [] };
  const dir = new Directory(deps.ctx, call.orgId);
  return { agents: [...(await dir.usable(accountId)).values()] };
}

/**
 * The collab item a conversation serves: candidates are items whose agent last worked in it
 * (run state) or whose history has an agent write from it; the kernel's subject index
 * (`ctx.conversations.bySubject`, own subjects only) confirms one.
 */
async function itemOfConversation(
  deps: QueryDeps,
  orgId: string,
  conversationId: string,
): Promise<Item | null> {
  const { db } = deps;
  const direct = await db
    .selectFrom("items")
    .select("id")
    .where("org_id", "=", orgId)
    .where("agent_conversation_id", "=", conversationId)
    .orderBy("updated_at", "desc")
    .limit(CONVERSATION_CANDIDATES)
    .execute();
  const viaActivity = await db
    .selectFrom("activity")
    .select("item_id")
    .distinct()
    .where("org_id", "=", orgId)
    // Matches the partial index activity_conversation (predicate and expression).
    .where(sql<SqlBool>`actor ? 'conversationId' AND actor->>'conversationId' = ${conversationId}`)
    .limit(CONVERSATION_CANDIDATES)
    .execute();
  const ids = [...new Set([...direct.map((r) => r.id), ...viaActivity.map((r) => r.item_id)])];
  for (const id of ids.slice(0, CONVERSATION_CANDIDATES * 2)) {
    const serving = await deps.ctx.conversations.bySubject({
      orgId,
      subject: { kind: "item", id },
    });
    if (serving.some((c) => c.id === conversationId)) {
      return (
        (await db
          .selectFrom("items")
          .selectAll()
          .where("org_id", "=", orgId)
          .where("id", "=", id)
          .executeTakeFirst()) ?? null
      );
    }
  }
  return null;
}

async function itemByConversation(
  deps: QueryDeps,
  call: QueryCall,
): Promise<ItemByConversationResult> {
  if (!call.conversationId) return { item: null };
  const { db } = deps;
  const item = await itemOfConversation(deps, call.orgId, call.conversationId);
  if (!item) return { item: null };
  const role = await roleIn(db, call.orgId, call.accountId, item.project_id);
  if (!role) return { item: null };
  const project = await db
    .selectFrom("projects")
    .selectAll()
    .where("org_id", "=", call.orgId)
    .where("id", "=", item.project_id)
    .executeTakeFirstOrThrow();
  const { types, statuses } = await workflowsOf(db, call.orgId, project.id);
  const open = await db
    .selectFrom("decisions")
    .selectAll()
    .where("org_id", "=", call.orgId)
    .where("item_id", "=", item.id)
    .where("state", "=", "open")
    .orderBy("created_at", "desc")
    .execute();
  const dir = new Directory(deps.ctx, call.orgId);
  await dir.load([item.responsible_account_id]);
  const s = statusOf(statuses, item.type, item.status_key);
  const decisions = await decisionRows(db, call.orgId, call.accountId, project, item, open, dir);
  const budget = new Budget();
  const openDecisions: DecisionRow[] = [];
  const truncated = fill(budget, decisions, openDecisions);
  return {
    truncated,
    item: {
      id: item.id,
      key: `${project.key}-${item.number}`,
      title: item.title,
      projectKey: project.key,
      projectName: project.name,
      type: types.find((t) => t.key === item.type) ?? {
        key: item.type,
        name: { zh: item.type, en: item.type },
        icon: null,
      },
      statusKey: s.key,
      statusName: s.name,
      statusCategory: s.category,
      priority: item.priority as Priority,
      labels: item.labels,
      version: item.version,
      responsible: dir.personOrNull(item.responsible_account_id),
      agent: await dir.agent(item.responsible_account_id, item.executing_agent_id),
      agentState: item.agent_state,
      openDecisions,
      canEdit: role !== "guest" && !project.archived,
    },
  };
}

async function agentItems(deps: QueryDeps, call: QueryCall): Promise<AgentItemsResult> {
  if (!call.agentId) return { items: [] };
  const rows = await deps.db
    .selectFrom("items as i")
    .innerJoin("projects as p", (j) =>
      j.onRef("p.id", "=", "i.project_id").onRef("p.org_id", "=", "i.org_id"),
    )
    .innerJoin("project_members as m", (j) =>
      j.onRef("m.project_id", "=", "i.project_id").onRef("m.org_id", "=", "i.org_id"),
    )
    .selectAll("i")
    .select("p.key as project_key")
    .where("i.org_id", "=", call.orgId)
    .where("i.executing_agent_id", "=", call.agentId)
    .where("i.closed_at", "is", null)
    .where("m.account_id", "=", call.accountId)
    .orderBy("i.updated_at", "desc")
    .limit(AGENT_ITEMS_MAX)
    .execute();
  const dir = new Directory(deps.ctx, call.orgId);
  await dir.load(rows.map((r) => r.responsible_account_id));
  const statusCache = new Map<string, Map<string, Status[]>>();
  const items = [];
  for (const r of rows) {
    let statuses = statusCache.get(r.project_id);
    if (!statuses) {
      statuses = (await workflowsOf(deps.db, call.orgId, r.project_id)).statuses;
      statusCache.set(r.project_id, statuses);
    }
    const s = statusOf(statuses, r.type, r.status_key);
    items.push({
      id: r.id,
      key: `${r.project_key}-${r.number}`,
      title: r.title,
      projectKey: r.project_key,
      statusKey: s.key,
      statusName: s.name,
      statusCategory: s.category,
      responsible: dir.personOrNull(r.responsible_account_id),
      agentState: r.agent_state,
      updatedAt: isoOf(r.updated_at),
    });
  }
  const kept: AgentItemsResult["items"] = [];
  const truncated = fill(new Budget(), items, kept);
  return { items: kept, truncated };
}

type Handler = (deps: QueryDeps, call: QueryCall, p: Params) => Promise<unknown>;

/** The queries of each component (one `ctx.ui.query` handler per component). */
// capybara:allow-module-state read-only dispatch tables
const QUERIES: Record<string, Record<string, Handler>> = {
  [PROJECTS]: {
    "projects.list": projectsList,
    "project.board": projectBoard,
    "project.items": projectItems,
    "item.detail": itemDetail,
    "item.activity": itemActivity,
    "item.conversations": itemConversations,
    "item.comment": itemComment,
    "project.settings": projectSettings,
    "people.search": peopleSearch,
    "agents.usable": agentsUsable,
  },
  [ITEM_PANEL]: { "item.byConversation": itemByConversation },
  [ITEM_PROPERTIES]: { "item.byConversation": itemByConversation },
  [AGENT_ITEMS]: { "agent.items": agentItems },
};

/** Runs one query of a component; an unknown query name throws. */
export async function runQuery(
  deps: QueryDeps,
  component: string,
  call: QueryCall,
): Promise<JsonValue> {
  const handler = QUERIES[component]?.[call.query];
  if (!handler) throw new Error(`collab: unknown query ${call.query} of ${component}`);
  return (await handler(deps, call, paramsOf(call.params))) as JsonValue;
}

/** Registers the `ctx.ui.query` handler of every component (in `setup`). */
export function registerQueries(ctx: ExtensionContext): void {
  const deps: QueryDeps = { ctx, db: collabDb(ctx.db) };
  for (const component of Object.keys(QUERIES)) {
    ctx.ui.query(component, (args) => runQuery(deps, component, args));
  }
}
