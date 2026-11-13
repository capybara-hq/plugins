import {
  type ExtensionContext,
  type JsonValue,
  UI_LIMITS,
  type UiActionArgs,
  type UiActionResult,
  type UiRenderArgs,
  type UiView,
} from "@capybara-hq/plugin-sdk";
import { enqueueEmbed, type MemoryDeps } from "./embed.js";
import type { MemoryType } from "./paths.js";
import { MAX_QUERY_LENGTH, search } from "./search.js";
import {
  getByIds,
  linksOf,
  MemoryError,
  type MemoryRow,
  type Owner,
  put,
  remove,
} from "./store.js";

/**
 * The memory page (`org.page` component "记忆 / Memory"): the server half. The view and the
 * actions return the page's data in `UiView.data` for the client component (Task 8 draws it).
 *
 * Whose memories: the caller's own, unless the caller is an org admin or owner who selected
 * another member (`accountId`); then every select, open, search and delete is written to
 * `admin_access_log`, and edits are refused. The org and the caller come from the kernel's call
 * args; only `agentId` and an admin's `accountId` come from the payload, and both are checked
 * against `owners` (the pairs the plugin has seen) before any memory is read. Nothing here counts
 * as a recall: recalls are the model's use (the tools and the context).
 */

type Db = ExtensionContext["db"];

/** The page's contribution id (manifest `ui`, `permissions.ui.components`). */
export const PAGE = "overview";

/** Most memories one owner pair keeps, and so most nodes the page can list. */
const MAX_NODES = 1000;
/** Most agents and members listed in the selectors (most recently seen first). */
export const MAX_AGENTS = 100;
export const MAX_MEMBERS = 200;
/** Byte budget of a page's `data` (the kernel refuses more than `UI_LIMITS.componentDataBytes`). */
export const DATA_BUDGET = UI_LIMITS.componentDataBytes - 512;
/** Hits of a page search. */
const SEARCH_LIMIT = 20;

/** A memory in the graph. `dir` is the path's directory (`project/github`), `type` its first segment. */
export interface GraphNode {
  id: string;
  path: string;
  type: MemoryType;
  description: string;
  recalls: number;
  lastRecalledAt: string | null;
  dir: string;
}

/** A link written by the model (`[[…]]`, resolved only) or a semantic neighbour pair. */
export interface GraphEdge {
  from: string;
  to: string;
  kind: "link" | "semantic";
  score?: number;
}

/** An agent or a member in a selector. */
export interface Named {
  id: string;
  name: string;
}

/** The page's data (the view, `select` and `delete`). */
export interface MemoryPageData {
  /** The caller is an org admin or owner: `members` is listed and another member can be selected. */
  canAdmin: boolean;
  /** The selection is the caller's own memories: edit and delete are offered. */
  editable: boolean;
  /** The caller's agents (admins: every agent of the org the plugin has seen). */
  agents: Named[];
  /** Admins only: the members of the org the plugin has seen. */
  members?: Named[];
  selection: { agentId: string | null; accountId: string };
  /** Nodes by path; the first page only when `cursor` is set (`more` fetches the rest). */
  nodes: GraphNode[];
  /** Edges among the nodes sent so far. */
  edges: GraphEdge[];
  /** All memories of the selection. */
  total: number;
  /** Not every node is in this page (`cursor` is set). */
  truncated: boolean;
  /** Pass to `more` for the next page; null when this page has the last node. */
  cursor: string | null;
}

/** `more`: the next page of nodes, and the edges between them and the nodes sent before. */
export interface MemoryNodesPage {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
  cursor: string | null;
}

/** `open` and `edit`: one memory in full. */
export interface MemoryDetail extends GraphNode {
  body: string;
  /** Its `[[…]]` links: `targetId` null when dangling (not written yet, or an ambiguous name). */
  links: { path: string; targetId: string | null }[];
  createdAt: string;
  /** The conversation it was first written in. */
  createdIn: string | null;
  updatedAt: string;
}

/** `search`: hits best first. */
export interface MemorySearchHit {
  id: string;
  path: string;
  description: string;
  snippet: string;
}

const T = {
  forbidden: {
    zh: "只有组织管理员可以查看其他成员的记忆。",
    en: "Only org admins can see another member's memories.",
  },
  unknown: { zh: "没有找到这个智能体或成员的记忆。", en: "No memories for that agent or member." },
  notFound: { zh: "这条记忆已不存在。", en: "This memory no longer exists." },
  noEdit: {
    zh: "管理员不能编辑其他成员的记忆。",
    en: "Admins cannot edit another member's memories.",
  },
  invalid: { zh: "请求无效。", en: "Invalid request." },
} as const;

