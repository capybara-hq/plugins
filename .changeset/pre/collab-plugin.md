---
"@capybara-hq/plugin-collab": patch
---

New plugin: **collab** (项目协作 / Projects), a project tracker for people and agents.

- Projects with requirements, tasks and bugs, each moving through its type's workflow; statuses can
  need a person's confirmation (a request waits in the confirmer's inbox) and hand the item to the
  next member and their default agent.
- Every item has a responsible person and, optionally, the agent working on it for them;
  assignment is a directed event that reaches the agent through the person's acceptance rule and
  opens the item's own conversation.
- Agent tools for projects, items, comments, links, artifacts (links) and decisions; tools act as
  the conversation's owner and never answer decisions.
- Decisions with options, recommendations, deadlines, reminders and escalation; answers from the
  inbox or the item page.
- Pages: project list, board, table, item page and project settings; an item panel and properties
  section in the item's conversation and an item list on the agent page.
- Events for automations (`trigger-source@1`) through a transactional outbox; agent run state from
  `run.lifecycle`; archived projects are read-only.
- Agent templates (product, engineer, qa) and skills (collab-workflow, prd-writing, test-planning).
