# @capybara-hq/plugin-google

Sign in with Google for Capybara (`identity-source@1`): OpenID Connect against Google with PKCE
(S256) and a nonce through the kernel's SSO flow, the ID token verified against Google's JWKS, the
Workspace hosted domain (`hd`) enforced on the verified token, and consumer accounts refused unless
the super admin allows them. Google Workspace connector templates (Gmail, Drive, Calendar, …) follow
in a later version (design: `docs/superpowers/specs/2026-11-22-google-plugin-design.md`).

## Configuration (platform only)

A super admin sets it up on the extension's platform page, guided by the setup guide
`google-sign-in` (Google Cloud console steps, the redirect URI, two checks). There is no org config:
the login page runs before any org is known. Login is offered once `google` is in
`auth.loginSources`.

| Field | Default | What |
|---|---|---|
| `clientId` | | The Web application OAuth client ID (`….apps.googleusercontent.com`); trimmed. Login is unavailable while empty |
| `clientSecret` (secret) | | The client's secret; trimmed, sealed at rest, never in a check result or an error |
| `allowedDomains` | `[]` | Workspace / Cloud Identity primary domains (`hd` values), lowercased, deduplicated, at most 50. Non-empty: the ID token's `hd` must be present and listed. `gmail.com` / `googlemail.com` are refused (consumer accounts carry no `hd`; use `allowConsumerAccounts`) |
| `allowConsumerAccounts` | `false` | Only read when `allowedDomains` is empty. `false`: an account without `hd` is refused (any Workspace domain may sign in). `true`: consumer Google accounts may sign in too |
| `endpoints` (advanced) | Google's | `authorizationUrl`, `tokenUrl`, `jwksUrl`, `issuers`, `discoveryUrl`; only for tests and egress proxies (`https:`, or plain http on 127.0.0.1 / localhost) |

The authorized redirect URI to register at Google is `<http.publicUrl>/api/v1/auth/sso/google/callback`.

Invalid config never fails startup: the login page shows the source as unavailable.

## The identity

| `ExternalIdentity` | Value |
|---|---|
| `externalId` | `sub` (Google: never use the email as the identifier) |
| `tenantId` | the `hd` claim lowercased; `consumer` for an account without `hd` |
| `source` | `google:<tenantId>` |
| `email` | `email` lowercased (dropped when not plain ASCII) |
| `emailVerified` | true only when `email_verified` is the boolean `true` **and** Google is authoritative for the address: `hd` is set, or the address ends in `@gmail.com` |
| `displayName` | `name`, else `given_name family_name`, else the email's local part, else `sub` |
| `avatarUrl` | `picture` when it is an `https:` URL |

Why the tenant is `hd`: trust in `auth.trustedIdentitySources` is per tenant, so the super admin can
trust `google:example.com` (their own Workspace, whose admins control every address in it) without
trusting every Google account. **Never list `google:consumer` in `auth.trustedIdentitySources`:**
anyone can create a Google account on any email address, and Google vouches only for `@gmail.com`
addresses there. The email domain is not required to equal
`hd` (Workspace users on secondary domains are legitimate).

A person whose organization changes its primary domain arrives under a new `source` and becomes a
new identity (accepted cost of per-domain trust).

## The flow

- **Authorize**: `https://accounts.google.com/o/oauth2/v2/auth` with `response_type=code`,
  `scope=openid email profile`, the kernel's `state`, `nonce` and PKCE challenge
  (`code_challenge_method=S256`), `prompt=select_account`, and `hd=<domain>` only when exactly one
  domain is allowed. That `hd` is a UI hint only; the gate is the ID token's `hd` claim. No
  `access_type`: login needs no refresh token, and the plugin stores no Google token.
- **PKCE**: Google's discovery document advertises S256 and the token endpoint accepts
  `code_verifier`, though the web-server guide does not describe PKCE for confidential clients;
  we send it in addition to the client secret.
- **Callback**: one `POST https://oauth2.googleapis.com/token` (`client_secret_post` plus
  `code_verifier`, 10 s timeout, no retries); the `id_token` verified with jose against
  `https://www.googleapis.com/oauth2/v3/certs` (RS256 only, `iss` `https://accounts.google.com` or
  `accounts.google.com`, `aud` = the client, `exp` / `iat` / `sub` / `nonce` required, 60 s clock
  tolerance, at most one hour old), the nonce compared in constant time, `azp` equal to the client
  when present (required with several audiences). Then the hosted-domain gate. No userinfo call.
- **JWKS rotation**: jose caches Google's keys (10 minutes) and refetches on an unknown `kid` after
  its 30-second cooldown, so a key rotation needs no restart.
- **Refusals**: a domain or consumer account that is not allowed throws `IdentitySourceRefused`;
  the login page says the account is not allowed (`sso.account_not_allowed`). Every other failure is
  `sso.provider_error`. Errors carry Google's error code or the HTTP status only, never a body, the
  code, a token or the secret.

## Setup checks (platform page)

| Id | What |
|---|---|
| `google-discovery` | `GET https://accounts.google.com/.well-known/openid-configuration`: ok when the issuer and the authorization, token and JWKS endpoints equal the plugin's; failing ("update the plugin") when they differ |
| `google-client` | `POST` the token endpoint with the saved client and the fixed invalid code `capybara-setup-probe`: `400 invalid_grant` = ok (client accepted); `invalid_client` / `unauthorized_client` / 401 = failing; anything else unknown (a 2xx is dropped unread) |

The redirect URI cannot be checked this way (Google refuses the invalid code first); the guide shows
the exact URI.

## Not supported (yet)

- `directory@1` (Admin SDK Directory API) and a Google Chat channel.
- Workspace connector templates (phase 2, waiting on extra authorization parameters in core).
- Per-org Google clients or domain lists.

## Live acceptance

`test/live/google.live.test.ts` runs both checks against Google when
`CAPYBARA_TEST_GOOGLE_CLIENT_ID` and `CAPYBARA_TEST_GOOGLE_CLIENT_SECRET` are set (an Internal Web
client in a Workspace-owned project). The interactive login is checked by hand on a dev deployment:

1. A Workspace account of an allowed domain signs in and lands in the app.
2. A consumer account (`@gmail.com`) is refused while `allowConsumerAccounts` is off.
3. An account of a second, unlisted Workspace domain is refused.
4. A refused account sees the "this account is not allowed" login page.

## Sources (read 2026-11-21 / 22)

- OpenID Connect: https://developers.google.com/identity/openid-connect/openid-connect
- Verify the ID token (email authority): https://developers.google.com/identity/gsi/web/guides/verify-google-id-token
- Web server OAuth: https://developers.google.com/identity/protocols/oauth2/web-server
- Discovery: https://accounts.google.com/.well-known/openid-configuration
