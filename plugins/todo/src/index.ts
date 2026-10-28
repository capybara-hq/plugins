import {
  defineExtension,
  type ExtensionContext,
  ToolError,
  type ToolHandler,
  type ToolSpec,
  type UiView,
} from "@capybara-hq/plugin-sdk";
import { z } from "zod";

type Db = ExtensionContext["db"];

const TodoItem = z.object({
  content: z.string().min(1),
  status: z.enum(["pending", "in_progress", "completed"]),
  activeForm: z.string().min(1),
});
const WriteInput = z.object({ todos: z.array(TodoItem).max(100) });

export type Todo = z.infer<typeof TodoItem>;

const SPEC: ToolSpec = {
  name: "write",
  description:
    "Create and update the task list for the current conversation. Use it for work with three or " +
    "more steps: write the full list first, then call it again to mark items in_progress or " +
    "completed as you go. Each call replaces the whole list, so always send every item. Keep at " +
    "most one item in_progress. Do not use it for a single trivial task.",
  inputSchema: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        maxItems: 100,
        description: "The complete task list, in order.",
        items: {
          type: "object",
          properties: {
            content: {
              type: "string",
              minLength: 1,
              description: 'What needs to be done, in the imperative form, e.g. "Run the tests".',
            },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed"],
              description: "Progress of the item.",
            },
            activeForm: {
              type: "string",
              minLength: 1,
              description:
                'The same task in the present continuous form, e.g. "Running the tests".',
            },
          },
          required: ["content", "status", "activeForm"],
          additionalProperties: false,
        },
      },
    },
    required: ["todos"],
    additionalProperties: false,
  },
  defaultPolicy: "allow",
};

const MARK: Record<Todo["status"], string> = {
  completed: "[x]",
  in_progress: "[>]",
  pending: "[ ]",
};

/** 清单的文本渲染：进行中的条目显示 activeForm，其余显示 content。 */
export function renderTodos(todos: Todo[]): string {
  if (todos.length === 0) return "The todo list is now empty.";
  const lines = todos.map(
    (t) => `${MARK[t.status]} ${t.status === "in_progress" ? t.activeForm : t.content}`,
  );
  return `Todo list updated (${todos.length} items):\n${lines.join("\n")}`;
}

/** 整表覆盖写入一个会话的清单（单条 upsert，多副本并发下最后写入者胜出）。 */
export async function writeTodos(db: Db, conversationId: string, todos: Todo[]): Promise<void> {
  await db
    .insertInto("todos")
    .values({ conversation_id: conversationId, items: JSON.stringify(todos) })
    .onConflict((oc) =>
      oc.column("conversation_id").doUpdateSet((eb) => ({
        items: eb.ref("excluded.items"),
        updated_at: new Date(),
      })),
    )
    .execute();
}

/** 读一个会话的当前清单；没写过返回空表。 */
export async function readTodos(db: Db, conversationId: string): Promise<Todo[]> {
  const row = await db
    .selectFrom("todos")
    .select("items")
    .where("conversation_id", "=", conversationId)
    .executeTakeFirst();
  return row === undefined ? [] : (row.items as Todo[]);
}

/**
 * Snapshots kept per conversation: each write drops the older ones, so the table stays bounded
 * (an older call's card then shows the current list).
 */
export const SNAPSHOTS_PER_CONVERSATION = 50;

/**
 * Stores the list as of one call and drops the conversation's snapshots beyond the latest
 * {@link SNAPSHOTS_PER_CONVERSATION}; returns the snapshot id (the inline card's key).
 */
export async function writeSnapshot(
  db: Db,
  orgId: string,
  conversationId: string,
  todos: Todo[],
): Promise<string> {
  const id = globalThis.crypto.randomUUID();
  await db.transaction().execute(async (t) => {
    await t
      .insertInto("snapshots")
      .values({ id, org_id: orgId, conversation_id: conversationId, items: JSON.stringify(todos) })
      .execute();
    const older = await t
      .selectFrom("snapshots")
      .select("id")
      .where("conversation_id", "=", conversationId)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .offset(SNAPSHOTS_PER_CONVERSATION)
      .execute();
    if (older.length > 0) {
      await t
        .deleteFrom("snapshots")
        .where(
          "id",
          "in",
          older.map((r) => r.id),
        )
        .execute();
    }
  });
  return id;
}

/** The list as of a call, scoped by its conversation; null when there is none. */
export async function readSnapshot(
  db: Db,
  conversationId: string,
  id: string,
): Promise<Todo[] | null> {
  const row = await db
    .selectFrom("snapshots")
    .select("items")
    .where("id", "=", id)
    .where("conversation_id", "=", conversationId)
    .executeTakeFirst();
  return row === undefined ? null : (row.items as Todo[]);
}

/** The right panel (title-bar icon) with the full list. */
export const TASKS_PANEL = "tasks-panel";
/** The "Tasks" section of the properties panel. */
export const TASKS_SECTION = "tasks-section";
/** The inline card under each `todo__write` call. */
export const TASKS_CARD = "tasks-card";
/** The old right-side tab id: an alias of {@link TASKS_PANEL} for one release (remove after). */
export const TASKS_LEGACY = "tasks";
/** Every contribution showing the list (refreshed after a write). */
// capybara:allow-module-state a read-only list of contribution ids, never written
const TASKS_ALL = [TASKS_PANEL, TASKS_SECTION, TASKS_CARD, TASKS_LEGACY] as const;

