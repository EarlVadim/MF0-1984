/**
 * Shared runtime price map for OpenRouter per-model pricing.
 * Populated at server startup from openrouter-models.txt (see api.mjs).
 * Consumed by analytics.mjs for cost estimation.
 *
 * Lives in its own file (no imports, no top-level await) so it can be
 * imported synchronously by any module including those with async init.
 *
 * @type {Map<string, { inputPer1M: number, outputPer1M: number }>}
 */
export const openRouterModelPriceMap = new Map();
