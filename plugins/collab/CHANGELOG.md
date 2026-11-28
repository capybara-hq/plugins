# @capybara-hq/plugin-collab

## 0.1.0-rc.3

### Patch Changes

- 0a2feb8: Follow and unfollow collab items from the item page or with an agent tool. Watchers receive bilingual inbox notices for status changes, comments, and decision answers. Item events expose a filterable watcher list.

## 0.1.0-rc.2

### Patch Changes

- d2c6358: Collab acceptance fixes: the agent templates and the collab-workflow skill state that work an agent
  assigns to itself arrives as no event; gate answers are named 批准 / 驳回 in Chinese; closing an
  item cancels its open questions (inbox resolved, activity recorded, the asking pair told).
- c5d99b6: Inbox items in both UI languages: assignment and handoff notices, decision and gate items,
  reminders and escalations carry Chinese and English titles and bodies (the asker's question and
  option texts as written). Needs plugin-sdk 0.1.0-rc.89 (a kernel that takes localized inbox
  texts).

## 0.1.0-rc.1

### Patch Changes

- ca86a11: New plugin: **collab** (项目协作 / Projects), a project tracker for people and agents.
  
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
