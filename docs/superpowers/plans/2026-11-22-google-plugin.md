# Google Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task, with core's `wave-planned-subagent-development` layer (the wave table below). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@capybara-hq/plugin-google` phase 1 (Sign in with Google, `identity-source@1`) after two small core PRs, and lay out phase 2 (Google Workspace connector templates), which waits for one core change.

**Architecture:** Part 1 is core (`capybara-hq/core`): an OIDC mode for `startFakeOAuthServer` in `@capybara-hq/testing` (core#551) and a login refusal reason `sso.account_not_allowed` (core#553), released as rc. Part 2 is a new plugin `plugins/google` in this repository: one extension that provides `identity-source@1` (OpenID Connect against Google with PKCE S256, nonce, the ID token verified with `jose` against Google's JWKS, the `hd` claim enforced on the verified token) and two read-only setup checks, a platform setup guide in zh / en, unit, kernel-level and live tests. Part 3 (phase 2) is an outline gated on core#552.

**Tech Stack:** TypeScript, `jose` (^6.2.12, as in `plugins/slack`), `zod` ^4, `@capybara-hq/plugin-sdk`, vitest, `@capybara-hq/testing` (`startTestKernel`, `startFakeOAuthServer` with `oidc`).

**Spec:** `docs/superpowers/specs/2026-11-22-google-plugin-design.md` (this repository, PR #146; D1–D14 accepted 2026-11-22). Read §4 before any phase 1 task and §5 before phase 2.

**Core issues:** core#551 (fake OIDC, phase 1 tests), core#552 (`authorizationParams`, blocks phase 2), core#553 (refusal reason, phase 1), core#554 (`signInCallbackUrl` at `extension-deployment` and guide limits; not blocking).

## Maintainer answers (2026-11-22)

- core#553 (refusal reason) is in phase 1.
- The live test uses an Internal Web OAuth client in a Workspace-owned project, kept in
  `~/.capybara-test.env`; the maintainer creates it. Until then the live test skips.
- The maintainer stages the npm name `@capybara-hq/plugin-google` (`0.0.0-stage`) before the plugin
  PR merges, so `release --auto` can publish it.
- core#552 gets a short design note in core before code.

## Global Constraints

- Plugin dir `plugins/google`, npm `@capybara-hq/plugin-google`, plugin and extension name `google`, `repository.directory: plugins/google`, first version `0.1.0-rc.0`. Not a bootstrap plugin; no core pin.
- Dependencies: `@capybara-hq/plugin-sdk`, `jose`, `zod` only; never `@capybara-hq/kernel`. Tests import only the SDK, `@capybara-hq/testing`, `@capybara-hq/plugin-model-fake` and the plugin (`plugin-test-imports`).
- One `plugin-sdk` instance in the workspace: the SDK, kernel and testing versions are pinned by `overrides` in `pnpm-workspace.yaml`; bumping one bumps the overrides in the same commit (`pnpm why @capybara-hq/plugin-sdk` shows one version).
- Config is deployment-level only (`config.deployment`, Ruling P1): no field carries `orgAccess`; invalid config never fails startup (`authorizeUrl` throws, the kernel shows `sso.unavailable`).
- Endpoints (constants, overridable only through the platform-only `endpoints` field): authorize `https://accounts.google.com/o/oauth2/v2/auth`, token `https://oauth2.googleapis.com/token`, JWKS `https://www.googleapis.com/oauth2/v3/certs`, discovery `https://accounts.google.com/.well-known/openid-configuration`, issuers `https://accounts.google.com` and `accounts.google.com`.
- Scopes `openid email profile`; no `access_type`; `prompt=select_account` always (D6); `hd=<domain>` only when `allowedDomains` has exactly one entry, as a UI hint.
- The hosted-domain gate reads only the verified `hd` claim, never the URL parameter, never the email domain (D5). The email domain is not required to equal `hd`.
- Identity: `externalId = sub`, `tenantId = hd` lowercased or `consumer`, `source = google:<tenantId>` (D3); `emailVerified` is true only when `email_verified === true` and (`hd` is set or the email ends in `@gmail.com`).
- Every request: `signal` combined with a 10-second timeout, one attempt, no retries. Errors and logs carry Google's `error` code and HTTP status only, never a body, code, token, client id + secret pair or secret.
- Setup checks: read-only, one request each, fixed texts, place `extension-deployment`, never a secret in `reason` / `fix`.
- The extension keeps no state beyond a per-instance JWKS map created in the factory (read-only, correct when lost); no kv, no timers, no hooks, no tools, no UI, no migrations, no `secrets` permission.
- English for code, comments, identifiers, commits; every UI string (field labels, help, guide, check texts, source label) in zh and en; zh uses 平台 / 超级管理员 / 智能体, never 企业 or "agent". Conventional Commits, body lines ≤ 100 characters.
- Tests: no fixed sleeps, no per-test timeouts; live tests skip unless their `CAPYBARA_TEST_*` variables are set; keys come from `~/.capybara-test.env`, loaded only inside the test command, never printed.

## Review Focus

1. **JWKS key rotation.** Google rotates signing keys; an ID token whose `kid` is not in the cached key set must make `jose` refetch the JWKS and the login succeed, not fail until restart. Test in Task 6 (`rotated key`).
2. **`gmail.com` in `allowedDomains`.** A super admin who lists `gmail.com` expecting to admit consumer accounts would lock everyone out silently (consumer tokens carry no `hd`). Config validation refuses `gmail.com` and `googlemail.com` with a message pointing at `allowConsumerAccounts`. Test in Task 4.
3. **Pasted values with whitespace.** A client id or secret copied from the Google console with a trailing space or newline must work: both are trimmed before use. Test in Task 4.
4. **A hung token endpoint.** The token exchange aborts at 10 s (inside the kernel's 15 s budget), the login ends on `sso.provider_error`, and neither the code nor the secret reaches the error. Test in Task 6 (`hung token endpoint`).
5. **`email_verified` as the string `"true"`.** Some Google token paths historically sent strings; only the boolean `true` counts (conservative: no merge, never a false positive). Test in Task 5.

---

## Wave plan

| Task | Depends on (interfaces) | Files / areas | Risk | Wave | Review |
|---|---|---|---|---|---|
| 1 Fake OIDC in `startFakeOAuthServer` (core#551) | none | core `packages/testing` | normal | 1 | batched (wave 1) |
| 2 Refusal reason `sso.account_not_allowed` (core#553) | none | core SDK `identity.ts`, kernel `identity/sso.ts`, web login | **high** (auth flow) | 1 | alone, most capable |
| — core release (Version Packages PR; testing, plugin-sdk, kernel rc) | 1, 2 | | | gate | |
| 3 Scaffold + core upgrade | release | `plugins/google` skeleton, root manifests, lockfile, icon check | normal | 2 | batched (wave 2) |
| 4 Config | 3 | `src/config.ts` | normal | 3 | batched (wave 3) |
| 5 Claims: hd gate, emailVerified, identity mapping | 3 | `src/claims.ts` | **high** | 3 | alone, most capable |
| 6 Identity source: authorize URL, token exchange, ID token verification | 4, 5 | `src/identity.ts` | **high** | 4 | alone, most capable |
| 7 Setup checks | 4 | `src/setup-checks.ts` | **high** (uses the client secret) | 4 | alone, most capable |
| 8 Extension manifest, guide, README | 6, 7 | `src/index.ts`, `guides/`, `plugin.json`, README | normal | 5 | batched (wave 5) |
| 9 Kernel-level login test | 1, 2, 8 | `test/kernel/login.test.ts` | normal | 6 | batched (wave 6) |
| 10 Live test, marketplace entry, docs | 8 | `test/live/`, `marketplace.json`, root README, AGENTS.md, skill | normal | 6 | batched (wave 6) |
| — plugins PR, merge, Version Packages PR, publish rc.0 | 1–10 | | | gate | final whole-branch review, most capable |

The whole-branch review of Part 2 re-reads Tasks 5–7 together: the security argument (nonce, `aud`, `iss`, `azp`, `hd`, email authority) spans three files.

---

## Part 1 — core (`capybara-hq/core`)

Two PRs, one worktree each (`pnpm wt:new feat/fake-oidc --from origin/main` and `pnpm wt:new feat/sso-account-not-allowed --from origin/main` in `/Users/grant/Capybara/core`). Both must be released (the Version Packages PR in core publishes `@capybara-hq/testing`, `@capybara-hq/plugin-sdk` and `@capybara-hq/kernel` rc) before Part 2 starts. Read core's `writing-channels` and `writing-connectors` skills (fake servers sections) first.

### Task 1: OIDC mode for `startFakeOAuthServer` (core#551)

**Files:**
- Modify: `packages/testing/src/fake-oauth-server.ts`
- Modify: `packages/testing/src/index.ts` (export the new types)
- Test: `packages/testing/test/fake-oauth-server.test.ts`
- Modify: `.agents/skills/writing-connectors/SKILL.md` and `.agents/skills/writing-channels/SKILL.md` (fake-server rows)
- Create: `.changeset/fake-oauth-oidc.md` (patch, `@capybara-hq/testing`)

**Interfaces:**
- Produces (options): `FakeOAuthServerOptions.oidc?: { issuer?: string }` (default `issuer` = the server's own `http://127.0.0.1:<port>`); `FakeOAuthServerOptions.refreshTokenOnlyWith?: Record<string, string>`.
- Produces (server): `jwksUrl: string` (`${issuer}/jwks`); `queueLogin(claims: FakeOidcClaims): void`; `tamperNextIdToken(claims: Record<string, unknown>, o?: { foreignKey?: boolean; kid?: string }): void`; `issNext(iss: string): void`.
- `FakeOidcClaims = { sub: string; email?: string; email_verified?: unknown; hd?: string; name?: string; given_name?: string; family_name?: string; picture?: string; [k: string]: unknown }`.
- Behaviour: with `oidc`, `/.well-known/openid-configuration` adds `jwks_uri`, `id_token_signing_alg_values_supported: ["RS256"]`; the authorize request's `nonce` is kept with the code; the code exchange answers `id_token` (RS256, header `kid`, claims `iss` (or the `issNext` value), `aud = client_id`, `azp = client_id`, `iat = now`, `exp = now + 3600`, `nonce`, then the dequeued login's claims; an empty queue logs in `{ sub: "fake-sub-1" }`). `GET /jwks` serves the public key. `refreshTokenOnlyWith`: the code exchange returns a refresh token only when the authorize request carried every listed parameter with that value.
- Uses `node:crypto` (`generateKeyPairSync("rsa")`, `createSign("RSA-SHA256")`), like `fake-slack.ts`'s `signJwt`; no new dependency.

- [ ] **Step 1: Write the failing tests** in `fake-oauth-server.test.ts`, a `describe("oidc")` driving authorize → token by `fetch` with PKCE:
  - `it("issues an RS256 ID token with the authorize nonce and the queued claims")`: `queueLogin({ sub: "1001", hd: "example.com", email: "a@example.com", email_verified: true })`; decode the token (split, base64url) and verify the signature with `crypto.verify` against the JWK from `jwksUrl`; expect `nonce`, `aud`, `azp`, `iss === server.issuer`, `hd`, `sub`.
  - `it("issNext changes one token's iss")` → `"accounts.google.com"` once, then back.
  - `it("tamperNextIdToken with foreignKey signs with a key not in the JWKS")` → verification against the JWKS fails; the next token verifies again.
  - `it("refreshTokenOnlyWith issues a refresh token only with access_type=offline")` → no `refresh_token` without the parameter, one with it.
  - `it("without oidc nothing changes")`: no `id_token`, `/jwks` 404.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/testing/test/fake-oauth-server.test.ts` → FAIL.
- [ ] **Step 3: Implement** in `fake-oauth-server.ts`; keep existing behaviour byte-for-byte without `oidc`. Add `id_token` values to `issuedSecrets()`.
- [ ] **Step 4: Run** the same command → PASS; then `pnpm verify --fast`.
- [ ] **Step 5: Skills and changeset.** Add the OIDC mode to the fake-server sentence of writing-connectors and the fake table of writing-channels. Changeset: patch on `@capybara-hq/testing`, "startFakeOAuthServer: OIDC mode (ID tokens, JWKS, queued claims, tampering) and refreshTokenOnlyWith".
- [ ] **Step 6: Commit** `feat(testing): OIDC mode for the fake OAuth server (#551)` and open the PR (`Closes #551`), per the `contributing` skill.

### Task 2: A refusal reason at login, `sso.account_not_allowed` (core#553) — high risk

Auth flow: reviewed alone on the most capable model.

**Files:**
- Modify: `packages/plugin-sdk/src/identity.ts` (class and guard), `packages/plugin-sdk/src/index.ts` (exports)
- Modify: `packages/kernel/src/identity/sso.ts` (`SsoLoginError`, the catch around `src.callback`)
- Modify: `apps/web/src/lib/auth-sources.ts` (`LOGIN_ERROR_CODES`), `apps/web/messages/en.json`, `apps/web/messages/zh.json` (`login.ssoError.sso.account_not_allowed`)
- Test: `packages/kernel/test/identity/sso.http.test.ts`, `apps/web/test/login-sso.test.tsx`, a unit test for the guard next to the SDK's existing identity tests (create `packages/plugin-sdk/test/identity.test.ts` if none)
- Modify: `.agents/skills/writing-channels/SKILL.md` (identity-source section: when to throw it); the generated SDK API report (`pnpm gen:sdk-api`)
- Create: `.changeset/sso-account-not-allowed.md` (patch: `@capybara-hq/plugin-sdk`, `@capybara-hq/kernel`, `@capybara-hq/capybara`)

**Interfaces:**
- Produces (SDK): `class IdentitySourceRefused extends Error` with `name = "IdentitySourceRefused"`; `function isIdentitySourceRefused(err: unknown): boolean` (true when `err` is an `Error` whose `name === "IdentitySourceRefused"`: duck-typed, so a plugin bundling another SDK copy still matches).
- Produces (kernel): `SsoLoginError` gains `"sso.account_not_allowed"`; a callback error for which `isIdentitySourceRefused` is true redirects to `/login?error=sso.account_not_allowed`; every other error stays `sso.provider_error`. The plugin's message is logged (warn), never put in the URL.
- Copy: en "This account is not allowed to sign in on this platform. Use an account of an allowed organization, or contact an administrator."; zh "这个账号不允许登录本平台。请使用允许的组织的账号，或联系管理员。"

- [ ] **Step 1: Failing tests.** SDK: `isIdentitySourceRefused(new IdentitySourceRefused("x"))` true; a plain `Error` false; `Object.assign(new Error("x"), { name: "IdentitySourceRefused" })` true. Kernel (`sso.http.test.ts`, its existing fixture identity source): `it("a source that refuses the account → sso.account_not_allowed, no identity row")`; the existing `sso.provider_error` cases stay green. Web: `/login?error=sso.account_not_allowed` renders the en text.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/identity/sso.http.test.ts apps/web/test/login-sso.test.tsx` and the SDK test → FAIL.
- [ ] **Step 3: Implement**; `pnpm gen:sdk-api`.
- [ ] **Step 4: Run** → PASS; `pnpm check:i18n`, `pnpm verify --fast`, `pnpm check:api-changeset --base origin/main`.
- [ ] **Step 5: Commit** `feat(identity): a refusal reason at login (#553)` and open the PR (`Closes #553`).

### Core release gate

After both PRs merge, the core Version Packages PR publishes the rc versions. Record them as `SDK_V`, `KERNEL_V`, `TESTING_V` for Task 3. Part 2 does not start before they are on npm (`npm view @capybara-hq/testing@next version`).

---

## Part 2 — plugins, phase 1 (this repository)

Branch: `pnpm wt:new feat/139-google-sign-in --from origin/main` in `/Users/grant/Capybara/plugins`. One PR (`Refs #139`), linked to core#551 and core#553. Read `.agents/skills/writing-channels` (identity-source, testing), `writing-extensions` and `writing-plugins` first; the closest references are `plugins/slack/src/identity.ts` (ID token with `jose`), `plugins/push-fcm` (an `extension-deployment` guide, its check and `test/kernel.http.test.ts`).

### Task 3: Scaffold and core upgrade

**Files:**
- Create: `plugins/google/package.json` (shape of `plugins/push-fcm/package.json`: `exports` with `@capybara-hq/source`, `files: ["dist"]`, `build: tsc -b`; dependencies `@capybara-hq/plugin-sdk: ^SDK_V`, `jose: ^6.2.12`, `zod: ^4.6.7`; devDependencies `@capybara-hq/plugin-model-fake` (current workspace range), `@capybara-hq/testing: ^TESTING_V`)
- Create: `plugins/google/tsconfig.json` (copy of push-fcm's), `plugins/google/.capybara-plugin/plugin.json` (`name: "google"`, `displayName: { zh: "Google", en: "Google" }`, `version: "0.1.0-rc.0"`, `publisher: "Capybara"`, `icon: "./icon.svg"`, `description` en / zh, `homepage`; no `setupGuides` yet, no `dependencies` until phase 2)
- Create: `plugins/google/icon.svg` (Google's "G" mark per Google's brand guidelines, light and dark legible), `plugins/google/src/index.ts` (a stub `defineExtension({ name: "google", version: "0.1.0-rc.0", sdk: "^0.1.0-rc.0", provides: [], permissions: {}, setup() {} })`, replaced in Task 8)
- Modify: `tsconfig.json` (add `{ "path": "plugins/google" }`), `tools/checks/src/plugin-icons.ts` (`BRAND_ICON_EXEMPTIONS.google: "vendor brand: the Google G mark"`)
- Modify: `pnpm-workspace.yaml` (`overrides`: `@capybara-hq/plugin-sdk: SDK_V`, `@capybara-hq/kernel: KERNEL_V`, `@capybara-hq/testing: TESTING_V`), root `package.json` (`@capybara-hq/plugin-sdk` and `@capybara-hq/testing` devDependencies to the same versions), `pnpm-lock.yaml`

**Interfaces:**
- Produces: a buildable, checkable empty plugin `google`; the workspace on one SDK instance that has `IdentitySourceRefused`, and a test kit with `startFakeOAuthServer({ oidc })`.

- [ ] **Step 1: Write the files above; `pnpm install`.**
- [ ] **Step 2: Verify the single SDK instance:** `pnpm why @capybara-hq/plugin-sdk` → one version, `SDK_V`.
- [ ] **Step 3: Run** `pnpm lint && pnpm typecheck && pnpm check` → PASS (the icon check sees the exemption).
- [ ] **Step 4: Run the suites that catch a second SDK copy:** `pnpm exec vitest run plugins/connector-mcp/test/kernel plugins/connector-openapi/test/kernel` → PASS. (The lockfile change runs every test in CI anyway.)
- [ ] **Step 5: Commit** `chore: scaffold the google plugin and upgrade the core packages (#139)`.

### Task 4: Config

**Files:**
- Create: `plugins/google/src/config.ts`
- Test: `plugins/google/test/config.test.ts`

**Interfaces:**
- Produces: `GOOGLE_ENDPOINTS: Readonly<GoogleEndpoints>` (the constants of Global Constraints, plus `discoveryUrl`); `type GoogleEndpoints = { authorizationUrl: string; tokenUrl: string; jwksUrl: string; issuers: string[]; discoveryUrl: string }`.
- Produces: `GoogleDeployment` (zod, every field wrapped in `ui(...)` with zh / en `label` and `help`): `clientId?: string` (trimmed, `min(1)`), `clientSecret?: secret(string)` (trimmed), `allowedDomains: string[]` (default `[]`, max 50, each lowercased then `/^[a-z0-9.-]+\.[a-z]{2,}$/`, deduplicated, `gmail.com` / `googlemail.com` refused with "gmail.com accounts have no hosted domain; leave allowedDomains empty and set allowConsumerAccounts instead"), `allowConsumerAccounts: boolean` (default `false`), `endpoints?: Partial<GoogleEndpoints>` (advanced; URLs `https:` or `http://127.0.0.1` / `http://localhost` only, for tests).
- Produces: `function loginConfig(config: unknown): GoogleLoginConfig` where `GoogleLoginConfig = { clientId: string; clientSecret: string; allowedDomains: string[]; allowConsumerAccounts: boolean; endpoints: GoogleEndpoints }` (endpoints merged over `GOOGLE_ENDPOINTS`); throws `Error("Sign in with Google is not configured: set clientId and clientSecret in the google plugin's platform config")` when either is missing, and the zod message (field path only, never a value) when invalid.

- [ ] **Step 1: Failing tests** (`config.test.ts`): defaults (`allowedDomains: []`, `allowConsumerAccounts: false`, endpoints = `GOOGLE_ENDPOINTS`); `allowedDomains: ["Example.COM", "example.com"]` → `["example.com"]`; `["gmail.com"]` and `["googlemail.com"]` refused with the message naming `allowConsumerAccounts`; `["not a domain"]` and 51 entries refused; `clientId: " 123.apps.googleusercontent.com\n"` → trimmed, same for the secret; `loginConfig({})` throws the "not configured" text; a thrown validation error never contains the secret value (`expect(msg).not.toContain("s3cr3t-value")`); `endpoints: { tokenUrl: "http://evil.example/token" }` refused; `endpoints: { tokenUrl: "http://127.0.0.1:9/token" }` accepted; the schema has no `orgAccess` / `x-org` marker on any field (JSON schema of `GoogleDeployment` contains no `x-org`).
- [ ] **Step 2: Run** `pnpm exec vitest run plugins/google/test/config.test.ts` → FAIL.
- [ ] **Step 3: Implement** `src/config.ts`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(google): deployment config (#139)`.

### Task 5: Claims — hosted-domain gate, email authority, identity mapping — high risk

The authorization decision of the plugin. Reviewed alone on the most capable model. Pure functions over already-verified claims; no I/O.

**Files:**
- Create: `plugins/google/src/claims.ts`
- Test: `plugins/google/test/claims.test.ts`

**Interfaces:**
- Consumes: `IdentitySourceRefused` from `@capybara-hq/plugin-sdk` (Task 2), `ExternalIdentity`.
- Produces: `const CONSUMER_TENANT = "consumer"`.
- Produces: `function hostedDomainGate(claims: { hd?: unknown }, policy: { allowedDomains: string[]; allowConsumerAccounts: boolean }): string | undefined` — returns the lowercased `hd` (or undefined for none) when allowed; throws `IdentitySourceRefused("Google account not allowed: hosted domain <hd | none> is not permitted")` otherwise. Rules (spec §4.3 step 4): `hd` = string claim lowercased, a non-string or empty `hd` counts as none; `allowedDomains` non-empty → `hd` defined and listed; empty and `allowConsumerAccounts` false → `hd` defined; else allowed.
- Produces: `function emailIsAuthoritative(claims: { email?: unknown; email_verified?: unknown; hd?: unknown }): boolean` — `email_verified === true` (boolean only) and (`hd` is a non-empty string or the lowercased email ends with `@gmail.com`).
- Produces: `function toExternalIdentity(claims: JWTPayload, hd: string | undefined): ExternalIdentity` — the table of spec §4.4: `externalId = sub`, `tenantId = hd ?? "consumer"`, `source = "google:" + tenantId`, `email` lowercased when a string, `emailVerified = emailIsAuthoritative(...)` (false without an email), `displayName` = `name`, else `given_name family_name` trimmed, else the email's local part, else `sub` (each capped at 200 characters), `avatarUrl` = `picture` only when it parses as an `https:` URL.

- [ ] **Step 1: Failing tests** (`claims.test.ts`):
  - Hosted-domain matrix (`it.each`): allowed listed `hd` (`"example.com"` with `["example.com"]`) → `"example.com"`; `"Example.COM"` → `"example.com"`; not listed (`"other.example"`) → throws, `isIdentitySourceRefused(err)` true, message `"Google account not allowed: hosted domain other.example is not permitted"`; missing `hd` with a list → throws with `"hosted domain none"`; missing `hd`, empty list, `allowConsumerAccounts: false` → throws; missing `hd`, empty list, `true` → `undefined`; any `hd`, empty list → that `hd`; `hd: ""` and `hd: 42` count as none. No refusal message contains the email.
  - Email authority matrix: `hd` + `email_verified: true` → true; `@gmail.com` + true (no `hd`) → true; `@GMail.com` → true; consumer on `alice@customer.com` + true, no `hd` → **false**; `hd` + `email_verified: false` → false; `email_verified: "true"` → false (Review Focus 5); no email → false.
  - Mapping: `tenantId` `consumer` and `source` `google:consumer` without `hd`; `source` `google:example.com` with; email lowercased; displayName fallbacks in order; `picture: "http://x/y.png"` and `"javascript:alert(1)"` → no `avatarUrl`; `picture: "https://lh3.googleusercontent.com/a"` kept.
- [ ] **Step 2: Run** `pnpm exec vitest run plugins/google/test/claims.test.ts` → FAIL.
- [ ] **Step 3: Implement** `src/claims.ts`; the comments cite the Google docs lines of spec §2.1 (`hd` claim, email authority).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(google): hosted-domain gate and email authority (#139)`.

### Task 6: Identity source — authorize URL, token exchange, ID token verification — high risk

Reviewed alone on the most capable model.

**Files:**
- Create: `plugins/google/src/identity.ts`
- Test: `plugins/google/test/identity.test.ts` (with a local JWKS / token server written in the test file on `node:http`, keys from `jose`'s `generateKeyPair("RS256")` and `exportJWK`, tokens from `SignJWT`; no `@capybara-hq/testing` needed here)

**Interfaces:**
- Consumes: `loginConfig`, `GoogleLoginConfig` (Task 4); `hostedDomainGate`, `toExternalIdentity` (Task 5).
- Produces: `const GOOGLE_OIDC_SCOPES = "openid email profile"`; `function createGoogleIdentitySource(): IdentitySource` with `label: { zh: "Google", en: "Google" }`.
- `authorizeUrl({ config, redirectUri, state, nonce, codeChallenge, codeChallengeMethod })`: `loginConfig(config)`; URL = `endpoints.authorizationUrl` with `response_type=code`, `client_id`, `redirect_uri`, `scope`, `state`, `nonce`, `code_challenge`, `code_challenge_method` (both only when given; the kernel always gives S256), `prompt=select_account`, and `hd` only when `allowedDomains.length === 1`. Never `access_type`.
- `callback({ config, redirectUri, query, nonce, signal, codeVerifier })`, spec §4.3 steps 1–5: `query.error` → throw `Google authorization failed: <error, max 100 chars>`; no `code` → throw; one form `POST tokenUrl` (`grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, `client_secret`, `code_verifier` when given), `redirect: "manual"`, `signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)])`; non-200 → throw `Google token exchange failed: <error code matching /^[a-z_]{1,64}$/ or "HTTP <status>">`; network / abort → `Google token exchange failed: network error`; no `id_token` → throw.
- Verification: `jwtVerify(idToken, keySet(jwksUrl), { algorithms: ["RS256"], issuer: endpoints.issuers, audience: clientId, requiredClaims: ["exp", "iat", "sub", "nonce"], clockTolerance: 60 })`; then the nonce compared with `timingSafeEqual` (unequal lengths → mismatch); `azp`, when present, must equal `clientId`; `signal.throwIfAborted()`. Any failure → throw `Google ID token rejected: <jose error code or "nonce mismatch" / "azp mismatch">` (never the token). Then `toExternalIdentity(payload, hostedDomainGate(payload, config))`. No userinfo call.
- JWKS: a `Map<string, JWTVerifyGetKey>` created inside the factory, one `createRemoteJWKSet(new URL(url), { timeoutDuration: 10_000 })` per URL (jose refetches on an unknown `kid`, with its cooldown).

- [ ] **Step 1: Failing tests** (`identity.test.ts`), each against the local server (endpoints overridden to it, `issuers: ["https://accounts.google.com", "accounts.google.com"]` signed as such):
  - Authorize URL: S256 challenge and nonce present; `prompt=select_account`; `hd=example.com` with one domain, no `hd` with zero or two; no `access_type`; throws "not configured" without a client.
  - Token exchange request: form fields exact, `client_secret_post`, `code_verifier` sent; `query.error=access_denied` and a missing `code` throw before any request.
  - Verification: a valid token → identity `google:example.com` / `sub`; each issuer form accepted; `iss: "https://evil.example"` refused; wrong `aud`; signature by a key not in the JWKS; `alg: "HS256"` token refused; expired (`exp` 2 minutes ago) refused, 30 s ago accepted; `iat` 30 s in the future accepted; missing `nonce` and a wrong `nonce` refused; `azp` ≠ client refused, absent `azp` accepted; `rotated key`: the server swaps its JWKS to a new key and signs with it → the next callback succeeds on the same source instance (Review Focus 1).
  - The hosted-domain refusal propagates as `IdentitySourceRefused` (one case; the matrix lives in Task 5).
  - Errors: a 400 `{ "error": "invalid_grant", "error_description": "<secret-ish text>" }` → message `Google token exchange failed: invalid_grant` without the description; `hung token endpoint`: the server never answers → rejects with `network error` once the test's own `AbortController` fires (the test aborts the signal; no 10 s wait), and no error text across all cases contains the code, the secret, the id token or the verifier.
- [ ] **Step 2: Run** `pnpm exec vitest run plugins/google/test/identity.test.ts` → FAIL.
- [ ] **Step 3: Implement** `src/identity.ts`; the doc comment lists the flow and cites spec §4.3 / §4.8.
- [ ] **Step 4: Run** → PASS; `pnpm check` (extension-state rule accepts the factory-local Map).
- [ ] **Step 5: Commit** `feat(google): Sign in with Google identity source (#139)`.

### Task 7: Setup checks — high risk (uses the client secret)

Reviewed alone on the most capable model: the probe authenticates with the secret, and no part of it may reach a result.

**Files:**
- Create: `plugins/google/src/setup-checks.ts`
- Test: `plugins/google/test/setup-checks.test.ts` (local `node:http` server)

**Interfaces:**
- Consumes: `GoogleDeployment`, `GOOGLE_ENDPOINTS`, `GoogleEndpoints` (Task 4).
- Produces: `function discoveryCheck(): SetupCheckDefinition` (id `google-discovery`) and `function clientCheck(): SetupCheckDefinition` (id `google-client`), both `place: "extension-deployment"`, reading `target.config` (kind `extension-deployment`; any other kind → `unknown` "This check runs on the platform's Google page."). Endpoints = `GOOGLE_ENDPOINTS` merged with the config's `endpoints`.
- `google-discovery`: `GET discoveryUrl` (`signal`, `redirect: "manual"`); `ok` when `issuer` ∈ issuers and `authorization_endpoint`, `token_endpoint`, `jwks_uri` equal ours; `failing` (fix: "Update the google plugin; Google's published endpoints changed.") when any differs, naming which field; `unknown` on network error, non-JSON, 5xx, 429.
- `google-client`: no client id → `failing` ("No client ID is saved", fix: create a Web application client and paste the id and secret); no secret → `failing` likewise. Else form `POST tokenUrl` with `grant_type=authorization_code`, `code=capybara-setup-probe`, `redirect_uri=<publicUrl-free fixed value "https://capybara-setup-probe.invalid/callback">`, `client_id`, `client_secret`: `invalid_grant` → `ok` ("Google accepted the client ID and secret."); `invalid_client` / `unauthorized_client` / 401 → `failing` (fix: "Copy the client ID and secret again from Google Auth Platform → Clients; the secret is shown only when created or reset."); anything else including a 2xx (the body is dropped unread) → `unknown`. All texts zh and en, fixed; the only echoed value is an OAuth error code matching `/^[a-z_]{1,64}$/`.

- [ ] **Step 1: Failing tests:** each row of the spec §4.6 table for both checks (ok / failing / unknown, including a changed `token_endpoint`, `accounts.google.com` issuer form accepted, a 503, a network error, a 2xx probe answer → `unknown`); the probe request carries the fixed code and `client_secret_post`; `validateSetupCheckResult` accepts every result; `JSON.stringify(result)` never contains the secret, the client id + secret pair, or any response body text (the server answers bodies with a marker string; assert it is absent); `signal` aborted → `unknown`, no hang.
- [ ] **Step 2: Run** `pnpm exec vitest run plugins/google/test/setup-checks.test.ts` → FAIL.
- [ ] **Step 3: Implement** `src/setup-checks.ts`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(google): setup checks for discovery and the OAuth client (#139)`.

### Task 8: Extension manifest, setup guide, README

**Files:**
- Modify: `plugins/google/src/index.ts` (the real extension), `plugins/google/.capybara-plugin/plugin.json` (`setupGuides: [{ "id": "google-sign-in", "place": "extension-deployment" }]`)
- Create: `plugins/google/guides/google-sign-in.md`, `plugins/google/guides/google-sign-in.zh.md`, `plugins/google/README.md`
- Test: `plugins/google/test/guides.test.ts`, `plugins/google/test/manifest.test.ts`

**Interfaces:**
- Consumes: `GoogleDeployment` (4), `createGoogleIdentitySource` (6), `discoveryCheck`, `clientCheck` (7).
- Produces: the default export `defineExtension({ name: "google", version: "0.1.0-rc.0", sdk: "^0.1.0-rc.0", provides: [IDENTITY_SOURCE_EXTENSION_POINT], permissions: { network: ["accounts.google.com", "oauth2.googleapis.com", "www.googleapis.com"], setupChecks: ["google-discovery", "google-client"] }, config: { deployment: GoogleDeployment }, setup(ctx) { ctx.provide(...); ctx.setup.check(...) x2 } })`; re-exports `createGoogleIdentitySource`, `GoogleDeployment`, `GOOGLE_ENDPOINTS`, the two check factories.
- Guide steps: spec §4.5, 1–6, with `{{publicUrl}}/api/v1/auth/sso/google/callback` as the redirect URI (a url variable first in the value; core#554 would replace it with `{{signInCallbackUrl}}`), `::check google-discovery`, `::check google-client`, the Internal vs External choice, `allowedDomains` recommended, and the boxed warning: never add `google:consumer` to `auth.trustedIdentitySources`.
- README: what the plugin does, config table, the identity key and why (`hd` tenant, `consumer`), the `emailVerified` rule, what is not supported (directory, Chat), PKCE note (S256 sent; spec §2.3.7), the live acceptance list (a Workspace account signs in; a consumer account refused by default; a second domain refused; a refused account sees the "not allowed" page), sources accessed with dates.

- [ ] **Step 1: Failing tests.** `guides.test.ts` (shape of `plugins/push-fcm/test/guides.test.ts`): `validateSetupGuide({ id: "google-sign-in", place: "extension-deployment", en, zh, pluginChecks })` → `[]`; renders in both languages containing both check ids and `https://cap.example/api/v1/auth/sso/google/callback` with `values.publicUrl = "https://cap.example"`; the zh document contains neither `企业` nor the Latin word `agent`. `manifest.test.ts`: `provides` is exactly identity-source; `permissions.setupChecks` equals the ids registered in `setup` (call `setup` with a stub ctx recording `provide` / `setup.check`); no `secrets`, `hooks`, `ui` permission.
- [ ] **Step 2: Run** `pnpm exec vitest run plugins/google/test/guides.test.ts plugins/google/test/manifest.test.ts` → FAIL.
- [ ] **Step 3: Write** `src/index.ts`, the guides, `plugin.json`, README.
- [ ] **Step 4: Run** → PASS; `pnpm lint && pnpm typecheck && pnpm check && pnpm check:marketplace`.
- [ ] **Step 5: Commit** `feat(google): extension manifest and the sign-in setup guide (#139)`.

### Task 9: Kernel-level login test

**Files:**
- Create: `plugins/google/test/kernel/login.test.ts` (one kernel per file)

**Interfaces:**
- Consumes: `startTestKernel`, `testKernelConfig`, `startTestPostgres`, `startTestRedis`, `createDb`, `kernelDb`, `createLocalAccount`, `startFakeOAuthServer({ oidc: {}, clients: [{ clientId: "cli-google", clientSecret: "google-secret-5f2e", redirectUris: ["https://cap.example/api/v1/auth/sso/google/callback"] }] })` from `@capybara-hq/testing` (Task 1), the plugin by source path (`resolveFrom` the plugin dir, extensions `[MODEL_FAKE, <src/index.ts>]` as in `plugins/push-fcm/test/kernel.http.test.ts`).
- Kernel config: `auth: { cookieSecure: false, loginSources: ["google"], trustedIdentitySources: ["google:example.com"] }`, `http: { port: 0, publicUrl: "https://cap.example" }`, `extensionConfig.google = { clientId: "cli-google", clientSecret: "google-secret-5f2e", allowedDomains: ["example.com", "other.example"], endpoints: { authorizationUrl: fake.issuer + "/authorize", tokenUrl: fake.issuer + "/token", jwksUrl: fake.jwksUrl, issuers: [fake.issuer], discoveryUrl: fake.issuer + "/.well-known/openid-configuration" } }`.
- Flow helper in the file: `GET /api/v1/auth/sso/google/start?returnTo=%2Fchat` via `k.http.inject` with a cookie jar (as `absorb` in `plugins/slack/test/kernel/slack-identity.dual.test.ts`), `fetch(location, { redirect: "manual" })` on the fake (auto-approves the queued login), then `GET` the callback path with the jar.

- [ ] **Step 1: Write the tests:**
  - `it("a Workspace account signs in and gets google:example.com + sub")`: `queueLogin({ sub: "1001", hd: "example.com", email: "new@example.com", email_verified: true, name: "New" })`; the authorize request on the fake has `code_challenge_method=S256`, `nonce`, `prompt=select_account`, no `access_type`; callback → 302 to `https://cap.example/chat`; `identities` row `{ source: "google:example.com", external_id: "1001" }`; `/api/v1/me` 200 and its body contains neither the secret nor any issued token (`fake.issuedSecrets()`).
  - `it("merges into an existing account only for a trusted tenant with an authoritative email")`: local accounts `alice` and `bob` with `email` / `email_verified = true` set through `kernelDb` (`alice@example.com`, `bob@other.example`); Alice (`hd: example.com`, verified) → her identity row points at the existing account; Bob (`hd: other.example`, verified; tenant not trusted) → a new account; Carol (`hd: example.com`, `email_verified: false`, email equal to a third verified account) → a new account.
  - `it("a refused domain ends on the login page with sso.account_not_allowed")`: `hd: "evil.example"` → 302 to `https://cap.example/login?error=sso.account_not_allowed`, no identity row for that `sub`.
  - `it("a tampered ID token ends on sso.provider_error")`: `tamperNextIdToken({}, { foreignKey: true })` → `sso.provider_error`.
  - `it("the kernel's own checks still hold")`: replaying a used callback URL → `sso.state_invalid`; the callback without the binding cookie → `sso.session_mismatch`.
- [ ] **Step 2: Run** `pnpm exec vitest run plugins/google/test/kernel/login.test.ts` → PASS (Tasks 1–8 are in). If a case fails, fix the plugin, not the test's expectation, and say so in the report.
- [ ] **Step 3: Commit** `test(google): sign-in through a real kernel (#139)`.

### Task 10: Live test, marketplace entry, docs

**Files:**
- Create: `plugins/google/test/live/google.live.test.ts`
- Modify: `.capybara-plugin/marketplace.json` (by `pnpm build:ui && capybara-plugin marketplace --write` only: the new `google` entry at `0.1.0-rc.0` with its sha512), root `README.md` (a plugin table row)
- No changeset: a new plugin enters at `0.1.0-rc.0` with its marketplace entry in the feature PR and no first-release changeset, as `file-preview` and the push plugins did (`97d1617`); the release publishes every version not on npm yet. Later changes to the plugin add changesets as usual.
- Modify: `AGENTS.md` ("Live API tests": the two Google variables), `.agents/skills/writing-channels/SKILL.md` (references: `plugins/google` as the OIDC-only identity source; the live variables)

**Interfaces:**
- Consumes: `discoveryCheck`, `clientCheck`, `GOOGLE_ENDPOINTS`.
- Runs only when `CAPYBARA_TEST_GOOGLE_CLIENT_ID` and `CAPYBARA_TEST_GOOGLE_CLIENT_SECRET` are both filled (the `filled()` guard of `plugins/push-fcm/test/live/fcm.live.test.ts`, logging one skip line otherwise).

- [ ] **Step 1: Write the test:** `google-discovery` against Google → `ok`; `google-client` with the real client → `ok`; with the secret altered by one character → `failing`; Google's discovery `jwks_uri` fetch returns a JWKS with at least one RS256 key. No result printed beyond its status.
- [ ] **Step 2: Run** without the variables: `pnpm exec vitest run plugins/google/test/live` → skipped. With them: `set -a; . ~/.capybara-test.env; set +a; pnpm exec vitest run plugins/google/test/live` → PASS (or report that no test client exists yet; see open questions).
- [ ] **Step 3: Marketplace entry and docs;** `pnpm check:marketplace` → PASS; `pnpm verify`.
- [ ] **Step 4: Commit** `test(google): live checks against Google (#139)`; open the PR (`Refs #139`, links core#551 / core#553), per the `contributing` skill.

### Release

- The PR already carries `0.1.0-rc.0` and its `.capybara-plugin/marketplace.json` entry (Task 10; written by `capybara-plugin marketplace --write`, never by hand; CI's `marketplace --check --base` verifies it).
- `release --auto` publishes it on the push to `main` after the merge. A new package name may need the maintainer's first publish (npm trusted publishing is per existing package; `push-fcm` was staged as `0.0.0-stage` first): if the publish job refuses or fails on the name, report it and ask the maintainer to stage the name or dispatch the release.
- Manual acceptance on a dev deployment: the README's live acceptance list with a real Workspace account.

---

## Part 3 — phase 2 outline (Google Workspace connector templates)

**Gate:** core#552 (`authorizationParams` on `oauth_code`) merged and released, plus Task 1's `refreshTokenOnlyWith` (already in). Core#554 is not needed for the seven templates (exactly eight guides). A detailed plan is written when the gate opens, after re-verifying spec §2.3 (Developer Preview enrolment, BigQuery stage and enable command, the client's project, custom redirect URIs for BigQuery, current `tools/list` of every server).

1. **Core (core#552)**: a core design note or issue-level design, then SDK `connector-auth.ts` + kernel `tools/oauth/flow.ts` + tests on the fake with `refreshTokenOnlyWith`; SDK API report + changesets; release. High risk (OAuth flow): reviewed alone.
2. **Plugins upgrade**: overrides and devDependencies to the released versions (as Task 3).
3. **Templates** `plugins/google/connectors/{gmail,google-drive,google-calendar,google-sheets,google-docs,google-slides,bigquery}.json` per spec §5.1 (`discovery: "manual"`, `client: "manual"`, `client_secret_post`, full-URL scopes per §2.2, `authorizationParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" }`, `defaultEnabled: false`, no `editableEndpoint`), product icons under `plugins/google/icons/`, `plugin.json` dependency `connector-mcp ^0.1.0-rc.1`.
4. **Policies** from recorded tool lists `test/fixtures/<id>-tools.json`: reads `allow`, writes `ask`, `execute_sql_readonly` `allow`, `execute_sql` `ask` (§5.2).
5. **Guides** one per template (`connector-template`, audiences admin and member, `{{oauthCallbackUrl}}`, `::check capybara:oauth-token-endpoint`, BigQuery IAM roles), zh / en.
6. **Tests**: `test/connector-templates.test.ts` (schema, hosts, scopes, policies ⊆ fixtures, writes never `allow`), `test/guides.test.ts` extended, a kernel-level connect test (`startFakeMcpServer` + `startFakeOAuthServer` with `refreshTokenOnlyWith: { access_type: "offline" }`: authorize carries `access_type=offline` and `prompt=consent`, a refresh token is stored and kept across a refresh), live `test/live/google-mcp.live.test.ts` (`CAPYBARA_TEST_LIVE_TOOLS` + `CAPYBARA_TEST_GOOGLE_ACCESS_TOKEN`) that also refreshes the fixtures.
7. **Release**: a minor changeset on `@capybara-hq/plugin-google` (rc bump in pre mode).

Risk in phase 2 is mostly in core#552 (the parameter deny list); the templates are data reviewed in one batch.
