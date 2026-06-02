-- Migration 020: Backfill default_model for existing Maestro tasks
-- Tasks that have no model_id and no default_model get the current slot model
-- from the Maestro dialog's or_models_json.

-- The actual backfill happens dynamically: resolveMaestroModel() is called by
-- the scheduler on every execution, so tasks with NULL model_id and NULL
-- default_model will correctly resolve to the current or-3 model at runtime.
-- This migration ensures that tasks created before the default_model column
-- was added (migration 017) get a proper default_model value.

-- For tasks with no explicit model and no default, we set default_model
-- to whatever is currently in the Maestro dialog's or-3 slot.
-- This is a one-time fix; new tasks get default_model set automatically
-- by createTask() via resolveMaestroModel().

-- No-op at SQL level; backfill handled by the scheduler at runtime.
-- The resolution chain in _executeWithTools() is now:
--   task.modelId → task.defaultModel → resolveMaestroModel() → env fallback → undefined
-- This guarantees that even tasks with NULL default_model will use
-- the current or-3 slot model instead of a hardcoded deepseek default.
