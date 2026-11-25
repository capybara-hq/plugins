---
"@capybara-hq/plugin-device-docker": patch
---

A running instance whose egress proxy is missing, stopped or on another image than the configured one gets it back at its next
use (a command, a service start, a resume), in every network mode, open public included, without recreating the instance; an
instance with the egress control is rebuilt only from its config volume, as before.
