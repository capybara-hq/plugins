---
name: writing-extension-ui
description: 'Use when adding UI to an extension in this repository (an inline card, a properties section or a right panel on the conversation page, a file previewer, or an org page under the "Extensions" menu): the places panel / section / inline / page / file-preview, icons, open targets and ToolResult.card; choosing between a rendered schema view and an embed iframe; the manifest ui contribution and permissions.ui.views / embeds (an embed blocks loading and is sensitive), the perm-ui check; ctx.ui.view / action / invalidate (signal, timeout, error codes); UiView blocks and UI_LIMITS; the bilingual ToolResult.display summary; embed tokens (verifyEmbedToken), what the /plugin-ui proxy allows, the message bridge rules, SSE via ctx.bus with req.signal; reference plugins/todo and plugins/example-board, and tests.'
---

# Writing extension UI

This skill covers only the UI an extension contributes; for general extension authoring (manifest, approval, ctx, multi-replica rules, dual-replica tests) see `.agents/skills/writing-extensions`, for tools `.agents/skills/writing-tools`. The web host (the conversation page slots, the "Extensions" menu, the `/plugin-ui` proxy, the bridge's host side), embed token issuing and view rendering are core's: [writing-extension-ui in core](https://github.com/capybara-hq/core/tree/main/.agents/skills/writing-extension-ui).

Reference implementations:

- Tier 1 (rendered schema view): `plugins/todo`, views `tasks-panel` / `tasks-section` / `tasks-card` (and the alias `tasks`); `todo__write` returns `card` and calls `invalidate` after writing.
- Tier 2 (embed): `plugins/example-board`, org page `board` and conversation panel `board-conv` (still declared with the old `place: "conversation"`), icon `layout-grid`, with live SSE refresh.

## How to choose between the two tiers

| | Tier 1: rendered schema (`kind: "view"`) | Tier 2: embed (`kind: "embed"`) |
|---|---|---|
| What the extension provides | `render()` returns a `UiView` (a list of blocks), drawn by the web app with design system components | A full page of HTML / JS served by extension routes, placed in a sandboxed iframe |
| Styles and code | The extension cannot write styles or run code | The page is responsible for itself and can use the `--cb-*` design tokens sent by the outer page |
| Interaction | Buttons and forms call back into `ctx.ui.action` | Anything (drag and drop, multi-user collaboration, complex forms) |
| Refresh | `ctx.ui.invalidate` -> the web app re-fetches the view | The extension opens its own SSE / long polling |
| Approval | Recorded in the snapshot, **does not block loading** | **Blocks loading**, needs approval, a sensitive item |

**Use tier 1 whenever you can**: lists, progress, key-values, tables, simple charts, a few buttons or one form are all covered, and there is no new security surface. Only what blocks cannot draw (kanban drag and drop, real-time multi-user editing, workflow canvases) should be an embed.

A contribution appears only in **orgs where this extension is enabled**; kind view also requires that the extension registered a render with `ctx.ui.view`.

**Roles**: `place: "page"` contributions (view and embed) are given only to org roles **member and above**; for a guest every org page route answers 404 `ui.not_found`. Conversation places (`panel`, `section`, `inline`) follow the conversation rule (anyone who can read the conversation, guests included). The extension reads `role` (`owner` / `admin` / `member` / `guest`) in `UiRenderArgs` / `UiActionArgs` / `EmbedClaims` and may tighten further (e.g. only member and above change data); it does not need to block guests from org pages itself.

## Places

`UiPlace` is `"panel" | "section" | "inline" | "page" | "file-preview"`, plus the old `"conversation"`:

| Place | Where | Notes |
|---|---|---|
| `panel` | A right panel opened from the extension's icon in the conversation title bar | Full height, one at a time; the old `place: "conversation"` means `panel` and keeps working |
| `section` | A section of the conversation's properties panel | Rendered `dense`; a `badge` shows as the section's value (todo's "1 / 3") |
| `inline` | An inline card in the stream | **Hangs off a tool result**: the tool returns `card: { view: "<inline view id>", key? }` in its `ToolResult` (display only, never in the model's context). A card naming no `inline` contribution of the same extension is dropped with a warning and the result still succeeds. Extensions cannot write card events into the log themselves |
| `page` | An org page under "Extensions", route `/p/<plugin>/<id>` | Member and above |
| `file-preview` | An embed previewer of `file-preview@1` (below) | Embed only |

- **Icon**: `icon` from `UI_ICONS` (`list-checks`, `layout-grid`, `file`, `chart`, `calendar`, `users`, `bot`, `book`, `message-square`, `puzzle`); default `puzzle`. The title-bar button uses it, so pick one per panel.
- **Open targets**: `UiOpen = { contribution, item? }`, where `contribution` is a `panel` of the same extension. A view may carry `open` (shown in an inline card's title row and a section header); checklist and keyValue items may carry `open` and `id`; a table block carries a parallel `open?: (UiOpen | null)[]` (never an `_open` key in a row). Clicking opens that panel scrolled to the block or item whose `id` equals `item`; `render` receives it as `UiRenderArgs.item`, and an inline card's render receives `card: { callId, key? }` (served only for a card a tool result of that conversation really recorded).
- **Failures stay local**: a failing block shows "Failed to load · Retry" in that block only (10 s timeout on the conversation page); the stream keeps going.
- **Aliases**: `aliasOf: "<id>"` keeps a retired id answering as another contribution of the same extension and kind (not listed, no `ctx.ui.view` of its own, but still in `permissions.ui`). Invalidate it too while it lives (todo invalidates `tasks` with the rest).

### File previewers (`file-preview@1`)

Previewing a file output in the right panel is the extension point `file-preview@1` (org scoped, several providers). A provider lists `previewers`, each with an `id` (`[a-z0-9-]{1,40}`), a bilingual `title`, `accepts: { mimeTypes?, extensions? }` (at least one; `image/*` allowed; extensions match case-insensitively), `maxBytes` (≤ `FILE_PREVIEW_MAX_BYTES`, 20 MB) and exactly one of `render(args) => UiView` or `embed: <id of a ui contribution { kind: "embed", place: "file-preview" }>`.

- The extension never gets a storage key or a URL: `render` reads the bytes through `args.read()`, a read grant for that one file in that conversation, valid only during the call; an embed gets them through the message bridge (`type: "file"` after `init`; `createEmbedBridge({ file })`), and its token claims carry `fileId`.
- An org admin orders and disables previewers; an accepting extension previewer wins over the built-in ones (image, text, Markdown, CSV / TSV), and the person can switch in the panel header. A slow (10 s) or failing previewer affects only the panel and falls back to the file card with Download.
- **Validated at `ctx.provide`**: an invalid provider (`validateFilePreviewProvider`), or an `embed` naming no `{ kind: "embed", place: "file-preview" }` contribution of the same extension, fails `setup`.

## Manifest

```ts
defineExtension({
  name: "todo",
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
  // ...
});

defineExtension({
  name: "example-board",
  ui: [
    { id: "board", title: { zh: "看板", en: "Board" }, place: "page", kind: "embed", path: "/ui/board" },
    { id: "board-conv", title: { zh: "看板", en: "Board" }, place: "conversation", kind: "embed", path: "/ui/board-conv" },
  ],
  permissions: {
    http: [{ method: "GET", path: "/ui/board" }, { method: "GET", path: "/ui/board-conv" }, /* data routes are also under /ui/ */],
    ui: { embeds: ["board", "board-conv"] },
  },
});
```

- A contribution `id` matches `^[a-z][a-z0-9-]{0,39}$` and is unique within the extension; both the zh and en parts of `title` are non-empty and <= 100 characters.
- `path` is allowed only on embeds: it starts with `/ui/` and is declared as `GET <path>` in `permissions.http`. All routes an embed uses (page, scripts, data, SSE) must be under `/ui/`; the web proxy forwards only there.
- **Two-way cross-check** (`validateUiContributions`, run by `defineExtension` and the kernel): a kind view id must be in `permissions.ui.views`, a kind embed id in `permissions.ui.embeds`, and every id in `permissions.ui` must have a contribution of that kind. An id cannot be on both sides.
- **Approval**: the permission keys are `ui.view:<id>` and `ui.embed:<id>`.
  - `ui.view:*` is recorded and visible at review but **never blocks loading**: an upgrade that adds only views loads as usual and the kernel merges them into the snapshot. Exception: a brand-new extension needs approval even with only views.
  - `ui.embed:*` blocks loading like any new permission and is a **sensitive item** at review.
- **Static check `perm-ui`** (`pnpm check`): the id of `ctx.ui.view(id)` / `ctx.ui.action(id)` must be in `permissions.ui.views` (action is checked against views too). Write the id as a string literal or same-file const; dynamic values and aliasing `ctx.ui` report "cannot statically confirm" (exemption `// capybara:allow-dynamic-permission <reason>` for ids truly known only at runtime; an undeclared id cannot be exempted). When passing `ctx.ui` to another function, pass a wrapper (todo's `{ invalidate: (t) => ctx.ui.invalidate(t) }`) so the check can see the usage.

## Tier 1: `ctx.ui`

```ts
setup(ctx) {
  ctx.ui.view("tasks", async ({ orgId, accountId, conversationId, locale, signal }) =>
    tasksView(conversationId === undefined ? [] : await readTodos(ctx.db, conversationId)),
  );
  ctx.ui.action("tasks", async ({ actionId, payload, answer, signal }) => {
    // ...
    return { toast: { zh: "已清空", en: "Cleared" } }; // or { view: newView }, or {}
  });
}
// when the data changes:
await ctx.ui.invalidate({ orgId, conversationId, contribution: "tasks" }).catch(() => {});
```

- `view` / `action` can be called only in `setup`, with an id in `permissions.ui.views`, otherwise `ExtensionPermissionError`; registering the same id twice throws.
- The identities in the arguments (`orgId`, `accountId`, `role`, `conversationId`) are set by the kernel after authentication: a conversation view has already verified that the caller can access the conversation, and the extension never gets the user's session. Org pages get no `conversationId`. `locale` is the web app's language (`zh` / `en`, default `en`); produce the view's text in it.
- **5 second timeout; both `render` and `action` must respond to `signal`**: pass it to queries and external requests (`fetch(url, { signal })`) and give up as soon as it aborts. After a timeout the user sees a failure and may retry, so a write in an `action` must not keep running to completion.
- A failure affects only that block (error and "Retry"); nothing is written to the conversation log. Error codes:

  | Code | Status | When |
  |---|---|---|
  | `ui.not_found` | 404 | extension not enabled / not loaded, contribution missing, an embed fetched as a view, the view has no action, the conversation is not accessible |
  | `ui.render_failed` | 502 | `render` threw (your message is not echoed) |
  | `ui.action_failed` | 502 | `action` threw |
  | `ui.invalid_view` | 502 | the returned view or toast is invalid |
  | `ui.timeout` | 504 | over 5 seconds (`signal` aborted) |
  | `validation_failed` | 400 | a conversation view lacks `conversationId`, an org page carries one, the action body is over the limit |

- Action request body: `actionId` 1-200 characters; `payload` <= `UI_LIMITS.payloadBytes` UTF-8 bytes of JSON; form `answer` keys and multi-select length <= `UI_LIMITS.tableRows`, a single text <= `UI_LIMITS.textChars`. Returning `{ view }` replaces the view (badge included); `{ toast }` shows `toast[locale]`.
- **`invalidate({ orgId, conversationId?, contribution })`**: `contribution` is any id in the manifest `ui` (view or embed), `conversationId` a conversation UUID. With a conversation, the conversation's event stream gets it; without, the org-level UI stream. It crosses replicas for you. A target where the extension is not enabled in `orgId` or the conversation is not in `orgId` is silently dropped. It is only a "fetch again" hint (authorization happens on fetch), so a refresh failure must not affect business writes: `.catch(() => {})`.
- **The web app coalesces refreshes** (one request in flight per view, one re-fetch after it however many arrive, the old view kept meanwhile, everything re-fetched after a reconnect), so call `invalidate` on every write without throttling.

## Tier 1: `UiView` blocks and limits

The types and `validateUiView` are in the SDK (`ui.ts`); the kernel validates every `render` / `action` return, and an invalid one is `ui.invalid_view`.

| Block | Fields | How the web app draws it |
|---|---|---|
| `heading` | `text` (non-empty) | small heading |
| `text` | `markdown` | **Shown as plain text with line breaks** for now: Markdown is not rendered, links are not clickable, raw HTML is text. Validation still requires links to be absolute http(s) addresses |
| `checklist` | `items[{ text, status: pending / in_progress / completed }]` | a checklist; `in_progress` highlighted, `completed` struck through |
| `keyValue` | `items[{ label, value }]` | key-value table |
| `table` | `columns[{ key, label }]`, `rows[Record<key, string>]` | data table. Column keys cannot repeat; a row cannot have undeclared columns, but may omit columns |
| `code` | `language?`, `text` | monospace code block |
| `image` | `url`, `alt` | **Absolute http(s) addresses only** (<= 2000 characters); a relative address under the extension's routes is rejected |
| `chart` | `kind: bar / line`, `series[{ label, value }]` | bar / line chart; `value` is a finite number |
| `actions` | `buttons[{ actionId, label, payload?, danger? }]` (non-empty) | a group of buttons, calling back into `ctx.ui.action` |
| `form` | `form: InputForm`, `actionId`, `submitLabel` | the form fields of `ask_user`; submitting goes through `action` (with `answer`); not submitted while a required field is empty |

A view may carry a `badge` (<= 32 characters), such as todo's "2/4".

- **Limits `UI_LIMITS`**: `blocks` 50; `tableRows` 200 (also the cap on keyValue items, table columns, chart points and buttons); `checklistItems` 100; `textChars` 20000 (all text in the view; a form counts by JSON length); `payloadBytes` 2000 (one button `payload` as JSON; unserializable is an error). Going over invalidates the whole view, so truncate yourself and add text such as "N more items".
- **`actionId` is unique across the whole view** (buttons and forms together).
- **Danger buttons** `danger: true`: the web app asks the user to type the button text before running. Mark every delete, clear and irreversible operation. View buttons are never primary buttons.
- **Use `Object.hasOwn(row, key)` for table cells**, not `row[key]` or `key in row`: a column key may be `constructor` or `toString`.
- Text in a view is for people (by `locale`) and never enters the model context.

## The display summary for tool results, `ToolResult.display`

A tool can return a sentence meant only for people, shown on the tool-call row instead of the raw input JSON:

```ts
return {
  content: [{ type: "text", text: renderTodos(todos) }],
  display: { summary: { zh: `更新任务清单（${n} 项）`, en: `Updated task list (${n} items)` } },
};
```

- Both languages, each <= 200 code points (`validateToolDisplay`); an invalid one is dropped with a warning and the result is written as usual.
- The summary is logged with the result, so reloading restores it; it **never enters the model context**, so anything the model needs goes in `content`. Details in `.agents/skills/writing-tools`.

## Tier 2: embeds

The extension's page is placed in the web app's sandboxed iframe (`sandbox="allow-scripts allow-forms"`, no `allow-same-origin`, so an opaque origin) and cannot read the outer page or cookies.

### Embed tokens

- The web app obtains a token for a contribution (a conversation embed carries its `conversationId`) and loads `src` = `/plugin-ui/<plugin>/<path with the leading /ui/ removed>` (e.g. `/plugin-ui/example-board/board`). At signing the kernel has verified that the extension is enabled, the contribution is an embed, and the caller can access the conversation.
- A token is stateless and signed with the master key; valid for 300 seconds (`EMBED_TOKEN_TTL_SECONDS`). Its claims are `EmbedClaims`: `plugin`, `orgId`, `accountId`, `role`, `conversationId?`, `contribution`, `exp` (and `fileId` for a previewer).
- **Every data route first does `await ctx.ui.verifyEmbedToken(token)`** and returns 401 on null. It accepts only tokens signed for **this extension**, and checks every time (uncached) that the extension is still enabled in `claims.orgId`, the org exists, and the account is active and still a member: disabling, leaving or deactivation invalidates issued tokens at once. The returned `role` is the current one; an org-page token is null after the caller is demoted to guest. **Take org, account and conversation only from the returned claims**, never from request parameters. A conversation token scopes data by `conversationId`; an org token (no conversation) must not see data inside conversations (example-board's `scoped()`).
- The kernel's `/api` never accepts embed tokens; the worst outcome of a leak is calling **this extension's** data routes as that user within 300 seconds.

### What the `/plugin-ui` proxy lets through

The web app's `/plugin-ui/<plugin>/<rest>` forwards to the kernel's `/plugins/<plugin>/ui/<rest>`:

- Only GET / POST (OPTIONS answers 204); malformed names or path segments are 404 without forwarding; undeclared routes 404.
- **Request headers**: `accept`, `accept-language`, `cache-control`, `content-type`, `if-modified-since`, `if-none-match`, `last-event-id`, `x-forwarded-for`. No cookies, no CSRF header. **`Authorization` only as a Bearer in the embed-token shape**.
- **Response headers**: `content-type`, `cache-control`, `etag`, `last-modified`, `expires`, `vary`, `content-language`, `x-accel-buffering`, `retry-after`; everything else (`Set-Cookie`, HSTS, `Link`, …) is dropped. A 3xx `Location` survives only if it stays under `/plugin-ui/<this plugin>/`.
- **Caching is private only**: a request that forwarded a token is `no-store`; otherwise `public` / `s-maxage` / `proxy-revalidate` are removed and `private` prepended (default `no-store`).
- Every response gets a CSP (`default-src 'self'`, inline scripts and styles allowed, `connect-src 'self'`, `frame-ancestors 'self'`, `base-uri 'none'`, `object-src` / `frame-src` / `worker-src 'none'`, and **`sandbox allow-scripts allow-forms`**), `nosniff`, `Referrer-Policy: no-referrer`. Bodies stream (SSE works).
- So use **relative addresses** in the page (`fetch("cards")`, `<script src="board.js">`); external resources are blocked by the CSP.

### The message bridge (`postMessage`, protocol `capybara-embed/1`)

- **Outer -> iframe**:
  - `init` (token, `locale`, `theme`, the `--cb-*` design tokens, `context: { orgId, conversationId? }`) is **sent only on the iframe's first `load`**.
  - `token`: renewal before expiry.
  - `theme`: when the outer theme switches.
- **A second `load` of the iframe counts as having left the extension page** (whole-page navigation, a form submit navigation, assigning `location`): the outer page stops talking to it and remounts the iframe at the original `src` (at most 3 remounts in 10 seconds, then an error until "Retry"). So:
  - **Use the History API for multiple pages** (`history.pushState` plus a front-end router), not whole-page navigation.
  - **Never navigate before `load`**: no redirects while loading, no `location.replace`, no `<meta http-equiv="refresh">`; route-level redirects stay under `/plugin-ui/<plugin>/`.
- **iframe -> outer** with `window.parent.postMessage(msg, "*")` (an opaque origin cannot name a targetOrigin); the outer page validates with `parseEmbedChildMessage` and ignores anything else:
  - `resize { height }`: 0-10000, clamped to 120-4000 pixels.
  - `navigate { path }`: only an in-site path (such as `/chat/<id>`): one leading `/`, no `//`, backslash or control characters; no `.` / `..` segments (including `%2e`), no `%2f` / `%5c` / `%00`-`%1f` / `%7f`; unchanged by URL normalization; <= 2000 characters; non-ASCII through `encodeURIComponent` first.
  - `toast { text }`: non-empty, <= 500 characters, plain text.

### Pages and data

- **Static pages and scripts carry no data** and may skip token verification (an iframe loading `src` cannot send `Authorization`, and the token arrives only with `init`); data comes only through routes that verify the token. Never put the token in a URL query string (logs, history).
- Build the DOM with `textContent`; no data through `innerHTML`. Styles use `var(--cb-*, fallback)`, written to `:root` on `init` / `theme`.
- **Real-time refresh goes through `ctx.bus`, subscribed per request**: in an SSE route `await ctx.bus.subscribe(topic, ...)`, and unsubscribe when `req.signal` aborts or in the `ReadableStream` `cancel`; end the stream at the token's `exp` (the page reconnects with the renewed token, so permissions expire with it). Heartbeats wait with `AbortSignal.timeout` inside the request, not a timer; no module-level subscription table. The page reads the stream with `fetch` (`EventSource` cannot send `Authorization`). The writer publishes once and streams on every replica receive it.
- `req.signal` aborts only if the client disconnects before the response is fully written.

## Writing tests

- **Pure functions**: unit-test the view function (todo's `tasksView`) and assert `validateUiView` returns empty; for a tool handler inject a fake `ui` (`{ invalidate: async (t) => void calls.push(t) }`) and assert the arguments; see `plugins/todo/test/todo.test.ts`.
- **Through a real kernel**: `startTestKernel` from `@capybara-hq/testing` serves the view, action and embed-token routes; see `plugins/todo/test/kernel.http.test.ts` and `plugins/example-board/test/board.http.test.ts` (page and conversation tokens, cross-org / cross-conversation isolation).
- **Dual-replica**: `plugins/example-board/test/board-events.dual.test.ts`. For SSE use `openSse(url, headers)` from `@capybara-hq/testing` straight to one replica's port (`replicaOf(res)` confirms where it landed) and wait for frames with `waitFor`. For cross-replica refresh open streams on **both** replicas; for unsubscription assert with Redis `PUBSUB CHANNELS` that no subscription is left.
- Run from the repository root: `pnpm exec vitest run plugins/todo plugins/example-board`.
