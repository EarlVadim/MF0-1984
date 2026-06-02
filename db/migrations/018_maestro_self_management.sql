-- Migration 018: Maestro self-management — retry policy, run triggers, memory writes

-- Retry policy columns on tasks
ALTER TABLE maestro_tasks ADD COLUMN retry_on_error INTEGER NOT NULL DEFAULT 0;    -- 0 = no retry, 1 = auto-retry on error
ALTER TABLE maestro_tasks ADD COLUMN max_retries INTEGER NOT NULL DEFAULT 3;       -- max consecutive retries before giving up
ALTER TABLE maestro_tasks ADD COLUMN consecutive_errors INTEGER NOT NULL DEFAULT 0; -- current retry counter

-- Track which task triggered this run (for run_task tool)
ALTER TABLE maestro_runs ADD COLUMN source_task_id TEXT;  -- the task that called run_task, or NULL for scheduler/manual
