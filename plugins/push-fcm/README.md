# @capybara-hq/plugin-push-fcm

Firebase Cloud Messaging push provider for Capybara (`push-provider@1`): the kernel hands it the
notifications owed to a person's Android devices (an approval waiting, a reply finished, a task
done) and it sends each one through the
[FCM HTTP v1 API](https://firebase.google.com/docs/reference/fcm/rest/v1/projects.messages/send).

## Configuration (platform only)

A super admin sets it up on the extension's platform page, guided by the setup guide
`fcm-service-account` (its check `fcm-credentials` runs one token exchange). There is no org
config.

| Field | What |
|---|---|
| `serviceAccount` (secret) | The whole service account key file (JSON) from Firebase console → Project settings → Service accounts → Generate new private key. It must carry `project_id`, `client_email` and `private_key`; a refusal names the missing field, never a value |
| `applicationIds` | The Android application ids the key covers (`apps()`), at least one |

Env example: `CAPYBARA_EXTENSION_CONFIG__PUSH_FCM__APPLICATION_IDS='["com.example.app"]'`.

## How it sends

- **Auth**: an RS256 JWT bearer grant (`node:crypto`, no third-party dependency) to
  `https://oauth2.googleapis.com/token` for the scope
  `https://www.googleapis.com/auth/firebase.messaging`. The access token is cached in `ctx.kv`
  under `fcm-token-<sha256(client_email)>` for `expires_in − 300` seconds, shared by every replica.
  A 401 from FCM (other than `THIRD_PARTY_AUTH_ERROR`) drops the cached token, so the kernel's retry exchanges a new one.
- **Request**: `POST https://fcm.googleapis.com/v1/projects/<project_id>/messages:send`, one per
  registration (in parallel, one token exchange per call):

  ```json
  {
    "message": {
      "token": "<device token>",
      "notification": { "title": "…", "body": "…" },
      "data": { "path": "/chat/…", "origin": "https://…", "threadId": "…" },
      "android": {
        "priority": "HIGH",
        "ttl": "86400s",
        "collapse_key": "<collapseId>",
        "notification": { "tag": "<threadId>", "notification_count": 3 }
      }
    }
  }
  ```

  `collapse_key` carries the message's `collapseId` (the same for every resend of one event, so a
  resend replaces the notification); `tag` groups a conversation's notifications.
  `notification_count` is present only when the message has a badge.
- **No retries** inside the plugin: the kernel's push queue retries.

## Result mapping

| FCM answer | Result |
|---|---|
| 200 | `delivered` |
| 404 `UNREGISTERED`; 400 `INVALID_ARGUMENT` naming `message.token` | `unregistered` (the kernel deletes the registration) |
| 401; 403 (`SENDER_ID_MISMATCH` and others); `THIRD_PARTY_AUTH_ERROR`; a 404 that is not `UNREGISTERED` (wrong `project_id`) | failed `auth` |
| 429 (`QUOTA_EXCEEDED`) | failed `rate_limited`, `Retry-After` (seconds or a date, capped at one hour) → `retryAfterMs` |
| any other 4xx, 5xx, a network error, an abort | failed `transient` |
| token endpoint `invalid_grant` / `invalid_client` / `unauthorized_client` | thrown `PushError` `auth` (every registration of the call) |
| token endpoint 429 (with its `Retry-After`) / other failure | thrown `PushError` `rate_limited` / `transient` |

Result messages name HTTP statuses and FCM / OAuth error codes only: never a device token, an
access token or any part of the service account.

## Tests

- `test/conformance.test.ts`: `describePushProviderConformance` against `test/fake-fcm.ts` (a local
  token endpoint that verifies the JWT signature and a local send endpoint).
- `test/provider.test.ts`, `test/config.test.ts`, `test/check.test.ts`, `test/guides.test.ts`.
- `test/kernel.http.test.ts`: a real kernel with the plugin pointed at the fake
  (`test/fixtures/local-fcm.ts`; the endpoints are a factory argument, not admin config), a
  registration, a finished model-fake run, one FCM request.
- `test/live/fcm.live.test.ts`: real Google, only with `CAPYBARA_TEST_FCM_SERVICE_ACCOUNT`,
  `CAPYBARA_TEST_FCM_APP_ID` and `CAPYBARA_TEST_FCM_TOKEN` set.
