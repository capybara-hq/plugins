-- The list as of each todo__write call: the inline card under that call shows it (its
-- ToolResult.card key is the snapshot id). Looked up by id and conversation together.
CREATE TABLE IF NOT EXISTS snapshots (
  id text PRIMARY KEY,
  conversation_id text NOT NULL,
  items jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS snapshots_conversation_idx ON snapshots (conversation_id);
