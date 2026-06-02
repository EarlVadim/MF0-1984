-- Migration 017: Task chaining — chain_to and chain_condition columns
-- Enables dependency chains between Maestro tasks (prerequisite for parallel execution).
-- NOTE: This was previously duplicated in 021_maestro_task_chain.sql with conflicting defaults.
-- Both are now consolidated here; 021 is kept as a no-op for idempotency.

-- chain_to: ID of another task that must complete before this one can run.
--           NULL = no dependency (independent task, can run in parallel).
-- chain_condition: When to trigger this task after chain_to completes.
--   "success"  — run only if predecessor succeeded (default)
--   "error"    — run only if predecessor failed
--   "always"   — run regardless of predecessor's outcome

-- Use IF NOT EXISTS equivalent: only add columns if they don't exist
-- SQLite doesn't support IF NOT EXISTS for ALTER TABLE ADD COLUMN, so we handle errors in JS.
ALTER TABLE maestro_tasks ADD COLUMN chain_to TEXT DEFAULT NULL;
ALTER TABLE maestro_tasks ADD COLUMN chain_condition TEXT NOT NULL DEFAULT 'success';
