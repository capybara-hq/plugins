---
"@capybara-hq/plugin-browser": patch
---

Page dialogs, HTTP sign-in, permission prompts, phone viewport and touch takeover (plugins#208):
confirm, prompt and leave-page dialogs are held until answered (new tool `browser_dialog`, the
panel's dialog box), HTTP Basic sign-in from the panel with credentials kept in the daemon's
memory, refused permission requests reported (notifications and clipboard can be allowed), and a
phone viewport with touch input and a soft keyboard for a takeover from a phone.
