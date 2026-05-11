import { Router } from "express";
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
    openai:          Boolean(String(process.env.OPENAI_API_KEY    ?? "").trim()),
    ollama:          true,   // local Ollama — always available
    "ollama-kimi":   true,   // kimi-k2.6:cloud via Ollama
    "ollama-ds":     true,   // deepseek-v4-pro:cloud via Ollama
    "gemini-flash":  Boolean(String(process.env.GEMINI_API_KEY    ?? "").trim()),
    anthropic:       Boolean(String(process.env.ANTHROPIC_API_KEY ?? "").trim()),
  };
  res.json({ ok: true, configured });
});

export default router;
