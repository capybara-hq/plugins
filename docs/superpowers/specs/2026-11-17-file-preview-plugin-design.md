# Official file preview plugin (`plugin-file-preview`)

Status: draft for maintainer review, 2026-11-17.

## Why

Agents deliver files (the `Deliver` tool) and the person opens them in the conversation's right
panel (core `apps/web/src/components/conversation/FilePanel.tsx`). Today only the core built-in
previewers exist: bitmaps (png / jpeg / gif / webp), plain text, Markdown and CSV / TSV. Everything
else shows the file card with Download, including the most common business deliverables (xlsx,
docx, pdf, zip), and HTML shows as source. Source files whose extension the `Deliver` content-type
table does not know (`.tsx`, `.go`, `.rs`, `.sh`, …) are `application/octet-stream` and get no
preview at all. No plugin implements `file-preview@1` yet.

The goal: mainstream deliverables are viewable in the panel without downloading, with an official
plugin on the existing extension point. The only core change is allowing Web Workers in embeds
(below).

## Where previews show

All entry points open the same `FilePanel`: the Deliver card in a reply, a file path mentioned in
reply text, the title bar Files button (opens the newest file; the panel header switches), a
sub-agent's deliveries listed in the parent, and the panel's fullscreen mode. Maintainer decision
2026-11-17: user attachments join them (core change, plan Task 1A): a sent attachment is listed with
the conversation's files (marked uploaded) and opens in the same panel, so every previewer here also
previews attachments; images open a new full-screen zoomable viewer (plan Task 1B). Not in scope:
channels (Lark / Telegram users get the file itself), a standalone file page.

## Goals

- Code: syntax-highlighted view for common languages, including extensions that are
  `application/octet-stream` today.
- zip: the directory tree with sizes; selecting a text, code, image or other supported entry
  previews it inside the same embed.
- xlsx: one tab per sheet, rows and columns with
  computed values; no styling, no formula editing.
- docx: the document as formatted HTML (headings, paragraphs, lists, tables, inline images).
- pdf: page-by-page rendering with page navigation and zoom.
- svg: shown as an image, never executed.
- html: a static rendering (scripts removed) with a switch to the highlighted source.
- Looks native: follows the host theme (light / dark and the design tokens the bridge sends).
- Every format is its own previewer so an org admin can disable or reorder it (existing admin page).

## Non-goals

- HTML with live scripts or network resources (chart libraries from a CDN), and sharing previews
  outside the conversation: project B (isolated content origin, share links with expiry, scope and
  revoke), designed separately. When B exists, the html previewer switches to it.
- Audio / video: the embed CSP (`media-src 'self'`) refuses `blob:` URLs, and the 20 MiB cap makes
  video of little use; needs a core change, later.
- pptx: open-source rendering is poor; maybe slide text later.
- Editing anything; Markdown and CSV / TSV (core built-ins already cover them well).
- Files over 20 MiB (`FILE_PREVIEW_MAX_BYTES`): no previewer accepts them; the panel already shows
  the file card with type, size and Download. Nothing to build.

## Anti-goals (a failure even if it works)

- Agent-produced content running script in, or reading anything from, the host page or the embed's
  own context (its embed token): a crafted html, svg, docx or zip must stay inert.
- A malicious file (zip bomb, huge sheet, pathological pdf) freezing the person's browser tab beyond
  the embed, or the kernel process.
- A previewer that looks like a foreign widget next to the design system.

## Constraints (from core, unchanged)

- `file-preview@1`: each previewer declares `accepts` (MIME types and / or extensions), `maxBytes`
  (≤ 20 MiB) and either `render() → UiView` or `embed: <ui contribution id>` of a contribution
  with `kind: "embed"`, `slot: "file.preview"` (core `plugin-sdk/src/ui.ts`). The slot accepts
  embeds only. `accepts` has no exclusions (MIME wildcards and extensions only) and an extension
  previewer is always listed before the built-in one, so a `text/*` claim would take Markdown and
  CSV away from the built-ins: accepted MIME types are listed one by one.
