CREATE UNIQUE INDEX IF NOT EXISTS items_org_project_id ON items (org_id, project_id, id);

CREATE TABLE IF NOT EXISTS item_watchers (
  org_id text NOT NULL,
  project_id uuid NOT NULL,
  item_id uuid NOT NULL,
  account_id text NOT NULL,
  PRIMARY KEY (org_id, item_id, account_id),
  FOREIGN KEY (org_id, project_id, item_id) REFERENCES items (org_id, project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, account_id) REFERENCES project_members (project_id, account_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS item_watchers_project_account ON item_watchers (project_id, account_id);

ALTER TABLE activity ADD COLUMN IF NOT EXISTS watcher_recipients text[];

CREATE INDEX IF NOT EXISTS activity_watcher_notices ON activity (org_id, created_at)
  WHERE watcher_recipients IS NOT NULL AND notified_at IS NULL;
