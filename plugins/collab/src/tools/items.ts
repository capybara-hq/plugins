import {
  type InputRequired,
  type ToolCallContext,
  ToolError,
  type ToolSpec,
} from "@capybara-hq/plugin-sdk";
import { gateNotifier } from "../decisions-queue.js";
import { assign, validateAssignee } from "../domain/assignment.js";
import { CollabError } from "../domain/errors.js";
import { loadItem } from "../domain/internal.js";
import {
  attachArtifact,
  comment,
  createItem,
  type ItemPatch,
  link,
  transition,
  updateItem,
} from "../domain/items.js";
import { statusesForType } from "../domain/workflow.js";
import type { Item, LinkKind, Project } from "../store/types.js";
import {
  agentAllowedFor,
  assertStillAssigned,
  droppedAgentNote,
  guarded,
  int,
  itemByKey,
  namesOf,
  optStr,
  personOf,
  projectByKey,
  resolvePerson,
  stillAssignedGuard,
  str,
  type ToolDeps,
  usableAgents,
  writing,
} from "./common.js";
import {
  actorLabel,
  agentLabel,
  itemLine,
  keyOf,
  nextStatuses,
  PRIORITY_NAMES,
  personLabel,
  result,
  statusLabel,
} from "./format.js";

const SEARCH_DEFAULT_LIMIT = 20;
const SEARCH_MAX_LIMIT = 50;
const ACTIVITY_SHOWN = 20;
const COMMENTS_SHOWN = 10;
const COMMENT_CHARS_SHOWN = 2000;
const CHILDREN_SHOWN = 50;
const ARTIFACTS_SHOWN = 30;

const KEY_PROP = {
  type: "string",
  description: 'The item key, e.g. "CAP-12" (from item_search or item_get).',
} as const;
const VERSION_PROP = {
  type: "integer",
  minimum: 1,
  description:
    "The item version you last read (item_get, item_search or the previous write return it). A stale version is refused so you never overwrite someone's change.",
} as const;
const RESPONSIBLE_PROP = {
  type: "string",
  description:
    'Who is responsible: "me" (your person), an account id, or the exact name of a project member (project_list lists them). Assigning someone other than your person asks your person to confirm first.',
} as const;
const AGENT_PROP = {
  type: ["string", "null"],
  description:
    "The agent that works on the item for the responsible person: an agent id they may use, or null for no agent. Left out: the person's default agent in the project, if any.",
} as const;

const ITEM_SEARCH: ToolSpec = {
  name: "item_search",
  title: "Search items",
  description:
    "Search the tracker items (requirements, tasks, bugs) of the projects you are a member of.\n" +
    "Filter by project key, words in the title, status key, item type, or items your person is " +
    "responsible for; open items only unless includeClosed is true or a closed status is asked for. " +
    "Returns one line per item with its key, status, assignment and version, newest change first. " +
    "Use item_get for an item's full details.",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: 'A project key, e.g. "CAP".' },
      query: { type: "string", maxLength: 200, description: "Words in the title or an item key." },
      status: { type: "string", description: 'A status key, e.g. "in_progress" or "review".' },
      type: { type: "string", description: 'An item type: "requirement", "task" or "bug".' },
      assignedToMe: {
        type: "boolean",
        description: "Only items your person is responsible for.",
      },
      includeClosed: { type: "boolean", description: "Also done and canceled items." },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: SEARCH_MAX_LIMIT,
        description: `Most items to return (1 to ${SEARCH_MAX_LIMIT}, default ${SEARCH_DEFAULT_LIMIT}).`,
      },
    },
    additionalProperties: false,
  },
  keyArgs: ["project", "query", "status"],
  annotations: { readOnlyHint: true },
  defaultPolicy: "allow",
};

const ITEM_GET: ToolSpec = {
  name: "item_get",
  title: "Read item",
  description:
    "Read one tracker item in full: fields, description, status and allowed next statuses, " +
    "assignment, children, links, artifacts, open decisions, recent comments and the last 20 " +
    "activity entries, plus the version to pass to a write.\n" +
    "Use it before changing an item and whenever a write reports a version conflict.",
  inputSchema: {
    type: "object",
    properties: { key: KEY_PROP },
    required: ["key"],
    additionalProperties: false,
  },
  keyArgs: ["key"],
  annotations: { readOnlyHint: true },
  defaultPolicy: "allow",
};

