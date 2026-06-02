-- Migration 015: Maestro task scheduler tables
-- Stores scheduled / one-shot tasks managed by the Maestro orchestrator slot.

-- Scheduled and one-shot tasks
CREATE TABLE IF NOT EXISTS maestro_tasks (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  description     TEXT,
  task_type       TEXT NOT NULL DEFAULT 'chat',    -- chat | keeper | custom
  provider_id     TEXT NOT NULL DEFAULT 'or-3',     -- LLM provider slot to use
  model_id        TEXT,                              -- specific model (NULL = slot default)
  schedule_cron   TEXT,                              -- cron expression (NULL = one-shot)
  schedule_enabled INTEGER NOT NULL DEFAULT 0,      -- 0 = paused, 1 = active
  system_prompt   TEXT,                              -- override system prompt for the task
  context_json    TEXT,                              -- extra context: memory node ids, rules, etc.
  max_context_nodes INTEGER NOT NULL DEFAULT 20,    -- max memory-graph nodes to inject
  last_run_at     TEXT,
  next_run_at     TEXT,
  run_count       INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'idle',      -- idle | running | error | disabled
  last_error      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_maestro_tasks_status
  ON maestro_tasks(status);

CREATE INDEX IF NOT EXISTS idx_maestro_tasks_next_run
  ON maestro_tasks(next_run_at)
  WHERE status = 'idle' AND schedule_enabled = 1;

-- Task execution log
CREATE TABLE IF NOT EXISTS maestro_runs (
  id               TEXT PRIMARY KEY,
  task_id          TEXT NOT NULL REFERENCES maestro_tasks(id) ON DELETE CASCADE,
  started_at       TEXT NOT NULL,
  finished_at      TEXT,
  status           TEXT NOT NULL DEFAULT 'running',  -- running | success | error
  result_summary   TEXT,
  prompt_tokens    INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens     INTEGER NOT NULL DEFAULT 0,
  error_message    TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_maestro_runs_task
  ON maestro_runs(task_id);

CREATE INDEX IF NOT EXISTS idx_maestro_runs_status
  ON maestro_runs(status);

CREATE INDEX IF NOT EXISTS idx_maestro_runs_started
  ON maestro_runs(started_at);
