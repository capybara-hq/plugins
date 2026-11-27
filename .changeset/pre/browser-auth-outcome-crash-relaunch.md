---
"@capybara-hq/plugin-browser": patch
---

Report what the site answered to the credentials a person enters for HTTP sign-in (accepted, or rejected with the new sign-in dialog, once per origin) instead of always "signed in" (#306). After Chromium crashes, the daemon stays up and relaunches it on the next use, reopening each conversation's tabs; a request that was running when it crashed says so (#307).
