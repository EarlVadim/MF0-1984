/**
 * Browser-safe semantic search for memory_graph_nodes — Layer 1.5.
 *
 * No server/DB imports. Works in both browser (via /api/llm proxy) and Node.
 *
 * Public API:
 *   embedTextViaProxy(text, openrouterKey)
 *     → Promise<Float32Array | null>
 *
 *   semanticCandidateIdsFromGraph(userQuery, nodes, openrouterKey, topK)
 *     → Promise<string[]>   ordered node IDs, most similar first
 *
 * The nodes array is the same { id, category, label, blob, embedding? } shape
 * that /api/memory-graph already returns. If a node has a pre-computed
 * `embedding` field (Float32Array or base64 string written by the server),
 * it is used directly — otherwise the node is skipped silently.
 */

const EMBED_MODEL    = "perplexity/pplx-embed-v1-4b";
//const EMBED_MODEL    = "nvidia/llama-nemotron-embed-vl-1b-v2:free";
const EMBED_TEXT_MAX = 2000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Cosine similarity. Returns 0 on zero-vector inputs or length mismatch.
 * @param {Float32Array} a
 * @param {Float32Array} b
 */
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Decode a node's embedding field to Float32Array.
 * Accepts: Float32Array (pass-through), ArrayBuffer, Buffer,
 *          base64 string (server writes raw LE bytes as base64).
 * Returns null if the field is missing or unrecognisable.
 * @param {unknown} raw
 * @returns {Float32Array | null}
 */
