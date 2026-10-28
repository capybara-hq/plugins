---
name: writing-migrations
description: 'Use when adding or changing an extension SQL migration (plugins/<name>/migrations, schema plugin_<name>): file naming, applied migrations are immutable, idempotent style, no transaction control or DO blocks, the expand-then-contract two-step column drop, and the exemption comment and reason required for destructive statements.'
---

# Writing extension migrations

An extension's migrations are plain SQL files in `plugins/<name>/migrations/`, declared in the manifest as `migrations: "../migrations"` (see `.agents/skills/writing-extensions`). They run in the schema `plugin_<name>` (`-` replaced by `_`). `pnpm check` (`capybara-plugin check`) checks them statement by statement; the rule ids below are the ids it reports. Kernel migrations are core's business: see [writing-migrations in core](https://github.com/capybara-hq/core/tree/main/.agents/skills/writing-migrations).

## Naming

`NNNN_<snake_desc>.sql`: four digits, then lower-case letters / digits / underscores; files run in numeric order. Example: `0002_add_label.sql`. A non-conforming name reports `naming`.

**Applied migrations are immutable.** Never edit, delete or rename a migration file once it is on `main`; add a new one instead. Kernels record each file by name and checksum, so an edited file fails on every database that already ran it, while fresh test databases pass. `capybara-plugin check --base <ref>` fails when the diff modifies, deletes or renames an existing file under `plugins/*/migrations/` (rule `applied-migration-edited`); adding files is fine. Run it locally with `--base origin/main`.

## Which schema a migration runs in

The kernel wraps each file in a transaction and runs `set local search_path to plugin_<name>, public`. So **table names carry no schema prefix**. `public` comes second: a name not found in your schema resolves to the same-named object in `public`, so do not depend on anything in `public`, and do not give a table the name of an existing object in `public`. Touch only your own schema: statements that write outside it, change permissions / roles, create functions / triggers or control transactions show up as sensitive warnings when a deployer reviews the plugin, and a change in those warnings needs re-approval.

```sql
CREATE TABLE IF NOT EXISTS events (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now()
);
```

## Rules

| Rule | Description | Rule id |
|---|---|---|
| Creating objects takes `IF NOT EXISTS` | `CREATE TABLE / INDEX / SCHEMA / EXTENSION / SEQUENCE` | `idempotent` |
| Dropping objects takes `IF EXISTS` | `DROP TABLE / INDEX / ...`, `DROP COLUMN IF EXISTS`, `DROP CONSTRAINT IF EXISTS` | `idempotent` |
| No transaction control | No `BEGIN` / `COMMIT` / `ROLLBACK` / `SAVEPOINT`; no `CREATE INDEX CONCURRENTLY` (it cannot run inside a transaction; use a plain `CREATE INDEX IF NOT EXISTS`) | `transaction-control` |
| Avoid `DO` blocks where possible | The statements inside cannot be reviewed statically (deployers see them as a warning); split into ordinary idempotent statements when you can. When one is really needed (for example `RENAME COLUMN` has no `IF EXISTS`, so it goes inside `IF EXISTS (SELECT … information_schema.columns …) THEN … END IF`), write the exemption comment **directly above** the `DO` line, see below | `do-block` |
| Destructive statements need an exemption | See below | `destructive` |

Destructive statements = dropping a column, `DROP TABLE` / `DROP SCHEMA`, `TRUNCATE`, `DELETE FROM`, anything containing `RENAME`, and changing a column type (`ALTER COLUMN ... TYPE`). The check also scans the body of `DO $$ … $$` blocks: if the body has such statements and there is no exemption comment above the `DO` line, it reports `destructive` in addition to `do-block`. A comment inside the `$$` does not count. Statements assembled with `EXECUTE` are invisible to the check, so a `DO` block carrying an exemption comment needs the reason whether or not the body was recognized as destructive.

```sql
-- capybara:allow-destructive column rename; the table is new in this release and has no data yet
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'plugin_my_plugin' AND table_name = 'items' AND column_name = 'old_name') THEN
    ALTER TABLE items RENAME COLUMN old_name TO new_name;
  END IF;
END
$$;
```

## Expand -> contract (two-step column drop)

Extension migrations are **expand-only** within a release: during a rolling upgrade, old and new versions of the extension run at the same time on different replicas, so you **cannot both stop using a column and drop it in one version**.

Version N (expand): add the new column, change the code to read and write it; the old column is no longer used but is kept.

```sql
-- 0002_add_label.sql
ALTER TABLE events ADD COLUMN IF NOT EXISTS label text;
```

Version N+1 (contract): after confirming that no running version still reads or writes the old column, drop it.

```sql
-- 0003_drop_old_name.sql
-- capybara:allow-destructive since 0002 all code reads label instead; no version reads or writes old_name any more
ALTER TABLE events DROP COLUMN IF EXISTS old_name;
```

A deployment can only downgrade an extension to a version whose migration files have all been run unchanged, so never rely on a downgrade undoing a migration.

## Exemption comment

- Form: `-- capybara:allow-destructive <reason>`; it must be on the line **immediately above** the destructive statement (or the `DO` line of a `DO` block), with no blank line or other comment in between.
- **The reason cannot be empty**, and should explain why this version may run the statement directly (for example "this table is new in this version and has no data yet", "reads and writes stopped in the previous version"). A marker with an empty reason still reports `destructive`.
- A destructive statement with no marker reports `destructive`. Destructive statements are also listed as warnings for the deployer at review, exemption or not.

## Running

A kernel runs an extension's migrations when the extension is approved and loads (one replica, under an advisory lock; unapproved extensions do not migrate). In tests, `createDualReplicaHarness` and `startTestKernel` from `@capybara-hq/testing` load the plugin and run its migrations against the test database; see "Test template" in `.agents/skills/writing-extensions`. Check: `pnpm check`.
