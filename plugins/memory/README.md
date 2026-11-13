# @capybara-hq/plugin-memory

Memory for Capybara agents, modelled on Claude Code's memory: each agent remembers each member
across conversations. A memory is one note about one thing at `<type>/…/<name>.md`, where the type
is `user`, `feedback`, `project` or `reference`.

Memories belong to one (agent, member) pair in an org and exist only in one-to-one conversations
(web chat and channel DMs) of non-guest members.

## Database

The plugin keeps its rows in the schema `plugin_memory`. The migration `0001_init.sql` contains one
`DO` block, shown to deployers as a `dynamic_sql` warning at review: it only adds the `embedding`
column, typed pgvector's `vector` when the type is visible from the plugin's search path (the kernel
installs pgvector into `public` when the server offers it) and `real[]` otherwise. pgvector is
recommended, not required: without it, semantic search computes cosine similarity in the plugin.
