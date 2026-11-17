# File Preview Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@capybara-hq/plugin-file-preview`, seven sandboxed embed previewers (code, zip, sheet, docx, pdf, svg, html) for conversation files, after a one-line core CSP change that allows workers in embeds.

**Architecture:** Part 1 is a core PR (`capybara-hq/core`): `EMBED_CSP` gets `worker-src 'self' blob:`. Part 2 is a new plugin in `capybara-hq/plugins`: a server extension that provides `file-preview@1` and serves a prebuilt single-page embed app from public `/ui/` routes; the app receives the file over the embed bridge, parses it in a blob-URL worker under a watchdog, and builds the DOM on the main thread.

**Tech Stack:** TypeScript, esbuild (embed app build), Shiki (JavaScript regex engine), fflate, exceljs, mammoth, DOMPurify, pdfjs-dist, vitest (+ jsdom), `@capybara-hq/testing`.

**Spec:** `docs/superpowers/specs/2026-11-17-file-preview-plugin-design.md` (this repository). Read it before any task.

## Global Constraints

- Plugin dir `plugins/file-preview`, npm `@capybara-hq/plugin-file-preview`, plugin and extension name `file-preview`, `repository.directory: plugins/file-preview`.
- Depends only on `@capybara-hq/plugin-sdk` and third-party npm packages (no `@capybara-hq/kernel`); tests import only the SDK, `@capybara-hq/testing`, `@capybara-hq/plugin-model-fake` and the plugin.
- Every previewer: `maxBytes` = `FILE_PREVIEW_MAX_BYTES` (20 MiB); contribution `{ kind: "embed", slot: "file.preview" }`; never claims `text/markdown`, `text/csv`, `text/tab-separated-values`, `md`, `markdown`, `csv`, `tsv`, or bitmap images.
- Embed CSP after Part 1: `default-src 'self'`, inline scripts and styles allowed, `img-src 'self' data: blob:`, `font-src 'self' data:`, `connect-src 'self'`, `frame-src 'none'`, `worker-src 'self' blob:`, no `'wasm-unsafe-eval'` (no WebAssembly anywhere), sandbox `allow-scripts allow-forms` (opaque origin).
- The embed is a single-page app: no navigation of the iframe after first load (no `location` changes, no navigating links, no form submits).
- No agent content becomes script or unsanitized markup: html and docx through `sanitizeHtml` into a shadow root, svg only as `<img src="blob:…">`, everything else via `textContent` or canvas. No `innerHTML` with any other string.
- No network requests except the plugin's own `/plugin-ui/file-preview/…` assets.
- Limits: code highlight first 1 MiB or 20 000 lines; zip 10 000 entries listed, 100 MiB decompressed per opened archive, nested zip one level; sheet 100 000 rows × 200 columns per sheet; worker budget 20 s per file, 10 s per pdf page.
- English for code, comments, identifiers, commits; UI strings in zh and en (zh uses 智能体 / 平台, never "agent"); Conventional Commits, body lines ≤ 100 chars.
- Tests: no fixed sleeps, no per-test timeouts; jsdom tests start with `// @vitest-environment jsdom`.

## Review Focus

1. A text file that is not UTF-8 or is really binary (UTF-16 `.txt`, a `.log` with NUL bytes): shows decoded text with replacement characters, never an exception. Test in Task 6.
2. A 0-byte file of every format: an "empty file" state, not a spinner or an error. Tests in Tasks 6–11.
3. The person switches files while the previous file's worker is still running: the old result is never painted over the new file, and the old worker is terminated. Test in Task 5.
4. Theme switch while a preview is open: the app re-themes without reload; sanitized html keeps its own colors inside the shadow root. Test in Task 4.
5. A corrupt or misnamed file (a `.xlsx` that is CSV text, a truncated pdf, a `.zip` that is not a zip): the renderer's inline error with the reason and "download instead", not the watchdog after 20 s. Tests in Tasks 7, 8, 11.

---

## Part 1 — core (`capybara-hq/core`)

Branch: `pnpm wt:new fix/embed-workers --from origin/main` in `/Users/grant/Capybara/core`. Tasks 1, 1A and 1B in one PR; it must be released (web image rc) before Part 2's browser verification on a deployment, but Part 2 development can proceed against a local dev stack running this branch.

### Task 1: Allow workers in embeds

