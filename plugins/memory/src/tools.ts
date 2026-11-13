import {
  type ExtensionContext,
  type ToolCallContext,
  ToolError,
  type ToolHandler,
  type ToolResult,
  type ToolSpec,
} from "@capybara-hq/plugin-sdk";
import { EMBED_RETRY_DELAY_MS, embedMemory, enqueueEmbed, type MemoryDeps } from "./embed.js";
import { MEMORY_TYPES, parsePath } from "./paths.js";
import { MAX_SEARCH_LIMIT, search } from "./search.js";
import {
  edit,
  get,
  linksOf,
  list,
  MemoryNotFoundError,
  MemoryPathError,
  type MemoryRow,
  type Owner,
  put,
  remove,
  touch,
} from "./store.js";

/**
 * The memory tools (`plugin__memory__<name>`). The owner of every read and write is taken from the
 * call context (org, agent, and the conversation's owner, who must be the caller), never from the
 * input. The kernel offers the tools only in web and channel DM conversations; the handlers check
 * again (defence in depth).
 */

/** The refusal outside a one-to-one conversation with its owner. */
export const NOT_AVAILABLE =
  "Memory is only available in one-to-one conversations with their owner. Do not call the memory tools in this conversation; answer without them.";

/** How long `write` / `edit` wait for the embedding before leaving it to the queue. */
export const EMBED_WAIT_MS = 5_000;

/** Default number of search hits. */
const DEFAULT_SEARCH_LIMIT = 10;

/**
 * The owner whose memories a call may use: refuses (with {@link NOT_AVAILABLE}) outside web and
 * channel DM conversations, for guests, and when the caller is not the conversation's owner.
 */
export function ownerOf(call: ToolCallContext): Owner {
  const oneToOne = call.source === "web" || call.source === "channel_dm";
  if (
    !oneToOne ||
    call.role === undefined ||
    call.role === "guest" ||
    call.ownerAccountId !== call.accountId
  ) {
    throw new ToolError(NOT_AVAILABLE);
  }
  return { orgId: call.orgId, agentId: call.agentId, accountId: call.accountId };
}

const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });

function field(input: unknown, key: string): unknown {
  return typeof input === "object" && input !== null
    ? (input as Record<string, unknown>)[key]
    : undefined;
}

function str(input: unknown, key: string): string {
  const v = field(input, key);
  if (typeof v !== "string") {
    throw new ToolError(`Invalid input: pass "${key}" as a string.`);
  }
  return v;
}

function optStr(input: unknown, key: string): string | undefined {
  return field(input, key) === undefined ? undefined : str(input, key);
}

const PATH_FIELD = {
  type: "string",
  description:
    'Memory path "<type>/<name>.md", the type being user, feedback, project or reference; deeper directories are allowed. Examples: "feedback/reply-in-chinese.md", "project/github/probe.md".',
};

const VIEW: ToolSpec = {
  name: "view",
  title: "View memory",
  description:
    "Read a memory in full, or list a memory directory. " +
    'Pass a memory path (e.g. "feedback/reply-in-chinese.md") to get its description, body and links ' +
    '(links to memories not written yet are marked); pass a directory (e.g. "project/") or "/" to list ' +
    "what it contains. Use it before relying on a memory whose index line looks relevant, and before " +
    "editing one. Reading a memory counts as a recall.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          'A memory path like "user/role.md", a directory like "project/" or "project/github/", or "/" for the root.',
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  defaultPolicy: "allow",
  keyArgs: ["path"],
  sources: ["web", "channel_dm"],
};

const SEARCH: ToolSpec = {
  name: "search",
  title: "Search memories",
  description:
    "Search your memories of this member by words and by meaning. " +
    "Returns matching memory paths with their description and a snippet, best first. Use it to find " +
    "memories not listed in the index, and to check for an existing memory on a topic before writing " +
    "a new one. Each returned hit counts as a recall.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        minLength: 1,
        description: 'Words or a question, in any language, e.g. "reply language" or "部署流程".',
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: MAX_SEARCH_LIMIT,
        description: `Most hits to return (1 to ${MAX_SEARCH_LIMIT}, default ${DEFAULT_SEARCH_LIMIT}).`,
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  defaultPolicy: "allow",
  keyArgs: ["query"],
  sources: ["web", "channel_dm"],
};

