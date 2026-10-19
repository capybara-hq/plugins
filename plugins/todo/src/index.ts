import {
  definePlugin,
  type PluginContext,
  ToolError,
  type ToolHandler,
  type ToolSpec,
} from "@capybara-hq/plugin-sdk";
import { z } from "zod";

type Db = PluginContext["db"];

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

/** `todo__write` 的处理函数。 */
export function writeHandler(db: Db): ToolHandler {
  return async (input, ctx) => {
    const parsed = WriteInput.safeParse(input);
    if (!parsed.success) {
      throw new ToolError(
        "Invalid todos: pass an array of items with content, status and activeForm, " +
          "where status is pending, in_progress or completed.",
      );
    }
    await writeTodos(db, ctx.conversationId, parsed.data.todos);
    return { content: [{ type: "text", text: renderTodos(parsed.data.todos) }] };
  };
}

/** todo 插件：一个工具 `write`（模型可见名 `todo__write`），清单存在本插件 schema，各副本读写一致。 */
export default definePlugin({
  name: "todo",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [],
  migrations: "../migrations",
  permissions: { tools: ["write"] },
  setup(ctx) {
    ctx.tools.register(SPEC, writeHandler(ctx.db));
  },
});