**Files:**
- Modify: `apps/web/src/lib/plugin-ui-proxy.ts` (`EMBED_CSP` and its doc comment)
- Test: `apps/web/test/csp.test.ts`
- Modify: `.agents/skills/writing-extension-ui/SKILL.md` (the CSP sentence near line 223)
- Create: `.changeset/<name>.md` (patch, `@capybara-hq/capybara`)

**Interfaces:**
- Produces: `EMBED_CSP` containing the directive `worker-src 'self' blob:` (the rest unchanged).

- [ ] **Step 1: Write the failing test** in `apps/web/test/csp.test.ts`, a new `it("the embed CSP allows workers from the embed's own origin and blob: only")`:

```ts
const directives = Object.fromEntries(
  EMBED_CSP.split("; ").map((d) => [d.split(" ")[0], d.split(" ").slice(1)]),
);
expect(directives["worker-src"]).toEqual(["'self'", "blob:"]);
expect(directives["frame-src"]).toEqual(["'none'"]);
expect(directives["script-src"]).toEqual(["'self'", "'unsafe-inline'"]);
expect(EMBED_CSP).not.toContain("wasm-unsafe-eval");
expect(directives.sandbox).toEqual(["allow-scripts", "allow-forms"]);
```

- [ ] **Step 2: Run it.** `pnpm exec vitest run apps/web/test/csp.test.ts` → FAIL on `worker-src`.
- [ ] **Step 3: Change** `"worker-src 'none'"` to `"worker-src 'self' blob:"` in `EMBED_CSP`; in the doc comment replace "不允许插件页…起 worker" with an English line: workers are allowed from the embed's own routes and `blob:` URLs; a worker of a sandboxed embed inherits its opaque origin and CSP, so it reaches nothing the page cannot and only moves work off the main thread (decision 2026-11-17, plugin-file-preview spec). Note that an opaque-origin page can construct workers only from `blob:` / `data:` URLs in practice, which is why `blob:` is listed.
- [ ] **Step 4: Run it.** Same command → PASS. Then `pnpm verify --fast`.
- [ ] **Step 5: Skill and changeset.** In the skill, change `object-src` / `frame-src` / `worker-src 'none'` to `object-src` / `frame-src 'none'`, `worker-src 'self' blob:` (workers for off-main-thread parsing). Changeset: patch on `@capybara-hq/capybara`, "Embeds may start Web Workers (`worker-src 'self' blob:`)".
- [ ] **Step 6: Commit and open the PR** (`fix(web): allow workers in embeds`), linked issue per the `contributing` skill.

### Task 1A: Download affordance on user file attachments