const WRITE: ToolSpec = {
  name: "write",
  title: "Write memory",
  description:
    "Create or replace a memory about this member, kept across conversations with this agent. " +
    "Save when the member asks you to remember something, or on your own when you learn something " +
    "that will help in later conversations: who they are (user/), how they want work done (feedback/), " +
    "ongoing work and its constraints (project/), where external things live (reference/). Keep one " +
    "fact or topic per memory; check the index or search first and update an existing memory instead " +
    "of writing a duplicate. For feedback and project memories, lead with the rule or fact, then a " +
    '"Why:" line and a "How to apply:" line; write absolute dates. Link related memories with ' +
    "[[name]] or [[type/path.md]]. Do not save secrets, or what only this conversation needs. " +
    "Writing an existing path replaces its description and body.",
  inputSchema: {
    type: "object",
    properties: {
      path: PATH_FIELD,
      description: {
        type: "string",
        description:
          "One line (at most 200 characters) saying what the memory is and when it matters; it is the memory's index line.",
      },
      body: {
        type: "string",
        description:
          "The memory in Markdown, at most 8 KB. Short and specific; links as [[name]] or [[type/path.md]].",
      },
    },
    required: ["path", "description", "body"],
    additionalProperties: false,
  },
  defaultPolicy: "allow",
  keyArgs: ["path"],
  sources: ["web", "channel_dm"],
};

const EDIT: ToolSpec = {
  name: "edit",
  title: "Edit memory",
  description:
    "Change part of an existing memory: replaces the exact text old with new in its body, and the " +
    "description when given. old must occur exactly once (include surrounding text to make it unique); " +
    "view the memory first to copy the text. Use it to correct or extend a memory, or to merge another " +
    "memory into it; use write to replace the whole memory.",
  inputSchema: {
    type: "object",
    properties: {
      path: PATH_FIELD,
      old: {
        type: "string",
        minLength: 1,
        description: "The exact text to replace, once in the body.",
      },
      new: { type: "string", description: "The replacement text (may be empty to remove old)." },
      description: {
        type: "string",
        description:
          "A new one-line description (at most 200 characters); omit to keep the current one.",
      },
    },
    required: ["path", "old", "new"],
    additionalProperties: false,
  },
  defaultPolicy: "allow",
  keyArgs: ["path"],
  sources: ["web", "channel_dm"],
};

const DELETE: ToolSpec = {
  name: "delete",
  title: "Delete memory",
  description:
    "Delete a memory that is wrong, outdated or merged into another. Links to it from other memories " +
    "become links to a memory not written yet. Do not use it to change a memory; use edit or write.",
  inputSchema: {
    type: "object",
    properties: { path: PATH_FIELD },
    required: ["path"],
    additionalProperties: false,
  },
  annotations: { destructiveHint: true },
  defaultPolicy: "allow",
  keyArgs: ["path"],
  sources: ["web", "channel_dm"],
};

/**
 * Embeds a written memory, waiting at most `waitMs` (and never past the call's abort). A slower
 * embedding is left to the `memory-embed` queue; the memory is saved either way.
 */
async function embedWithin(
  ctx: MemoryDeps,
  owner: Owner,
  row: MemoryRow,
  call: ToolCallContext,
  waitMs: number,
): Promise<void> {
  const signal = AbortSignal.any([call.signal, AbortSignal.timeout(waitMs)]);
  const embedded = embedMemory(ctx, owner, row, { signal }).then(
    () => true,
    () => false,
  );
  const stopped = new Promise<boolean>((resolve) => {
    if (signal.aborted) resolve(false);
    else signal.addEventListener("abort", () => resolve(false), { once: true });
  });
  if (await Promise.race([embedded, stopped])) return;
  try {
    await enqueueEmbed(ctx.queue, owner, row.id, EMBED_RETRY_DELAY_MS);
  } catch {
    // the memory is saved; a later search re-embeds memories without a vector
  }
}

function plural(n: number): string {
  return n === 1 ? "1 memory" : `${n} memories`;
}

/** Lists the entries directly under `dir` ("" = the root). */
async function viewDirectory(ctx: MemoryDeps, owner: Owner, dir: string): Promise<string | null> {
  const rows = await list(ctx.db, owner, dir);
  if (rows.length === 0) return null;
  const prefix = dir === "" ? "" : `${dir}/`;
  const dirs = new Map<string, number>();
  const files: string[] = [];
  for (const r of rows) {
    const rest = r.path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) files.push(`${r.path} — ${r.description}`);
    else {
      const sub = `${prefix}${rest.slice(0, slash)}/`;
      dirs.set(sub, (dirs.get(sub) ?? 0) + 1);
    }
  }
  const order = (d: string) => {
    const i = (MEMORY_TYPES as readonly string[]).indexOf(d.slice(0, -1));
    return i === -1 ? MEMORY_TYPES.length : i;
  };
  const dirLines = [...dirs.entries()]
    .sort(([a], [b]) => (dir === "" ? order(a) - order(b) : a.localeCompare(b)))
    .map(([d, n]) => `${d} (${plural(n)})`);
  return [...dirLines, ...files].join("\n");
}

