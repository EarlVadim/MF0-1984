/**
 * Semantic embeddings for memory_graph_nodes — Layer 1.5.
 *
 * Model: perplexity/pplx-embed-v1-4b via the existing OpenRouter proxy.
 * Vector storage: embedding BLOB (raw Float32LE bytes) + embedding_model TEXT.
 *
 * Public API:
 *   embedText(text)                          → Float32Array | null
 *   upsertNodeEmbedding(nodeId, text)        → Promise<void>
 *   semanticCandidateIds(queryText, topK)    → Promise<string[]>
 *   scheduleNodeEmbedding(nodeId, text)      → void  (fire-and-forget)
 *   batchReindexMissingEmbeddings()          → Promise<{ done, failed }>
 *
 * Design notes:
 *   - embedText calls the server-side proxy, so the OpenRouter key never
 *     reaches the browser.
 *   - All heavy work is async and never blocks the turn pipeline.
 *   - If the embedding call fails the node is left with embedding=NULL;
 *     semanticCandidateIds gracefully skips nodes without a vector.
 */

// adapter is imported lazily inside functions to avoid the circular dependency:
// memoryGraph.mjs → memoryGraphEmbeddings.mjs → migrations.mjs → memoryGraph.mjs

/** @returns {Promise<import("../db/adapter.mjs").DbAdapter>} */
async function getAdapter() {
  const m = await import("../db/migrations.mjs");
  return m.adapter;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const EMBED_MODEL    = "perplexity/pplx-embed-v1-4b";
//const EMBED_MODEL    = "nvidia/llama-nemotron-embed-vl-1b-v2:free";
const EMBED_DIM      = 2048;          // pplx-embed-v1-4b output dimension
const EMBED_TEXT_MAX = 2000;          // chars sent to the model per node
const REINDEX_BATCH  = 40;            // nodes per batchReindex run
// Route through the first available OR slot proxy (or-1/or-2/or-3 → openrouter.ai)
const OPENROUTER_EMBED_PATH = "/api/llm/or-1/api/v1/embeddings";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the text we embed for a node: "Category / Label\n<first lines of blob>".
 * Keeping it short and structured gives better recall than dumping all blob text.
 * @param {string} category
 * @param {string} label
 * @param {string} blob
 * @returns {string}
 */
export function buildNodeEmbedText(category, label, blob) {
  const head = `${String(category ?? "").trim()} / ${String(label ?? "").trim()}`;
  const body = String(blob ?? "").trim().slice(0, EMBED_TEXT_MAX - head.length - 2);
  return body ? `${head}\n${body}` : head;
}

/**
 * Float32Array → Buffer (raw little-endian bytes).
 * @param {Float32Array} vec
 * @returns {Buffer}
 */
function vecToBuffer(vec) {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/**
 * Buffer → Float32Array.
 * @param {Buffer|null|undefined} buf
 * @returns {Float32Array|null}
 */
function bufferToVec(buf) {
  if (!buf || buf.length === 0) return null;
  // better-sqlite3 returns BLOBs as Buffer; make sure it's the right length
  if (buf.length % 4 !== 0) return null;
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/**
 * Cosine similarity between two Float32Arrays of equal length.
 * Returns 0 on zero-vector inputs.
 * @param {Float32Array} a
 * @param {Float32Array} b
 * @returns {number}
 */
function cosine(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// ---------------------------------------------------------------------------
// Embedding API call (server-side fetch through the existing proxy)
// ---------------------------------------------------------------------------

/**
 * Call the OpenRouter embeddings endpoint via the server proxy.
 * Returns a Float32Array or null on failure.
 *
 * NOTE: this is called from server-side code (api.mjs / ingest hooks),
 * so `fetch` is Node 18+ global fetch.
 *
 * @param {string} text
 * @returns {Promise<Float32Array|null>}
 */
export async function embedText(text) {
  const t = String(text ?? "").trim().slice(0, EMBED_TEXT_MAX);
  if (!t) return null;

  const apiKey = String(process.env.OPENROUTER_API_KEY ?? "").trim();
  if (!apiKey) {
    console.warn("[memoryGraphEmbeddings] OPENROUTER_API_KEY not set — skipping embed");
    return null;
  }

  try {
    // Use the real key directly — the proxy injects it from process.env when
    // Authorization is absent, but for server-to-server calls we inject it
    // ourselves so we don't depend on the proxy being up yet at cold-start.
    const res = await fetch(`http://127.0.0.1:${process.env.API_PORT ?? 1984}${OPENROUTER_EMBED_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "HTTP-Referer": String(process.env.OPENROUTER_REFERER ?? "http://localhost:1984"),
        "X-Title":      String(process.env.OPENROUTER_APP_TITLE ?? "MF0-1984"),
      },
      body: JSON.stringify({ 
        model: EMBED_MODEL, 
        input: t, 
        encoding_format: "float" 
      }),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => "");
      console.warn(`[memoryGraphEmbeddings] embed request failed ${res.status}: ${err.slice(0, 200)}`);
      return null;
    }

    const json = await res.json();
    const vector = json?.data?.[0]?.embedding;
    if (!Array.isArray(vector) || vector.length === 0) {
      console.warn("[memoryGraphEmbeddings] unexpected embedding response shape");
      return null;
    }

    return Float32Array.from(vector);
  } catch (e) {
    console.warn("[memoryGraphEmbeddings] embed error:", e?.message ?? e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// DB write
// ---------------------------------------------------------------------------

/**
 * Compute and persist embedding for a single node.
 * Silently no-ops if the node doesn't exist or embedding fails.
 * @param {string} nodeId
 * @param {string} embedText_  pre-built embed text (call buildNodeEmbedText first)
 * @returns {Promise<void>}
 */
export async function upsertNodeEmbedding(nodeId, embedText_) {
  const vec = await embedText(embedText_);
  if (!vec) return;
  const buf = vecToBuffer(vec);
  const adapter = await getAdapter();
  await adapter.run(
    `UPDATE memory_graph_nodes SET embedding = ?, embedding_model = ?, updated_at = ? WHERE id = ?`,
    [buf, EMBED_MODEL, new Date().toISOString(), nodeId],
  );
}

// ---------------------------------------------------------------------------
// Fire-and-forget scheduling (used in ingest hot path)
// ---------------------------------------------------------------------------

/**
 * Schedule an embedding update on the next event-loop tick.
 * Never throws, never blocks the caller.
 * @param {string} nodeId
 * @param {string} category
 * @param {string} label
 * @param {string} blob
 */
export function scheduleNodeEmbedding(nodeId, category, label, blob) {
  const text = buildNodeEmbedText(category, label, blob);
  setImmediate(async () => {
    try {
      await upsertNodeEmbedding(nodeId, text);
    } catch (e) {
      console.warn("[memoryGraphEmbeddings] schedule error:", e?.message ?? e);
    }
  });
}

// ---------------------------------------------------------------------------
// Batch reindex
// ---------------------------------------------------------------------------

/**
 * Find nodes missing an embedding (or produced by a different model) and index them.
 * Safe to call at startup or via the /api/memory-graph/reindex route.
 * @returns {Promise<{ done: number, failed: number }>}
 */
export async function batchReindexMissingEmbeddings() {
  const adapter = await getAdapter();
  const m = await import("../db/migrations.mjs");
  
  const total = await adapter.get(`SELECT count(*) as cnt FROM memory_graph_nodes`);
  console.log(`[CRITICAL DEBUG] Reindex DB Path: ${m.dbPath}`);
  console.log(`[CRITICAL DEBUG] Total nodes in DB: ${total?.cnt ?? 'N/A'}`);

  const tbl = await adapter.get(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='memory_graph_nodes'`,
  );
  if (!tbl) return { done: 0, failed: 0 };

  const rows = await adapter.all(
    `SELECT id, category, label, blob FROM memory_graph_nodes
     WHERE embedding IS NULL OR embedding_model != ?
     LIMIT ?`,
    [EMBED_MODEL, REINDEX_BATCH],
  );
  
  console.log(`[DEBUG] Reindex found ${rows.length} rows to process.`);

  let done = 0, failed = 0;
  for (const row of rows) {
    try {
      const text = buildNodeEmbedText(
        String(row.category ?? ""),
        String(row.label ?? ""),
        String(row.blob ?? ""),
      );
      await upsertNodeEmbedding(String(row.id), text);
      done++;
    } catch {
      failed++;
    }
  }
  return { done, failed };
}

// ---------------------------------------------------------------------------
// Semantic search — the actual Layer 1.5
// ---------------------------------------------------------------------------

/**
 * Find the top-K most semantically similar node IDs for a given query string.
 * Loads all embedded nodes into memory and ranks by cosine similarity.
 * For graphs up to ~10k nodes this is fast enough in-process (<5ms typically).
 *
 * Returns an empty array when:
 *   - no API key configured
 *   - embedding call fails
 *   - no nodes have embeddings yet
 *
 * @param {string} queryText
 * @param {number} [topK=20]
 * @returns {Promise<string[]>}  ordered node IDs, most similar first
 */
export async function semanticCandidateIds(queryText, topK = 20) {
  const q = String(queryText ?? "").trim();
  if (!q) return [];

  // Fetch all nodes that have an embedding
  const adapter = await getAdapter();
  const rows = await adapter.all(
    `SELECT id, embedding FROM memory_graph_nodes WHERE embedding IS NOT NULL`,
  );
  if (rows.length === 0) return [];

  // Embed the query
  const qVec = await embedText(q);
  if (!qVec) return [];

  // Score
  /** @type {Array<{ id: string, score: number }>} */
  const scored = [];
  for (const row of rows) {
    const vec = bufferToVec(/** @type {Buffer} */ (row.embedding));
    if (!vec || vec.length !== qVec.length) continue;
    scored.push({ id: String(row.id), score: cosine(qVec, vec) });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map((x) => x.id);
}
