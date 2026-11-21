# push-apns

A `push-provider@1` extension for Apple Push Notification service (APNs): the kernel hands it the
notifications for iOS devices registered with `provider: "push-apns"`, and it sends each one with
token-based authentication over HTTP/2.

## Deployment config (super admin)

| Field | What |
|---|---|
| `key` (secret) | The content of the `.p8` signing key file, BEGIN and END lines included |
| `keyId` | The key's 10-character Key ID |
| `teamId` | The 10-character Team ID of the Apple Developer team |
| `bundles` | Each app build to reach: `bundleId` and `environment` (`production`, or `sandbox` for development builds) |

`apps()` lists the bundle ids. The setup guide on the extension's platform page walks through
creating the key; its check `apns-credentials` signs a provider token and asks APNs about an
all-zero device token (APNs verifies the key, then refuses the device; nothing is delivered).

## Behavior

- Request: `POST /3/device/<token>` to `api.push.apple.com` or `api.sandbox.push.apple.com` (by the
  registration's bundle), headers `authorization: bearer <ES256 JWT>`, `apns-topic`,
  `apns-push-type: alert`, `apns-priority: 10`, `apns-expiration` (one day) and
  `apns-collapse-id` (the event id, so a resend replaces the notification); body
  `{ aps: { alert: { title, body }, thread-id, sound, badge? }, path, origin }`.
- The provider token is cached in `ctx.kv` (`apns-jwt-<keyId>`, 40 minutes: Apple refuses a new
  one more often than every 20 minutes and an old one after an hour) and dropped on
  `ExpiredProviderToken`. The private key is never written anywhere.
- Answers: 200 delivered; 410, 400 `BadDeviceToken` / `Unregistered` unregistered; 403
  (`InvalidProviderToken` and others), 400 `DeviceTokenNotForTopic` / `TopicDisallowed` /
  `BadTopic` / `MissingTopic` auth;
  403 `ExpiredProviderToken` transient; 429 rate limited; 5xx and connection errors transient.
  No retries inside the extension: the kernel's queue retries. Messages carry the status and the
  APNs reason code, never a device token or the key.

## Known limitations

- **One HTTP/2 connection per send call.** Apple recommends keeping connections open, but the
  extension holds no in-process pool (production runs several replicas; extensions keep no
  process-local shared objects), so each delivery job opens a TLS connection, sends its
  registrations and closes it. That is fine for notifications people trigger (approvals, finished
  runs); a deployment pushing at very high volume pays a TLS handshake per job and may see APNs
  throttle connection churn.
- `ExpiredProviderToken` right after signing means the server clock is off: the token is dropped
  and re-signed on the next try, which keeps failing until the clock is fixed (NTP).

## Tests

`pnpm exec vitest run plugins/push-apns` runs the conformance suite and the unit tests against a
local HTTP/2 fake (`test/fake-apns.ts`, test-only certificate in `test/fixtures`) and the kernel
test. The live test runs only with `CAPYBARA_TEST_APNS_KEY`, `_KEY_ID`, `_TEAM_ID`, `_BUNDLE` and
`_TOKEN` set (optional `_ENVIRONMENT`, default `sandbox`).
