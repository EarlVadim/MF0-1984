-- Migration 016: Maestro enhancements — tool_trace in runs, conversation history support

-- Add tool_trace column to maestro_runs (stores full tool call/result log as JSON)
ALTER TABLE maestro_runs ADD COLUMN tool_trace TEXT;

-- Add conversation_history column to maestro_tasks (stores last N run summaries as context)
ALTER TABLE maestro_tasks ADD COLUMN conversation_history TEXT;

-- Add max_tool_rounds column to maestro_tasks (per-task override for tool round limit)
ALTER TABLE maestro_tasks ADD COLUMN max_tool_rounds INTEGER DEFAULT 10;