const ITEM_CREATE: ToolSpec = {
  name: "item_create",
  title: "Create item",
  description:
    "Create a tracker item (requirement, task or bug) in a project, optionally as a child of " +
    "another item and assigned to a person and their agent.\n" +
    "It starts in the first status of its type's workflow; without a responsible person the " +
    "status's default assignment applies (e.g. new bugs go to the engineering member). Assigning " +
    "someone other than your person asks your person to confirm first. Use item_search first to " +
    "avoid duplicates.",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: 'The project key, e.g. "CAP".' },
      type: {
        type: "string",
        description: 'The item type: "requirement", "task" or "bug" (or a type the project added).',
      },
      title: { type: "string", maxLength: 200, description: "A short title." },
      description: {
        type: "string",
        maxLength: 50000,
        description: "Markdown description; attach long documents with artifact_attach.",
      },
      parent: { type: "string", description: 'The parent item key, e.g. "CAP-12".' },
      responsible: RESPONSIBLE_PROP,
      agent: AGENT_PROP,
      priority: {
        type: "integer",
        minimum: 0,
        maximum: 4,
        description: "0 none, 1 urgent, 2 high, 3 normal (default), 4 low.",
      },
      labels: {
        type: "array",
        items: { type: "string", maxLength: 50 },
        maxItems: 20,
        description: "Labels.",
      },
    },
    required: ["project", "type", "title"],
    additionalProperties: false,
  },
  keyArgs: ["project", "type", "title"],
  defaultPolicy: "allow",
};

const ITEM_UPDATE: ToolSpec = {
  name: "item_update",
  title: "Update item",
  description:
    "Change a tracker item's own fields: title, description, priority, labels, parent or custom " +
    "fields, at the version you last read.\n" +
    "Fields left out of patch stay. Use item_transition to change the status and item_assign to " +
    "change who works on it.",
  inputSchema: {
    type: "object",
    properties: {
      key: KEY_PROP,
      version: VERSION_PROP,
      patch: {
        type: "object",
        properties: {
          title: { type: "string", maxLength: 200 },
          description: {
            type: "string",
            maxLength: 50000,
            description: "Replaces the whole description.",
          },
          priority: { type: "integer", minimum: 0, maximum: 4 },
          labels: {
            type: "array",
            items: { type: "string", maxLength: 50 },
            maxItems: 20,
            description: "Replaces all labels.",
          },
          parent: {
            type: ["string", "null"],
            description: "The new parent item key, or null to detach.",
          },
          fields: {
            type: "object",
            description: "Custom fields merged into the existing ones (under 16 KB of JSON).",
          },
        },
        additionalProperties: false,
      },
    },
    required: ["key", "version", "patch"],
    additionalProperties: false,
  },
  keyArgs: ["key"],
  defaultPolicy: "allow",
};

const ITEM_TRANSITION: ToolSpec = {
  name: "item_transition",
  title: "Move item",
  description:
    "Move a tracker item to another status of its workflow, at the version you last read.\n" +
    "item_get lists the allowed next statuses. Moving into a gated status does not move the item: " +
    "it asks the confirming person and reports who it waits on. Entering a status may hand the " +
    "item to another person and agent (the status's default assignment).",
  inputSchema: {
    type: "object",
    properties: {
      key: KEY_PROP,
      version: VERSION_PROP,
      to: { type: "string", description: 'The target status key, e.g. "in_progress".' },
    },
    required: ["key", "version", "to"],
    additionalProperties: false,
  },
  keyArgs: ["key", "to"],
  defaultPolicy: "allow",
};

const ITEM_ASSIGN: ToolSpec = {
  name: "item_assign",
  title: "Assign item",
  description:
    "Assign a tracker item to a responsible person and the agent that works on it for them, at " +
    "the version you last read.\n" +
    "Assigning your own person (with or without one of their agents) happens at once; assigning " +
    "anyone else always asks your person to confirm first, and the call waits for the answer. " +
    "The new agent receives the item as work it may accept.",
  inputSchema: {
    type: "object",
    properties: {
      key: KEY_PROP,
      version: VERSION_PROP,
      responsible: RESPONSIBLE_PROP,
      agent: AGENT_PROP,
    },
    required: ["key", "version", "responsible"],
    additionalProperties: false,
  },
  keyArgs: ["key", "responsible"],
  defaultPolicy: "allow",
};

const ITEM_COMMENT: ToolSpec = {
  name: "item_comment",
  title: "Comment on item",
  description:
    "Add a comment to a tracker item, seen by the project members and the item's agents.\n" +
    "Use it to report progress, findings or questions that need no answer; use decisions for " +
    "questions a person must answer.",
  inputSchema: {
    type: "object",
    properties: {
      key: KEY_PROP,
      body: { type: "string", maxLength: 20000, description: "The comment, in Markdown." },
    },
    required: ["key", "body"],
    additionalProperties: false,
  },
  keyArgs: ["key"],
  defaultPolicy: "allow",
};

