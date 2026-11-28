import type {
  ExtensionContext,
  FormAnswer,
  InputRequired,
  ToolCallContext,
  ToolHandler,
  ToolResult,
  ToolSpec,
} from "@capybara-hq/plugin-sdk";
import { ToolError } from "@capybara-hq/plugin-sdk";
import type { CollabDb } from "../../src/store/db.js";
import { registerTools } from "../../src/tools/index.js";

/** Agents each account may use (`ctx.agents.usableBy`), by account id. */
export type UsableAgents = Record<string, { id: string; name: string }[]>;

/** Display names `ctx.people.get` returns, by account id. */
export type People = Record<string, string>;

export interface Harness {
  specs: Map<string, ToolSpec>;
  /** What the tools emitted through `ctx.triggers.emit`. */
  emitted: { type: string; cause: unknown }[];
  /** The work conversations `ctx.conversations.bySubject` returns, by item id. */
  work: Map<string, string[]>;
  /** Calls a tool as `call` (an agent in a conversation of `call.ownerAccountId`). */
  run(
    name: string,
    input: unknown,
    call: Partial<ToolCallContext> & { orgId: string; ownerAccountId: string; agentId: string },
  ): Promise<ToolResult | InputRequired>;
}

/** The plugin's tools registered on a stand-in ctx: real database, fake kernel reads. */
export function toolHarness(db: CollabDb, agents: UsableAgents, people: People): Harness {
  const registered = new Map<string, { spec: ToolSpec; handler: ToolHandler }>();
  const emitted: { type: string; cause: unknown }[] = [];
  const work = new Map<string, string[]>();
  const ctx = {
    db,
    tools: {
      register: (spec: ToolSpec, handler: ToolHandler) => {
        registered.set(spec.name, { spec, handler });
      },
    },
    agents: {
      usableBy: async ({ accountId }: { orgId: string; accountId: string }) =>
        (agents[accountId] ?? []).map((a) => ({ ...a, avatar: null })),
    },
    conversations: {
      bySubject: async ({ subject }: { orgId: string; subject: { kind: string; id: string } }) =>
        (subject.kind === "item" ? (work.get(subject.id) ?? []) : []).map((id) => ({
          id,
          ownerAccountId: "x",
          agentId: "x",
          state: "idle",
          lastActivityAt: new Date().toISOString(),
        })),
    },
    people: {
      get: async ({ accountIds }: { orgId: string; accountIds: string[] }) =>
        accountIds
          .filter((id) => people[id] !== undefined)
          .map((id) => ({ id, name: people[id] as string, avatar: null, active: true })),
      search: async () => [],
    },
    triggers: {
      emit: async (req: { type: string; cause: unknown }) => {
        emitted.push({ type: req.type, cause: req.cause });
        return { eventId: "e", duplicate: false };
      },
      causeOf: async () => "handle",
    },
    queue: { define() {}, add: async () => {} },
    log: { info() {}, warn() {}, error() {} },
  } as unknown as ExtensionContext;
  registerTools(ctx);
  const specs = new Map([...registered].map(([k, v]) => [k, v.spec]));
  return {
    specs,
    emitted,
    work,
    async run(name, input, call) {
      const tool = registered.get(name);
      if (!tool) throw new Error(`no tool ${name}`);
      return tool.handler(input, {
        accountId: call.ownerAccountId,
        callId: "call-1",
        conversationId: "conv-1",
        rootConversationId: "conv-1",
        signal: new AbortController().signal,
        ...call,
      } as ToolCallContext);
    },
  };
}

/** The text of a tool result (fails the test on an InputRequired). */
export function text(result: ToolResult | InputRequired): string {
  if ("kind" in result) throw new Error("expected a result, got input_required");
  return result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
}

/** The ToolError message of a call, or "ok". */
export async function errorOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    if (e instanceof ToolError) return e.message;
    throw e;
  }
}

/** A resume answer for the assignment confirmation. */
export function confirmed(
  state: unknown,
  confirm: boolean,
): { state: unknown; answer: FormAnswer; outcome: "answered" } {
  return { state, answer: { confirm }, outcome: "answered" };
}

/** The version a tool reported (`version N`). */
export function versionIn(out: string): number {
  const m = /version (\d+)/.exec(out);
  if (!m?.[1]) throw new Error(`no version in: ${out}`);
  return Number(m[1]);
}
