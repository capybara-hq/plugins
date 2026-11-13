import {
  CONTEXT_EXTENSION_POINT,
  type ContextProvider,
  defineExtension,
} from "@capybara-hq/plugin-sdk";
import { provideMemoryContext } from "./context.js";
import { EMBED_QUEUE, type EmbedJob, runEmbedJob } from "./embed.js";
import { registerTools } from "./tools.js";

/**
 * Memory for agents, modelled on Claude Code's memory: each (agent, member) pair in an org keeps
 * memories under `<type>/…/<name>.md`; at run start the model gets an index of them (`context@1`),
 * and reads, searches and changes them with the memory tools. Only in one-to-one conversations
 * (web and channel DMs) of non-guest members, with the conversation's owner.
 */
export default defineExtension({
  name: "memory",
  version: "0.1.0-rc.0",
  sdk: "^0.1.0-rc.19",
  provides: [CONTEXT_EXTENSION_POINT],
  permissions: {
    tools: ["view", "search", "write", "edit", "delete"],
    hooks: ["org.member_removed", "agent.deleted", "org.deleted"],
    models: [
      {
        purpose: "memory.embed",
        kind: "embedding",
        label: { zh: "记忆检索", en: "Memory search" },
      },
    ],
  },
  migrations: "../migrations",
  setup(ctx) {
    // (re-)embeds one memory: after a failed or slow embedding at write, and for stale vectors
    ctx.queue.define<EmbedJob>(EMBED_QUEUE, (job) => runEmbedJob(ctx, job));
    // view, search, write, edit, delete (declared in permissions.tools; specs in tools.ts)
    registerTools(ctx);
    const provider: ContextProvider = { provide: (req) => provideMemoryContext(ctx.db, req) };
    ctx.provide(CONTEXT_EXTENSION_POINT, provider);
  },
});