type Toast = { zh: string; en: string };
const toast = (t: Toast): UiActionResult => ({ toast: { zh: t.zh, en: t.en } });

const viewOf = (data: object): { view: UiView } => ({
  view: { blocks: [], data: data as unknown as JsonValue },
});

const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), "utf8");

// biome-ignore lint/suspicious/noExplicitAny: the plugin's tables have no Kysely schema type
type Raw = Record<string, any>;

const iso = (d: Date | null): string | null => (d === null ? null : new Date(d).toISOString());

function dirOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function nodeOf(r: Pick<MemoryRow, "id" | "path" | "type" | "description"> & Raw): GraphNode {
  return {
    id: r.id,
    path: r.path,
    type: r.type,
    description: r.description,
    recalls: r.recallCount ?? r.recall_count,
    lastRecalledAt: iso(r.lastRecalledAt ?? r.last_recalled_at ?? null),
    dir: dirOf(r.path),
  };
}

/** The caller of a page call: the org and account from the kernel, and whether they are an admin. */
interface Caller {
  orgId: string;
  accountId: string;
  canAdmin: boolean;
}

function callerOf(args: UiRenderArgs): Caller | null {
  if (args.scope === "platform") return null;
  return {
    orgId: args.orgId,
    accountId: args.accountId,
    canAdmin: args.role === "admin" || args.role === "owner",
  };
}

/** Whose memories a call reads: the owner, and whether it is another member's (an admin's view). */
interface Selection {
  owner: Owner;
  other: boolean;
}

function field(payload: unknown, key: string): unknown {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)[key]
    : undefined;
}

function optString(payload: unknown, key: string): string | undefined | null {
  const v = field(payload, key);
  if (v === undefined) return undefined;
  return typeof v === "string" && v.length > 0 && v.length <= 200 ? v : null;
}

/** Whether the plugin has seen any owner pair matching these ids in the org. */
async function seen(db: Db, orgId: string, ids: { agentId?: string; accountId?: string }) {
  let q = db.selectFrom("owners").select("agent_id").where("org_id", "=", orgId);
  if (ids.agentId !== undefined) q = q.where("agent_id", "=", ids.agentId);
  if (ids.accountId !== undefined) q = q.where("account_id", "=", ids.accountId);
  return (await q.limit(1).executeTakeFirst()) !== undefined;
}

/**
 * Checks the payload's `accountId` (another member only for admins, and only one the plugin has
 * seen in the org) and `agentId` (a member: an agent they have memories with; an admin: an agent
 * of the org the plugin has seen). Returns the selection or the refusal.
 */
async function select(
  db: Db,
  caller: Caller,
  payload: unknown,
  opts: { agentRequired: boolean },
): Promise<{ sel: Selection | null; accountId: string } | { refuse: Toast }> {
  const accountArg = optString(payload, "accountId");
  const agentArg = optString(payload, "agentId");
  if (accountArg === null || agentArg === null) return { refuse: T.invalid };
  const accountId = accountArg ?? caller.accountId;
  const other = accountId !== caller.accountId;
  if (other) {
    if (!caller.canAdmin) return { refuse: T.forbidden };
    if (!(await seen(db, caller.orgId, { accountId }))) return { refuse: T.unknown };
  }
  let agentId = agentArg;
  if (agentId === undefined) {
    if (opts.agentRequired) return { refuse: T.invalid };
    agentId = await latestAgent(db, caller.orgId, accountId);
    if (agentId === undefined) return { sel: null, accountId };
  } else {
    const allowed = caller.canAdmin
      ? await seen(db, caller.orgId, { agentId })
      : await seen(db, caller.orgId, { agentId, accountId: caller.accountId });
    if (!allowed) return { refuse: T.unknown };
  }
  return { sel: { owner: { orgId: caller.orgId, agentId, accountId }, other }, accountId };
}

/** The agent the member was last seen with, if any. */
async function latestAgent(db: Db, orgId: string, accountId: string): Promise<string | undefined> {
  const row = await db
    .selectFrom("owners")
    .select("agent_id")
    .where("org_id", "=", orgId)
    .where("account_id", "=", accountId)
    .orderBy("seen_at", "desc")
    .orderBy("agent_id")
    .executeTakeFirst();
  return row?.agent_id;
}