const label = (t: Todo) => (t.status === "in_progress" ? t.activeForm : t.content);
const badge = (todos: Todo[]) =>
  `${todos.filter((t) => t.status === "completed").length}/${todos.length}`;

/**
 * The panel: badge done/total and a checklist (in-progress items show activeForm); each item's
 * `id` is its index, the anchor the section's open targets scroll to.
 */
export function tasksView(todos: Todo[]): UiView {
  return {
    badge: badge(todos),
    blocks: [
      {
        type: "checklist",
        items: todos.map((t, i) => ({ text: label(t), status: t.status, id: String(i) })),
      },
    ],
  };
}

/** The properties section: badge done/total; every item opens the panel at that item. */
export function tasksSectionView(todos: Todo[]): UiView {
  return {
    badge: badge(todos),
    open: { contribution: TASKS_PANEL },
    blocks: [
      {
        type: "checklist",
        items: todos.map((t, i) => ({
          text: label(t),
          status: t.status,
          open: { contribution: TASKS_PANEL, item: String(i) },
        })),
      },
    ],
  };
}

/** The inline card: the checklist, with ⤢ in its title row opening the panel. */
export function tasksCardView(todos: Todo[]): UiView {
  return {
    badge: badge(todos),
    open: { contribution: TASKS_PANEL },
    blocks: [
      { type: "checklist", items: todos.map((t) => ({ text: label(t), status: t.status })) },
    ],
  };
}

/**
 * `todo__write` 的处理函数：写入后通知界面刷新任务清单的各个位置（刷新失败不影响写入结果），结果带一张
 * 行内卡片（`card`，只给界面显示）。
 */
export function writeHandler(db: Db, ui: Pick<ExtensionContext["ui"], "invalidate">): ToolHandler {
  return async (input, ctx) => {
    const parsed = WriteInput.safeParse(input);
    if (!parsed.success) {
      throw new ToolError(
        "Invalid todos: pass an array of items with content, status and activeForm, " +
          "where status is pending, in_progress or completed.",
      );
    }
    const todos = parsed.data.todos;
    await writeTodos(db, ctx.conversationId, todos);
    const snapshot = await writeSnapshot(db, ctx.orgId, ctx.conversationId, todos);
    for (const contribution of TASKS_ALL) {
      await ui
        .invalidate({ orgId: ctx.orgId, conversationId: ctx.conversationId, contribution })
        .catch(() => {});
    }
    return {
      content: [{ type: "text", text: renderTodos(todos) }],
      display: {
        summary: {
          zh: `更新任务清单（${todos.length} 项）`,
          en: `Updated task list (${todos.length} items)`,
        },
      },
      card: { view: TASKS_CARD, key: snapshot },
    };
  };
}

/**
 * todo 插件：一个工具 `write`（模型可见名 `todo__write`），清单存在本插件 schema，各副本读写一致。
 * 对话页上三个位置（UI refresh B）：右侧面板 `tasks-panel`、属性面板的「任务」小节 `tasks-section`
 * （条目打开面板里的那一项）、每次写入下面的行内卡片 `tasks-card`（shows the list as of that call,
 * from a snapshot row）；旧 id `tasks` 作为面板的别名保留一个版本。
 * 写入后经 `ctx.ui.invalidate` 实时刷新。
 */
const title = { zh: "任务", en: "Tasks" };

export default defineExtension({
  name: "todo",
  version: "0.1.0-rc.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  migrations: "../migrations",
  ui: [
    { id: "tasks-panel", title, place: "panel", kind: "view", icon: "list-checks" },
    { id: "tasks-section", title, place: "section", kind: "view", icon: "list-checks" },
    { id: "tasks-card", title, place: "inline", kind: "view", icon: "list-checks" },
    { id: "tasks", title, place: "conversation", kind: "view", aliasOf: "tasks-panel" },
  ],
  permissions: {
    tools: ["write"],
    ui: { views: ["tasks-panel", "tasks-section", "tasks-card", "tasks"] },
  },
  setup(ctx) {
    ctx.tools.register(
      SPEC,
      writeHandler(ctx.db, { invalidate: (target) => ctx.ui.invalidate(target) }),
    );
    const todosOf = (conversationId: string | undefined) =>
      conversationId === undefined ? Promise.resolve([]) : readTodos(ctx.db, conversationId);
    ctx.ui.view("tasks-panel", async ({ conversationId }) =>
      tasksView(await todosOf(conversationId)),
    );
    ctx.ui.view("tasks-section", async ({ conversationId }) =>
      tasksSectionView(await todosOf(conversationId)),
    );
    // the card shows the list as of its call (the snapshot its key names); old cards without a
    // key, or a snapshot that is gone, fall back to the current list
    ctx.ui.view("tasks-card", async ({ conversationId, card }) => {
      const at =
        conversationId !== undefined && card?.key !== undefined
          ? await readSnapshot(ctx.db, conversationId, card.key)
          : null;
      return tasksCardView(at ?? (await todosOf(conversationId)));
    });
  },
});