Maintainer request 2026-11-17: a user's attachment looks like the agent's file card and shows its
actions. Decision (assistant's call, stated to the maintainer): a non-image attachment keeps
"click = download"; its row gains a trailing download icon button (`aria-label` 下载 / Download)
in place of nothing. No "open in new tab" for non-image files: the kernel serves only bitmaps
inline, so a new tab would download anyway (real opening waits for the content-origin project or
attachments in the right panel). Read core's `writing-web-ui` skill first.

**Files:**
- Modify: `packages/design/src/conversation/bubble.tsx` (`BubbleAttachments` file rows), its CSS in the design package, `packages/design/src/i18n.ts` if a new string is needed
- Modify: the `/dev/ui` catalog entry for bubbles (`apps/web/src/dev/catalog/components/chat.tsx`)
- Test: the design package's bubble test (or a new `bubble-attachments.test.tsx` next to it)

**Interfaces:**
- `BubbleAttachments` gains `onDownload?(id: string): void`; when given, each file row shows the icon button, whose click calls `onDownload` and does not also fire `onOpen`. `Thread.tsx` passes `openDownload(attachmentDownloadUrl(orgId, id))`.

- [ ] **Step 1: Failing test:** with `onDownload`, a file row has a button named 下载 / Download; clicking it calls `onDownload("a1")` once and `onOpen` zero times; image thumbnails get no such button; without `onDownload` no button renders. The row matches `FileCard`'s parts (type badge, middle-truncated name, size).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (no box inside a box: the icon is a ghost icon button inside the row, `check:web-ui` and `findNestedBoxes` pass).
- [ ] **Step 4: Run** the test and `pnpm check:web-ui` → PASS. **Step 5: Commit** `feat(design): download action on file attachments`.

### Task 1B: `ImageViewer` lightbox replaces `ImageZoom`

Maintainer request 2026-11-17: image preview is a full-screen dimmed overlay with zoom, not a
dialog. Pre-0.1.0: `ImageZoom` is removed, not kept beside it.

**Files:**
- Create: `packages/design/src/conversation/image-viewer.tsx` (+ CSS in the design package)
- Delete: `packages/design/src/conversation/image-zoom.tsx`; update `packages/design/src/conversation/index.ts`
- Modify: `apps/web/src/components/conversation/Thread.tsx` (use `ImageViewer` for a message's images, all images of that message navigable), `apps/web/src/components/conversation/FilePanel.tsx` (clicking the built-in `ImagePreview` opens the viewer for that file), `packages/design/src/conversation/file-preview.tsx` (`ImagePreview` gains `onOpen?()`), `docs/design/spec.md` §5.6 (the zoom description), the `/dev/ui` catalog
- Test: `packages/design/test/image-viewer.test.tsx` (jsdom)

**Interfaces:**
- `ImageViewer({ open, onOpenChange, images, index, onIndexChange, onDownload, onOpenInNewTab, onRetry }: { open: boolean; onOpenChange(open: boolean): void; images: { src: string; name: string; size?: string }[]; index: number; onIndexChange(i: number): void; onDownload(i: number): void; onOpenInNewTab(i: number): void; onRetry?(i: number): void }): JSX.Element`
- Behavior: portal over the whole page on a dimmed backdrop token (new design token if none fits); image starts fit-to-viewport (never upscaled); zoom 0.1×–8× by wheel (around the pointer), pinch (two pointers), and toolbar buttons (−, +, 1:1, fit) with the percent shown; drag pans when the image exceeds the viewport; double-click toggles fit ↔ 100 %; Esc, the close button and a click on the backdrop (not on the image) close; ← / → and side buttons switch when `images.length > 1` and reset zoom; a top bar with name, size, `n / total`, open in new tab, download, close; focus trapped while open and restored to the opener; a failed image shows `LoadFailed` with Retry when `onRetry`; only `isSafeAttachmentHref` sources load. Strings zh / en in the design i18n (放大 / 缩小 / 实际大小 / 适应窗口 / 在新标签打开 / 下载 / 关闭 / 上一张 / 下一张).
- `onOpenInNewTab` in the web: `window.open(src with ?inline=1 where the URL is an artifact download URL, "_blank", "noopener,noreferrer")` via the existing `useOpenDownload` session refresh pattern.

- [ ] **Step 1: Failing tests:** opens with the image at fit scale; `+` raises the shown percent, `1:1` shows 100 %, `fit` restores; wheel up over the image zooms in; Esc calls `onOpenChange(false)`; click on backdrop closes, click on the image does not; with three images `ArrowRight` calls `onIndexChange(1)`, with one image no nav buttons render; download / new-tab buttons call their handlers with the index; an unsafe `src` renders no `img`; focus returns to the opener after close.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**, then wire `Thread.tsx` and `FilePanel.tsx`, remove `ImageZoom` and its references.
- [ ] **Step 4: Run** the design tests, `pnpm check:web-ui`, `pnpm typecheck` → PASS; check `/dev/ui` by hand in light and dark. Visual baselines are re-rendered only by the `visual-update` workflow: trigger it on the PR.
- [ ] **Step 5: Commit** `feat(design): image viewer with zoom replaces the image dialog`; changeset patch on `@capybara-hq/capybara` (shared with Task 1's PR).

---

## Part 2 — plugin (`capybara-hq/plugins`)

Branch: continue on `docs/file-preview-plugin`'s successor `feat/file-preview` (`pnpm wt:new feat/file-preview --from origin/main`, then cherry-pick the spec and plan commit). One PR, tasks committed in order.

### File structure

```
plugins/file-preview/
  package.json, tsconfig.json, icon.svg, README.md, CHANGELOG.md (via changeset)
  .capybara-plugin/plugin.json
  .gitignore                      ui/
  src/index.ts                    defineExtension: provide file-preview@1, ui contributions, routes
  src/previewers.ts               PREVIEWERS table (ids, titles, accepts) — single source
  src/assets.ts                   serve ui/ files by manifest allowlist
  ui-src/build.ts                 buildUi(outDir) — esbuild, deterministic, writes manifest.json
  ui-src/index.html               the shell page template
  ui-src/app/main.ts              boot: bridge → theme → watchdog → renderer
  ui-src/app/bridge.ts            parent message parsing and state
  ui-src/app/theme.ts             tokens → CSS custom properties
  ui-src/app/frame.ts             loading / empty / error states (+ i18n strings)
  ui-src/app/worker-host.ts       runInWorker: blob-URL worker, budget, cancel
  ui-src/app/sanitize.ts          sanitizeHtml (DOMPurify) for html and docx
  ui-src/renderers/<id>.ts        render(file, ctx) per previewer, main-thread side
  ui-src/workers/<id>.worker.ts   parsing per previewer, worker side
  test/*.test.ts                  unit (node / jsdom) and kernel tests
  test/fixtures/                  one small file per format + hostile fixtures
```

### Task 2: Scaffold and the build pipeline

**Files:**
- Create: `plugins/file-preview/{package.json,tsconfig.json,.gitignore,.capybara-plugin/plugin.json,icon.svg}`, `plugins/file-preview/ui-src/{build.ts,index.html}`, `plugins/file-preview/ui-src/app/main.ts` (placeholder that renders "ready")
- Modify: root `package.json` scripts, `tsconfig.json` references, `.github/workflows/ci.yml` (one step), `.github/workflows/release.yml` (two steps)
- Test: `plugins/file-preview/test/build.test.ts`

**Interfaces:**
- Produces: `buildUi(outDir: string): Promise<UiManifest>` in `ui-src/build.ts`; `interface UiManifest { files: Record<string, { contentType: string; sha256: string }> }` written to `<outDir>/manifest.json`; output file names are flat (`[a-z0-9.-]+`), the entry is `app.js`, the shell `index.html`, each worker `<id>.worker.js`, chunks `chunk-<hash>.js`.
- Produces: package script `build:ui` (`tsx ui-src/build.ts`, writes `plugins/file-preview/ui/`), and root script `build:ui` = `pnpm -r --if-present run build:ui`.

- [ ] **Step 1: Failing test** `build.test.ts`: `it("builds the same bytes twice")` — `buildUi` into two temp dirs, assert both `manifest.json` deep-equal and every listed file's bytes equal; `it("emits only flat, allowlisted names")` — every manifest key matches `/^[a-z0-9][a-z0-9.-]*$/` and `index.html`, `app.js` are present.
- [ ] **Step 2: Run** `pnpm exec vitest run plugins/file-preview/test/build.test.ts` → FAIL (no module).
- [ ] **Step 3: Implement.** Package metadata like `plugins/todo` (description: "Previews code, archives, spreadsheets, documents, PDFs, SVG and HTML files in the conversation"), `publisher: "Capybara"`, displayName zh 文件预览 / en File preview; icon via `pnpm icons:generate` (pick the closest glyph). esbuild options: `bundle`, `splitting`, `format: "esm"`, `minify`, `target: "es2022"`, `legalComments: "none"`, `metafile`, no sourcemaps, fixed `entryNames`/`chunkNames`, `charset: "utf8"`; workers built as separate IIFE bundles; manifest keys sorted. `.gitignore` ignores `ui/`.
- [ ] **Step 4: Wire the pipeline.** Root scripts: `pack-plugins`, `release`, `check:marketplace` and `version-packages` run `pnpm build:ui &&` first. `ci.yml`: a step "Build plugin UI" (`pnpm build:ui`) before "Marketplace manifest" (that step calls `capybara-plugin` directly). `release.yml`: `pnpm build:ui` after `pnpm install` in both jobs.
- [ ] **Step 5: Run** the test → PASS; `pnpm build:ui && pnpm pack-plugins` twice and compare the `file-preview` tgz sha512 → equal; `pnpm check` passes.
- [ ] **Step 6: Commit** `feat(file-preview): scaffold the plugin and its embed build`.

### Task 3: The extension — previewers and asset routes

**Files:**
- Create: `src/previewers.ts`, `src/assets.ts`, `src/index.ts`
- Test: `test/previewers.test.ts`, `test/assets.test.ts`, `test/kernel.http.test.ts`

**Interfaces:**
- Consumes: `UiManifest` and the `ui/` layout from Task 2.
- Produces: `PREVIEWERS: readonly PreviewerSpec[]` where `PreviewerSpec = { id: PreviewerId; title: { zh: string; en: string }; accepts: { mimeTypes: string[]; extensions: string[] } }`, `type PreviewerId = "code" | "zip" | "sheet" | "docx" | "pdf" | "svg" | "html"`.
- Produces routes (all `public` GET in `permissions.http`): `/ui/<id>` for each previewer id → the shell `index.html` with `<meta name="previewer" content="<id>">`; `/ui/assets/:file` → a file listed in `manifest.json`, else 404.
- Produces: contribution ids = previewer ids; `permissions.ui.embeds` = the seven ids.

- [ ] **Step 1: Failing tests.**
  - `previewers.test.ts`: `validateFilePreviewProvider` returns `[]` for the provider built from `PREVIEWERS`; using the SDK's `previewerAccepts`, none accepts `{name:"a.md",contentType:"text/markdown"}`, `a.csv`/`text/csv`, `a.tsv`, `a.png`/`image/png`; `code` accepts `a.tsx`/`application/octet-stream`, `a.ts`/`text/plain`, `a.py`/`text/x-python`; `html` accepts `a.htm`/`text/html` and `code` does not; `sheet` accepts `a.xlsx` and not `a.xls`; `zip` accepts `a.jar`.
  - `assets.test.ts` (against a temp `ui/` written by `buildUi`): `/ui/assets/app.js` → 200, `text/javascript; charset=utf-8`; `../package.json`, `%2e%2e%2fpackage.json`, `manifest.json`-unlisted names → 404; `/ui/pdf` → HTML containing the `previewer` meta `pdf`.
  - `kernel.http.test.ts` (pattern of `plugins/todo/test/kernel.http.test.ts`, `buildUi` into the plugin's `ui/` in `beforeAll`): the extension loads and is enabled for an org; `GET /api/v1/orgs/<org>/file-previewers` as the org owner lists the seven ids in order; `GET /plugins/file-preview/ui/code` → 200 HTML; `GET /plugins/file-preview/ui/assets/app.js` → 200.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Accept lists exactly as the spec's table (code MIME types listed one by one; xlsx MIME `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`; docx MIME as in core `deliver.ts`). `assets.ts` reads `new URL("../ui/", import.meta.url)` (same relative path from `src/` and from the packed `dist/`), loads `manifest.json` once per request handler call (no module state; cache via a lazily filled `ctx`-scoped object created in `setup`), serves with `cache-control: private, max-age=31536000, immutable` for hashed chunk names and `no-cache` for `index.html`, `app.js`, `*.worker.js`.
- [ ] **Step 4: Run** → PASS; `pnpm check` (perm-ui, plugin-state).
- [ ] **Step 5: Commit** `feat(file-preview): previewers and asset routes`.

### Task 4: Embed shell — bridge, theme, states, watchdog, renderer switch

**Files:**
- Create: `ui-src/app/{bridge.ts,theme.ts,frame.ts,main.ts}`, `ui-src/renderers/index.ts`
- Test: `test/app-shell.test.ts` (jsdom)

**Interfaces:**
- Consumes: `EmbedParentMessage`, `EMBED_PROTOCOL`, `Locale` types from `@capybara-hq/plugin-sdk` (types and the constant only).
- Produces: `interface PreviewFile { name: string; contentType: string; size: number; data: ArrayBuffer }`; `interface RenderContext { root: HTMLElement; locale: "zh" | "en"; signal: AbortSignal; t(key: MessageKey): string; runInWorker: RunInWorker; showError(reason: string): void }`; `type Renderer = (file: PreviewFile, ctx: RenderContext) => Promise<void>`; `loadRenderer(id: PreviewerId): Promise<Renderer>` (dynamic import per id); `createBridge(win: Window, onEvent: (e: BridgeEvent) => void): () => void` where `BridgeEvent = { type: "init"; locale; theme; tokens } | { type: "theme"; theme; tokens } | { type: "file"; file: PreviewFile }`; `applyTheme(doc: Document, theme: "dark" | "light", tokens: Record<string, string>): void`; `frame.ts` exports `showLoading`, `showEmpty`, `showError(reason, onDownloadHint)`; i18n `MESSAGES: Record<"zh" | "en", Record<MessageKey, string>>`.

- [ ] **Step 1: Failing tests.**
  - `createBridge` ignores messages whose `source` is not `window.parent`, whose `protocol` differs, or with unknown `type`; delivers `file` only after `init`; a second `file` is ignored.
  - `applyTheme` sets `--cap-<token>` custom properties on `:root` and `data-theme`; a later `theme` event replaces them (Review Focus 4: a mounted preview's root keeps its DOM nodes, only properties change).
  - Main flow with a stub renderer: `size === 0` → `showEmpty`, renderer not called; renderer throwing → `showError` with its message; renderer never resolving → after the 20 s budget (vitest fake timers) `showError` with the timeout message.
- [ ] **Step 2: Run** `pnpm exec vitest run plugins/file-preview/test/app-shell.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Previewer id from the `previewer` meta. Messages (zh / en): loading 正在加载… / Loading…; empty 空文件 / Empty file; error title 无法预览此文件 / Can't preview this file; download hint 可以用右上角的下载查看原文件 / Use Download at the top right to open the original; timeout 解析超时 / Took too long to read. `window.onerror` and `unhandledrejection` → `showError`. No `resize` messages (the panel area has a fixed height; the app scrolls internally).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(file-preview): embed shell`.

### Task 5: Worker host

**Files:**
- Create: `ui-src/app/worker-host.ts`, `ui-src/workers/protocol.ts`
- Test: `test/worker-host.test.ts` (jsdom with a fake `Worker` and `fetch`)

**Interfaces:**
- Produces: `type RunInWorker = <I, O>(worker: PreviewerId | "pdfjs", input: I, opts?: { budgetMs?: number; transfer?: Transferable[] }) => Promise<O>`; `createWorkerHost(deps: { fetch: typeof fetch; Worker: typeof Worker; createObjectURL: (b: Blob) => string; assetBase: string }): { run: RunInWorker; dispose(): void }`; worker protocol `{ id: number; input } → { id; ok: true; output } | { id; ok: false; error: string }`. Rejections: `WorkerTimeoutError`, `WorkerDisposedError`, or `Error(error)`.
- Worker scripts are fetched from `assets/<id>.worker.js`, turned into a `blob:` URL, and constructed with `new Worker(url)` (an opaque-origin page cannot start a worker from its own URL).

- [ ] **Step 1: Failing tests.** `run` posts the input and resolves with `output`; `ok:false` rejects with the message; no answer within `budgetMs` → `WorkerTimeoutError` and `terminate()` called; `dispose()` terminates live workers and rejects pending runs with `WorkerDisposedError` (Review Focus 3: main ignores a result that arrives after dispose — assert the renderer's DOM write callback is not called); the script is fetched once per worker id.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** Default budget 20 000 ms.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Real-browser spike (required before Task 6).** With the core branch from Task 1 running locally (`pnpm dev:kernel` + `pnpm dev:web` in core, the plugin loaded from this worktree), deliver a `.ts` file and confirm in Chrome, Firefox and Safari that a test worker answers inside the embed. If any browser refuses `blob:` workers in the sandboxed iframe, stop and report: the plan's Global Constraints change.
- [ ] **Step 6: Commit** `feat(file-preview): worker host`.

### Task 6: Code renderer

**Files:**
- Create: `ui-src/renderers/code.ts`, `ui-src/workers/code.worker.ts`, `ui-src/app/language.ts`
- Test: `test/code.test.ts` (node for the worker logic, jsdom for the renderer)

**Interfaces:**
- Produces: `languageFor(name: string, contentType: string): string` (Shiki language id or `"text"`); worker input `{ text: string; lang: string; theme: "dark" | "light" }` → output `{ lines: { content: string; color?: string }[][]; truncated: boolean }`; `renderCode(root, file, ctx)` reused by zip and html (source mode): `export function mountCode(root: HTMLElement, text: string, name: string, contentType: string, ctx: RenderContext): Promise<void>`.

- [ ] **Step 1: Failing tests.** `languageFor("a.tsx","application/octet-stream") === "tsx"`, `("Dockerfile","application/octet-stream") === "dockerfile"`, `("x.unknown","text/plain") === "text"`, `("a.py","text/x-python") === "python"`; worker logic: 25 000-line input → 20 000 lines and `truncated: true`; 2 MiB single line → cut at 1 MiB, `truncated: true`; UTF-16LE bytes with BOM decode correctly, invalid UTF-8 and NUL bytes produce `�`/visible text without throwing (Review Focus 1); renderer builds spans only via `textContent` (assert a line `<img src=x onerror=alert(1)>` yields no `img` element); 0 bytes → empty state (Review Focus 2); wrap toggle flips a `data-wrap` attribute.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** with Shiki's core + `createJavaScriptRegexEngine`, a fixed language list covering the spec's extensions, two themes (light / dark) chosen to match the design tokens; decode with `TextDecoder` (BOM sniffing, `fatal: false`). Line numbers in a separate column.
- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `feat(file-preview): code previewer`.

### Task 7: Zip renderer

**Files:**
- Create: `ui-src/renderers/zip.ts`, `ui-src/workers/zip.worker.ts`
- Test: `test/zip.test.ts` (+ fixtures built in the test with fflate: normal, 10 001 entries, a bomb whose declared size exceeds the cap, encrypted entry, nested zip, not-a-zip bytes)

**Interfaces:**
- Consumes: `loadRenderer` (Task 4), `mountCode` (Task 6).
- Produces: worker ops `{ op: "list" } → { entries: { path: string; size: number; compressed: number; modified: string; encrypted: boolean; dir: boolean }[]; truncated: boolean }` and `{ op: "extract"; path: string } → { data: ArrayBuffer }` (the worker keeps the archive bytes and a running decompressed-bytes counter).

- [ ] **Step 1: Failing tests.** listing sorted folders first; 10 001 entries → 10 000 and `truncated`; extracting an entry whose declared size > 20 MiB → error "entry too large", nothing inflated; cumulative extraction past 100 MiB → error "archive limit reached"; an entry whose actual inflated size exceeds its declared size → error (stream-inflate with a byte cap); encrypted → listed with a lock, extract refused; nested zip lists one level, a zip inside that is shown but not openable; not-a-zip → inline error (Review Focus 5); empty archive (valid, 0 entries) and 0-byte file → empty state (Review Focus 2); selecting `a/b.json` mounts the code renderer in the detail pane without changing `location`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (tree pane + detail pane; entry preview picks the renderer by extension through the same `PREVIEWERS` accept rules, bitmaps shown as `<img src="blob:…">`).
- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `feat(file-preview): zip previewer`.

### Task 8: Sheet renderer

**Files:**
- Create: `ui-src/renderers/sheet.ts`, `ui-src/workers/sheet.worker.ts`
- Test: `test/sheet.test.ts` (fixtures generated with exceljs in the test: two sheets, a formula with cached result, a merged range, dates, 100 001 rows; plus CSV text renamed `.xlsx`)

**Interfaces:**
- Produces: worker input `{ data: ArrayBuffer }` → `{ sheets: { name: string; rows: string[][]; merges: { r1: number; c1: number; r2: number; c2: number }[]; truncatedRows: boolean; truncatedCols: boolean }[] }` (cell text = exceljs `cell.text`).

- [ ] **Step 1: Failing tests.** two tabs named as in the file; formula cell shows its cached result; date cell shows the formatted text; 100 001 rows → 100 000 and the truncation note; 201 columns → 200 and the note; CSV renamed `.xlsx` → inline error (Review Focus 5); 0 bytes → empty state; the table renders only the visible window of rows (virtualization: with 100 000 rows the DOM holds < 500 `tr`).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (column letters header, row numbers, sticky headers, tab bar).
- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `feat(file-preview): spreadsheet previewer`.

### Task 9: Sanitizer, html and svg renderers

**Files:**
- Create: `ui-src/app/sanitize.ts`, `ui-src/renderers/html.ts`, `ui-src/renderers/svg.ts`
- Test: `test/sanitize.test.ts`, `test/html-svg.test.ts` (jsdom), `test/fixtures/hostile/*.html`

**Interfaces:**
- Produces: `sanitizeHtml(html: string, doc: Document): { fragment: DocumentFragment; styles: string[]; external: boolean }` (styles = the document's `<style>` contents, sanitized of `@import` and `url(http…)`; `external` true when any script, stylesheet link, remote `src`/`href`/`url()` was removed); `mountSanitized(root: HTMLElement, result): ShadowRoot`.

- [ ] **Step 1: Failing tests** over hostile fixtures: `<script>`, `onerror`/`onclick` attributes, `javascript:`/`data:text/html` URLs, `<meta http-equiv=refresh>`, `<base>`, `<iframe>`, `<object>`, `<embed>`, `<form>`, inline `<svg><script>`, `<style>@import url(https://x)</style>` → none survive, `external === true` for the remote ones; `<a href="https://example.com">x</a>` → a non-navigating element with `title="https://example.com"` and no `href`; a page's `body { color: red }` applies inside the shadow root and not to the app's own frame (Review Focus 4); html renderer defaults to "rendered" and the toggle mounts `mountCode` with the original source; the notice "外部资源和脚本未加载 / External resources and scripts are not loaded" shows only when `external`; svg renderer creates exactly one `img` with a `blob:` src and never an `svg` element in the DOM; 0 bytes → empty state.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** with DOMPurify (`RETURN_DOM_FRAGMENT`, `WHOLE_DOCUMENT` for html input, a hook rewriting `a[href]`), on the main thread (DOMPurify needs a DOM).
- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `feat(file-preview): html and svg previewers`.

### Task 10: Docx renderer

**Files:**
- Create: `ui-src/renderers/docx.ts`, `ui-src/workers/docx.worker.ts`
- Test: `test/docx.test.ts` (fixtures: a small docx with heading, list, table and an embedded png; a docx whose text contains `<script>` and a hyperlink; a corrupt docx)

**Interfaces:**
- Consumes: `sanitizeHtml`, `mountSanitized` (Task 9).
- Produces: worker input `{ data: ArrayBuffer }` → `{ html: string }` (mammoth `convertToHtml`, images as data URIs).

- [ ] **Step 1: Failing tests.** heading, list items, table cells and an `img` with a `data:image/png` src appear in the shadow root; the literal `<script>` text appears as text, not an element; the hyperlink is non-navigating with its URL as title; corrupt docx → inline error; 0 bytes → empty state.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (document styles from the theme tokens: page width, readable line length).
- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `feat(file-preview): docx previewer`.

### Task 11: Pdf renderer

**Files:**
- Create: `ui-src/renderers/pdf.ts`; the pdf.js worker bundled as `pdfjs.worker.js`; standard fonts and cmaps copied into the build output and listed in the manifest (update `build.ts`)
- Test: `test/pdf.test.ts` (logic with a stubbed pdf.js document; real fixtures: a 3-page pdf, an encrypted pdf, a truncated pdf), `test/build.test.ts` (fonts and cmaps listed)

**Interfaces:**
- Consumes: `createWorkerHost`'s fetch-to-blob routine for the pdf.js worker (`GlobalWorkerOptions.workerPort = new Worker(blobUrl)`), `RenderContext`.
- Produces: `standardFontDataUrl` and `cMapUrl` pointing at `assets/` paths; `isEvalSupported: false`; no WebAssembly decoders (`useWasm: false` or the JS fallback the chosen pdfjs-dist version offers).

- [ ] **Step 1: Failing tests.** page indicator shows `1 / 3`; only pages intersecting the viewport (+1) are rendered (stub counts `render` calls); zoom fit-width / 100 % / ± changes the scale and re-renders visible pages only; a page whose render exceeds 10 s shows an inline page error and other pages still render; encrypted → "password-protected PDF" message, no prompt; truncated pdf → inline error (Review Focus 5); 0 bytes → empty state; build manifest lists `pdfjs.worker.js` and the font files.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** Check the tgz stays under 50 MiB / 5 000 entries (ship only the cmaps pdf.js needs for CJK and the standard fonts).
- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `feat(file-preview): pdf previewer`.

### Task 12: Docs, release note and browser verification

**Files:**
- Create: `plugins/file-preview/README.md`, `.changeset/<name>.md` (patch on `@capybara-hq/plugin-file-preview`; the repo's rc pre mode makes the first version `0.1.0-rc.0`)
- Modify: `.agents/skills/writing-extension-ui/SKILL.md` (CSP line: workers allowed; point to `plugins/file-preview` as the reference file previewer), the plugin description in `plugin.json` / `package.json` gains the zip note ("entries inside archives are previewed regardless of per-previewer settings")
- Modify: `tools/ci` only if `affected.ts` needs to know `ui-src/` (check that a change under `plugins/file-preview/ui-src` runs that plugin's tests)

- [ ] **Step 1:** README: what each previewer shows, the limits, the zip-ignores-org-disable note, links are not clickable, html is static until the content-origin project.
- [ ] **Step 2:** Browser verification on the local stack (core branch from Task 1): one fixture per format plus each hostile fixture, Chrome / Firefox / Safari, light and dark; switch files rapidly (Review Focus 3); record screenshots in the PR description.
- [ ] **Step 3:** `pnpm verify`; open the PR (`feat(file-preview): official file preview plugin`), linked issue; state that it needs the core release from Part 1.
- [ ] **Step 4: Commit** `docs(file-preview): readme and skill`.

### After both PRs merge (not part of this plan's PRs)

Bootstrap entry in core's `packages/kernel/bootstrap.json` (`builtin: true`) is a maintainer decision still open in the spec; ask before doing it.
