---
"@capybara-hq/plugin-device-e2b": patch
---

File calls (`readFile`, `writeFile`, `stat`) check only the path's shape; which roots they may reach
is the kernel's, by mode. In auto mode the file tools reach any clean absolute path in the
instance (`Read /etc/passwd` failed with "invalid sandbox path" before), as the auto mode design
says; sandbox mode stays held to the workspace, skills and temporary roots by the kernel.
