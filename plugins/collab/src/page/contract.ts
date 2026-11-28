/**
 * The contract between the collab pages' server half (`ctx.ui.query` / `ctx.ui.action`, in
 * `src/page/`) and their client half (`src/client/`): the params and result of every query and
 * the payload of every action. Types and constants only, so the client bundle can import it.
 *
 * Conventions:
 * - Times are ISO 8601 strings. Item `version` is the optimistic-lock version every versioned
 *   action sends back.
 * - A query for something the viewer cannot see (not a member of its project) answers
 *   {@link NotFound}, the same as for something that does not exist.
 * - Actions answer only `{ toast?, invalidate? }` (the host passes nothing else to the client).
 *   A toast means the action was refused (keep the dialog open and show it); success answers
 *   only `invalidate`, never a toast (close the dialog). Refusals invalidate too. The inbox
 *   actions (`inbox.answer`, `inbox.stop-agent`) are the exception: inbox buttons show a toast
 *   either way.
 * - Results stay under ~900 KB of UTF-8 JSON: a list that hit the budget sets `truncated`
 *   (show "showing the first N" / open the table), the activity page ends early at its cursor.
 */

/** Text in both UI languages. */
export interface LocalText {
  zh: string;
  en: string;
}

/** An avatar as the kernel gives it (the shape `Avatar` / `PrincipalPicker` take). */
export type AvatarValue = { kind: "preset"; id: string } | { kind: "image"; src: string } | null;

/** A person; `name` falls back to the account id when the kernel does not know them (left the org). */
export interface PersonRef {
  id: string;
  name: string;
  avatar: AvatarValue;
}

/** An agent; `name` falls back to the agent id when it is no longer usable by its person. */
export interface AgentRef {
  id: string;
  name: string;
  avatar: AvatarValue;
}

/** Who did something: a person, or an agent acting for them. */
export interface ActorRef {
  person: PersonRef;
  agent: AgentRef | null;
}

/** The answer of a query for something hidden from the viewer or missing. */
export interface NotFound {
  notFound: true;
}

export type ProjectRole = "owner" | "member" | "guest";
export type StatusCategory = "backlog" | "todo" | "in_progress" | "review" | "done" | "canceled";
export type AgentState = "working" | "waiting" | "idle" | "declined";
export type LinkKind = "blocks" | "relates" | "duplicates";
export type DecisionKind = "question" | "gate";
export type DecisionState = "open" | "answered" | "canceled" | "expired";
/** Priority: 0 none, 1 urgent, 2 high, 3 medium (default), 4 low. */
export type Priority = 0 | 1 | 2 | 3 | 4;

/** Who confirms entry into a gated status (see the domain's `GateRule`). */
export type GateRule =
  | { confirmer: "requester" }
  | { confirmer: "responsible" }
  | { confirmer: "owner" }
  | { confirmer: "member"; accountId: string }
  | { confirmer: "function"; functionLabel: string };

/** Who an item entering a status is handed to (see the domain's `DefaultAssignmentRule`). */
export interface DefaultAssignmentRule {
  accountId?: string;
  functionLabel?: string;
  agentId?: string;
  /** Hand it to the resolved member's default agent. */
  memberAgent?: boolean;
}

/** A project as headers show it. */
export interface ProjectHeader {
  id: string;
  key: string;
  name: string;
  description: string;
  archived: boolean;
  /** The viewer's role in the project. */
  role: ProjectRole;
  owner: PersonRef;
}

/** An item type of a project. */
export interface ItemTypeInfo {
  key: string;
  name: LocalText;
  icon: string | null;
}

/** A status of an item type's workflow, in board order. */
export interface StatusInfo {
  key: string;
  name: LocalText;
  category: StatusCategory;
  /** The statuses an item here may move to (empty: any). */
  next: string[];
  gate: GateRule | null;
  defaultAssignment: DefaultAssignmentRule | null;
}

/** A short reference to another item. */
export interface ItemRef {
  id: string;
  key: string;
  title: string;
  statusKey: string;
  statusName: LocalText;
  statusCategory: StatusCategory;
}

// ---------------------------------------------------------------------------------------------
// Queries of the `projects` component (org.page)
// ---------------------------------------------------------------------------------------------

