/**
 * Local reranker via OLLAMA: pdurugyan/qwen3-reranker-0.6b-q8_0
 * Takes user query + passages, returns ranked list with relevance scores.
 */

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const RERANKER_MODEL = "pdurugyan/qwen3-reranker-0.6b-q8_0:latest";
const RERANK_TIMEOUT_MS = 30000;

/**
 * Call OLLAMA embeddings endpoint to get reranker scores.
 * @param {string} query - user query
 * @param {string[]} passages - list of passages to rank
 * @returns {Promise<Array<{ index: number, relevance_score: number }>>}
 */
export async function rerankPassages(query, passages) {
  if (!query || !Array.isArray(passages) || passages.length === 0) {
    console.warn("[localReranker] empty input");
    return [];
  }

  const validPassages = passages
    .map((p) => String(p ?? "").trim())
    .filter((p) => p.length > 0)
    .slice(0, 100); // Cap at 100 passages

  if (validPassages.length === 0) {
    console.warn("[localReranker] no valid passages after filtering");
    return [];
  }

  console.log(`[localReranker] reranking ${validPassages.length} passages…`);
  const start = Date.now();

  try {
    // Format: query [SEP] passage for each passage (standard reranker input)
    const pairs = validPassages.map((p) => `${query} [SEP] ${p}`);

    // Call OLLAMA embeddings endpoint
    const response = await fetch(`${OLLAMA_BASE_URL}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: RERANKER_MODEL,
        input: pairs,
        stream: false,
      }),
      signal: AbortSignal.timeout(RERANK_TIMEOUT_MS),
    });

    if (!response.ok) {
      console.error(`[localReranker] HTTP ${response.status}:`, response.statusText);
      return [];
    }

    const data = await response.json();
    if (!data.embeddings || !Array.isArray(data.embeddings)) {
      console.error("[localReranker] unexpected response format:", data);
      return [];
    }

    // Convert embeddings to scores (reranker returns single value per passage)
    // If multi-dim, use first dimension as relevance signal
    const ranked = data.embeddings
      .map((emb, index) => {
        // Single value or first element of array
        const score = Array.isArray(emb) ? emb[0] : emb;
        return {
          index,
          relevance_score: Math.max(0, Math.min(1, Number(score) || 0)),
        };
      })
      .sort((a, b) => b.relevance_score - a.relevance_score);

    const elapsed = Date.now() - start;
    console.log(
      `[localReranker] completed in ${elapsed}ms | top: #0:${Math.round(ranked[0]?.relevance_score * 100)}% #5:${Math.round(ranked[5]?.relevance_score * 100)}% #12:${Math.round(ranked[12]?.relevance_score * 100)}%`
    );

    return ranked;
  } catch (err) {
    const elapsed = Date.now() - start;
    console.error(`[localReranker] failed after ${elapsed}ms:`, err.message);
    return [];
  }
}
