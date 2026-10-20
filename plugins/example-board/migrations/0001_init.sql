-- 迁移在 search_path 为 "plugin_example_board, public" 下运行，表名不带 schema 前缀。
-- 看板卡片：按组织隔离；conversation_id 不为空的卡片属于某个对话（对话标签 board-conv 只看这些）。
CREATE TABLE IF NOT EXISTS cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  conversation_id text NULL,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'done')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cards_org_idx ON cards (org_id, created_at);
CREATE INDEX IF NOT EXISTS cards_conversation_idx ON cards (org_id, conversation_id, created_at);
