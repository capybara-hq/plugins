---
"@capybara-hq/plugin-atlassian": patch
---

Connector template descriptions in English and Chinese (plugin-sdk 0.1.0-rc.65). The Bitbucket
template is on by default: a live test connected over OAuth and listed workspaces, repositories and
pull requests, so the guides, README and description drop the "OAuth unconfirmed" caveat and keep
the prerequisite that the Bitbucket Cloud workspace is linked to the Atlassian organization. The
Confluence guide says the Atlassian site must have Confluence (a Jira-only site answers 404 on
every Confluence tool although connecting succeeds); the Jira guide says the site must have Jira.
