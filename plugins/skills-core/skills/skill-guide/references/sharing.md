# Sharing skills and proposing versions

Read this before sharing a skill with the org, or when you register a new version of one.

## Share

1. The owner asks to share a skill (or uses the agent page).
2. Call `Platform` `agents.skills` to find the skill id, then `agents.share-skill` with
   `{ "agentId": ..., "skillId": ... }`.
3. An org admin confirms it in the inbox. When the owner is an org admin it is shared at once.
   Until an admin decides, the skill stays this agent's own and keeps working.

Only the agent's owner can share. You never decide a share yourself.

## After sharing

- The skill is an org skill: any agent in the org can select it, and this agent keeps using it.
- The owner becomes its maintainer.
- A skill someone else maintains cannot be changed by registering a package of the same name from
  your agent: a name used by an org skill this agent uses (and does not maintain) is refused. Pick a
  different name for your own variant.

## New versions of an org skill

When the maintainer registers a package with the org skill's name from an agent they own, it is a
proposed version: an org admin approves it in the inbox (an admin maintainer's registration applies
at once). Until it is approved, only the proposing conversation uses the new version; everyone else
keeps the current one. Tell the person that the new version is waiting for approval.

As always, a registration is a complete version: zip the whole directory, not only the changes.
