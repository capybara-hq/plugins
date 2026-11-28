-- Runs with search_path "plugin_collab, public": table names carry no schema prefix.
-- Ids from the kernel (org, account, agent, conversation) are stored as text. Every table has
-- org_id; every query filters it. Actor JSON: {"accountId"} or {"accountId","agentId","conversationId"}.

CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  key text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  archived boolean NOT NULL DEFAULT false,
  next_item_number integer NOT NULL DEFAULT 1,
  owner_account_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS projects_org_key ON projects (org_id, key);

CREATE TABLE IF NOT EXISTS project_members (
  org_id text NOT NULL,
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  account_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'member', 'guest')),
  function_label text,
  -- The member's agent a default assignment with `memberAgent` hands the item to.
  default_agent_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, account_id)
);
CREATE INDEX IF NOT EXISTS project_members_org_account ON project_members (org_id, account_id);

CREATE TABLE IF NOT EXISTS workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  item_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS workflows_project_type ON workflows (project_id, item_type);

CREATE TABLE IF NOT EXISTS statuses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  workflow_id uuid NOT NULL REFERENCES workflows (id) ON DELETE CASCADE,
  key text NOT NULL,
  name_zh text NOT NULL,
  name_en text NOT NULL,
  category text NOT NULL CHECK (category IN ('backlog', 'todo', 'in_progress', 'review', 'done', 'canceled')),
  position integer NOT NULL DEFAULT 0,
  next_keys text[],
  gate jsonb,
  default_assignment jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS statuses_workflow_key ON statuses (workflow_id, key);

CREATE TABLE IF NOT EXISTS item_types (
  org_id text NOT NULL,
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  key text NOT NULL,
  name_zh text NOT NULL,
  name_en text NOT NULL,
  icon text,
  workflow_id uuid REFERENCES workflows (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, key)
);

CREATE TABLE IF NOT EXISTS items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  number integer NOT NULL,
  type text NOT NULL,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  status_key text NOT NULL,
  responsible_account_id text,
  executing_agent_id text,
  priority integer NOT NULL DEFAULT 3,
  labels text[] NOT NULL DEFAULT '{}',
  parent_id uuid REFERENCES items (id) ON DELETE SET NULL,
  fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS items_project_number ON items (project_id, number);
CREATE INDEX IF NOT EXISTS items_org_responsible ON items (org_id, responsible_account_id);
CREATE INDEX IF NOT EXISTS items_org_agent ON items (org_id, executing_agent_id);
CREATE INDEX IF NOT EXISTS items_parent ON items (parent_id);
CREATE INDEX IF NOT EXISTS items_org_project_status ON items (org_id, project_id, status_key);

CREATE TABLE IF NOT EXISTS item_watchers (
  org_id text NOT NULL,
  item_id uuid NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  account_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, account_id)
);

CREATE TABLE IF NOT EXISTS item_links (
  org_id text NOT NULL,
  from_id uuid NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  to_id uuid NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('blocks', 'relates', 'duplicates')),
  CHECK (from_id <> to_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (from_id, to_id, kind)
);
CREATE INDEX IF NOT EXISTS item_links_to ON item_links (to_id);

CREATE TABLE IF NOT EXISTS comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  item_id uuid NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  author jsonb NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS comments_item ON comments (item_id, created_at);

CREATE TABLE IF NOT EXISTS activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  item_id uuid NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  actor jsonb NOT NULL,
  kind text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activity_item ON activity (item_id, created_at);

CREATE TABLE IF NOT EXISTS artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  item_id uuid NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  kind text NOT NULL,
  name text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  storage_key text,
  url text,
  author jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS artifacts_item ON artifacts (item_id, created_at);

CREATE TABLE IF NOT EXISTS decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  item_id uuid NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('question', 'gate')),
  asker jsonb NOT NULL,
  addressee_account_id text NOT NULL,
  question text NOT NULL,
  options jsonb NOT NULL DEFAULT '[]'::jsonb,
  recommendation jsonb,
  blocking boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'answered', 'canceled', 'expired')),
  answer jsonb,
  deadline_at timestamptz,
  gate_target text,
  created_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz
);
CREATE INDEX IF NOT EXISTS decisions_item ON decisions (item_id, created_at);
CREATE INDEX IF NOT EXISTS decisions_item_open ON decisions (item_id) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS decisions_addressee_open ON decisions (org_id, addressee_account_id) WHERE state = 'open';

-- Events owed to ctx.triggers.emit, written in the transaction of the change they describe.
CREATE TABLE IF NOT EXISTS event_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  type text NOT NULL,
  subject jsonb NOT NULL,
  facts jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary text NOT NULL,
  dedupe_key text NOT NULL,
  audience jsonb,
  cause jsonb,
  emitted_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS event_outbox_dedupe ON event_outbox (org_id, dedupe_key);
CREATE INDEX IF NOT EXISTS event_outbox_pending ON event_outbox (created_at) WHERE emitted_at IS NULL;