async function viewMemory(ctx: MemoryDeps, owner: Owner, row: MemoryRow): Promise<string> {
  const links = await linksOf(ctx.db, owner, row.id);
  await touch(ctx.db, owner, [row.id]);
  const lines = [`path: ${row.path}`, `description: ${row.description}`, "", row.body];
  if (links.length > 0) {
    lines.push("", "Links:");
    for (const l of links) {
      lines.push(l.target === null ? `→ ${l.path} (not written yet)` : `→ ${l.target.path}`);
    }
  }
  return lines.join("\n");
}

function viewHandler(ctx: MemoryDeps): ToolHandler {
  return async (input, call) => {
    const owner = ownerOf(call);
    const raw = str(input, "path").trim();
    const dir = raw.replace(/[A-Z]/g, (c) => c.toLowerCase()).replace(/^\/+|\/+$/g, "");
    if (dir === "") {
      return text((await viewDirectory(ctx, owner, "")) ?? "No memories yet.");
    }
    if (!raw.endsWith("/")) {
      const row = await get(ctx.db, owner, raw);
      if (row !== null) return text(await viewMemory(ctx, owner, row));
    }
    const listing = await viewDirectory(ctx, owner, dir);
    if (listing !== null) return text(listing);
    if (raw.endsWith("/")) {
      throw new ToolError(
        `No memories under "${dir}/". Use plugin__memory__view with "/" to see the directories that have memories.`,
      );
    }
    const p = parsePath(raw);
    if (!p.ok) throw new MemoryPathError(p.error);
    throw new MemoryNotFoundError(p.path);
  };
}

function searchHandler(ctx: MemoryDeps): ToolHandler {
  return async (input, call) => {
    const owner = ownerOf(call);
    const query = str(input, "query");
    const rawLimit = field(input, "limit");
    const limit = typeof rawLimit === "number" ? rawLimit : DEFAULT_SEARCH_LIMIT;
    const hits = await search(ctx, ctx.db, owner, query, limit, { signal: call.signal });
    if (hits.length === 0) {
      return text(
        `No memories match "${query}". Try other words, or use plugin__memory__view with "/" to browse them.`,
      );
    }
    return text(
      hits
        .map((h, i) => `${i + 1}. ${h.row.path} — ${h.row.description}\n   ${h.snippet}`)
        .join("\n"),
    );
  };
}

function writeHandler(ctx: MemoryDeps, waitMs: number): ToolHandler {
  return async (input, call) => {
    const owner = ownerOf(call);
    const { row, created } = await put(ctx.db, owner, {
      path: str(input, "path"),
      description: str(input, "description"),
      body: str(input, "body"),
      conversationId: call.conversationId,
    });
    await embedWithin(ctx, owner, row, call, waitMs);
    const dangling = (await linksOf(ctx.db, owner, row.id))
      .filter((l) => l.target === null)
      .map((l) => l.path);
    let out = `${created ? "Created" : "Updated"} memory ${row.path}.`;
    if (dangling.length > 0) {
      out += `\nLinks to memories not written yet: ${dangling.join(", ")}. Write them when there is something worth remembering, or remove the links.`;
    }
    return text(out);
  };
}

function editHandler(ctx: MemoryDeps, waitMs: number): ToolHandler {
  return async (input, call) => {
    const owner = ownerOf(call);
    const row = await edit(
      ctx.db,
      owner,
      str(input, "path"),
      str(input, "old"),
      str(input, "new"),
      optStr(input, "description"),
    );
    await embedWithin(ctx, owner, row, call, waitMs);
    return text(`Edited memory ${row.path}.`);
  };
}

function deleteHandler(ctx: MemoryDeps): ToolHandler {
  return async (input, call) => {
    const owner = ownerOf(call);
    const raw = str(input, "path");
    const p = parsePath(raw);
    if (!p.ok) throw new MemoryPathError(p.error);
    if (!(await remove(ctx.db, owner, p.path))) throw new MemoryNotFoundError(p.path);
    return text(`Deleted memory ${p.path}.`);
  };
}

/** Registers the five memory tools (call from `setup`). */
export function registerTools(
  ctx: Pick<ExtensionContext, "db" | "models" | "queue" | "tools">,
  opts: { embedWaitMs?: number } = {},
): void {
  const waitMs = opts.embedWaitMs ?? EMBED_WAIT_MS;
  ctx.tools.register(VIEW, viewHandler(ctx));
  ctx.tools.register(SEARCH, searchHandler(ctx));
  ctx.tools.register(WRITE, writeHandler(ctx, waitMs));
  ctx.tools.register(EDIT, editHandler(ctx, waitMs));
  ctx.tools.register(DELETE, deleteHandler(ctx));
}
