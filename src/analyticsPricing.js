/**
 * Illustrative USD per 1M tokens for Analytics cost estimates (not live billing).
 * Provider buckets mix models; rates are a single reference tier per provider.
 */

/** @type {Record<string, { input: number, output: number, tier: string }>} */
export const ANALYTICS_USD_PER_1M = {
  /** User reference: GPT-4o–class ~ $2.50 / $15 per 1M */
  openai: { input: 2.5, output: 15, tier: "GPT-4o class (illustrative)" },
  /** Claude Sonnet–class mid tier */
  anthropic: { input: 3, output: 15, tier: "Claude Sonnet class (illustrative)" },
  /** Gemini Flash list pricing */
  "gemini-flash": { input: 0, output: 0, tier: "Gemini Flash (AI Studio)" },
  /** Ollama — local/cloud model, no API cost */
  ollama:        { input: 0.1, output: 0.1, tier: "Gemma4 via Ollama" },
  "ollama-kimi": { input: 0.1, output: 0.1, tier: "Kimi via Ollama" },
  "ollama-ds":   { input: 0.1, output: 0.1, tier: "DeepSeek via Ollama" },
  openrouter:    { input: 0.14, output: 0.28, tier: "OpenRouter (per-model)" },
};

// ── OpenRouter per-model pricing ──────────────────────────────────────────────

/**
 * Runtime price map loaded from openrouter-models.txt via the server API.
 * Key: model_id (e.g. "deepseek/deepseek-v3.2")
 * Value: { inputPer1M, outputPer1M }
 * @type {Map<string, { inputPer1M: number, outputPer1M: number }>}
 */
let _openRouterPrices = new Map();

/**
 * Populate the per-model price map (call once at startup after fetching model entries).
 * @param {Array<{ id: string, inputPer1M: number, outputPer1M: number }>} entries
 */
export function setOpenRouterModelPrices(entries) {
  _openRouterPrices = new Map(
    (Array.isArray(entries) ? entries : []).map((e) => [
      String(e.id),
      { inputPer1M: Number(e.inputPer1M) || 0, outputPer1M: Number(e.outputPer1M) || 0 },
    ]),
  );
}

/**
 * Look up per-model price for an OpenRouter model. Returns null if unknown.
 * @param {string} modelId
 * @returns {{ inputPer1M: number, outputPer1M: number } | null}
 */
export function getOpenRouterModelPrice(modelId) {
  const key = String(modelId ?? "").trim();
  return key && _openRouterPrices.has(key) ? _openRouterPrices.get(key) : null;
}

/**
 * @param {string} providerId
 * @param {number} promptTokens
 * @param {number} completionTokens
 * @param {string} [modelId]   — required for accurate OpenRouter per-model pricing
 */
export function estimateProviderUsd(providerId, promptTokens, completionTokens, modelId) {
  const p = Math.max(0, Number(promptTokens) || 0);
  const c = Math.max(0, Number(completionTokens) || 0);

  // Precise per-model pricing for OpenRouter
  if (providerId === "openrouter" && modelId) {
    const price = getOpenRouterModelPrice(modelId);
    if (price) {
      const inputUsd  = (p / 1_000_000) * price.inputPer1M;
      const outputUsd = (c / 1_000_000) * price.outputPer1M;
      return {
        inputUsd,
        outputUsd,
        totalUsd: inputUsd + outputUsd,
        tier: `${modelId} (per-model)`,
        inputPer1M: price.inputPer1M,
        outputPer1M: price.outputPer1M,
      };
    }
  }

  const r = ANALYTICS_USD_PER_1M[providerId];
  if (!r) return null;
  const inputUsd = (p / 1_000_000) * r.input;
  const outputUsd = (c / 1_000_000) * r.output;
  return {
    inputUsd,
    outputUsd,
    totalUsd: inputUsd + outputUsd,
    tier: r.tier,
    inputPer1M: r.input,
    outputPer1M: r.output,
  };
}

/**
 * @param {number | null | undefined} usd
 */
export function formatUsdEstimate(usd) {
  if (usd == null || !Number.isFinite(usd)) return "—";
  const x = Math.max(0, usd);
  if (x === 0) return "$0.00";
  if (x < 0.01) return `$${x.toFixed(4)}`;
  if (x < 1) return `$${x.toFixed(3)}`;
  return `$${x.toFixed(2)}`;
}
