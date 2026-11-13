# @capybara-hq/plugin-memory

Memory for Capybara agents, modelled on Claude Code's memory: each agent remembers each member
across conversations. A memory is one note about one thing at `<type>/…/<name>.md`, where the type
is `user` (who the person is), `feedback` (how they want work done, and why), `project` (ongoing
work and constraints) or `reference` (where external things live). Each memory has a one-line
description and a Markdown body; bodies link to other memories with `[[name]]` or
`[[type/…/name.md]]` (a link to a memory not written yet is allowed and becomes live when it is).

What the plugin does:

- **An index at run start** (`context@1`): a fixed English block that explains the memory system to
  the model (what to save, what not to save, check before writing, recalled memories are background
  and may be stale), then one line per memory, `- <path> — <description>`, grouped by type and
  ordered by recalls. At most 200 lines or 16 KB; past that the index ends with "N more memories
  not listed". The text has no timestamps and a stable order, so it only changes when the memories
  do (the kernel appends a new context event only then).
- **Five tools** the model uses on its own, like Claude Code saves memories without asking.
- **Hybrid search**: keyword and semantic, merged by reciprocal rank fusion.
- **A memory page** (记忆 / Memory, under the org's pages): the directory neural tree.
- **Cleanup** when a member leaves the org, an agent is deleted or the org is deleted.

## Whose memory, and where

- A memory belongs to one **(agent, member)** pair in one org. Members of the same agent never see
  each other's memories; the same member with another agent starts from nothing. Every query
  filters on the org, the agent and the member taken from the call, never from model or page input.
- "The member" is the **conversation's owner**. Memory is on only in **one-to-one conversations**:
  web chat and channel DMs (a scheduled task's conversation, run as its creator, too; one bound
  into a group does not). It is off, with no
  index and no tools, in **channel groups**, in **sub-agent** conversations, for **guests**
  (including anonymous channel guests) and in any run where someone other than the owner acts in
  the conversation. The tools declare `sources: ["web", "channel_dm"]`, so the kernel hides them
  elsewhere; the handlers refuse again (defence in depth).
- An agent stops using memory when its memory tools are disabled, and an org admin can switch the
  tools off: with no memory tool available in a run the plugin provides no index.

## Tools

| Tool | Does | Default policy |
|---|---|---|
| `plugin__memory__view` | A directory (`/` for the root) with its entries, or a memory in full with its links (resolved or not written yet). Counts as a recall. | `allow` (read only) |
| `plugin__memory__search` | Hybrid search, `limit` up to 20 (default 10): path, description and a snippet per hit. Each hit counts as a recall. | `allow` (read only) |
| `plugin__memory__write` | Creates or replaces a memory; the type is the path's first segment. | `allow` |
| `plugin__memory__edit` | Exact string replacement in the body, optionally a new description. | `allow` |
| `plugin__memory__delete` | Deletes a memory; links to it become dangling. | `allow` (`destructiveHint`) |

Every tool defaults to `allow` **on purpose**: memory is meant to be saved and tidied without asking,
as in Claude Code. An org admin can set any of them to `ask` or `deny` like any other tool policy;
`delete` carries `destructiveHint` so policies and reviews can tell it apart.

Limits: paths at most 200 characters (lowercase `[a-z0-9-_.]` or CJK segments, the first one the
type), descriptions one line of at most 200 characters, bodies at most 8 KB (UTF-8), 1,000 memories
per (agent, member) pair. A write over a limit fails with an error that tells the model what to do
(shorten, or consolidate memories).

## Permissions

The extension's manifest asks for:

| Permission | Why |
|---|---|
| `client: true`, `ui.components: ["memory-page"]` | The memory page is client code (a React component drawing a canvas). Both keys are sensitive at review and block loading until approved. |
| `tools: view, search, write, edit, delete` | The memory tools. |
| `models: memory.embed` (`kind: "embedding"`, 记忆检索 / Memory search) | Embeddings for semantic search and the graph's semantic edges (below). |
| `hooks: org.member_removed, agent.deleted, org.deleted` | Cleanup: deletes the memories of the member, the agent or the org. Idempotent. |
| `provides: context@1` | The index at run start. |

The migration `0001_init.sql` contains one `DO` block, which the import review shows as a
**`dynamic_sql` warning**. It only adds the `embedding` column, typed pgvector's `vector` when that
type is visible from the plugin's search path (`plugin_memory, public`) and `real[]` otherwise; it
cannot pick the type in plain DDL. Nothing else in the migration is dynamic.

## Embeddings, pgvector and search

- **The embedding model is a model purpose, not plugin config.** The plugin declares `memory.embed`
  (`kind: "embedding"`). An org admin maps it to any enabled embedding model on the org's model
  settings, or the super admin sets the deployment default for it. Memories are embedded on write
  (a failure saves the memory without a vector and retries through the `memory-embed` queue);
  vectors made by an earlier model are re-embedded lazily when a search finds them.
- **Without a model for the purpose** the plugin still works: search is keyword only (no error), and
  the page shows no semantic edges.
- **Keyword search** segments text with `Intl.Segmenter` (Chinese without spaces included: "回复用中文"
  is found by "中文") into a `simple` `tsvector`; no PG extension needed.
- **pgvector is optional.** With it, cosine distance runs in PG (`<=>`); without it, vectors are
  `real[]` and the plugin computes cosine similarity itself. Search is always within one (agent,
  member) pair (at most 1,000 rows), so no ANN index is needed. **The column type is fixed when the
  migration first runs**: installing pgvector later does not convert an existing `real[]` column
  (both paths keep working; the plugin reads the column's type, not whether pgvector is installed).
- **Thresholds are model-dependent.** A memory found only by its vector must reach cosine
  similarity 0.3 to be a hit (`MIN_SIMILARITY`); semantic neighbours on the page need 0.75 (top 3
  per memory). Both suit common embedding models; a model with a very different similarity
  distribution may need other values.

## The memory page

`org.page` "记忆 / Memory", for members and above (guests get no page). The top bar picks the agent
(the agents the viewer has memories with; admins: every agent of the org the plugin has seen),
for admins the member, and searches with the same hybrid search.

The **directory neural tree** draws one agent's memories about one member: the agent at the centre,
the four type directories as branches (deeper directories as sub-branches), memories as leaves.
Node size is the recall count, brightness how recently it was recalled (fading over about a month),
colour the type (theme tokens, so the page follows the theme). Solid edges are the `[[links]]` the
model wrote, faint dashed ones semantic neighbours. Hover lights a node's neighbours; click (or
arrow keys and Enter) opens the side panel with the memory's body, links, recalls, dates and the
conversation it was written in; nodes can be dragged, the view panned and zoomed. Recently recalled
memories pulse; with reduced motion nothing moves and the layout settles once. A list view shows
every memory as a table (the default past 300 memories).

Members edit and delete their own memories. **Org admins and owners** can view and delete any
member's memories but never edit them, and the page says so while they look. Every admin view of
another member's memories (select, open, search) and every delete is written to the plugin's
**admin access log** (`plugin_memory.admin_access_log`: who, whose, which agent, what, when). The
log is not shown in the UI yet; it is there for audit questions.

The page's data arrives in pages under the 32 KB limit of a component view: the first view carries
the nodes and edges that fit, and the page fetches the rest with the `more` action until it has
every memory. Viewing the page does not count as a recall.

## Deleting memories

Deleting a memory, or a member leaving the org, removes rows from the plugin's tables only. A
conversation's event log is append-only: the next run gets a new index without the deleted memory,
but earlier index events and tool results that showed it stay in those conversations' history (and
in their trajectories and evals), as in Claude Code. The page's delete confirmation says so:

> 已删除的记忆不会再出现在新的索引里，但之前对话中已出现的内容仍保留在那些对话的记录中。
>
> Deleted memories no longer appear in new indexes, but what earlier conversations already showed
> stays in those conversations' records.

## Development

```bash
pnpm exec vitest run plugins/memory   # from the repository root; needs Docker for PostgreSQL
```

The page's component tests (`test/client.test.ts`) run on the plugin-client fake host in jsdom; the
graph (`src/client/graph.ts`) is framework-free and tested on its own (`test/graph.test.ts`).
