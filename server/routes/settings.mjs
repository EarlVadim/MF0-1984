import { Router }   from "express";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const OPENROUTER_MODELS_FILE = resolve(__dir, "../../openrouter-models.json");

/**
 * Parse openrouter-models.json → array of model entries.
 * Falls back to empty array on any error.
 * @returns {Array<{ id: string, shortName: string, inputPer1M: number, outputPer1M: number, modes: object }>}
 */
function loadOpenRouterModels() {
  try {
    if (!existsSync(OPENROUTER_MODELS_FILE)) return [];
    const raw = readFileSync(OPENROUTER_MODELS_FILE, "utf-8");
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((e) => e && typeof e.id === "string" && e.id.trim())
      .map((e) => ({
        id:          e.id.trim(),
        shortName:   typeof e.shortName === "string" ? e.shortName.trim() : e.id.split("/").pop(),
        desc:        typeof e.desc === "string" ? e.desc.trim() : "",
        inputPer1M:  Number(e.inputPer1M)  || 0,
        outputPer1M: Number(e.outputPer1M) || 0,
        modes:       e.modes && typeof e.modes === "object" ? e.modes : {},
      }));
  } catch (e) {
    console.error("[settings] Failed to load openrouter-models.json:", e.message);
    return [];
  }
}
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
    "or-1":   Boolean(String(process.env.OPENROUTER_API_KEY    ?? "").trim()),
    "or-2":   Boolean(String(process.env.OPENROUTER_API_KEY    ?? "").trim()),
	"or-3":   Boolean(String(process.env.OPENROUTER_API_KEY    ?? "").trim()),
    "gemini-flash":  Boolean(String(process.env.GEMINI_API_KEY        ?? "").trim()),
    anthropic:       Boolean(String(process.env.ANTHROPIC_API_KEY     ?? "").trim()),
    
  };
  res.json({ ok: true, configured });
});

/**
 * GET /api/settings/openrouter-models
 * Returns OpenRouter model entries from openrouter-models.txt.
 * Supports two line formats (lines starting with # and blank lines are ignored):
 *   Legacy:  model_id
 *   New:     model_id | input_per_1M_USD | output_per_1M_USD
 *
 * Response: { ok: true, models: Array<{ id: string, inputPer1M: number, outputPer1M: number }> }
 */
router.get("/settings/openrouter-models", (_req, res) => {
  try {
    res.json({ ok: true, models: loadOpenRouterModels() });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Update configured-providers to include openrouter
export default router;
