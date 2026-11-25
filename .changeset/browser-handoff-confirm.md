---
"@capybara-hq/plugin-browser": patch
---

The handoff question in the conversation now matches the panel banner. Its title is a short
"请在浏览器中完成：<reason>" / "Finish in the browser: <reason>", the agent's full reason is the body,
and 完成 / 取消 are buttons (InputForm `choices` on `{ done }`) instead of a toggle with Answer.
Needs plugin-sdk rc.75 (core v0.1.0-rc.117).

The panel's `/ui/handoff-answer` passes `handoffConversationId`, which plugin-sdk rc.75's
`answerHandoff` requires. By default it is the panel's conversation, or the raising conversation
when the panel names it (a sub-agent's).
