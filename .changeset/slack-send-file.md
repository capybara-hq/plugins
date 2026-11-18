---
"@capybara-hq/plugin-slack": minor
---

Send conversation files: the channel implements `sendFile` (`features.files`: 1 GB, images
included) through Slack's external upload (`files.getUploadURLExternal`, the upload POST,
`files.completeUploadExternal`), one message per file in the conversation's channel and thread.
The app needs the new bot scope `files:write`: admins re-paste the manifest from the setup guide (or
add the scope under OAuth & Permissions) and reinstall the app to the workspace; the `bot-scopes`
check names it until then. Without it the replies still arrive and files are delivered as links
(a missing scope on an upload is `rejected`, not `auth`).
The permission manifest gains the network host `files.slack.com` (where uploads go), so the upgrade
asks the super admin to re-approve the plugin's permissions.
