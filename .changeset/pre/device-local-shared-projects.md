---
"@capybara-hq/plugin-device-local": patch
---

Shows the project directories shared on the machine: the device report lists "Also used by another
connection on this computer" with the directories the machine reports as `sharedProjectRoots` in
its policy summary (only those the owner listed for this connection, never naming the other
connection). A change tells the kernel once and keeps the report revision, so it never moves the
device authority epoch. Needs plugin-sdk 0.1.0-rc.58.