/** `projects.list`: the projects the viewer is a member of. */
export type ProjectsListParams = Record<string, never>;
export interface ProjectsListResult {
  projects: ProjectRow[];
  /** The viewer may create projects (org members and up; not org guests). */
  canCreate: boolean;
  /** Some projects were left out (size budget). */
  truncated?: boolean;
}
export interface ProjectRow {
  id: string;
  key: string;
  name: string;
  description: string;
  archived: boolean;
  role: ProjectRole;
  owner: PersonRef;
  /** Items not in a done / canceled status. */
  openItems: number;
}

/** Filters the board and the table share; all optional, combined with AND. */
export interface ItemFilter {
  /** Matches the title or the key (case-insensitive substring). */
  q?: string;
  /** An account id, or "me". */
  responsible?: string;
  agent?: string;
  label?: string;
  priority?: Priority;
}

/** `project.board`: one item type's workflow as columns, with its cards. */
export interface ProjectBoardParams {
  /** The project key. */
  project: string;
  /** The item type; default the project's first type. */
  type?: string;
  filter?: ItemFilter;
}
export interface ProjectBoardResult {
  project: ProjectHeader;
  types: ItemTypeInfo[];
  /** The item type shown. */
  type: string;
  columns: BoardColumn[];
  /** At most {@link BOARD_MAX_CARDS}: open items first, then the newest closed ones. */
  cards: BoardCard[];
  /** More items matched than the board shows (use the table). */
  truncated: boolean;
  /** The viewer may create and move items (owner or member, and the project is not archived). */
  canEdit: boolean;
}
export interface BoardColumn extends StatusInfo {
  /**
   * The column has a gate: dropping a card here asks its confirmer instead of moving it, unless
   * the viewer is the confirmer (then the drop moves it). Show a lock.
   */
  locked: boolean;
}
export interface BoardCard {
  id: string;
  key: string;
  title: string;
  statusKey: string;
  priority: Priority;
  labels: string[];
  version: number;
  responsible: PersonRef | null;
  agent: AgentRef | null;
  agentState: AgentState | null;
  parentKey: string | null;
  /** Open decisions of the item (questions and gate requests). */
  openDecisions: number;
  /** The status an open gate request waits to move it to, if any. */
  pendingGate: string | null;
  updatedAt: string;
}

/** `project.items`: the table view, paged. */
export interface ProjectItemsParams {
  project: string;
  /** 1-based. */
  page?: number;
  /** At most {@link ITEMS_MAX_PAGE_SIZE}; default 50. */
  pageSize?: number;
  sort?: { field: ItemSortField; dir: "asc" | "desc" };
  filter?: ItemFilter & { type?: string; status?: string; open?: boolean };
}
export type ItemSortField = "key" | "title" | "status" | "priority" | "updated" | "created";
export interface ProjectItemsResult {
  project: ProjectHeader;
  types: ItemTypeInfo[];
  rows: ItemRow[];
  total: number;
  page: number;
  pageSize: number;
  canEdit: boolean;
  /** The page holds fewer rows than `pageSize` because of the size budget. */
  truncated?: boolean;
}
export interface ItemRow {
  id: string;
  key: string;
  type: string;
  title: string;
  statusKey: string;
  statusName: LocalText;
  statusCategory: StatusCategory;
  priority: Priority;
  labels: string[];
  version: number;
  responsible: PersonRef | null;
  agent: AgentRef | null;
  agentState: AgentState | null;
  updatedAt: string;
  createdAt: string;
}

