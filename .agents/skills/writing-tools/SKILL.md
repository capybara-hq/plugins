---
name: writing-tools
description: 'Use when adding or changing an extension tool in this repository (ctx.tools.register, reference plugins/todo), or the tool rules shared by connector tools: tool naming and keys, English descriptions and actionable error text (the tool-description and tool-error-actionable checks), annotations and defaultPolicy, ToolError and kind (circuit breaker), timeouts and call.signal, the error when an extension is disabled mid-call, result unknown after a crash, output size and spilling, InputRequired and resume, writing descriptions for tool_search, display-only title / keyArgs / display summary / inline cards, and extension hooks in a tool call (tool.preExecute, tool.postExecute). For connectors see writing-connectors.'
---

# Writing tools

This skill is the plugin half: tools an extension registers with `ctx.tools.register`, and the rules connector tools share. General extension authoring (manifest, config, ctx, multi-replica rules, dual-replica tests) is in `.agents/skills/writing-extensions`. The kernel's builtin tools (`ask_user`, `read_tool_output`, `tool_search`, the sandbox tools `sandbox_*`, the skill tools `skill_load` / `skill_write`, the sub-agent tool `agent`), policy evaluation, output archiving, drift review and resume are core's: [writing-tools in core](https://github.com/capybara-hq/core/tree/main/.agents/skills/writing-tools).

Reference implementations:

- Extension tool: `plugins/todo` (one `write` tool, writes the whole list into the extension's schema, default allow, returns a display summary and an inline card).
- Connectors: `plugins/connector-mcp`, `plugins/connector-openapi` (see `.agents/skills/writing-connectors`).

Every tool call goes through the kernel pipeline: resolve `{"$output": id}` references -> validate the arguments against `inputSchema` -> policy (allow / ask / deny) and approval -> `tool.preExecute` hooks -> record that the call started -> execute (timeout + abort) -> render the result -> spill oversized results -> record the result. An extension only "does the work and returns the result"; approval, timeouts, archiving, audit and redaction are the kernel's and **must not be reimplemented in the extension**.

## Keys

The tool name (key) the model sees matches `^[a-zA-Z0-9_-]{1,64}$`:

| Source | key | Naming rule |
|---|---|---|
| builtin (kernel) | the name itself: `ask_user`, `read_tool_output`, `tool_search`, `sandbox_bash`, `skill_load`, `agent` | lowercase + underscores, no dots |
| extension | `<plugin>__<tool>`, e.g. `todo__write` | `spec.name` matches `^[a-zA-Z0-9_-]{1,40}$` (`EXTENSION_TOOL_NAME`) |
| connector | `<connectorSlug>__<tool>`, e.g. `docs__search` | slug `^[a-z][a-z0-9_]{0,23}$`; the tool name is decided by the remote |

An invalid key is **neither truncated nor guessed**. Name tools with lowercase + underscore verb phrases (`write`, `search`, `delete_doc`), and don't repeat the extension name in the tool name (the key carries the prefix). An agent references an extension tool as `{kind:"plugin", plugin, name}` (the value is the extension name); a tool that is unavailable at a step (extension not enabled in the org, unloaded) is skipped with an English reminder to the model, and the run does not fail.

## Extension tools: `ctx.tools.register`

```ts
import { defineExtension, ToolError, type ToolSpec } from "@capybara-hq/plugin-sdk";

const SPEC: ToolSpec = {
  name: "write",
  description:
    "Create and update the task list for the current conversation. Use it for work with three or " +
    "more steps … Do not use it for a single trivial task.",
  inputSchema: { type: "object", properties: { /* … */ }, required: ["todos"], additionalProperties: false },
  defaultPolicy: "allow",
};

export default defineExtension({
  name: "todo",
  // permissions: { tools: ["write"] },
  setup(ctx) {
    ctx.tools.register(SPEC, async (input, call) => {
      // call: { orgId, accountId, agentId, conversationId, callId, signal, resume? }
      // …validate, write ctx.db…
      return { content: [{ type: "text", text: "Todo list updated (3 items): …" }] };
    });
  },
});
```

- **Register only during `setup`**, with the local name listed in `permissions.tools` (`perm-tools`); names are unique within an extension; `validateToolSpec` validates at registration (name, non-empty description, `inputSchema` is an object, `defaultPolicy` only `allow` / `ask`, display fields below).
- **An extension tool is available only in orgs that enabled the extension** (unlike connectors, which are deployment-level). Elsewhere it is an unavailable tool.
- State follows the multi-replica discipline: persistent data in `ctx.db` (todo upserts one row per `conversationId`), never a module-level Map.
- The handler **must honor `call.signal`** (the tool timeout `tools.timeoutMs` merged with the run abort): pass it to `fetch`, database queries and so on. The kernel returns a timeout result on time even if you ignore it, but your side effects may keep running.
- Arguments are already validated against `inputSchema` (JSON Schema 2020-12) before the call; on failure the model gets the error paths and the schema and the handler is not called. Parse once more with zod for types, and throw `ToolError` on failure.

## Descriptions and error text (model-visible, always English)

`pnpm check` (`capybara-plugin check`) checks statically:

| Rule id | Requirement |
|---|---|
| `tool-description` | The `spec.description` of `ctx.tools.register(spec, …)` is a string literal (may be joined with `+`, may reference a const in the same file), ≥ 20 characters, no Chinese |
| `tool-error-actionable` | The message of `new ToolError(msg)` is a literal / template (or a constant or function return in the same file) and contains one of the verbs `use` / `call` / `retry` / `check` / `ask` / `pass` / `provide` |

Beyond the checks:

- **A description covers three things**: what it does, when to use it, and when not to; state side effects ("Each call replaces the whole list"). Give every `inputSchema` field a `description`, with examples.
- **Errors give facts and a next step**: what went wrong and what the model should do (retry with other arguments, call another tool first, ask the user). Examples: `Invalid todos: pass an array of items with content, status and activeForm, where status is pending, in_progress or completed.`; `Authentication failed for this app; ask the user to reconnect it.`
- No credentials, internal paths or stack traces in errors; no fuzzy matching ("did you mean to call X").
- Text shown in the UI (form titles, field labels) may be bilingual `{ zh, en }`; text for the model is English only.

### Descriptions under `tool_search`

When an agent has many tools (above the kernel's thresholds, by count or tokens), the model sees only a catalog line per tool, `- <key>: <first line of the description>` (cut at 200 characters), and loads full definitions with `tool_search`, which scores tools by keyword (words in the key weigh double). So:

- **The first line must explain the tool's purpose on its own**, with the object and action words (`create calendar event`).
- Verb-phrase names (`search_docs`) help matching.
- Don't try to "make sure the model always sees" a tool by other means; with many tools it goes through the catalog anyway.

## Annotations and default policy

`ToolSpec.annotations` (aligned with MCP): `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, `requiresUserInteraction`.

- A tool that declares `defaultPolicy` uses it; otherwise it is derived from the annotations: `readOnlyHint: true` -> `allow`, everything else (no annotations, destructive) -> `ask`. A connector tool's policy is derived from its annotations at install (admins and connector templates can change it).
- Declare `defaultPolicy: "allow"` only for a tool with no side effects, or whose side effects stay in this conversation (todo); when unsure, leave it out and let it `ask`.
- The final policy is the strictest at **the moment of execution**: org defaults, the agent's `toolPolicies` (only tighten), `requiresUserInteraction` (at least `ask`, remembered grants don't apply). A remembered grant lets an `ask` through only while the tool's definition fingerprint is unchanged, so changing a spec revokes grants.
- `ask` -> the run waits for approval and resumes later (possibly on another replica); a denial (optionally with the approver's reason), timeout or abort becomes the call's result. The extension doesn't handle any of this.

## Display metadata (never sent to the model)

The conversation page shows a call as one row, "verb + source: title + key arguments".

- **`ToolSpec.title`** (optional, 1–80 characters, one line): a short human title, e.g. "Search messages". It wins over the key on the row (the approval block always shows the key and every argument). No control, bidi or invisible characters (Unicode Cc / Cf; ZWNJ U+200C and ZWJ U+200D are allowed).
- **`ToolSpec.keyArgs`** (optional, at most 3 unique names, each a property of `inputSchema.properties`): the input values shown on the row, in order, e.g. `["query", "channel"]`. Without it the first string argument is shown.
- `validateToolPresentation` checks both (part of `validateToolSpec`, so an invalid one makes `ctx.tools.register` throw naming the field). Neither is part of the definition fingerprint, so changing them never revokes grants or triggers review.
- Extension tools are shown with the generic `tool` kind (row verb); kernel builtins have their own kinds and result views (exit code, diff, read range).
- **`display`** in the result: `{ content, display: { summary: { zh, en } } }`, a sentence for people shown instead of the raw input (todo's "Updated task list (3 items)"). Both languages, each ≤ 200 code points (`validateToolDisplay`); an invalid one is dropped with a warning. It is logged with the result but **never reaches the model**, so anything the model needs goes in `content`. Connector tool summaries are not trusted.
- **`card`** in the result: `{ view: "<inline view id>", key? }` hangs an inline UI card of this extension off the result (display only); see `.agents/skills/writing-extension-ui`.

## Results, `ToolError` and failure

- Return `{ content: ToolContent[], isError? }`. `text` is passed as is; for `image` / `resource_link` the model gets a type description. `isError: true` means "the tool ran but the result is an error", and the content still goes to the model.
- Throw `ToolError(message)`: the message goes to the model **as is** (English, actionable). An optional `{ kind: "unavailable" }` means the remote is unreachable (can't connect, HTTP 5xx) and matters only for connectors: the connector circuit breaker counts timeouts, transport errors (non-`ToolError` exceptions) and `kind: "unavailable"`; a default `kind: "error"` (argument, business, authentication errors) and `isError` results mean the remote is reachable and reset the count. Extension tools are not subject to the circuit breaker.
- Any other thrown error: the model sees only `Tool <key> failed (<ErrorName>). The operation may not have completed; check before retrying or try another approach.`; details go to the (redacted) log. Don't rely on exception messages to pass information.
- Timeout: `Tool <key> timed out after <n>s. The operation may or may not have completed; verify before retrying.`
- **The extension is taken down mid-call** (disabled, uninstalled, upgraded): in-flight calls get up to `extensionHost.drainSeconds` (default 30 s); then `call.signal` aborts and the model gets `PLUGIN_UNLOADED_TOOL_ERROR` (`The plugin that provides this tool was disabled or upgraded while the call was running, so the call was aborted. Retry if the tool is still available.`). So long operations must be abortable and retryable.
- **Crash mid-call**: the kernel records the start before executing; if the process dies, the call's result becomes `Result unknown: the call was interrupted before a result was recorded. Verify the outcome before retrying.` and **your handler is not called again**. The model may retry on its own, so make writes naturally idempotent where possible (todo overwrites the whole list).

## Output size

- A result over `tools.outputSpillChars` (default 50000 characters) is archived; the model sees the first `tools.outputPreviewChars` (default 2000) characters and a note telling it to page with `read_tool_output` or pass `{"$output":"<id>"}` as an argument to another tool (the handler then sees the full text in place of the reference). Archives are readable only within the conversation that produced them.
- So **don't truncate** large results or invent pagination; return the full text. For truly unbounded data (a whole-database export), add a limit or pagination parameters and say so in the description.

## Needing user input: `InputRequired` and resume

A handler can return `{ kind: "input_required", form, state? }` instead of a result: the kernel validates the form (`validateInputForm`; fields use the ParamSchema subset, enums may be `multiSelect` / `allowOther`), asks the person, and the run pauses. After the answer (or timeout / cancel) the kernel **calls the handler again with the same input** and `call.resume = { state, answer }` (`answer` is `null` on timeout / cancel).

```ts
async (input, call) => {
  if (!call.resume) {
    return { kind: "input_required", form: { title: { zh: "确认", en: "Confirm" }, fields: [ /* … */ ] }, state: { step: 1 } };
  }
  if (call.resume.answer === null) throw new ToolError("The user did not answer; ask again later or try another approach.");
  // continue with call.resume.state / answer
}
```

- `state` is JSON-serializable and ≤ 16 KB; it is stored in PG and the resume may run on another replica, so **keep nothing the resume needs in memory**.
- One call may ask at most 3 times in a row; the 4th -> `Tool requested user input too many times.`
- MCP elicitation (a remote asking mid-call) is turned into the same request by the kernel; that is between a connector and the kernel (`.agents/skills/writing-connectors`).

## Extension hooks around a tool call

Extensions can observe or deny tool calls through `ctx.hooks` (see "Hooks" in `.agents/skills/writing-extensions`).

- `tool.preExecute` runs after the policy and approval, before the call starts. A policy denial never runs the tool: the result is `Tool call blocked by the "<plugin>" policy hook: <reason>` (reason sanitized and cut to 500 characters, or a generic sentence for a hook error or timeout). The denial is sticky: a resumed step reuses it.
- `tool.postExecute` is observe-only and gets the result the model sees (after spilling, not the raw output).
- A sub-agent dispatch is the parent's `agent` call, so `tool.preExecute` can refuse it (the input has `subagent_type`). Hooks never fire in eval replays.

## Connectors

A connector (`connector@1`) connects a remote service; its tools are decided by the remote, and policy, approval, spilling and `tool_search` apply as above. The kernel re-reads a connector's tool list periodically and sends changed definitions to admin review, so `listTools` output must be deterministic. Contract, sessions, auth, `connectorData`, `inspect`, elicitation and test fixtures: `.agents/skills/writing-connectors`.

## Testing

- Unit tests: call the handler directly with a constructed `ToolCallContext`; see `plugins/todo/test/todo.test.ts`. Multi-replica consistency: `createDualReplicaHarness` from `@capybara-hq/testing`.
- Through a real kernel: model-fake's `tool:<key>:<json>` message makes the model call a tool (e.g. `tool:todo__write:{"todos":[]}`); see `plugins/todo/test/kernel.http.test.ts` (`startTestKernel` from `@capybara-hq/testing`, model-fake as a devDependency loaded by package name).
- Run from the repository root: `pnpm exec vitest run plugins/todo`.
