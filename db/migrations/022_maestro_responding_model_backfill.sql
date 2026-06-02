-- Step: Backfill responding_model_id for Maestro conversation turns
-- The scheduler's _recordTurn() now writes result.modelId into responding_model_id,
-- but old turns have NULL there. This migration backfills from maestro_runs data.

-- Get the Maestro purpose dialog
-- For each conversation turn with request_type='maestro' that has no responding_model_id,
-- find the corresponding maestro_run by matching timestamps and fill in the model_id.

UPDATE conversation_turns
SET responding_model_id = (
  SELECT r.model_id
  FROM maestro_runs r
  JOIN maestro_tasks t ON t.id = r.task_id
  WHERE r.model_id IS NOT NULL
    AND conversation_turns.user_text LIKE '[Maestro Task: ' || t.title || ']%'
    AND r.started_at <= conversation_turns.assistant_message_at
    AND r.finished_at >= conversation_turns.assistant_message_at
  ORDER BY r.started_at DESC
  LIMIT 1
)
WHERE request_type = 'maestro'
  AND responding_model_id IS NULL
  AND assistant_message_at IS NOT NULL;
