# Connect JPush

{{pluginName}} {{pluginVersion}} sends push notifications to the Android app through JPush. JPush
delivers through its own connection and, when the app integrates them, through the Huawei, Honor,
Xiaomi, OPPO and vivo vendor channels. Every notification is sent as a service message (JPush
`classification: 1`).

1. In the JPush console, open the app that the Android build integrates and copy the **AppKey**
   and the **Master Secret** from its app settings.
2. Save them as `appKey` and `masterSecret` on this page, and list the Android application ids
   (package names) of the builds that use this JPush app in `applicationIds`.
3. If the JPush app has an IP allowlist, add this deployment's outbound IP addresses to it.

::check jpush-credentials JPush accepts the AppKey and Master Secret

## Vendor channels

Each vendor decides on its own whether a notification counts as a service message. Apply for the
classification with the vendor first, then fill in what it gave you (all optional):

- **Xiaomi:** `xiaomi.channelId` (the private-message channel) and `xiaomi.templateId`.
- **OPPO:** `oppo.channelId`, `oppo.category` and `oppo.notifyLevel` (1, 2 or 16; needs a
  category).
- **vivo:** `vivo.category` and, for template messages, `vivo.templateId`.
- **Huawei:** `huawei.category` (needs Huawei's self-classification entitlement). Huawei and Honor
  always get the importance `NORMAL`.

A Xiaomi or vivo template must declare the variables `title` and `body`; the notification's title
and text fill them.
