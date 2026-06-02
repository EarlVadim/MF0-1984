-- Migration 021: Task chain columns (CONSOLIDATED into 017_maestro_task_chain.sql)
-- This migration is now a no-op: chain_to and chain_condition are added by migration 017.
-- Kept for idempotency: if 017 already ran, these ALTERs will be skipped by the JS migration runner
-- (duplicate column errors are caught). If 017 was somehow skipped, this serves as a fallback.
-- Default value for chain_condition is 'success' (consistent with 017 and code expectations).

-- The actual column additions are handled by migration 017.
-- This file is intentionally empty at the SQL level to avoid duplicate column errors.
-- The JS migration runner will attempt 017 first; if it fails with "duplicate column",
-- it means the columns already exist and that's fine.
