-- 迁移在 search_path 为 "plugin_example_counter, public" 下运行，表名不带 schema 前缀。
CREATE TABLE IF NOT EXISTS counters (
  name text PRIMARY KEY,
  n bigint NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS events (
  id bigserial PRIMARY KEY,
  job_id text UNIQUE,
  delta int NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