/** `item.detail`: everything the item page shows except the activity. */
export interface ItemDetailParams {
  /** `<PROJECT>-<n>`. */
  key: string;
}
export interface ItemDetailResult {
  project: ProjectHeader;
  item: ItemDetail;
  type: ItemTypeInfo;
  /** The item type's workflow, in board order. */
  statuses: StatusInfo[];
  parent: ItemRef | null;
  children: ItemRef[];
  links: ItemLinkRow[];
  artifacts: ArtifactRow[];
  /** Newest first: open ones, then up to 20 closed ones. */
  decisions: DecisionRow[];
  canEdit: boolean;
  watching: boolean;
  /** Some decisions, children, links or artifacts were left out (size budget). */
  truncated?: boolean;
}
export interface ItemDetail {
  id: string;
  key: string;
  type: string;
  title: string;
  /** Markdown. */
  description: string;
  statusKey: string;
  priority: Priority;
  labels: string[];
  version: number;
  requester: PersonRef;
  responsible: PersonRef | null;
  agent: AgentRef | null;
  agentState: AgentState | null;
  agentStateAt: string | null;
  /** The conversation the agent last worked in (a link target), if known. */
  agentConversationId: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface ItemLinkRow {
  kind: LinkKind;
  /** `out`: this item → other (e.g. this blocks other); `in`: other → this. */
  direction: "out" | "in";
  item: ItemRef;
}
export interface ArtifactRow {
  id: string;
  kind: string;
  name: string;
  version: number;
  /** An http(s) link. */
  url: string;
  author: ActorRef;
  createdAt: string;
}
export interface DecisionOption {
  id: string;
  label: string;
}
export interface DecisionRow {
  id: string;
  kind: DecisionKind;
  question: string;
  options: DecisionOption[];
  recommendation: { optionId: string; why: string } | null;
  blocking: boolean;
  state: DecisionState;
  asker: ActorRef;
  /** Who it waits on now (re-addressed when they left). */
  addressee: PersonRef;
  answer: { optionId: string | null; text: string | null; by: PersonRef | null } | null;
  /** Gates: the status the request moves the item to. */
  gateTarget: string | null;
  deadlineAt: string | null;
  createdAt: string;
  answeredAt: string | null;
  /** The viewer may answer it now (open, and they are its addressee or a confirmer). */
  canAnswer: boolean;
}

/** `item.activity`: the item's history, newest first, 50 per page. */
export interface ItemActivityParams {
  key: string;
  /** The `next` cursor of the previous page. */
  before?: string;
}
export interface ItemActivityResult {
  entries: ActivityEntry[];
  /** Cursor for older entries (a page may end early at the size budget); null at the start. */
  next: string | null;
}

/** `item.comment`: one comment in full. */
export interface ItemCommentParams {
  key: string;
  commentId: string;
}
export interface ItemCommentResult {
  id: string;
  /** Markdown. */
  body: string;
  author: ActorRef;
  at: string;
}
/** Activity kinds the domain records (others may appear later: render them generically). */
export type ActivityKind =
  | "created"
  | "updated"
  | "status_changed"
  | "assigned"
  | "commented"
  | "linked"
  | "artifact_attached"
  | "gate_requested"
  | "decision_asked"
  | "decision_answered"
  | "decision_canceled"
  | "decision_expired"
  | "default_agent_dropped"
  | "handoff_unresolved"
  | "agent_declined";
export interface ActivityEntry {
  id: string;
  kind: ActivityKind | (string & {});
  actor: ActorRef;
  at: string;
  /** The raw detail the domain stored (status keys, ids, changed fields...). */
  detail: Record<string, unknown>;
  /** `commented`: the comment's Markdown body (at most 4 000 characters, see `clipped`). */
  comment?: string;
  /** The body was cut; `item.comment` with `detail.commentId` returns all of it. */
  clipped?: boolean;
  /**
   * People and agents the detail names (assignment from / to, addressees), resolved for display;
   * keyed by account id / agent id.
   */
  people: Record<string, PersonRef>;
  agents: Record<string, AgentRef>;
}

/** `item.conversations`: the conversations serving the item (metadata only). */
export interface ItemConversationsParams {
  key: string;
}
export interface ItemConversationsResult {
  conversations: ItemConversationRow[];
  truncated?: boolean;
}
export interface ItemConversationRow {
  id: string;
  owner: PersonRef;
  agent: AgentRef;
  state: "idle" | "running" | "waiting";
  lastActivityAt: string;
}

/** `project.settings`: members, types and workflows. */
export interface ProjectSettingsParams {
  project: string;
}
export interface ProjectSettingsResult {
  project: ProjectHeader;
  members: MemberRow[];
  types: TypeSettings[];
  /** The viewer is a project owner (may change everything). */
  canEdit: boolean;
  /** Some members were left out (size budget). */
  truncated?: boolean;
}
export interface MemberRow {
  person: PersonRef;
  role: ProjectRole;
  functionLabel: string | null;
  defaultAgent: AgentRef | null;
  /** The viewer may change this member's default agent (an owner, or the member themselves). */
  canSetAgent: boolean;
}
export interface TypeSettings extends ItemTypeInfo {
  statuses: StatusInfo[];
}

/** `people.search`: people to pick. */
export interface PeopleSearchParams {
  query: string;
  /**
   * With a project key: only its owners and members (who may be responsible for items). Without:
   * any active member of the org (to add to a project).
   */
  project?: string;
  /** Default 20, at most 50. */
  limit?: number;
}
export interface PeopleSearchResult {
  people: PersonRef[];
}

/** `agents.usable`: the agents a (prospective) responsible person may use. */
export interface AgentsUsableParams {
  project: string;
  accountId: string;
}
export interface AgentsUsableResult {
  agents: AgentRef[];
}

// ---------------------------------------------------------------------------------------------
// Queries of the conversation components (item-panel, item-properties) and agent-items
// ---------------------------------------------------------------------------------------------

/** `item.byConversation` (item-panel, item-properties): the item the open conversation serves. */
export type ItemByConversationParams = Record<string, never>;
export interface ItemByConversationResult {
  /** Null when the conversation serves no collab item, or the viewer cannot see it. */
  item: PanelItem | null;
  /** Some open decisions were left out (size budget). */
  truncated?: boolean;
}
export interface PanelItem {
  id: string;
  key: string;
  title: string;
  projectKey: string;
  projectName: string;
  type: ItemTypeInfo;
  statusKey: string;
  statusName: LocalText;
  statusCategory: StatusCategory;
  priority: Priority;
  labels: string[];
  version: number;
  responsible: PersonRef | null;
  agent: AgentRef | null;
  agentState: AgentState | null;
  openDecisions: DecisionRow[];
  canEdit: boolean;
}

/** `agent.items` (agent-items): open items the agent executes, in projects the viewer sees. */
export type AgentItemsParams = Record<string, never>;
export interface AgentItemsResult {
  items: AgentItemRow[];
  truncated?: boolean;
}
export interface AgentItemRow {
  id: string;
  key: string;
  title: string;
  projectKey: string;
  statusKey: string;
  statusName: LocalText;
  statusCategory: StatusCategory;
  responsible: PersonRef | null;
  agentState: AgentState | null;
  updatedAt: string;
}

/** Every query's params and result, by name. */
export interface QueryMap {
  "projects.list": { params: ProjectsListParams; result: ProjectsListResult };
  "project.board": { params: ProjectBoardParams; result: ProjectBoardResult | NotFound };
  "project.items": { params: ProjectItemsParams; result: ProjectItemsResult | NotFound };
  "item.detail": { params: ItemDetailParams; result: ItemDetailResult | NotFound };
  "item.activity": { params: ItemActivityParams; result: ItemActivityResult | NotFound };
  "item.comment": { params: ItemCommentParams; result: ItemCommentResult | NotFound };
  "item.conversations": {
    params: ItemConversationsParams;
    result: ItemConversationsResult | NotFound;
  };
  "project.settings": { params: ProjectSettingsParams; result: ProjectSettingsResult | NotFound };
  "people.search": { params: PeopleSearchParams; result: PeopleSearchResult | NotFound };
  "agents.usable": { params: AgentsUsableParams; result: AgentsUsableResult | NotFound };
  "item.byConversation": { params: ItemByConversationParams; result: ItemByConversationResult };
  "agent.items": { params: AgentItemsParams; result: AgentItemsResult };
}
export type QueryName = keyof QueryMap;

// ---------------------------------------------------------------------------------------------
// Actions (`useAction()(actionId, { payload })`). The projects page, item-panel and
// item-properties all accept every action below.
// ---------------------------------------------------------------------------------------------

/** `project.create`: the viewer becomes its owner. Navigate to `project=<key>` on success. */
export interface ProjectCreatePayload {
  /** 2–10 upper-case letters or digits, starting with a letter. */
  key: string;
  name: string;
  description?: string;
}

/** `item.create`. The agent must be one the responsible person may use. */
export interface ItemCreatePayload {
  projectId: string;
  type: string;
  title: string;
  description?: string;
  parentId?: string;
  /** Omitted: the first status's default assignment applies. */
  responsibleAccountId?: string;
  /** Needs `responsibleAccountId`. */
  agentId?: string;
  priority?: Priority;
  labels?: string[];
}

/** `item.update`: the item's own fields, optionally with a reassignment (never the status). */
export interface ItemUpdatePayload {
  itemId: string;
  version: number;
  title?: string;
  description?: string;
  priority?: Priority;
  labels?: string[];
  /** Null removes the parent. */
  parentId?: string | null;
  /**
   * Also reassign, like `item.assign`, after the field update and at the version it returned
   * (one action, no version arithmetic on the client). Omitted: the assignment stays.
   */
  responsibleAccountId?: string;
  /** Only with `responsibleAccountId`; null or omitted: no agent. Must be usable by that person. */
  agentId?: string | null;
}

/**
 * `item.move`: a drag to another column. Into a gated column: the confirmer's drop moves it;
 * anyone else's drop asks the confirmer (toast says so) and the item stays.
 */
export interface ItemMovePayload {
  itemId: string;
  version: number;
  /** The target status key. */
  to: string;
}

/** `item.assign`: the person clicking is the consent; no further confirm. */
export interface ItemAssignPayload {
  itemId: string;
  version: number;
  responsibleAccountId: string;
  /** Null: no agent. Must be one the responsible person may use. */
  agentId: string | null;
}

/** `item.comment`: Markdown. */
export interface ItemCommentPayload {
  itemId: string;
  body: string;
}

/** `gate.confirm`: approve or reject the gate request (confirmers only). */
export interface GateConfirmPayload {
  decisionId: string;
  approve: boolean;
}

/** `decision.answer`: an option, free text, or both (addressee only). */
export interface DecisionAnswerPayload {
  decisionId: string;
  optionId?: string;
  text?: string;
}

/** `inbox.answer` (also what inbox buttons send). */
export interface InboxAnswerPayload {
  decisionId: string;
  optionId: string;
}

/** `inbox.stop-agent`: take the agent off the item (responsible person or project owner). */
export interface StopAgentPayload {
  itemId: string;
  agentId: string;
}

/** One status's gate and default assignment in `settings.save`. */
export interface StatusSettingsPatch {
  type: string;
  key: string;
  /** Omitted: unchanged; null: no gate. */
  gate?: GateRule | null;
  /** Omitted: unchanged; null: no default assignment. */
  defaultAssignment?: DefaultAssignmentRule | null;
}

/** `settings.save` (project owners): the project's name, description, archive flag and gates. */
export interface SettingsSavePayload {
  projectId: string;
  name?: string;
  description?: string;
  archived?: boolean;
  statuses?: StatusSettingsPatch[];
}

/** `member.add` (project owners): an org member joins, or changes role. */
export interface MemberAddPayload {
  projectId: string;
  accountId: string;
  role: ProjectRole;
  functionLabel?: string | null;
}

/** `member.remove` (project owners): their open items go back to the project owner. */
export interface MemberRemovePayload {
  projectId: string;
  accountId: string;
}

/**
 * `member.function`: the function label (project owners) and the default agent (owners, or the
 * member for themselves; must be one the member may use). Omitted fields stay.
 */
export interface MemberFunctionPayload {
  projectId: string;
  accountId: string;
  functionLabel?: string | null;
  defaultAgentId?: string | null;
}

/** Every action's payload, by id. */
export interface ActionMap {
  "project.create": ProjectCreatePayload;
  "item.create": ItemCreatePayload;
  "item.update": ItemUpdatePayload;
  "item.move": ItemMovePayload;
  "item.assign": ItemAssignPayload;
  "item.comment": ItemCommentPayload;
  "item.watch": { itemId: string; watching: boolean };
  "gate.confirm": GateConfirmPayload;
  "decision.answer": DecisionAnswerPayload;
  "inbox.answer": InboxAnswerPayload;
  "inbox.stop-agent": StopAgentPayload;
  "settings.save": SettingsSavePayload;
  "member.add": MemberAddPayload;
  "member.remove": MemberRemovePayload;
  "member.function": MemberFunctionPayload;
}
export type ActionId = keyof ActionMap;

/** The most cards `project.board` returns. */
export const BOARD_MAX_CARDS = 500;
/** The largest `project.items` page. */
export const ITEMS_MAX_PAGE_SIZE = 100;
/** Entries per `item.activity` page. */
export const ACTIVITY_PAGE_SIZE = 50;

/** The queries an item change refetches (actions put these in `invalidate`). */
// capybara:allow-module-state read-only constant
export const ITEM_QUERIES: readonly QueryName[] = [
  "project.board",
  "project.items",
  "item.detail",
  "item.activity",
  "item.byConversation",
  "agent.items",
  "projects.list",
];
