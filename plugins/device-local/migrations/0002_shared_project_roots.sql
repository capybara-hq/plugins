-- The project directories of the connection that another connection on the same machine also
-- uses, from the machine's last policy summary (only directories the owner listed for this
-- connection; never naming the other connection). Shown in the device report only.
ALTER TABLE connections ADD COLUMN IF NOT EXISTS shared_project_roots text[] NOT NULL DEFAULT '{}';
