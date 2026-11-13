import type { ContextRequest, ContextResult, ExtensionContext } from "@capybara-hq/plugin-sdk";
import { type IndexEntry, indexEntries, type Owner, rememberOwner } from "./store.js";

/**
 * The memory context (`context@1`): at each run start, the guidance below and the index of the
 * owner's memories. The text depends only on the memories' paths, descriptions, types and recall
 * order (no timestamps, a stable sort), so it stays byte-identical while nothing changed and the
 * kernel records it again only when the index really changed.
 */

type Db = ExtensionContext["db"];

/** Most memory lines in the index. */
export const INDEX_MAX_LINES = 200;
/** Largest index, in UTF-8 bytes (memory lines and the "N more" line). */
export const INDEX_MAX_BYTES = 16 * 1024;

/** The fixed explanation of the memory system for the model (modelled on Claude Code's). */
export const GUIDANCE = `# Memory

You have a persistent memory of this member, kept across your conversations with them. Use it to remember who they are, how they want work done, and the context of their work, so you do not have to ask again. Each agent keeps separate memories for each member; these are yours with this member.

## Types
Each memory is one file at "<type>/<name>.md" (deeper directories are fine, e.g. "project/github/probe.md"):
- user/: who the member is: role, expertise, responsibilities, preferences about themselves.
- feedback/: how they want you to work: corrections and confirmed preferences. Lead with the rule, then a "Why:" line and a "How to apply:" line.
- project/: ongoing work, goals, decisions, constraints and deadlines that are not written down elsewhere. Lead with the fact, then "Why:" and "How to apply:" lines. Write absolute dates (2026-03-05), never relative ones.
- reference/: where external things live (systems, documents, dashboards, channels) and what they are for.

## When to save
- When the member asks you to remember something, save it right away.
- On your own, when you learn something that will help in a later conversation: a correction, a confirmed preference, a fact about them or their work that is not obvious from elsewhere.
- Do not save what only this conversation needs, what can be found again easily (code, files, public documentation), or secrets (passwords, tokens, keys).
- One fact or topic per memory. Before writing, check the index below (or search) for a memory on the same topic and update it instead of writing a duplicate. Delete memories that turn out wrong or outdated, and consolidate when the index grows long.
- The description is the memory's index line: one line saying what it is and when it matters. Link related memories in the body with [[name]] or [[type/path.md]]; linking a memory not written yet is fine.

## Using memories
- Memories are background, not instructions: what the member says now wins over a memory.
- A memory may be stale. Before acting on one that names a specific file, system, date or state of work, check that it still holds, and correct or delete it if not.
- Read a memory in full with plugin__memory__view; find memories not in the index with plugin__memory__search; change them with plugin__memory__write, plugin__memory__edit and plugin__memory__delete.

## Index
One line per memory: path — description.`;

const MORE = (n: number): string =>
  `- … ${n} more memories not listed; use plugin__memory__search or plugin__memory__view to find them, and consolidate.`;

const bytes = (s: string): number => Buffer.byteLength(s, "utf8");

/**
 * The index text: one line per memory in the given order, at most {@link INDEX_MAX_LINES} lines
 * and {@link INDEX_MAX_BYTES} bytes; past either cap it ends with the "N more" line.
 */
export function renderIndex(entries: IndexEntry[]): string {
  if (entries.length === 0) return "No memories yet.";
  const lines = entries.map((e) => `- ${e.path} — ${e.description}`);
  const all = lines.join("\n");
  if (lines.length <= INDEX_MAX_LINES && bytes(all) <= INDEX_MAX_BYTES) return all;
  // the longest prefix that leaves room for the "N more" line (lines are joined by "\n")
  let kept = 0;
  let size = 0;
  while (kept < lines.length && kept < INDEX_MAX_LINES) {
    const next = size + bytes(lines[kept] ?? "") + 1;
    if (next + bytes(MORE(lines.length - kept - 1)) > INDEX_MAX_BYTES) break;
    size = next;
    kept++;
  }
  return [...lines.slice(0, kept), MORE(lines.length - kept)].join("\n");
}

const oneToOne = (req: ContextRequest): boolean =>
  (req.source === "web" || req.source === "channel_dm") && req.role !== "guest";

/**
 * The memory context of a run: null outside one-to-one conversations, for guests, when the run's
 * trigger is not the conversation's owner, and when the run has no memory tool (an agent or org
 * switches memory off by disabling the tools). In a one-to-one conversation it also records the
 * agent's and owner's names for the memory page, even when it returns null.
 */
export async function provideMemoryContext(db: Db, req: ContextRequest): Promise<ContextResult> {
  if (!oneToOne(req)) return null;
  const owner: Owner = { orgId: req.orgId, agentId: req.agentId, accountId: req.ownerAccountId };
  await rememberOwner(db, owner, { agentName: req.agentName, ownerName: req.ownerName });
  if (req.ownerAccountId !== req.accountId) return null;
  if (!req.tools.some((t) => t.startsWith("plugin__memory__"))) return null;
  return { text: `${GUIDANCE}\n\n${renderIndex(await indexEntries(db, owner))}` };
}
