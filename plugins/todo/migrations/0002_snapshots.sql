-- The list as of each todo__write call: the inline card under that call shows it (its
-- ToolResult.card key is the snapshot id). Looked up by id and conversation together. Each write
-- keeps only the conversation's latest SNAPSHOTS_PER_CONVERSATION (an older card falls back to
-- the current list); org_id lets an organization's rows be found and removed together.
CREATE TABLE IF NOT EXISTS snapshots (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  conversation_id text NOT NULL,
  items jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS snapshots_conversation_idx ON snapshots (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS snapshots_org_idx ON snapshots (org_id);