const ITEM_LINK: ToolSpec = {
  name: "item_link",
  title: "Link items",
  description:
    "Link two tracker items: key blocks to, key relates to to, or key duplicates to.\n" +
    "Use it to record dependencies and duplicates (a bug found while testing a task relates to " +
    "that task). Linking twice is a no-op. Use parent in item_create or item_update for children.",
  inputSchema: {
    type: "object",
    properties: {
      key: KEY_PROP,
      to: { type: "string", description: 'The other item key, e.g. "CAP-19".' },
      kind: {
        type: "string",
        enum: ["blocks", "relates", "duplicates"],
        description: "The link kind.",
      },
    },
    required: ["key", "to", "kind"],
    additionalProperties: false,
  },
  keyArgs: ["key", "kind", "to"],
  defaultPolicy: "allow",
};

const ARTIFACT_ATTACH: ToolSpec = {
  name: "artifact_attach",
  title: "Attach artifact",
  description:
    "Attach a link artifact to a tracker item, e.g. a pull request, a design document or a test " +
    "report published elsewhere.\n" +
    "Attaching again under the same name adds its next version. Use item_comment for short notes; " +
    "write longer text such as a PRD into the item description with item_update.",
  inputSchema: {
    type: "object",
    properties: {
      key: KEY_PROP,
      kind: {
        type: "string",
        maxLength: 50,
        description: 'What it is, e.g. "prd", "design", "test_plan", "pr", "report".',
      },
      name: { type: "string", maxLength: 200, description: 'A name, e.g. "PRD" or "PR #12".' },
      url: { type: "string", description: "An absolute http(s) URL." },
    },
    required: ["key", "kind", "name", "url"],
    additionalProperties: false,
  },
  keyArgs: ["key", "name"],
  defaultPolicy: "allow",
};

/** Who an assignment goes to; `dropped` is a default agent the person can no longer use. */
interface Target {
  accountId: string;
  agentId: string | null;
  dropped?: string;
}

/** The state an assignment confirmation keeps until the person answers. */
interface ConfirmState {
  confirm: "assign";
  target: Target;
}

/**
 * Resolves `responsible` and `agent` into a target: the person must be a writing member, the
 * agent one they may use (`ctx.agents.usableBy`). Without `agent`, the member's default agent in
 * the project, dropped (with a note) when they can no longer use it.
 */
async function resolveTarget(
  deps: ToolDeps,
  orgId: string,
  project: Project,
  person: string,
  responsible: string,
  agent: unknown,
): Promise<Target> {
  const accountId = await resolvePerson(deps, orgId, project.id, person, responsible);
  await validateAssignee(deps.db, orgId, project.id, accountId);
  if (agent === null) return { accountId, agentId: null };
  const usable = await usableAgents(deps.ctx, orgId, accountId);
  if (typeof agent === "string" && agent.trim() !== "") {
    if (!usable.has(agent)) {
      const names = await namesOf(deps, orgId, [accountId]);
      const list = [...usable].map(([id, name]) => `${id} (${name})`).join(", ");
      throw new CollabError(
        "invalid_assignee",
        `${personLabel(names, accountId)} cannot use agent "${agent}". Agents they may use: ${list || "none"}; pass one of them or null.`,
      );
    }
    return { accountId, agentId: agent };
  }
  const member = await deps.db
    .selectFrom("project_members")
    .select("default_agent_id")
    .where("org_id", "=", orgId)
    .where("project_id", "=", project.id)
    .where("account_id", "=", accountId)
    .executeTakeFirst();
  const fallback = member?.default_agent_id ?? null;
  if (fallback && usable.has(fallback)) return { accountId, agentId: fallback };
  return fallback ? { accountId, agentId: null, dropped: fallback } : { accountId, agentId: null };
}

/** Before a resumed assignment runs: the agent must still be one the person may use. */
async function recheckAgent(deps: ToolDeps, orgId: string, target: Target): Promise<void> {
  if (!target.agentId) return;
  const usable = await usableAgents(deps.ctx, orgId, target.accountId);
  if (!usable.has(target.agentId)) {
    throw new CollabError(
      "invalid_assignee",
      `The responsible person can no longer use agent "${target.agentId}".`,
    );
  }
}

/** "Zhang and their agent Engineer agent" / "Zhang without an agent". */
async function targetPhrase(deps: ToolDeps, orgId: string, target: Target): Promise<string> {
  const names = await namesOf(deps, orgId, [target.accountId]);
  const who = names.get(target.accountId) ?? target.accountId;
  if (!target.agentId) return `${who} without an agent`;
  const agents = await usableAgents(deps.ctx, orgId, target.accountId);
  return `${who} and their agent ${agents.get(target.agentId) ?? target.agentId}`;
}

