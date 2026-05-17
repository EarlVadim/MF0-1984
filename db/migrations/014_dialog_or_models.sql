-- Migration 014: per-dialog OR slot model selection
ALTER TABLE dialogs ADD COLUMN or_models_json TEXT;
-- Stores JSON object like {"or-1":"google/gemini-pro","or-2":"...","or-3":"..."}
-- NULL means "use global setting"