- `UiView` is too small for this (`UI_LIMITS`: 200 table rows, 20 000 characters): no view
  previewers.
- The embed runs in a sandboxed iframe (`allow-scripts allow-forms`, opaque origin) under
  `EMBED_CSP` (core `apps/web/src/lib/plugin-ui-proxy.ts`): scripts and styles only from the same
  origin (the plugin's `/ui/` routes) plus inline; `img-src 'self' data: blob:`; `font-src 'self'
  data:`; `frame-src 'none'`; `connect-src 'self'`; `worker-src 'none'` until the core change below.
- The file arrives over the message bridge (`createEmbedBridge({ file })`, `type: "file"` after
  `init`) as bytes, never a URL; the theme arrives as `theme` messages.
- An accepting extension previewer wins over the built-in one; the person can switch back in the
  panel header, and the header always has Download. The 10 s timeout and file-card fallback apply to
  `view` previewers only: an embed has no load timeout and no panel-level fallback when its script
  throws or hangs, so the embed app shows its own error states.
- The embed must be a single-page app: a second `load` of the iframe counts as navigating away
  (the host stops messaging and remounts it, at most 3 times in 10 s). Links that navigate the
  iframe trigger the same; the bridge's `navigate` only takes in-app paths, and the sandbox has no
  popups or downloads.
- No `'wasm-unsafe-eval'` in the CSP: no WebAssembly (Shiki's JavaScript regex engine, pdf.js's
  JavaScript decoders).
- Assets: `ctx.http.route` handlers declared as `public` GETs in `permissions.http`; packaged
  `ui/` files are unpacked to disk and readable through `import.meta.url`. Package limits: tgz 50
  MiB, 5 000 entries, 256 MiB unpacked (count pdf.js fonts and cmaps). The proxy turns cache
  headers into `private` (none = `no-store`).
- `capybara-plugin pack` bundles only the server entry `src/index.ts`; it copies `ui/` as is.
- Static pages and scripts are `public` GET routes and carry no data.
- The plugin depends only on `@capybara-hq/plugin-sdk` and third-party npm packages.

## Approaches considered

1. **One plugin, one embed previewer per format, a bundled client app (chosen).** Libraries are
   bundled into the plugin and served from its own public `/ui/` routes; rendering happens in the
   sandboxed embed. No core change beyond allowing workers; parsing hostile files never touches the host page or the kernel.
   Cost: the plugin carries its own styling (aligned through theme tokens) and a few MB of bundled
   libraries (loaded per format).
2. Server-side `view` previewers for structured formats plus embeds for the rest: native look, but
   `UI_LIMITS` cannot hold real sheets or archives, and parsing in the kernel process lets one zip
   bomb hurt a replica. Rejected.
3. Change core so `file.preview` accepts client components rendered in the host page: best look and
   speed, but a core change, and hostile files parsed in the host page; html still needs a sandbox.
   Rejected for this scope.

The maintainer picked 1.

## Core change (first, before the plugin ships)

Maintainer decision 2026-11-17: allow workers in embeds. In core, `EMBED_CSP` changes
`worker-src 'none'` to `worker-src 'self' blob:`, with the proxy's CSP test updated (a worker from
the plugin's own `/ui/` route and from a `blob:` URL allowed; other origins still refused) and the
comment block explaining why: a worker started by a sandboxed embed inherits its opaque origin and
CSP, so it reaches nothing the embed itself cannot; it only moves work off the page's main thread.
`writing-extension-ui` (core and plugins) mention that embeds may use workers. A web changeset; no
SDK change. Released before the plugin.

## Design

### Plugin

`plugins/file-preview`, npm `@capybara-hq/plugin-file-preview`, one extension `file-preview` that
provides `file-preview@1`. No migrations, no config, no data routes, no permissions beyond
`ui.embeds` for its contributions.

### Previewers

One `ui` contribution (`kind: "embed"`, `slot: "file.preview"`) per previewer, all served by the
same embed app, which picks the renderer from the contribution path (or a query parameter, builder's
call). Titles bilingual.

| id | zh / en title | accepts (MIME / extensions) | library (builder may swap for an equivalent) |
|---|---|---|---|
| `code` | 代码 / Code | `text/plain`, `text/css`, `text/javascript`, `text/x-python`, `application/json`, `application/xml`, `application/yaml`, `application/sql`; extensions of common languages and config files (ts, tsx, js, jsx, mjs, cjs, py, go, rs, java, kt, swift, c, h, cpp, hpp, cs, rb, php, sh, bash, zsh, ps1, sql, json, jsonc, yaml, yml, toml, ini, xml, css, scss, vue, svelte, dockerfile, makefile, gradle, proto, graphql, lua, r, dart, scala, txt, log, env) | Shiki (JavaScript regex engine, fixed language set) or highlight.js |
| `zip` | 压缩包 / Archive | `application/zip`; zip, jar | fflate (unzip) |
| `sheet` | 表格 / Spreadsheet | xlsx MIME; xlsx, xlsm | exceljs (npm SheetJS CE is stuck at 0.18.5 with known CVEs; fixed builds are off-registry) |
| `docx` | 文档 / Document | docx MIME; docx | mammoth |
| `pdf` | PDF | `application/pdf`; pdf | pdf.js, worker disabled |
| `svg` | SVG | `image/svg+xml`; svg | none (see below) |
| `html` | 网页 / Web page | `text/html`; html, htm | DOMPurify |

`maxBytes` is 20 MiB for every previewer (the cap) unless a renderer's limit below is lower.
Markdown and CSV / TSV are not claimed: the built-ins stay first for them.

### Embed app

- Single-page app (see constraints). Written in TypeScript, bundled with esbuild into the plugin's
  served assets: one small entry
  (bridge, theme, frame, renderer switch) plus one lazily loaded chunk per renderer, so opening a
  code file never downloads pdf.js. All assets are `public` GET routes under `/ui/`, immutable per
  plugin version (cache headers are the builder's call within what the proxy allows).
- Uses the SDK's `createEmbedBridge({ file })`, renders a loading state until `file` arrives,
  reports content height with `resize` where the slot needs it (the panel is a fixed-height area, so
  the renderer scrolls internally: builder checks which applies).
- Theme: maps the bridge's tokens to CSS custom properties; light and dark both look right.
- Every renderer shows an inline error state on a parse failure ("cannot read this file", with the
  reason) rather than throwing. The app also catches unhandled errors and runs its own watchdog
  (e.g. no first render within 15 s → the error state with "download instead"), since the panel
  has no fallback for embeds.
- Links in rendered content (html, docx) never navigate: they render as text styled as links with
  the URL as a tooltip and a "copy link" affordance (builder's call on the exact form). Opening them
  would need a new bridge message in core; not in this scope. (Design call.)

### Workers and budgets

All parsing and decoding runs in a dedicated worker (one per opened file, terminated on file
switch): unzip, xlsx parsing, docx conversion, syntax highlighting, and pdf.js with its worker
(`GlobalWorkerOptions.workerSrc` pointing at the plugin's route, no `disableWorker`). The main
thread only builds the DOM from the worker's results, in slices. A watchdog terminates a worker
that has not answered within a time budget (e.g. 20 s per file, per pdf page 10 s) and shows the
error state with "download instead". This is what keeps the anti-goal: a hostile file can hang
a worker, never the page.

### Renderers

- **code**: decode as UTF-8 (replacement characters allowed); language from the extension, then
  the MIME type, then plain. Highlight at most the first 1 MiB or 20 000 lines (show the rest
  plain or a "truncated" note: builder's call); line numbers, wrap toggle, monospace from the theme.
- **zip**: read the central directory; tree with folders collapsible, sizes, modified dates;
  encrypted entries listed but not opened. Selecting an entry previews it with the matching renderer
  (code, image, svg, sheet, docx, pdf, html). These inner previews do not consult the org's
  previewer settings (the embed cannot see them); an admin who disables `html` still sees html
  entries inside a zip rendered by the zip previewer. Intended: every renderer is sanitized; noted
  on the admin page description of `zip`. (Design call.) if its uncompressed size is ≤ 20 MiB; nested zips list
  one level deeper at most. Limits: at most 10 000 entries listed; total decompressed bytes per
  session capped (e.g. 100 MiB) and an entry's declared size checked before inflating (zip bomb).
- **sheet**: tabs per sheet; header row = column letters, row numbers on the left; cell text is
  the formatted value; merged cells shown merged where cheap; virtualized rows; at most 100 000
  rows × 200 columns rendered per sheet with a note beyond that.
- **docx**: mammoth to HTML, then DOMPurify, rendered in a styled container (no external
  resources; images as data URIs). Warnings from mammoth ignored silently.
- **pdf**: pdf.js with its worker (see above); render pages lazily as
  they scroll into view; zoom (fit width, 100 %, +/-); page indicator. Fonts load from data / the
  bundled standard fonts (served under `/ui/`). Password-protected pdf: message, no prompt.
- **svg**: rendered as `<img src="blob:…">` (an `<img>` never runs SVG script and loads no external
  resources), on a checkerboard ground; zoom to fit.
- **html**: two modes in a toggle, default "rendered": the document sanitized with DOMPurify
  (no script, no event handlers, no `iframe` / `object` / `embed` / `form` / `base` / `meta
  refresh`, no `javascript:` URLs), its styles kept but scoped by rendering into a shadow root, so
  they cannot restyle the embed's own UI. External resources (CDN scripts, styles, images, fonts)
  are blocked by the CSP anyway; a notice says "external resources and scripts are not loaded" when
  the document references any. "Source" mode: the code renderer.

### Security notes

- The embed token reaches the app's own scope; no agent content ever runs as script there: html
  and docx go through DOMPurify into a shadow root, svg only via `<img>`, everything else as text or
  canvas.
- Renderers never create elements from file content outside these paths and never set `innerHTML`
  with unsanitized strings.
- No network requests besides the plugin's own assets.

### Build and release

The embed app is built from `plugins/file-preview/ui-src/` into `plugins/file-preview/ui/` by a
package script (`build:ui`, esbuild with pinned versions, deterministic output). The plugins repo's
`pack-plugins`, release and `marketplace --check` steps run each plugin's `build:ui` first when it
exists, so `ui/` is never committed and the reproducible-pack check still holds (same lockfile →
same bytes; a test packs twice and compares). This changes only the plugins repo's scripts and CI,
not `capybara-plugin`. (Design call; the alternatives were committing built bundles to git, or
teaching `capybara-plugin pack` to run plugin build steps, a core change.)

### Distribution

- Published with the other official plugins (changeset, marketplace entry as usual).
- **Bootstrap (proposal, maintainer to confirm):** add it to core's `packages/kernel/bootstrap.json`
  as a `builtin: true` entry so every deployment has file previews out of the box without org
  setup; it holds no secrets and no data. That is a separate small core PR after the plugin's first
  release.

### Tests

- Unit (jsdom where needed): the accepts lists against the core built-ins (no claim on md / csv /
  tsv); language detection; zip limits (entry count, declared-size check, bomb fixture); sheet
  limits; the html sanitizer against a fixture of hostile documents (script, onerror, javascript:
  links, meta refresh, base, iframe, svg with script); svg never inserted as markup.
- Kernel-level (`@capybara-hq/testing`): the extension loads, the provider validates, previewers
  are listed for matching files and not for md / csv, the public `/ui/` routes serve the assets.
- A browser check of each renderer against a fixture file per format (manual or Playwright, builder's
  call) in light and dark themes.

## Left to the builder

Library choices within the table's intent, asset serving mechanics (inline strings vs packaged
`ui/` files, whichever `capybara-plugin pack` and the kernel support), exact limits where marked
"e.g.", visual details within the theme tokens, and the renderer switch mechanism.