/** Asks the conversation's person to confirm handing work to someone else. */
function confirmForm(question: string, target: Target): InputRequired {
  const state: ConfirmState = { confirm: "assign", target };
  return {
    kind: "input_required",
    form: {
      title: { zh: "确认指派", en: "Confirm assignment" },
      body: question,
      fields: [
        {
          key: "confirm",
          label: { zh: "指派给他人", en: "Assign to someone else" },
          schema: { type: "boolean" },
          required: true,
          choices: [
            { value: true, label: { zh: "指派", en: "Assign" } },
            { value: false, label: { zh: "取消", en: "Cancel" } },
          ],
        },
      ],
    },
    state,
  };
}

/** The confirmed target of a resumed call; null when the person declined. */
function resumed(call: ToolCallContext): Target | null {
  const resume = call.resume;
  if (!resume) throw new Error("not resumed");
  const state = resume.state as ConfirmState | null;
  if (state?.confirm !== "assign") {
    throw new ToolError(
      "The confirmation state is missing. Call the tool again to ask the user once more.",
    );
  }
  if (resume.answer === null) {
    throw new ToolError(
      "The user did not answer the assignment question. Ask the user whether to assign it, then call the tool again.",
    );
  }
  return resume.answer.confirm === true ? state.target : null;
}

const droppedNote = (t: Target) =>
  t.dropped
    ? ` The member's default agent ${t.dropped} was left out: they can no longer use it.`
    : "";

/** Links of the item, both directions, with the other item's key (hidden ones are not named). */
async function linksOf(deps: ToolDeps, orgId: string, person: string, item: Item) {
  const side = (outgoing: boolean) =>
    deps.db
      .selectFrom("item_links as l")
      .innerJoin("items as i", "i.id", outgoing ? "l.to_id" : "l.from_id")
      .innerJoin("projects as p", "p.id", "i.project_id")
      .leftJoin("project_members as m", (j) =>
        j.onRef("m.project_id", "=", "p.id").on("m.account_id", "=", person),
      )
      .select(["l.kind", "i.number", "i.title", "i.status_key", "p.key", "m.role"])
      .where("l.org_id", "=", orgId)
      .where(outgoing ? "l.from_id" : "l.to_id", "=", item.id)
      .orderBy("l.created_at")
      .execute();
  const [out, inc] = await Promise.all([side(true), side(false)]);
  const verbs: Record<LinkKind, [string, string]> = {
    blocks: ["blocks", "blocked by"],
    duplicates: ["duplicates", "duplicated by"],
    relates: ["relates to", "relates to"],
  };
  const line = (r: (typeof out)[number], outgoing: boolean) => {
    const other = r.role
      ? `${r.key}-${r.number} ${r.status_key} "${r.title}"`
      : "an item you cannot see";
    return `- ${verbs[r.kind][outgoing ? 0 : 1]} ${other}`;
  };
  return [...out.map((r) => line(r, true)), ...inc.map((r) => line(r, false))];
}

