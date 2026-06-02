-- Migration 019: Maestro — backfill default_model for existing tasks
-- Tasks that have no model_id and no default_model get the current slot model
-- from the Maestro dialog's or_models_json, or fall back to the env default.

-- This migration is a no-op at the SQL level; the backfill happens at runtime
-- in createTask() via resolveMaestroModel(). Existing tasks will pick up the
-- slot model on their next run through the resolution chain:
--   task.modelId → task.defaultModel → MAESTRO_DEFAULT_MODEL → undefined
-- If the user wants to force-update old tasks, they can use the UI "Set model"
-- or Maestro's update_task tool.
