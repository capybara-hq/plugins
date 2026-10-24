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

/** 对话页右侧「任务」标签的贡献 id。 */
export const TASKS_VIEW = "tasks";

/** 「任务」视图：badge 为「已完成/总数」，主体是一个 checklist（进行中的条目显示 activeForm）。 */
export function tasksView(todos: Todo[]): UiView {
  const done = todos.filter((t) => t.status === "completed").length;
  return {
    badge: `${done}/${todos.length}`,
    blocks: [
      {
        type: "checklist",
        items: todos.map((t) => ({
          text: t.status === "in_progress" ? t.activeForm : t.content,
          status: t.status,
        })),
      },
    ],
  };
}

/** `todo__write` 的处理函数：写入后通知界面刷新「任务」标签（刷新失败不影响写入结果）。 */
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
    await ui
      .invalidate({
        orgId: ctx.orgId,
        conversationId: ctx.conversationId,
        contribution: TASKS_VIEW,
      })
      .catch(() => {});
    return {
      content: [{ type: "text", text: renderTodos(todos) }],
      display: {
        summary: {
          zh: `更新任务清单（${todos.length} 项）`,
          en: `Updated task list (${todos.length} items)`,
        },
      },
    };
  };
}

/**
 * todo 插件：一个工具 `write`（模型可见名 `todo__write`），清单存在本插件 schema，各副本读写一致；
 * 对话页右侧的「任务」标签（视图 `tasks`），写入后经 `ctx.ui.invalidate` 实时刷新。
 */
export default defineExtension({
  name: "todo",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [],
  migrations: "../migrations",
  ui: [{ id: "tasks", title: { zh: "任务", en: "Tasks" }, place: "conversation", kind: "view" }],
  permissions: { tools: ["write"], ui: { views: ["tasks"] } },
  setup(ctx) {
    ctx.tools.register(
      SPEC,
      writeHandler(ctx.db, { invalidate: (target) => ctx.ui.invalidate(target) }),
    );
    ctx.ui.view("tasks", async ({ conversationId }) =>
      tasksView(conversationId === undefined ? [] : await readTodos(ctx.db, conversationId)),
    );
  },
});