/** The item in full, as item_get returns it. */
async function renderItem(
  deps: ToolDeps,
  orgId: string,
  person: string,
  project: Project,
  item: Item,
): Promise<string> {
  const { db } = deps;
  const statuses = await statusesForType(db, orgId, project.id, item.type);
  const [children, artifacts, decisions, comments, activity, links] = await Promise.all([
    db
      .selectFrom("items")
      .selectAll()
      .where("org_id", "=", orgId)
      .where("parent_id", "=", item.id)
      .orderBy("number")
      .limit(CHILDREN_SHOWN)
      .execute(),
    db
      .selectFrom("artifacts")
      .selectAll()
      .where("org_id", "=", orgId)
      .where("item_id", "=", item.id)
      .orderBy("name")
      .orderBy("version", "desc")
      .limit(ARTIFACTS_SHOWN)
      .execute(),
    db
      .selectFrom("decisions")
      .selectAll()
      .where("org_id", "=", orgId)
      .where("item_id", "=", item.id)
      .where("state", "=", "open")
      .orderBy("created_at")
      .execute(),
    db
      .selectFrom("comments")
      .selectAll()
      .where("org_id", "=", orgId)
      .where("item_id", "=", item.id)
      .orderBy("created_at", "desc")
      .limit(COMMENTS_SHOWN)
      .execute(),
    db
      .selectFrom("activity")
      .selectAll()
      .where("org_id", "=", orgId)
      .where("item_id", "=", item.id)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(ACTIVITY_SHOWN)
      .execute(),
    linksOf(deps, orgId, person, item),
  ]);
  const parent = item.parent_id ? await loadItem(db, orgId, item.parent_id) : null;
  const names = await namesOf(deps, orgId, [
    item.requester_account_id,
    item.responsible_account_id,
    ...decisions.map((d) => d.addressee_account_id),
    ...comments.map((c) => c.author.accountId),
    ...activity.map((a) => a.actor.accountId),
    ...children.map((c) => c.responsible_account_id),
  ]);
  const agents = item.responsible_account_id
    ? await usableAgents(deps.ctx, orgId, item.responsible_account_id).catch(
        () => new Map<string, string>(),
      )
    : new Map<string, string>();
  const key = keyOf(project.key, item);
  const lines = [
    `${key} [${item.type}] "${item.title}" (version ${item.version})`,
    `Project: ${project.key} "${project.name}"`,
    `Status: ${statusLabel(statuses, item.status_key)}; allowed next: ${nextStatuses(statuses, item.status_key).join(", ") || "none"}`,
    `Responsible: ${personLabel(names, item.responsible_account_id)}; agent: ${agentLabel(agents, item.executing_agent_id)}${item.executing_agent_id && item.agent_state ? ` (${item.agent_state})` : ""}`,
    `Requested by: ${personLabel(names, item.requester_account_id)}`,
    `Priority: ${item.priority} (${PRIORITY_NAMES[item.priority] ?? "?"}); labels: ${item.labels.join(", ") || "none"}`,
  ];
  if (parent) lines.push(`Parent: ${keyOf(project.key, parent)} "${parent.title}"`);
  if (Object.keys(item.fields).length > 0) lines.push(`Fields: ${JSON.stringify(item.fields)}`);
  lines.push("", "Description:", item.description || "(none)");
  if (children.length > 0) {
    lines.push("", `Children (${children.length}):`);
    for (const c of children) lines.push(itemLine(project.key, c, names));
  }
  if (links.length > 0) lines.push("", "Links:", ...links);
  if (artifacts.length > 0) {
    lines.push("", "Artifacts:");
    for (const a of artifacts) {
      lines.push(`- "${a.name}" v${a.version} (${a.kind}): ${a.url ?? "stored document"}`);
    }
  }
  if (decisions.length > 0) {
    lines.push("", "Open decisions:");
    for (const d of decisions) {
      const gate = d.gate_target ? `, gate to "${d.gate_target}"` : "";
      lines.push(
        `- ${d.id}: "${d.question}" waiting on ${personLabel(names, d.addressee_account_id)}${d.blocking ? " (blocking)" : ""}${gate}`,
      );
    }
  }
  if (comments.length > 0) {
    lines.push("", `Recent comments (newest first, up to ${COMMENTS_SHOWN}):`);
    for (const c of comments) {
      const body =
        c.body.length > COMMENT_CHARS_SHOWN ? `${c.body.slice(0, COMMENT_CHARS_SHOWN)}…` : c.body;
      lines.push(`- ${c.created_at.toISOString()} ${actorLabel(names, c.author)}: ${body}`);
    }
  }
  if (activity.length > 0) {
    lines.push("", `Activity (newest first, up to ${ACTIVITY_SHOWN}):`);
    for (const a of activity) {
      lines.push(
        `- ${a.created_at.toISOString()} ${actorLabel(names, a.actor)} ${a.kind}${activityDetail(a.kind, a.detail, names)}`,
      );
    }
  }
  return lines.join("\n");
}

function activityDetail(
  kind: string,
  d: Record<string, unknown>,
  names: Map<string, string>,
): string {
  const pair = (p: unknown) => {
    const v = p as { accountId?: string | null; agentId?: string | null } | undefined;
    return `${personLabel(names, v?.accountId ?? null)} / agent ${v?.agentId ?? "none"}`;
  };
  switch (kind) {
    case "status_changed":
      return ` ${String(d.from)} -> ${String(d.to)}${d.auto ? " (automatic)" : ""}`;
    case "assigned":
      return ` from ${pair(d.from)} to ${pair(d.to)}`;
    case "updated":
      return Array.isArray(d.changedFields) ? ` ${d.changedFields.join(", ")}` : "";
    case "gate_requested":
      return ` to "${String(d.to)}", waiting on ${personLabel(names, String(d.addressee))}`;
    case "artifact_attached":
      return ` "${String(d.name)}" v${String(d.version)}`;
    case "linked":
      return ` ${String(d.kind)}`;
    case "default_agent_dropped":
      return ` agent ${String(d.agentId)} for ${personLabel(names, String(d.accountId))}: ${String(d.reason)}`;
    default:
      return "";
  }
}

