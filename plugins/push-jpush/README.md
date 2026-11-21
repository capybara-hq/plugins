# JPush

Provides `push-provider@1` through [JPush](https://www.jiguang.cn/) (极光推送), so the kernel can send
push notifications to the Capybara Android app on phones in mainland China, where Google's FCM is
not available. JPush delivers through its own connection and, when the app integrates them,
through the Huawei, Honor, Xiaomi, OPPO and vivo vendor channels.

## Configuration

Platform deployment config only (the super admin's page of the extension; no org config):

- `appKey`, `masterSecret` (secret): from the JPush console, app settings.
- `applicationIds`: the Android application ids (package names) of the app builds that integrate
  this JPush app. The kernel only accepts registrations for these.
- Optional vendor fields for the service (non-marketing) classification, each obtained from the
  vendor after applying for it: `xiaomi.channelId` / `xiaomi.templateId`, `oppo.channelId` /
  `oppo.category` / `oppo.notifyLevel` (1, 2 or 16; needs a category), `vivo.category` /
  `vivo.templateId`, `huawei.category` (needs Huawei's self-classification entitlement). A
  Xiaomi or vivo template must declare the variables `title` and `body`.

The setup guide `jpush-app` has one check, `jpush-credentials`: it asks JPush for a push id
(`GET /v3/push/cid`), which needs a valid AppKey and Master Secret and sends nothing.

## What a push looks like

One `POST https://api.jpush.cn/v3/push` per registration (HTTP Basic `appKey:masterSecret`):
`platform: ["android"]`, the registration id as the only audience, `notification.android` with the
title, the text, an intent that opens the app and `extras` `{ path, origin, threadId, collapseId }`
(the app routes to `path` on tap). `options.classification: 1` marks a service message;
Huawei and Honor get importance `NORMAL`.

**Collapse:** JPush documents no collapse field for Android (`override_msg_id` needs the msg_id of
an earlier push, `cid` is a server-issued id). Each vendor channel gets
`third_party_channel.<vendor>.notify_id`, a positive 31-bit number derived from the collapse id,
so a resend of the same event replaces the notification on Huawei, Honor, Xiaomi, OPPO and vivo.
On JPush's own connection the app can use `extras.collapseId`.

**Badges** are not sent.

**Answers:** 1003 / 1011 for the sole target mark the registration unregistered; 1004 / 1008 /
2003 / 2004 (and a 401 / 403 without a code) are `auth`; 2002 (HTTP 429) / 1012 / 2005 / 2008 /
2009 / 2010 (and a 429 without a code) are `rate_limited`, with `Retry-After` or JPush's
`X-Rate-Limit-Reset` as the wait; everything else, 5xx and network errors are `transient`. After
an `auth` or `rate_limited` answer, the other registrations of the same call fail the same way
without a request. No retries inside: the kernel's queue retries. Error messages carry only
JPush's code and the HTTP status, never a registration id or JPush's own message text.

## Live tests

The tests in `test/live` call the real JPush and run only when `CAPYBARA_TEST_JPUSH_APP_KEY` and
`CAPYBARA_TEST_JPUSH_MASTER_SECRET` are set (the credentials check);
`CAPYBARA_TEST_JPUSH_REGISTRATION_ID` (a device of that app) adds one real push:

```bash
set -a; . ~/.capybara-test.env; set +a; pnpm exec vitest run plugins/push-jpush/test/live
```