/** Distinct ids with their latest name, most recently seen first. */
function latestNames(rows: Raw[], idKey: string, nameKey: string, max: number): Named[] {
  const out = new Map<string, string>();
  for (const r of rows) {
    if (out.size >= max) break;
    if (!out.has(r[idKey])) out.set(r[idKey], r[nameKey]);
  }
  return [...out].map(([id, name]) => ({ id, name }));
}

async function agentsOf(db: Db, caller: Caller): Promise<Named[]> {
  let q = db
    .selectFrom("owners")
    .select(["agent_id", "agent_name"])
    .where("org_id", "=", caller.orgId);
  if (!caller.canAdmin) q = q.where("account_id", "=", caller.accountId);
  const rows = await q.orderBy("seen_at", "desc").orderBy("agent_id").execute();
  return latestNames(rows, "agent_id", "agent_name", MAX_AGENTS);
}

async function membersOf(db: Db, orgId: string, selected: string): Promise<Named[]> {
  const rows = await db
    .selectFrom("owners")
    .select(["account_id", "owner_name"])
    .where("org_id", "=", orgId)
    .orderBy("seen_at", "desc")
    .orderBy("account_id")
    .execute();
  const named = latestNames(rows, "account_id", "owner_name", MAX_MEMBERS);
  if (!named.some((m) => m.id === selected)) {
    const row = rows.find((r) => r.account_id === selected);
    if (row !== undefined) named.push({ id: selected, name: row.owner_name });
  }
  return named;
}

