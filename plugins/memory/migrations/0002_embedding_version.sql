-- Counts the vectors stored for a memory (one more on every stored embedding). The `memory-embed`
-- job id carries it, so a re-embed after an embedding model switch never reuses the id of a job
-- the queue still retains from an earlier switch (A -> B -> A). Expand-only: older code ignores it.
ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding_version integer NOT NULL DEFAULT 0;