function decodeEmbedding(raw) {
  if (!raw) return null;

  // 1. JSON-serialized Node.js Buffer: { type: "Buffer", data: [...] }
  if (typeof raw === "object" && raw !== null && raw.type === "Buffer" && Array.isArray(raw.data)) {
    const bytes = new Uint8Array(raw.data);
    if (bytes.byteLength % 4 !== 0) return null;
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  }

  if (raw instanceof Float32Array) return raw;

  if (raw instanceof ArrayBuffer) {
    return raw.byteLength % 4 === 0 ? new Float32Array(raw) : null;
  }

  // 2. Node.js Buffer (if running in Node environment)
  if (typeof raw === "object" && raw !== null && raw.buffer instanceof ArrayBuffer) {
    if (raw.byteLength % 4 !== 0) return null;
    return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  }

  // 3. Base64 string (Server-side BLOB converted to base64)
  if (typeof raw === "string" && raw.length > 0) {
    try {
      const bin = atob(raw);
      if (bin.length % 4 !== 0) return null;
      const f32 = new Float32Array(bin.length / 4);
      const view = new DataView(f32.buffer);
      for (let i = 0; i < bin.length; i += 4) {
        // Читаем 4 байта и записываем как один float32
        const val = view.getFloat32(i, true); // true = little-endian (как пишет SQLite/Node)
        f32[i / 4] = val;
      }
      // На самом деле, правильнее просто прочитать байты в DataView:
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const floatArray = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      // Но чтобы 100% избежать RangeError из-за выравнивания:
      const result = new Float32Array(bin.length / 4);
      const dataView = new DataView(bytes.buffer);
      for(let i = 0; i < result.length; i++) {
        result[i] = dataView.getFloat32(bytes.byteOffset + i * 4, true);
      }
      return result;
    } catch (e) {
      return null;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Embed call — browser + Node compatible, always via proxy
// ---------------------------------------------------------------------------

/**
 * Call the OpenRouter embeddings endpoint.
 * In the browser the path goes through Vite proxy → server proxy (key injected server-side).
 * In Node the same server proxy is hit directly.
 *
 * @param {string} text
 * @param {string} openrouterKey  pass "server-proxy" when running in browser
 * @returns {Promise<Float32Array | null>}
 */
export async function embedTextViaProxy(text, openrouterKey) {
  const t = String(text ?? "").trim().slice(0, EMBED_TEXT_MAX);
  if (!t) return null;
  if (!openrouterKey) return null;

  try {
    const headers = /** @type {Record<string, string>} */ ({ "Content-Type": "application/json" });
    // When key is a real string (not "server-proxy"), inject it directly.
    // In browser the proxy does it; this path is for future direct-Node usage.
    if (openrouterKey !== "server-proxy") {
      headers["Authorization"] = `Bearer ${openrouterKey}`;
      headers["HTTP-Referer"]  = "http://localhost:1984";
      headers["X-Title"]       = "MF0-1984";
    }

    const res = await fetch("/api/llm/or-1/api/v1/embeddings", {
      method: "POST",
      headers,
      body: JSON.stringify({ model: EMBED_MODEL, input: t }),
    });

    if (!res.ok) {
      const msg = await res.text().catch(() => "");
      console.warn(`[semanticSearch] embed ${res.status}: ${msg.slice(0, 160)}`);
      return null;
    }

    const json = await res.json();
    const vector = json?.data?.[0]?.embedding;
    if (!Array.isArray(vector) || vector.length === 0) {
      console.warn("[semantic] embed response has no vector — json keys:", Object.keys(json ?? {}), "data[0] keys:", Object.keys(json?.data?.[0] ?? {}));
      return null;
    }
    console.log("[semantic] embed OK — dim:", vector.length);
    const f32 = new Float32Array(vector.length);
    for (let i = 0; i < vector.length; i++) f32[i] = vector[i];
    return f32;
  } catch (e) {
    console.warn("[semantic] embed error:", e?.message ?? e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public: semantic candidate IDs from an in-memory graph
// ---------------------------------------------------------------------------

/**
 * Embed the query and rank graph nodes by cosine similarity.
 *
 * Nodes that have a pre-computed `embedding` field (populated by the server
 * after each ingest) are scored directly without an extra API call.
 * Nodes without embeddings are silently skipped.
 *
 * @param {string} userQuery
 * @param {Array<{ id?: string, category?: string, label?: string, blob?: string, embedding?: unknown }>} nodes
 * @param {string} openrouterKey   "server-proxy" in browser, real key in Node
 * @param {number} [topK=20]
 * @returns {Promise<string[]>}
 */
export async function semanticCandidateIdsFromGraph(userQuery, nodes, openrouterKey, topK = 20) {
  const q = String(userQuery ?? "").trim();
  console.log("[semantic] start — query:", q.slice(0, 80), "| nodes:", nodes?.length, "| key:", openrouterKey?.slice(0, 12));

  if (!q || !Array.isArray(nodes) || nodes.length === 0) {
    console.log("[semantic] early exit — empty query or no nodes");
    return [];
  }

  // Decode embeddings and log per-node status
  const indexed = [];
  let nullCount = 0, missingCount = 0;
  for (const n of nodes) {
    const id = String(n.id ?? "").trim();
    if (!id) continue;
    if (!n.embedding) {
      missingCount++;
      continue;
    }
    const vec = decodeEmbedding(n.embedding);
    if (vec === null) {
      nullCount++;
      console.log("[semantic] decodeEmbedding failed for node:", id,
        "| embedding type:", typeof n.embedding,
        "| value sample:", typeof n.embedding === "string" ? n.embedding.slice(0, 20) : String(n.embedding).slice(0, 40));
    } else {
      indexed.push({ id, vec });
    }
  }
  console.log("[semantic] indexed:", indexed.length, "| missing embedding:", missingCount, "| decode failed:", nullCount);

  if (indexed.length === 0) {
    console.log("[semantic] no indexed nodes — returning []");
    return [];
  }

  // Embed the query
  console.log("[semantic] calling embedTextViaProxy…");
  const qVec = await embedTextViaProxy(q, openrouterKey);
  if (!qVec) {
    console.log("[semantic] embedTextViaProxy returned null — no query vector");
    return [];
  }
  console.log("[semantic] query vector dim:", qVec.length, "| sample:", qVec[0].toFixed(4), qVec[1].toFixed(4));

  // Dimension check
  const firstVec = indexed[0].vec;
  if (firstVec.length !== qVec.length) {
    console.log("[semantic] DIM MISMATCH — query:", qVec.length, "node:", firstVec.length, "— returning []");
    return [];
  }

  // Score and rank
  const scored = indexed
    .map((x) => ({ id: x.id, score: cosine(qVec, /** @type {Float32Array} */ (x.vec)) }))
    .sort((a, b) => b.score - a.score);

  const top = scored.slice(0, topK);
  console.log("[semantic] top", top.length, "results:", top.slice(0, 5).map(x => `${x.id.slice(0,8)}:${x.score.toFixed(3)}`).join(", "));

  return top.map((x) => x.id);
}
