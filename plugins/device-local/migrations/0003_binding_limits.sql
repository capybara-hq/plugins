-- The limits the device's instance generation enforces now (those of its create, replaced by
-- every update that answered "updated"), and the highest fence token a lifecycle call of the
-- device carried (create seeds it, update raises it; a lower token is a stale holder's).
ALTER TABLE bindings ADD COLUMN IF NOT EXISTS limits jsonb;
ALTER TABLE bindings ADD COLUMN IF NOT EXISTS fence_token bigint;
