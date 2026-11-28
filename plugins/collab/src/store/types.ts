import type { ColumnType, Generated, Selectable } from "kysely";

type Json<T> = ColumnType<T, string, string>;
/** A jsonb column with a database default: written as a JSON string, optional on insert. */
type JsonDefault<T> = ColumnType<T, string | undefined, string>;

/** Who did something: a person, or an agent acting for a person in a conversation. */
export type Actor =
  | { accountId: string }
  | {
      accountId: string;
      agentId: string;
      conversationId: string;
      /**
       * The kernel's cause handle of the tool call behind the write (`ctx.triggers.causeOf`), kept
       * only on the outbox rows the write owes so their events keep the call's chain depth and
       * self-trigger check; never stored in the item's history.
       */
      causeHandle?: string;
    };

export type ProjectRole = "owner" | "member" | "guest";
export type StatusCategory = "backlog" | "todo" | "in_progress" | "review" | "done" | "canceled";
export type LinkKind = "blocks" | "relates" | "duplicates";
export type DecisionKind = "question" | "gate";
/** What the executing agent is doing on an item (`run.lifecycle`). */
export type AgentState = "working" | "waiting" | "idle" | "declined";
export type DecisionState = "open" | "answered" | "canceled" | "expired";

export interface ProjectsTable {
  id: Generated<string>;
  org_id: string;
  key: string;
  name: string;
  description: Generated<string>;
  archived: Generated<boolean>;
  next_item_number: Generated<number>;
  owner_account_id: string;
  created_at: Generated<Date>;
}

export interface ProjectMembersTable {
  org_id: string;
  project_id: string;
  account_id: string;
  role: ProjectRole;
  function_label: string | null;
  default_agent_id: string | null;
  created_at: Generated<Date>;
}

export interface WorkflowsTable {
  id: Generated<string>;
  org_id: string;
  project_id: string;
  item_type: string;
  created_at: Generated<Date>;
}

export interface StatusesTable {
  id: Generated<string>;
  org_id: string;
  workflow_id: string;
  key: string;
  name_zh: string;
  name_en: string;
  category: StatusCategory;
  position: Generated<number>;
  next_keys: string[] | null;
  gate: Json<unknown> | null;
  default_assignment: Json<unknown> | null;
  created_at: Generated<Date>;
}

export interface ItemTypesTable {
  org_id: string;
  project_id: string;
  key: string;
  name_zh: string;
  name_en: string;
  icon: string | null;
  workflow_id: string | null;
  created_at: Generated<Date>;
}

export interface ItemsTable {
  id: Generated<string>;
  org_id: string;
  project_id: string;
  number: number;
  type: string;
  title: string;
  description: Generated<string>;
  status_key: string;
  requester_account_id: string;
  responsible_account_id: string | null;
  executing_agent_id: string | null;
  priority: Generated<number>;
  labels: Generated<string[]>;
  parent_id: string | null;
  fields: JsonDefault<Record<string, unknown>>;
  version: Generated<number>;
  agent_state: Generated<AgentState | null>;
  agent_conversation_id: Generated<string | null>;
  agent_state_at: Generated<Date | null>;
  assigned_version: Generated<number>;
  closed_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ItemLinksTable {
  org_id: string;
  from_id: string;
  to_id: string;
  kind: LinkKind;
  created_at: Generated<Date>;
}

export interface CommentsTable {
  id: Generated<string>;
  org_id: string;
  item_id: string;
  author: Json<Actor>;
  body: string;
  created_at: Generated<Date>;
}

export interface ActivityTable {
  id: Generated<string>;
  org_id: string;
  item_id: string;
  actor: Json<Actor>;
  kind: string;
  detail: JsonDefault<Record<string, unknown>>;
  notified_at: Generated<Date | null>;
  created_at: Generated<Date>;
}

export interface ArtifactsTable {
  id: Generated<string>;
  org_id: string;
  item_id: string;
  kind: string;
  name: string;
  version: Generated<number>;
  url: string;
  author: Json<Actor>;
  created_at: Generated<Date>;
}

export interface DecisionsTable {
  id: Generated<string>;
  org_id: string;
  item_id: string;
  kind: DecisionKind;
  asker: Json<Actor>;
  addressee_account_id: string;
  question: string;
  options: JsonDefault<unknown[]>;
  recommendation: Json<unknown> | null;
  blocking: Generated<boolean>;
  state: Generated<DecisionState>;
  answer: Json<unknown> | null;
  deadline_at: Date | null;
  gate_target: string | null;
  gate_from: string | null;
  address_gen: Generated<number>;
  stale_inbox_item_ids: Generated<string[]>;
  inbox_item_ids: Generated<string[]>;
  addressees: Generated<string[]>;
  inbox_by_account: JsonDefault<Record<string, Partial<Record<"notify" | "remind", string>>>>;
  notified_at: Date | null;
  reminded_at: Date | null;
  escalated_at: Date | null;
  created_at: Generated<Date>;
  answered_at: Date | null;
}

export interface EventOutboxTable {
  id: Generated<string>;
  org_id: string;
  type: string;
  subject: Json<unknown>;
  facts: JsonDefault<Record<string, unknown>>;
  detail: JsonDefault<Record<string, unknown>>;
  dedupe_key: string;
  audience: Json<unknown> | null;
  actor: Json<Actor>;
  cause_handle: string | null;
  emitted_at: Date | null;
  failed_at: Date | null;
  attempts: Generated<number>;
  created_at: Generated<Date>;
}

/** The tables of the `plugin_collab` schema (`ctx.db` is already scoped to it). */
export interface CollabDatabase {
  projects: ProjectsTable;
  project_members: ProjectMembersTable;
  workflows: WorkflowsTable;
  statuses: StatusesTable;
  item_types: ItemTypesTable;
  items: ItemsTable;
  item_links: ItemLinksTable;
  comments: CommentsTable;
  activity: ActivityTable;
  artifacts: ArtifactsTable;
  decisions: DecisionsTable;
  event_outbox: EventOutboxTable;
}

export type Project = Selectable<ProjectsTable>;
export type ProjectMember = Selectable<ProjectMembersTable>;
export type Status = Selectable<StatusesTable>;
export type Item = Selectable<ItemsTable>;
export type Comment = Selectable<CommentsTable>;
export type ItemLink = Selectable<ItemLinksTable>;
export type Artifact = Selectable<ArtifactsTable>;
export type Decision = Selectable<DecisionsTable>;
export type OutboxRow = Selectable<EventOutboxTable>;
