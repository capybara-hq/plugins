-- Runs with search_path "plugin_memory, public": table names carry no schema prefix.
-- Ids from the kernel (org, agent, account, conversation) are stored as text.

-- One memory of one (agent, member) pair in an org. Every query filters org_id, agent_id and
-- account_id. `tokens` is the plugin's own word segmentation (Intl.Segmenter) as a 'simple'
-- tsvector; `embedding` is added below, its type depends on pgvector.
CREATE TABLE IF NOT EXISTS memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  agent_id text NOT NULL,
  account_id text NOT NULL,
  path text NOT NULL,
  type text NOT NULL CHECK (type IN ('user', 'feedback', 'project', 'reference')),
  description text NOT NULL,
  body text NOT NULL,
  tokens tsvector NOT NULL DEFAULT ''::tsvector,
  embedding_model text,
  recall_count integer NOT NULL DEFAULT 0,
  last_recalled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_in text
);

-- One path per owner; its (org_id, agent_id, account_id) prefix serves the per-owner reads.
CREATE UNIQUE INDEX IF NOT EXISTS memories_owner_path ON memories (org_id, agent_id, account_id, path);
-- A member leaving the org removes their memories with every agent.
CREATE INDEX IF NOT EXISTS memories_org_account ON memories (org_id, account_id);
CREATE INDEX IF NOT EXISTS memories_tokens ON memories USING gin (tokens);

-- The embedding column: pgvector's `vector` when the type resolves from this search_path (the
-- kernel installs pgvector into `public` when the server offers it), else `real[]` with cosine
-- computed in the plugin. pgvector installed in another schema counts as absent. No fixed
-- dimension: orgs may map different embedding models, and search is per owner (at most 1,000
-- rows), so no ANN index is needed. The type cannot be chosen by a plain statement, hence the DO
-- block; deployers see it as a `dynamic_sql` warning at review (README, "Database").
-- capybara:allow-destructive not destructive: the DO block only adds the embedding column, typed vector when pgvector is visible and real[] otherwise
DO $$
BEGIN
  IF to_regtype('vector') IS NOT NULL THEN
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding vector;
  ELSE
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding real[];
  END IF;
END
$$;

-- `[[…]]` links of a memory, parsed on every write: a path or a bare name, resolved when read,
-- so a link to a memory written later becomes live.
CREATE TABLE IF NOT EXISTS memory_links (
  memory_id uuid NOT NULL REFERENCES memories (id) ON DELETE CASCADE,
  to_path text NOT NULL,
  PRIMARY KEY (memory_id, to_path)
);

-- Semantic neighbours (top cosine matches among the owner's memories), for the memory page.
CREATE TABLE IF NOT EXISTS memory_neighbors (
  memory_id uuid NOT NULL REFERENCES memories (id) ON DELETE CASCADE,
  neighbor_id uuid NOT NULL REFERENCES memories (id) ON DELETE CASCADE,
  score real NOT NULL,
  PRIMARY KEY (memory_id, neighbor_id)
);
CREATE INDEX IF NOT EXISTS memory_neighbors_neighbor ON memory_neighbors (neighbor_id);

-- Display names of the agents and members the plugin has seen (upserted from each context
-- request), so the memory page can name them without a kernel lookup.
CREATE TABLE IF NOT EXISTS owners (
  org_id text NOT NULL,
  agent_id text NOT NULL,
  account_id text NOT NULL,
  agent_name text NOT NULL,
  owner_name text NOT NULL,
  seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, agent_id, account_id)
);
CREATE INDEX IF NOT EXISTS owners_org_account ON owners (org_id, account_id);

-- One row per admin view of, or delete in, another member's memories (audit only).
CREATE TABLE IF NOT EXISTS admin_access_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  admin_account_id text NOT NULL,
  owner_account_id text NOT NULL,
  agent_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('view', 'delete')),
  memory_path text,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_access_log_org ON admin_access_log (org_id, at);