/** Registers the item tools. */
export function registerItemTools(deps: ToolDeps): void {
  const { ctx, db } = deps;

  ctx.tools.register(
    ITEM_SEARCH,
    guarded(async (input, call) => {
      const person = personOf(call);
      const limit =
        typeof input.limit === "number"
          ? Math.min(Math.max(1, Math.trunc(input.limit)), SEARCH_MAX_LIMIT)
          : SEARCH_DEFAULT_LIMIT;
      let q = db
        .selectFrom("items as i")
        .innerJoin("projects as p", "p.id", "i.project_id")
        .innerJoin("project_members as m", (j) =>
          j.onRef("m.project_id", "=", "p.id").on("m.account_id", "=", person),
        )
        .selectAll("i")
        .select("p.key as project_key")
        .where("i.org_id", "=", call.orgId)
        .where("p.org_id", "=", call.orgId)
        .where("m.org_id", "=", call.orgId);
      const project = optStr(input, "project");
      if (project) q = q.where("p.key", "=", project.trim().toUpperCase());
      const status = optStr(input, "status");
      if (status) q = q.where("i.status_key", "=", status);
      else if (input.includeClosed !== true) q = q.where("i.closed_at", "is", null);
      const type = optStr(input, "type");
      if (type) q = q.where("i.type", "=", type);
      if (input.assignedToMe === true) q = q.where("i.responsible_account_id", "=", person);
      const words = optStr(input, "query")?.trim();
      if (words) {
        const keyMatch = /^([A-Za-z][A-Za-z0-9]{1,9})-([1-9][0-9]{0,8})$/.exec(words);
        if (keyMatch?.[1] && keyMatch[2]) {
          q = q
            .where("p.key", "=", keyMatch[1].toUpperCase())
            .where("i.number", "=", Number(keyMatch[2]));
        } else {
          const pattern = `%${words.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
          q = q.where("i.title", "ilike", pattern);
        }
      }
      const rows = await q.orderBy("i.updated_at", "desc").limit(limit).execute();
      if (rows.length === 0) {
        return result(
          "No items match. Widen the filters (includeClosed, another project), or check project_list for the projects you can see.",
        );
      }
      const names = await namesOf(
        deps,
        call.orgId,
        rows.map((r) => r.responsible_account_id),
      );
      const lines = rows.map((r) => itemLine(r.project_key, r, names));
      const more =
        rows.length === limit ? `\nShowing the first ${limit}; narrow the filters for more.` : "";
      return result(`${rows.length} items:\n${lines.join("\n")}${more}`, {
        zh: `找到 ${rows.length} 个事项`,
        en: `Found ${rows.length} items`,
      });
    }),
  );

  ctx.tools.register(
    ITEM_GET,
    guarded(async (input, call) => {
      const person = personOf(call);
      const { item, project } = await itemByKey(db, call.orgId, person, str(input, "key"));
      const key = keyOf(project.key, item);
      return result(await renderItem(deps, call.orgId, person, project, item), {
        zh: `读取了 ${key}`,
        en: `Read ${key}`,
      });
    }),
  );

  ctx.tools.register(
    ITEM_CREATE,
    guarded(async (input, call) => {
      const person = personOf(call);
      const project = await projectByKey(db, call.orgId, person, str(input, "project"));
      const type = str(input, "type");
      const title = str(input, "title");
      const parentKey = optStr(input, "parent");
      const parent = parentKey
        ? (await itemByKey(db, call.orgId, person, parentKey)).item
        : undefined;

      let target: Target | null = null;
      const responsible = optStr(input, "responsible");
      if (call.resume) {
        target = resumed(call);
        if (!target) {
          return {
            ...result(
              `Not created: the user declined creating "${title}" assigned to someone else. Ask the user who should take it, or create it without a responsible person.`,
            ),
            isError: true,
          };
        }
        await recheckAgent(deps, call.orgId, target);
      } else if (responsible) {
        target = await resolveTarget(deps, call.orgId, project, person, responsible, input.agent);
        if (target.accountId !== person) {
          const phrase = await targetPhrase(deps, call.orgId, target);
          return confirmForm(
            `Create ${type} "${title}" in ${project.key} assigned to ${phrase}?`,
            target,
          );
        }
      } else if (input.agent !== undefined && input.agent !== null) {
        throw new CollabError(
          "invalid_assignee",
          "An agent needs a responsible person. Pass responsible too.",
        );
      } else {
        // Without a responsible, the domain applies the first status's default assignment;
        // agentAllowed drops a default agent the member can no longer use. It is not confirmed,
        // like a transition's handoff: both are configured by the project owner, and only a
        // responsible the agent chose asks. The recipient's acceptance rule (auto / confirm /
        // off) and the kernel's loop guards bound the fan-out.
      }

      const description = optStr(input, "description");
      const item = await writing(deps, call, (actor) =>
        createItem(
          db,
          call.orgId,
          actor,
          {
            projectId: project.id,
            type,
            title,
            ...(description ? { description } : {}),
            ...(parent ? { parentId: parent.id } : {}),
            ...(target
              ? {
                  responsibleAccountId: target.accountId,
                  ...(target.agentId ? { executingAgentId: target.agentId } : {}),
                }
              : {}),
            ...(typeof input.priority === "number" ? { priority: input.priority } : {}),
            ...(Array.isArray(input.labels) ? { labels: input.labels as string[] } : {}),
          },
          { agentAllowed: agentAllowedFor(deps, call.orgId) },
        ),
      );
      const key = keyOf(project.key, item);
      const names = await namesOf(deps, call.orgId, [item.responsible_account_id]);
      const who = item.responsible_account_id
        ? ` Responsible: ${personLabel(names, item.responsible_account_id)}; agent: ${item.executing_agent_id ?? "none"}.`
        : " Unassigned.";
      return result(
        `Created ${key} [${item.type}] "${item.title}" in status ${item.status_key} (version ${item.version}).${who}${target ? droppedNote(target) : await droppedAgentNote(deps, call.orgId, item.id)}`,
        { zh: `创建了 ${key}`, en: `Created ${key}` },
      );
    }),
  );

  ctx.tools.register(
    ITEM_UPDATE,
    guarded(async (input, call) => {
      const person = personOf(call);
      const { item, project } = await itemByKey(db, call.orgId, person, str(input, "key"));
      await assertStillAssigned(deps, call, item);
      const raw = (input.patch ?? {}) as Record<string, unknown>;
      const patch: ItemPatch = {};
      if (typeof raw.title === "string") patch.title = raw.title;
      if (typeof raw.description === "string") patch.description = raw.description;
      if (typeof raw.priority === "number") patch.priority = raw.priority;
      if (Array.isArray(raw.labels)) patch.labels = raw.labels as string[];
      if (raw.fields && typeof raw.fields === "object") {
        patch.fields = raw.fields as Record<string, unknown>;
      }
      if (raw.parent === null) patch.parentId = null;
      else if (typeof raw.parent === "string") {
        patch.parentId = (await itemByKey(db, call.orgId, person, raw.parent)).item.id;
      }
      const after = await writing(deps, call, (actor) =>
        updateItem(db, call.orgId, actor, item.id, int(input, "version"), patch),
      );
      const key = keyOf(project.key, after);
      const unchanged = after.version === item.version ? " Nothing changed." : "";
      return result(`Updated ${key} (version ${after.version}).${unchanged}`, {
        zh: `更新了 ${key}`,
        en: `Updated ${key}`,
      });
    }),
  );

  ctx.tools.register(
    ITEM_TRANSITION,
    guarded(async (input, call) => {
      const person = personOf(call);
      const { item, project } = await itemByKey(db, call.orgId, person, str(input, "key"));
      await assertStillAssigned(deps, call, item);
      const to = str(input, "to");
      const gates = gateNotifier(ctx, call.orgId);
      const out = await writing(deps, call, (actor) =>
        transition(db, call.orgId, actor, item.id, int(input, "version"), to, {
          agentAllowed: agentAllowedFor(deps, call.orgId),
          onGateDecision: gates.onGateDecision,
        }),
      );
      await gates.flush();
      const key = keyOf(project.key, item);
      const statuses = await statusesForType(db, call.orgId, project.id, item.type);
      if ("gate" in out) {
        const now = await loadItem(db, call.orgId, item.id);
        const names = await namesOf(deps, call.orgId, [out.gate.addressee_account_id]);
        const who = names.get(out.gate.addressee_account_id) ?? out.gate.addressee_account_id;
        return result(
          `Gate requested: moving ${key} to ${statusLabel(statuses, to)} needs confirmation, waiting on ${who} (decision ${out.gate.id}). The item stays in ${statusLabel(statuses, now.status_key)} (version ${now.version}). Do not ask again; continue with work that does not depend on the move.`,
          { zh: `${key} 等待 ${who} 确认`, en: `${key} waits on ${who}` },
        );
      }
      const after = out.item;
      let tail = "";
      if (
        after.responsible_account_id !== item.responsible_account_id ||
        after.executing_agent_id !== item.executing_agent_id
      ) {
        const names = await namesOf(deps, call.orgId, [after.responsible_account_id]);
        tail = ` It was handed to ${personLabel(names, after.responsible_account_id)} with agent ${after.executing_agent_id ?? "none"}.`;
        if (after.responsible_account_id !== person || after.executing_agent_id !== call.agentId) {
          tail += " You are no longer assigned to it: stop working on it.";
        }
      }
      if (after.status_key !== to) {
        tail += ` It then moved on to ${statusLabel(statuses, after.status_key)}.`;
      }
      tail += await droppedAgentNote(deps, call.orgId, item.id);
      return result(
        `${key} moved to ${statusLabel(statuses, to)} (version ${after.version}).${tail}`,
        { zh: `${key} 移至 ${to}`, en: `${key} moved to ${to}` },
      );
    }),
  );

  ctx.tools.register(
    ITEM_ASSIGN,
    guarded(async (input, call) => {
      const person = personOf(call);
      const { item, project } = await itemByKey(db, call.orgId, person, str(input, "key"));
      await assertStillAssigned(deps, call, item);
      const key = keyOf(project.key, item);
      const version = int(input, "version");
      let target: Target | null;
      if (call.resume) {
        target = resumed(call);
        if (!target) {
          return {
            ...result(
              `Not assigned: the user declined assigning ${key} to someone else. Ask the user who should take it.`,
            ),
            isError: true,
          };
        }
        await recheckAgent(deps, call.orgId, target);
      } else {
        target = await resolveTarget(
          deps,
          call.orgId,
          project,
          person,
          str(input, "responsible"),
          input.agent,
        );
        if (target.accountId !== person) {
          const phrase = await targetPhrase(deps, call.orgId, target);
          return confirmForm(`Assign ${key} to ${phrase}?`, target);
        }
      }
      const chosen = target;
      const after = await writing(deps, call, (actor) =>
        assign(db, call.orgId, actor, item.id, version, {
          responsibleAccountId: chosen.accountId,
          executingAgentId: chosen.agentId,
        }),
      );
      const phrase = await targetPhrase(deps, call.orgId, chosen);
      const same = after.version === item.version ? " It already was." : "";
      return result(
        `Assigned ${key} to ${phrase} (version ${after.version}).${same}${droppedNote(chosen)}`,
        { zh: `${key} 已指派`, en: `Assigned ${key}` },
      );
    }),
  );

  ctx.tools.register(
    ITEM_COMMENT,
    guarded(async (input, call) => {
      const person = personOf(call);
      const { item, project } = await itemByKey(db, call.orgId, person, str(input, "key"));
      await writing(deps, call, (actor) =>
        comment(db, call.orgId, actor, item.id, str(input, "body"), {
          guard: stillAssignedGuard(deps, call),
        }),
      );
      const key = keyOf(project.key, item);
      return result(`Commented on ${key}.`, { zh: `评论了 ${key}`, en: `Commented on ${key}` });
    }),
  );

  ctx.tools.register(
    ITEM_LINK,
    guarded(async (input, call) => {
      const person = personOf(call);
      const from = await itemByKey(db, call.orgId, person, str(input, "key"));
      const to = await itemByKey(db, call.orgId, person, str(input, "to"));
      const kind = str(input, "kind") as LinkKind;
      await writing(deps, call, (actor) =>
        link(
          db,
          call.orgId,
          actor,
          { fromId: from.item.id, toId: to.item.id, kind },
          { guard: stillAssignedGuard(deps, call) },
        ),
      );
      const a = keyOf(from.project.key, from.item);
      const b = keyOf(to.project.key, to.item);
      return result(`Linked: ${a} ${kind} ${b}.`, {
        zh: `关联了 ${a} 与 ${b}`,
        en: `Linked ${a} and ${b}`,
      });
    }),
  );

  ctx.tools.register(
    ARTIFACT_ATTACH,
    guarded(async (input, call) => {
      const person = personOf(call);
      const { item, project } = await itemByKey(db, call.orgId, person, str(input, "key"));
      const artifact = await writing(deps, call, (actor) =>
        attachArtifact(
          db,
          call.orgId,
          actor,
          item.id,
          { kind: str(input, "kind"), name: str(input, "name"), url: str(input, "url") },
          { guard: stillAssignedGuard(deps, call) },
        ),
      );
      const key = keyOf(project.key, item);
      return result(`Attached "${artifact.name}" v${artifact.version} to ${key}.`, {
        zh: `为 ${key} 附加了「${artifact.name}」`,
        en: `Attached "${artifact.name}" to ${key}`,
      });
    }),
  );
}
