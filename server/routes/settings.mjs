import { Router }   from "express";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const OPENROUTER_MODELS_FILE = resolve(__dir, "../../openrouter-models.txt");
import { readAiModelListsCachePayload, writeAiModelListsCachePayload } from "../services/aiModelCache.mjs";
import { getProjectCacheStatsPayload, clearProjectMultimediaCacheFull } from "../services/projectCache.mjs";

const router = Router();

router.get("/settings/ai-model-lists-cache", (_req, res) => {
  res.json({ ok: true, cache: readAiModelListsCachePayload() });
});

router.put("/settings/ai-model-lists-cache", (req, res) => {
  const body = req.body ?? {};
  try {
    const cache = writeAiModelListsCachePayload(body);
    res.json({ ok: true, cache });
  } catch (e) {
    res.status(400).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

router.get("/settings/project-cache-stats", (_req, res) => {
  res.json(getProjectCacheStatsPayload());
});

router.post("/settings/project-cache-clear-multimedia", (_req, res) => {
  try {
    const out = clearProjectMultimediaCacheFull();
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * Returns which LLM providers have API keys actually configured in .env.
 * Used by the frontend to skip providers without keys in AI opinion / model selection.
 * Response: { ok: true, configured: { openai: bool, ollama: bool, "gemini-flash": bool, anthropic: bool } }
 */
router.get("/settings/configured-providers", (_req, res) => {
  const configured = {
    openai:          Boolean(String(process.env.OPENAI_API_KEY        ?? "").trim()),
    ollama:          true,
    "ollama-kimi":   true,
    "ollama-ds":     true,
    "gemini-flash":  Boolean(String(process.env.GEMINI_API_KEY        ?? "").trim()),
    anthropic:       Boolean(String(process.env.ANTHROPIC_API_KEY     ?? "").trim()),
    openrouter:      Boolean(String(process.env.OPENROUTER_API_KEY    ?? "").trim()),
  };
  res.json({ ok: true, configured });
});

/**
 * GET /api/settings/openrouter-models
 * Returns the list of OpenRouter model IDs from openrouter-models.txt.
 * Lines starting with # and blank lines are ignored.
 */
router.get("/settings/openrouter-models", (_req, res) => {
  try {
    if (!existsSync(OPENROUTER_MODELS_FILE)) {
      return res.json({ ok: true, models: [] });
    }
    const raw  = readFileSync(OPENROUTER_MODELS_FILE, "utf-8");
    const models = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    res.json({ ok: true, models });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Update configured-providers to include openrouter
export default router;
