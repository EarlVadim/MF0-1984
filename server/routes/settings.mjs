import { Router }   from "express";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
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
        rerankModel: typeof e.rerankModel === "string" ? e.rerankModel.trim() : "",
        keeperModel: typeof e.keeperModel === "string" ? e.keeperModel.trim() : "",
        modes:       e.modes && typeof e.modes === "object" ? e.modes : {},
      }));
  } catch (e) {
    console.error("[settings] Failed to load openrouter-models.json:", e.message);
    return [];
  }
}

/**
 * Validate a single model entry from the client.
 * Returns a sanitized object or null if invalid.
 * @param {unknown} entry
 * @returns {object | null}
 */
function sanitizeModelEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const e = /** @type {Record<string, unknown>} */ (entry);
  const id = String(e.id ?? "").trim();
  if (!id) return null;
  return {
    id,
    shortName:   typeof e.shortName === "string" ? e.shortName.trim() : id.split("/").pop(),
    desc:        typeof e.desc === "string" ? e.desc.trim() : "",
    inputPer1M:  Number(e.inputPer1M)  || 0,
    outputPer1M: Number(e.outputPer1M) || 0,
    rerankModel: typeof e.rerankModel === "string" ? e.rerankModel.trim() : "",
    keeperModel: typeof e.keeperModel === "string" ? e.keeperModel.trim() : "",
    modes:       e.modes && typeof e.modes === "object" ? e.modes : {},
  };
}

/**
 * Write the full models array back to openrouter-models.json (atomic-ish).
 * @param {Array<object>} models
 */
function saveOpenRouterModels(models) {
  const json = JSON.stringify(models, null, 2) + "\n";
  writeFileSync(OPENROUTER_MODELS_FILE, json, "utf-8");
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
 * Returns OpenRouter model entries from openrouter-models.json.
 *
 * Response: { ok: true, models: Array<{ id, shortName, inputPer1M, outputPer1M, rerankModel, keeperModel, modes }> }
 */
router.get("/settings/openrouter-models", (_req, res) => {
  try {
    res.json({ ok: true, models: loadOpenRouterModels() });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

/**
 * PUT /api/settings/openrouter-models
 * Replace the entire models array. Body: { models: [...] }
 * Each entry is sanitized; entries without a valid id are dropped.
 */
router.put("/settings/openrouter-models", (req, res) => {
  try {
    const raw = req.body?.models;
    if (!Array.isArray(raw)) {
      return res.status(400).json({ ok: false, error: "Request body must contain a 'models' array" });
    }
    const models = raw.map(sanitizeModelEntry).filter(Boolean);
    saveOpenRouterModels(models);
    res.json({ ok: true, models });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * POST /api/settings/openrouter-models
 * Add a single model entry. Body: { id, shortName, desc, inputPer1M, outputPer1M, rerankModel, keeperModel, modes }
 * Returns 409 if a model with the same id already exists.
 */
router.post("/settings/openrouter-models", (req, res) => {
  try {
    const entry = sanitizeModelEntry(req.body);
    if (!entry) {
      return res.status(400).json({ ok: false, error: "Invalid model entry — 'id' is required" });
    }
    const models = loadOpenRouterModels();
    if (models.some((m) => m.id === entry.id)) {
      return res.status(409).json({ ok: false, error: `Model '${entry.id}' already exists` });
    }
    models.push(entry);
    saveOpenRouterModels(models);
    res.json({ ok: true, models });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * DELETE /api/settings/openrouter-models/:id
 * Remove a model by its id (URL-encoded). Returns 404 if not found.
 */
router.delete("/settings/openrouter-models/:id", (req, res) => {
  try {
    const targetId = String(req.params.id ?? "").trim();
    if (!targetId) {
      return res.status(400).json({ ok: false, error: "Model id is required" });
    }
    const models = loadOpenRouterModels();
    const before = models.length;
    const filtered = models.filter((m) => m.id !== targetId);
    if (filtered.length === before) {
      return res.status(404).json({ ok: false, error: `Model '${targetId}' not found` });
    }
    saveOpenRouterModels(filtered);
    res.json({ ok: true, models: filtered });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// Update configured-providers to include openrouter
export default router;