/** The owner's nodes in path order (code point order, so the cursor is stable). */
async function nodesOf(db: Db, owner: Owner): Promise<GraphNode[]> {
  const rows = await db
    .selectFrom("memories")
    .select(["id", "path", "type", "description", "recall_count", "last_recalled_at"])
    .where("org_id", "=", owner.orgId)
    .where("agent_id", "=", owner.agentId)
    .where("account_id", "=", owner.accountId)
    .limit(MAX_NODES)
    .execute();
  return rows
    .map((r) => nodeOf(r as Raw as MemoryRow & Raw))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The owner's resolved links and semantic neighbour pairs (each unordered pair once). */
async function edgesOf(db: Db, owner: Owner, nodes: GraphNode[]): Promise<GraphEdge[]> {
  const byPath = new Map(nodes.map((n) => [n.path, n.id]));
  const byName = new Map<string, string | null>();
  for (const n of nodes) {
    const name = n.path.slice(n.path.lastIndexOf("/") + 1).replace(/\.md$/, "");
    byName.set(name, byName.has(name) ? null : n.id);
  }
  const links = await db
    .selectFrom("memory_links as l")
    .innerJoin("memories as m", "m.id", "l.memory_id")
    .select(["l.memory_id", "l.to_path"])
    .where("m.org_id", "=", owner.orgId)
    .where("m.agent_id", "=", owner.agentId)
    .where("m.account_id", "=", owner.accountId)
    .execute();
  const edges: GraphEdge[] = [];
  const seenPair = new Set<string>();
  for (const l of links) {
    const to: string = l.to_path;
    const target = to.includes("/") ? byPath.get(to) : byName.get(to);
    if (target === undefined || target === null || target === l.memory_id) continue;
    const key = `${l.memory_id}>${target}`;
    if (seenPair.has(key)) continue;
    seenPair.add(key);
    edges.push({ from: l.memory_id, to: target, kind: "link" });
  }
  const neighbors = await db
    .selectFrom("memory_neighbors as n")
    .innerJoin("memories as a", "a.id", "n.memory_id")
    .innerJoin("memories as b", "b.id", "n.neighbor_id")
    .select(["n.memory_id", "n.neighbor_id", "n.score"])
    .where("a.org_id", "=", owner.orgId)
    .where("a.agent_id", "=", owner.agentId)
    .where("a.account_id", "=", owner.accountId)
    .where("b.org_id", "=", owner.orgId)
    .where("b.agent_id", "=", owner.agentId)
    .where("b.account_id", "=", owner.accountId)
    .execute();
  const semantic = new Map<string, GraphEdge>();
  for (const n of neighbors) {
    const [from, to] = [n.memory_id as string, n.neighbor_id as string].sort();
    const key = `${from}~${to}`;
    const score = Math.round(Number(n.score) * 1000) / 1000;
    const prev = semantic.get(key);
    if (prev === undefined || (prev.score ?? 0) < score) {
      semantic.set(key, { from: from as string, to: to as string, kind: "semantic", score });
    }
  }
  return [...edges, ...semantic.values()];
}

/**
 * The page of nodes after `cursor` (a path; null = from the start) that fits in `budget` bytes of
 * JSON, with the edges whose endpoints are both in this or an earlier page and at least one in
 * this page.
 */
function pageOf(
  nodes: GraphNode[],
  edges: GraphEdge[],
  cursor: string | null,
  budget: number,
): MemoryNodesPage {
  const start = cursor === null ? 0 : nodes.findIndex((n) => n.path > cursor);
  if (start === -1) return { nodes: [], edges: [], truncated: false, cursor: null };
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const byLater = new Map<number, GraphEdge[]>();
  for (const e of edges) {
    const a = index.get(e.from);
    const b = index.get(e.to);
    if (a === undefined || b === undefined) continue;
    const later = Math.max(a, b);
    if (later < start) continue;
    const list = byLater.get(later) ?? [];
    list.push(e);
    byLater.set(later, list);
  }
  const page: MemoryNodesPage = { nodes: [], edges: [], truncated: false, cursor: null };
  let used = 0;
  let i = start;
  for (; i < nodes.length; i++) {
    const node = nodes[i] as GraphNode;
    const its = byLater.get(i) ?? [];
    const cost = bytes(node) + 1 + its.reduce((s, e) => s + bytes(e) + 1, 0);
    // always send at least one node, so a page call makes progress
    if (page.nodes.length > 0 && used + cost > budget) break;
    used += cost;
    page.nodes.push(node);
    page.edges.push(...its);
  }
  if (i < nodes.length) {
    page.truncated = true;
    page.cursor = page.nodes.at(-1)?.path ?? null;
  }
  return page;
}

async function logAccess(
  db: Db,
  caller: Caller,
  sel: Selection,
  action: "view" | "delete",
  memoryPath: string | null,
): Promise<void> {
  if (!sel.other) return;
  await db
    .insertInto("admin_access_log")
    .values({
      org_id: caller.orgId,
      admin_account_id: caller.accountId,
      owner_account_id: sel.owner.accountId,
      agent_id: sel.owner.agentId,
      action,
      memory_path: memoryPath,
    })
    .execute();
}

/** The page data of a selection (`sel` null: the member has no memories with any agent yet). */
async function pageData(
  db: Db,
  caller: Caller,
  sel: Selection | null,
  accountId: string,
): Promise<MemoryPageData> {
  const base: MemoryPageData = {
    canAdmin: caller.canAdmin,
    editable: accountId === caller.accountId,
    agents: await agentsOf(db, caller),
    ...(caller.canAdmin ? { members: await membersOf(db, caller.orgId, accountId) } : {}),
    selection: { agentId: sel?.owner.agentId ?? null, accountId },
    nodes: [],
    edges: [],
    total: 0,
    truncated: false,
    cursor: null,
  };
  if (sel === null) return base;
  const nodes = await nodesOf(db, sel.owner);
  const edges = await edgesOf(db, sel.owner, nodes);
  const page = pageOf(nodes, edges, null, DATA_BUDGET - bytes(base));
  return { ...base, ...page, total: nodes.length };
}

/** Renders the page's first view: the caller's own memories with the agent they used last. */
export async function renderPage(db: Db, args: UiRenderArgs): Promise<UiView> {
  const caller = callerOf(args);
  if (caller === null) return { blocks: [] };
  const accountId = caller.accountId;
  const agentId = await latestAgent(db, caller.orgId, accountId);
  const sel: Selection | null =
    agentId === undefined
      ? null
      : { owner: { orgId: caller.orgId, agentId, accountId }, other: false };
  return viewOf(await pageData(db, caller, sel, accountId)).view;
}

async function detailOf(db: Db, owner: Owner, row: MemoryRow): Promise<MemoryDetail> {
  const links = await linksOf(db, owner, row.id);
  return {
    ...nodeOf(row as MemoryRow & Raw),
    body: row.body,
    links: links.map((l) => ({ path: l.path, targetId: l.target?.id ?? null })),
    createdAt: new Date(row.createdAt).toISOString(),
    createdIn: row.createdIn,
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

/** A UUID in its canonical 8-4-4-4-12 form (memory ids are `uuid`; anything else is not found). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function memoryOf(db: Db, sel: Selection, payload: unknown): Promise<MemoryRow | null> {
  const id = optString(payload, "memoryId");
  if (typeof id !== "string" || !UUID_RE.test(id)) return null;
  const [row] = await getByIds(db, sel.owner, [id]);
  return row ?? null;
}

/**
 * The page's actions (`args.actionId`), each with `agentId` and, for an admin, `accountId` in the
 * payload: `select` → page data; `more {cursor}` → the next nodes; `open {memoryId}` →
 * `{ detail }`; `search {query}` → `{ hits }`; `edit {memoryId, description, body}` (own only) →
 * `{ detail }`; `delete {memoryId}` → page data. A refusal is a toast.
 */
export async function pageAction(ctx: MemoryDeps, args: UiActionArgs): Promise<UiActionResult> {
  const db = ctx.db;
  const caller = callerOf(args);
  if (caller === null) return toast(T.invalid);
  const payload = args.payload;
  const action = args.actionId;
  const chosen = await select(db, caller, payload, { agentRequired: action !== "select" });
  if ("refuse" in chosen) return toast(chosen.refuse);
  const { sel, accountId } = chosen;
  if (action === "select") {
    if (sel !== null) await logAccess(db, caller, sel, "view", null);
    return viewOf(await pageData(db, caller, sel, accountId));
  }
  if (sel === null) return toast(T.invalid);
  switch (action) {
    case "more": {
      const cursor = optString(payload, "cursor");
      if (typeof cursor !== "string") return toast(T.invalid);
      const nodes = await nodesOf(db, sel.owner);
      const edges = await edgesOf(db, sel.owner, nodes);
      return viewOf(pageOf(nodes, edges, cursor, DATA_BUDGET));
    }
    case "open": {
      const row = await memoryOf(db, sel, payload);
      if (row === null) return toast(T.notFound);
      await logAccess(db, caller, sel, "view", row.path);
      return viewOf({ detail: await detailOf(db, sel.owner, row) });
    }
    case "search": {
      const query = field(payload, "query");
      if (typeof query !== "string" || query.length > MAX_QUERY_LENGTH) return toast(T.invalid);
      await logAccess(db, caller, sel, "view", null);
      if (query.trim() === "") return viewOf({ hits: [] });
      const hits = await search(ctx, db, sel.owner, query, SEARCH_LIMIT, {
        signal: args.signal,
        touch: false,
      });
      const out: MemorySearchHit[] = hits.map((h) => ({
        id: h.row.id,
        path: h.row.path,
        description: h.row.description,
        snippet: h.snippet,
      }));
      return viewOf({ hits: out });
    }
    case "edit": {
      if (sel.other) return toast(T.noEdit);
      const row = await memoryOf(db, sel, payload);
      if (row === null) return toast(T.notFound);
      const description = field(payload, "description");
      const body = field(payload, "body");
      if (typeof description !== "string" || typeof body !== "string") return toast(T.invalid);
      try {
        const { row: saved } = await put(db, sel.owner, {
          path: row.path,
          description,
          body,
          conversationId: null,
        });
        // the text changed: re-embed through the queue (a page call does not wait for a model)
        await enqueueEmbed(ctx.queue, sel.owner, saved).catch(() => {});
        return viewOf({ detail: await detailOf(db, sel.owner, saved) });
      } catch (e) {
        if (e instanceof MemoryError) {
          return toast({
            zh: "无法保存：描述须为一行、不超过 200 字，正文不超过 8 KB。",
            en: `Cannot save: ${e.message}`,
          });
        }
        throw e;
      }
    }
    case "delete": {
      const row = await memoryOf(db, sel, payload);
      if (row === null) return toast(T.notFound);
      await remove(db, sel.owner, row.path);
      await logAccess(db, caller, sel, "delete", row.path);
      return viewOf(await pageData(db, caller, sel, accountId));
    }
    default:
      return toast(T.invalid);
  }
}

/** Registers the page's view and actions (call from `setup`). */
export function registerPage(
  ctx: MemoryDeps & { ui: Pick<ExtensionContext["ui"], "view" | "action"> },
): void {
  ctx.ui.view(PAGE, (args) => renderPage(ctx.db, args));
  ctx.ui.action(PAGE, (args) => pageAction(ctx, args));
}
