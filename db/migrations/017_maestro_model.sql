-- Migration 017: Maestro — model_id in runs, default model support

-- Add model_id column to maestro_runs (records which model was actually used)
ALTER TABLE maestro_runs ADD COLUMN model_id TEXT;

-- Add default_model column to maestro_tasks (server-side default model override)
ALTER TABLE maestro_tasks ADD COLUMN default_model TEXT;
