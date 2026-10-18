-- 迁移在 search_path 为 "plugin_todo, public" 下运行，表名不带 schema 前缀。
-- 每个会话一行清单（整表覆盖写入）。
CREATE TABLE IF NOT EXISTS todos (
  conversation_id text PRIMARY KEY,
  items jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
