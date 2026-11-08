---
"@capybara-hq/plugin-sandbox-e2b": patch
---

Kill a command's children that left its session. Every exec carries `CAPYBARA_EXEC=<control file>`, and the kill
scripts (timeout, abort, `killTagged`, `killAll`, the in-sandbox deadline) also SIGKILL the processes whose
environment has it; when some are still there, the sandbox reboots. Real envd ends the output stream when the
command exits, so before this a `setsid` child kept running and the reboot fallback never fired. README: a paused
sandbox's network rules cannot be changed (verified on E2B).
