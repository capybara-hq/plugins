-- 迁移在 search_path 已设为本插件 schema（plugin_example_counter）下运行，表名不带 schema 前缀。
CREATE TABLE IF NOT EXISTS events (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now()
);
