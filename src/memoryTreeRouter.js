/**
 * Pre-turn “router” model: reads the Memory tree and selects excerpts useful for the user’s next message.
 * Retrieval design aligned with Cyprus Discovery’s `routeMemoryForUserQuery` (hybrid lexical + 1-hop expand + JSON rerank),
 * adapted to MF0’s graph shape: nodes { id, category, label, blob }, links { source, target, label }.
 */

import { callLlm, usageWithFallback } from "./llmGateway.js";
import { semanticCandidateIdsFromGraph } from "./memoryGraphSemanticSearch.js";

/** First line of the supplement user message — must match fitContextToBudget detection. */
export const MF0_MEMORY_TREE_SUPPLEMENT_PREFIX =
  "<<< MF0_MEMORY_TREE_SUPPLEMENT (personal Memory tree excerpts for this request; not the user's literal message)";

/** Provider → default router/rerank model.
 *  Populated by fetchMemoryTreeSupplementForPrompt from Settings (fixed providers)
 *  and openrouter-models.json (OR slots) via the `routerModels` argument.
 *  Fixed providers can ONLY run their own model from Settings.
 *  OR slots can ONLY run OpenRouter models (from JSON editor).
 *  NEVER cross-contaminate: an OR model through a fixed provider, or vice versa.
 */
// (No hardcoded ROUTER_MODEL — all models come from Settings / JSON via caller.)

/** Models that use the native /v1/rerank API instead of chat completions. */
const NATIVE_RERANK_MODELS = new Set([
  "cohere/rerank-v3.5",
]);

/**
 * Returns true if the given model ID should use the native rerank API
 * (POST /v1/rerank with {query, documents, top_n}) instead of chat completions.
 * @param {string} modelId
 * @returns {boolean}
 */
function isNativeRerankModel(modelId) {
  const m = String(modelId ?? "").trim();
  if (!m) return false;
  if (NATIVE_RERANK_MODELS.has(m)) return true;
  // Also match by prefix for future model versions (e.g. cohere/rerank-v4)
  for (const prefix of NATIVE_RERANK_MODELS) {
    const base = prefix.replace(/-v[\d.]+$/, "");
    if (m.startsWith(base)) return true;
  }
  return false;
}

/** LLM rerank: same contract shape as Cyprus Discovery `MEMORY_ROUTE_RERANK_INSTRUCTION`. */
const MEMORY_TREE_RERANK_SYSTEM = `You receive USER_QUESTION and candidate nodes from the user's MF0 Memory graph.
Each candidate has: id, category, label, blobExcerpt (notes / facts — truncated).
The user may write in any language; category/label may use another language.

Return JSON only:
{"ids":["bestNodeId1","bestNodeId2",...],"rationale":"short reason"}

Rules:
- Choose up to 22 ids that best help answer the question.
- Use semantic relevance (intent + relation), not literal token overlap only.
- A node may still be relevant when blobExcerpt is short/empty if its category/label itself carries the needed fact.
- Favor factual coverage (lists, names, dates, constraints) over vague topical similarity.
- Use only ids from provided candidates.
- If no candidate is useful, return {"ids":[],"rationale":"none"}.
- No markdown code fences outside the JSON object.`;

const MEMORY_TREE_TITLE_SCAN_SYSTEM = `You receive USER_QUESTION and a chunk of Memory graph node titles (id, category, label).
The user may write in any language; titles may mix languages.

Return JSON only:
{"ids":["nodeId1","nodeId2",...],"rationale":"short reason"}

Rules:
- Pick node ids that may contain facts needed to answer the user question, using semantic intent — not literal word match only.
- Include ids whose category/label may serve as the answer even if no long note text is attached.
- Use only ids from the provided chunk.
- If none look relevant, return {"ids":[],"rationale":"none"}.
- No markdown code fences outside the JSON object.`;

const RERANK_MAX_OUT = 950;
const LEX_RETRIEVE_HAY = 2800;
const BLOB_EXCERPT_RERANK = 720;
const BLOB_SUPPLEMENT_EACH = 1800;
/** Timeout for a single rerank LLM call.  If the model doesn't respond within
 *  this window the attempt is aborted and the next fallback is tried.
 *  Aborted requests are typically not billed by the provider. */
const RERANK_CALL_TIMEOUT_MS = 15_000;
/** Max nodes embedded into the Memory-tree supplement (router + augment). */
const MAX_IDS = 22;
const EXPAND_ID_CAP = 220;
const RERANK_POOL_START = 72;
/** Graphs at or below this size: every node is eligible for rerank (then JSON is trimmed to the model budget). */
const GRAPH_FULL_NODES_FOR_RERANK = 320;
/** For compact trees, append global title index so name-only leaf nodes are always visible to the main model. */
const GRAPH_APPEND_TITLE_INDEX_MAX_NODES = 420;

/** Generic synonym expansion (not project-specific); mirrors Cyprus Discovery’s pattern. */
const QUERY_SYNONYMS = {
  threats: ["risk", "risks", "pressure", "pressures", "danger", "threats"],
  endangered: ["critical", "vulnerable", "decline", "endangered"],
  percentage: ["percent", "%", "ratio", "share", "quota"],
  annually: ["yearly", "per year", "annual"],
  production: ["manufacturing", "making", "process"],
  regulations: ["rules", "law", "legal", "requirement", "requirements"],
  population: ["group", "species", "community"],
};

function stripCodeFence(text) {
  const t = String(text).trim();
  const m = t.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/im);
  if (m) return m[1].trim();
  return t;
}

/**
 * @param {string} text
 * @returns {{ ids: string[], rationale: string }}
 */
function parseRouteIdsJson(text) {
  let ids = [];
  let rationale = "";
  try {
    const inner = stripCodeFence(text);
    const o = JSON.parse(inner || text);
    if (Array.isArray(o.ids)) ids = o.ids.map((x) => String(x).trim()).filter(Boolean);
    if (o.rationale != null) rationale = String(o.rationale).trim().slice(0, 500);
  } catch {
    /* ignore */
  }
  return { ids, rationale };
}

function normText(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}%.\- ]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {string} s
 * @returns {string[]}
 */
function tokenWords(s) {
  return normText(s)
    .split(" ")
    .map((x) => x.trim())
    .filter((x) => x.length >= 3);
}

/**
 * @param {string[]} words
 */
function expandWithSynonyms(words) {
  const out = new Set(words);
  for (const w of words) {
    if (!QUERY_SYNONYMS[w]) continue;
    for (const alt of QUERY_SYNONYMS[w]) out.add(alt);
  }
  return [...out];
}

/**
 * @param {string} text
 * @returns {string[]}
 */
function extractEntitySignals(text) {
  const raw = String(text ?? "");
  const out = [];
  const years = raw.match(/\b(19|20)\d{2}\b/g) || [];
  const perc = raw.match(/\b\d{1,3}(?:[.,]\d+)?\s?%/g) || [];
  out.push(...years, ...perc);
  return [...new Set(out.map((x) => x.trim()))];
}

/**
 * @param {Array<{ id: string, category: string, label: string, blobHay: string }>} rows
 * @param {string[]} queryTerms
 * @param {string[]} entitySignals
 * @returns {{ lexicalTop: string[], entityTop: string[], scoreById: Map<string, number> }}
 */
function retrieveLexicalAndEntity(rows, queryTerms, entitySignals) {
  const scoreById = new Map();
  const entityScoreById = new Map();
  for (const r of rows) {
    const hay = normText(`${r.category} ${r.label} ${r.blobHay}`);
    let lexical = 0;
    for (const q of queryTerms) {
      if (!q) continue;
      if (hay.includes(normText(q))) lexical += q.length >= 6 ? 2 : 1;
    }
    let entity = 0;
    const raw = `${r.category} ${r.label} ${r.blobHay}`;
    for (const sig of entitySignals) {
      if (sig && raw.includes(sig)) entity += 3;
    }
    if (lexical > 0) scoreById.set(r.id, lexical + entity);
    if (entity > 0) entityScoreById.set(r.id, entity);
  }
  const lexicalTop = [...scoreById.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 120)
    .map((x) => x[0]);
  const entityTop = [...entityScoreById.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 80)
    .map((x) => x[0]);
  return { lexicalTop, entityTop, scoreById };
}

/**
 * @param {unknown[]} links
 * @returns {Map<string, Set<string>>}
 */
function buildAdjacency(links) {
  const m = new Map();
  for (const e of links) {
    if (!e || typeof e !== "object") continue;
    const from = String(/** @type {{ source?: string }} */ (e).source ?? "").trim();
    const to = String(/** @type {{ target?: string }} */ (e).target ?? "").trim();
    if (!from || !to) continue;
    if (!m.has(from)) m.set(from, new Set());
    if (!m.has(to)) m.set(to, new Set());
    m.get(from)?.add(to);
    m.get(to)?.add(from);
  }
  return m;
}

/**
 * @param {string} q
 */
function queryTokens(q) {
  const s = String(q ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]+/gu, " ");
  const parts = s.split(/\s+/).filter((w) => w.length > 2);
  return [...new Set(parts)];
}

/**
 * @param {{ id?: string, category?: string, label?: string, blob?: string }} n
 * @param {string[]} tokens
 */
function nodeRelevanceScore(n, tokens) {
  const hay = `${String(n.category ?? "")} ${String(n.label ?? "")} ${String(n.blob ?? "").slice(0, 1200)}`.toLowerCase();
  let s = 0;
  for (const t of tokens) {
    if (t && hay.includes(t)) s += 2;
  }
  if (String(n.label ?? "").toLowerCase() === "user" && String(n.category ?? "").toLowerCase() === "people") s += 50;
  return s;
}

/**
 * Serialize graph for the router in compact skeleton form (legacy / diagnostics).
 * @param {{ nodes?: unknown[], links?: unknown[] }} graph
 * @param {string} userQuery
 * @param {{ maxTotalChars?: number }} [opts]
 */
export function serializeMemoryGraphForRouter(graph, userQuery, opts = {}) {
  const maxTotal = opts.maxTotalChars ?? 28000;
  const maxNodes = 240;
  const maxEdges = 320;
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const links = Array.isArray(graph?.links) ? graph.links : [];
  const tokens = queryTokens(userQuery);

  const scored = nodes
    .filter((x) => x && typeof x === "object")
    .map((n) => ({
      n,
      score: nodeRelevanceScore(
        /** @type {{ category?: string, label?: string, blob?: string }} */ (n),
        tokens,
      ),
    }));
  scored.sort((a, b) => b.score - a.score);

  const idToLine = new Map();
  for (const { n } of scored) {
    const id = String(n.id ?? "").trim();
    const cat = String(n.category ?? "").trim();
    const lab = String(n.label ?? "").trim();
    idToLine.set(id, `NODE id=${id || "?"} | ${cat || "?"} / ${lab || "?"}`);
  }

  /** @type {string[]} */
  const parts = [];
  parts.push("EDGES (source_node_id -> target_node_id : relation):");
  for (const e of links.slice(0, maxEdges)) {
    if (!e || typeof e !== "object") continue;
    parts.push(`${String(e.source ?? "").trim()} -> ${String(e.target ?? "").trim()} : ${String(e.label ?? "").trim()}`);
  }
  parts.push("\nNODES (most relevant first, then remainder):\n");

  let used = parts.join("\n").length;
  const seen = new Set();
  for (const { n } of scored.slice(0, maxNodes)) {
    const id = String(n.id ?? "").trim();
    const line = idToLine.get(id) ?? "";
    if (seen.has(id)) continue;
    seen.add(id);
    if (used + line.length + 2 > maxTotal) break;
    parts.push(line);
    used += line.length + 2;
  }

  if (scored.length > seen.size) {
    parts.push(`\n… (${scored.length - seen.size} further nodes omitted for size cap)`);
  }

  return parts.join("\n");
}

/**
 * Returns true if the model ID belongs to OpenRouter (contains a vendor/ prefix).
 * Fixed-provider models are bare names like "gpt-4o-mini", "gemini-2.0-flash",
 * "gemma4:31b-cloud". OpenRouter models always have a slash: "deepseek/deepseek-v4-flash",
 * "cohere/rerank-v3.5", etc.
 * @param {string} modelId
 * @returns {boolean}
 */
function isOpenRouterModel(modelId) {
  return String(modelId ?? "").includes("/");
}

/** Fixed providers — each can ONLY run its own model from Settings.
 *  OR slots (or-1, or-2, or-3) can ONLY run OpenRouter models from JSON. */
const FIXED_PROVIDER_IDS = new Set(["openai", "anthropic", "gemini-flash", "ollama"]);
const OR_SLOT_IDS = ["or-1", "or-2", "or-3"];

/**
 * Pick the best provider + key + model for MemRouter rerank.
 *
 * CRITICAL ARCHITECTURE RULES:
 *   - Fixed providers (openai, anthropic, gemini-flash, ollama) can ONLY run
 *     their own model from Settings. They CANNOT run OpenRouter models.
 *   - OR slots (or-1, or-2, or-3) can ONLY run OpenRouter models from JSON.
 *     They CANNOT run fixed-provider models.
 *   - Never cross-contaminate: an OR model through a fixed provider → 403/err.
 *
 * @param {Record<string, string>} allKeys — providerId → API key
 * @param {string[]} [analysisPriority] — ordered fixed-provider IDs for fallback
 * @param {string} activeProviderId — the currently active chat provider
 * @param {string} activeApiKey — API key for the active provider
 * @param {string} [rerankModelOverride] — explicit rerank model from Settings/JSON
 * @param {Record<string, string>} [routerModels] — providerId → default model mapping
 *   (from Settings for fixed providers, from JSON for OR slots)
 * @returns {{ providerId: string, key: string, model: string }}
 */
function pickRouterKey(allKeys, analysisPriority, activeProviderId, activeApiKey, rerankModelOverride, routerModels = {}) {
  const rm = routerModels ?? {};

  // ── If rerankModel is an OR model (has vendor/ prefix), it MUST go through an OR slot.
  // Fixed providers CANNOT run cross-vendor models.
  if (rerankModelOverride && isOpenRouterModel(rerankModelOverride)) {
    for (const pid of OR_SLOT_IDS) {
      const key = String(allKeys?.[pid] ?? "").trim();
      if (key) return { providerId: pid, key, model: rerankModelOverride };
    }
  }

  // ── If rerankModel is a fixed-provider model (no /), it MUST go through its provider.
  // Find the fixed provider whose default model matches.
  if (rerankModelOverride && !isOpenRouterModel(rerankModelOverride)) {
    // Try to match: the model belongs to a fixed provider
    for (const pid of FIXED_PROVIDER_IDS) {
      if (rm[pid] === rerankModelOverride) {
        const key = String(allKeys?.[pid] ?? "").trim();
        if (key) return { providerId: pid, key, model: rerankModelOverride };
      }
    }
    // Didn't match any fixed provider's default model — try active provider
    const activeKey = String(activeApiKey ?? "").trim();
    if (activeKey) return { providerId: activeProviderId, key: activeKey, model: rerankModelOverride };
  }

  // ── No rerankModelOverride: pick from priority list with their default models.
  // Fixed providers first (from chatAnalysisPriority).
  const preferred = Array.isArray(analysisPriority)
    ? analysisPriority
    : [...FIXED_PROVIDER_IDS];
  for (const pid of preferred) {
    const key = String(allKeys?.[pid] ?? "").trim();
    const model = rm[pid] || "";
    if (key && model) return { providerId: pid, key, model };
  }

  // ── Fallback: OR slots with their JSON model.
  for (const pid of OR_SLOT_IDS) {
    const key = String(allKeys?.[pid] ?? "").trim();
    const model = rm[pid] || "";
    if (key && model) return { providerId: pid, key, model };
  }

  // ── Last resort: active provider.
  const k = String(activeApiKey ?? "").trim();
  if (k && rm[activeProviderId]) return { providerId: activeProviderId, key: k, model: rm[activeProviderId] };

  return { providerId: "", key: "", model: "" };
}

/**
 * @param {string} providerId
 * @param {string} key
 * @param {string} systemPrompt
 * @param {string} userBlock
 * @param {number} maxOutTokens
 * @param {string} model — explicit model ID (from routerModels / rerankModelOverride)
 * @returns {Promise<{ text: string, usage: { promptTokens: number, completionTokens: number, totalTokens: number } }>}
 */
async function runRouterLlm(providerId, key, systemPrompt, userBlock, maxOutTokens, model) {
  const ub = String(userBlock).slice(0, 32000);
  const isGemini = String(providerId ?? "").toLowerCase().startsWith("gemini");
  const gatewayProvider = isGemini ? "gemini-flash" : providerId;
  if (!model) throw new Error(`Memory tree router: no model for provider ${providerId}`);
  console.log(`[memRouter] runRouterLlm — gateway=${gatewayProvider} · model=${model} · userBlock chars=${ub.length}`);

  // Abort after RERANK_CALL_TIMEOUT_MS so we don't hang on a slow/failing model
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), RERANK_CALL_TIMEOUT_MS);

  try {
    const result = await callLlm({
      provider: gatewayProvider,
      key,
      model,
      messages: [{ role: "user", content: ub }],
      system: systemPrompt,
      temperature: 0.12,
      maxTokens: maxOutTokens,
      disableSearch: ["ollama", "or-1", "or-2", "or-3"].includes(providerId),
      requestKind: null,
      promptBasis: `${systemPrompt}\n\n${ub}`,
      abortSignal: ac.signal,
    });
    return result;
  } catch (llmErr) {
    const isTimeout = llmErr instanceof DOMException && llmErr.name === "AbortError";
    const errMsg = isTimeout
      ? `timeout after ${RERANK_CALL_TIMEOUT_MS}ms`
      : (llmErr instanceof Error ? llmErr.message : String(llmErr));
    console.warn(`[memRouter] runRouterLlm FAILED — gateway=${gatewayProvider} · model=${model} · error=${errMsg}`);
    throw new Error(`Rerank LLM call failed (provider=${gatewayProvider}, model=${model}): ${errMsg}`);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Call a native rerank API (e.g. Cohere rerank-v3.5) via OpenRouter proxy.
 * Unlike runRouterLlm which uses chat completions, this uses POST /v1/rerank
 * with { model, query, documents, top_n } and returns relevance-scored indices.
 *
 * @param {string} providerId  e.g. "or-1" — used to build proxy path
 * @param {string} key         API key for the provider
 * @param {string} model       e.g. "cohere/rerank-v3.5"
 * @param {string} userQuery   The user's query text
 * @param {Array<{ id: string, category: string, label: string, blobExcerpt: string }>} pool
 *   Candidate nodes to rank
 * @param {number} topN        How many top results to return
 * @returns {Promise<{ ids: string[], scores: number[], usage: { promptTokens: number, completionTokens: number, totalTokens: number } }>}
 */
async function runNativeRerank(providerId, key, model, userQuery, pool, topN = 22) {
  // Build documents array from pool — each doc is a human-readable string
  const documents = pool.map((c) => {
    const parts = [`${c.category} / ${c.label}`];
    if (c.blobExcerpt) parts.push(c.blobExcerpt);
    return parts.join(": ");
  });

  console.log(`[memRouter] runNativeRerank — provider=${providerId} · model=${model} · docs=${documents.length} · topN=${topN}`);

  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), RERANK_CALL_TIMEOUT_MS);

  try {
    // Proxy path: /api/llm/or-1/api/v1/rerank → https://openrouter.ai/api/v1/rerank
    const proxyPath = `/api/llm/${providerId}/api/v1/rerank`;
    const res = await fetch(proxyPath, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        query: userQuery.slice(0, 8000),
        documents,
        top_n: Math.min(topN, documents.length),
      }),
      signal: ac.signal,
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => res.statusText);
      throw new Error(`Rerank API returned ${res.status}: ${String(errBody).slice(0, 200)}`);
    }

    const json = await res.json();

    // Validate response structure
    if (!json || !Array.isArray(json.results)) {
      throw new Error(`Unexpected rerank response: ${JSON.stringify(json).slice(0, 200)}`);
    }

    // Map results back to pool ids
    const ids = [];
    const scores = [];
    for (const r of json.results) {
      const idx = typeof r.index === "number" ? r.index : -1;
      if (idx >= 0 && idx < pool.length) {
        ids.push(pool[idx].id);
        scores.push(typeof r.relevance_score === "number" ? r.relevance_score : 0);
      }
    }

    const usage = {
      promptTokens: json.meta?.tokens?.input_tokens ?? documents.length,
      completionTokens: json.meta?.tokens?.output_tokens ?? 0,
      totalTokens: (json.meta?.tokens?.input_tokens ?? documents.length) + (json.meta?.tokens?.output_tokens ?? 0),
    };

    console.log(`[memRouter] runNativeRerank OK — ids=${ids.length} · top score=${scores[0]?.toFixed(3) ?? "?"} · usage in=${usage.promptTokens}`);
    return { ids, scores, usage };
  } catch (err) {
    const isTimeout = err instanceof DOMException && err.name === "AbortError";
    const errMsg = isTimeout
      ? `timeout after ${RERANK_CALL_TIMEOUT_MS}ms`
      : (err instanceof Error ? err.message : String(err));
    console.warn(`[memRouter] runNativeRerank FAILED — model=${model} · error=${errMsg}`);
    throw new Error(`Native rerank call failed (model=${model}): ${errMsg}`);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Shrink rerank candidate list until JSON fits provider context budget.
 * @param {unknown[]} pool
 * @param {string} userQuery
 * @param {number} maxJsonChars
 */
function trimRerankPoolByJsonSize(pool, userQuery, maxJsonChars) {
  let p = [...pool];
  const header = `USER_QUESTION:\n${String(userQuery ?? "").trim().slice(0, 8000)}\n\nCANDIDATES_JSON:\n`;
  while (p.length > 6) {
    const payload = header + JSON.stringify(p);
    if (payload.length <= maxJsonChars) break;
    p = p.slice(0, p.length - 4);
  }
  return p;
}

/**
 * Split rows into title chunks so every node can be seen by the router.
 * @param {Array<{ id: string, category: string, label: string }>} rows
 * @param {number} [maxChars]
 */
function buildTitleChunks(rows, maxChars = 10_000) {
  /** @type {Array<Array<{ id: string, category: string, label: string }>>} */
  const chunks = [];
  /** @type {Array<{ id: string, category: string, label: string }>} */
  let cur = [];
  let used = 0;
  for (const r of rows) {
    const line = `${r.id} | ${r.category} | ${r.label}`;
    const add = line.length + 2;
    if (cur.length > 0 && used + add > maxChars) {
      chunks.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(r);
    used += add;
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

/**
 * Phase 1: scan all node titles in chunks and collect potentially relevant ids.
 * @param {string} providerId
 * @param {string} key
 * @param {string} userQuery
 * @param {Array<{ id: string, category: string, label: string }>} rows
 */
async function selectCandidateIdsByTitleChunks(providerId, key, model, userQuery, rows) {
  const chunks = buildTitleChunks(rows);
  /** @type {Set<string>} */
  const out = new Set();
  /** @type {string[]} */
  const rationales = [];
  let usageSum = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  for (const chunk of chunks) {
    const userBlock =
      `USER_QUESTION:\n${String(userQuery ?? "").trim().slice(0, 8000)}\n\nNODE_TITLES_CHUNK_JSON:\n` +
      JSON.stringify(chunk);
    const { text, usage } = await runRouterLlm(
      providerId,
      key,
      MEMORY_TREE_TITLE_SCAN_SYSTEM,
      userBlock,
      450,
      model,
    );
    const parsed = parseRouteIdsJson(String(text ?? ""));
    const allowed = new Set(chunk.map((x) => x.id));
    for (const id of parsed.ids) {
      if (allowed.has(id)) out.add(id);
    }
    if (parsed.rationale) rationales.push(parsed.rationale);
    const usageSafe = usageWithFallback(
      usage,
      `${MEMORY_TREE_TITLE_SCAN_SYSTEM}\n\n${userBlock}`,
      text,
    );
    usageSum = {
      promptTokens: usageSum.promptTokens + usageSafe.promptTokens,
      completionTokens: usageSum.completionTokens + usageSafe.completionTokens,
      totalTokens: usageSum.totalTokens + usageSafe.totalTokens,
    };
  }
  return { ids: [...out], rationale: rationales.filter(Boolean).slice(0, 2).join(" | "), usage: usageSum };
}

/**
 * @param {Map<string, unknown>} byId
 * @param {string[]} validIds
 * @param {string} rationale
 */
function buildSupplementFromNodes(byId, validIds, rationale) {
  const lines = [];
  lines.push("ROUTER_FOCUS (Memory graph — hybrid retrieve + rerank):");
  if (rationale) lines.push(String(rationale).trim());
  lines.push(
    "When a section shows (no notes in this node), the `### category / label` line alone may still be the stored canonical name (common for leaf entity nodes).",
  );
  lines.push("");
  let used = lines.join("\n").length;
  const cap = 24_000;
  // Keep router/graph rank order; relevance is encoded in `validIds`.
  for (const id of validIds) {
    const n = byId.get(id);
    if (!n || typeof n !== "object") continue;
    const cat = String(/** @type {{ category?: string }} */ (n).category ?? "").trim();
    const lab = String(/** @type {{ label?: string }} */ (n).label ?? "").trim();
    const blob = String(/** @type {{ blob?: string }} */ (n).blob ?? "").trim().slice(0, BLOB_SUPPLEMENT_EACH);
    // Skip nodes that have neither label nor blob
    if (!lab && !blob) continue;
    // Emit header only for leaf/empty nodes (saves ~20 tokens each); keep header+blob for notes
    const sec = blob
      ? [`### ${cat || "?"} / ${lab || "?"}`, blob, ""].join("\n")
      : `### ${cat || "?"} / ${lab || "?"}\n`;
    if (used + sec.length > cap) break;
    lines.push(sec);
    used += sec.length;
  }
  return lines.join("\n").trim();
}

/**
 * Build compact title index over all nodes (for small graphs).
 * @param {Array<{ id: string, category: string, label: string }>} rows
 * @param {number} [maxChars]
 * @returns {string}
 */
function buildAllNodeTitleIndex(rows, maxChars = 8_000) {
  if (!Array.isArray(rows) || rows.length === 0) return "";
  const lines = ["=== MEMORY GRAPH TITLE INDEX (all nodes, compact) ==="];
  let used = lines[0].length + 1;
  const sorted = [...rows].sort((a, b) => {
    const pa = `${a.category} / ${a.label}`;
    const pb = `${b.category} / ${b.label}`;
    return pa.localeCompare(pb, undefined, { sensitivity: "base" });
  });
  for (const r of sorted) {
    const line = `- ${r.category} / ${r.label}`;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n").trim();
}

/**
 * Expand selected ids along graph edges (2 hops), then rank nearby nodes so label-only facts are not dropped.
 * Universal graph heuristic: many names live in short/empty-note leaf nodes a hop or two away from a hub.
 * @param {string[]} ids
 * @param {Map<string, unknown>} byId
 * @param {unknown[]} links
 * @param {number} [cap]
 */
/**
 * Add every direct neighbor of the current id set (reaches parent hubs from leaf picks).
 * @param {string[]} ids
 * @param {Map<string, unknown>} byId
 * @param {unknown[]} links
 */
function expandOneGraphHop(ids, byId, links) {
  const adj = buildAdjacency(links);
  const out = new Set(ids.filter((id) => byId.has(id)));
  for (const id of [...out]) {
    for (const nb of adj.get(id) ?? []) {
      if (byId.has(nb)) out.add(nb);
    }
  }
  return [...out];
}

/**
 * Iteratively attach all neighbors of hub-like nodes (many incident edges), so sibling leaves are not split.
 * Degree bounds avoid exploding on mega-hubs in huge graphs.
 * @param {string[]} ids
 * @param {Map<string, unknown>} byId
 * @param {unknown[]} links
 */
function fullyExpandHubNeighbors(ids, byId, links, hardCap = 60) {
  const adj = buildAdjacency(links);
  const out = new Set(ids.filter((id) => byId.has(id)));
  const degMin = 2;
  const degMax = 160;
  let changed = true;
  while (changed) {
    changed = false;
    if (out.size >= hardCap) break;
    for (const id of [...out]) {
      if (out.size >= hardCap) break;
      const deg = Number(adj.get(id)?.size || 0);
      if (deg < degMin || deg > degMax) continue;
      for (const nb of adj.get(id) ?? []) {
        if (!byId.has(nb) || out.has(nb)) continue;
        out.add(nb);
        changed = true;
        if (out.size >= hardCap) break;
      }
    }
  }
  return [...out];
}

/**
 * Keep anchor ids first, then fill remaining slots with graph-ranked ids.
 * @param {string[]} expandedIds
 * @param {string[]} anchorIds
 * @param {Map<string, unknown>} byId
 * @param {unknown[]} links
 * @param {number} cap
 */
function capExpandedWithAnchors(expandedIds, anchorIds, byId, links, cap) {
  const expandedSet = new Set(expandedIds.filter((id) => byId.has(id)));
  const out = [];
  for (const id of anchorIds) {
    if (!expandedSet.has(id)) continue;
    if (out.includes(id)) continue;
    out.push(id);
    if (out.length >= cap) return out.slice(0, cap);
  }
  const rest = [...expandedSet].filter((id) => !out.includes(id));
  const ranked = augmentIdsWithNeighborLeaves(rest, byId, links, cap);
  for (const id of ranked) {
    if (out.length >= cap) break;
    if (!out.includes(id)) out.push(id);
  }
  return out.slice(0, cap);
}

function augmentIdsWithNeighborLeaves(ids, byId, links, cap = MAX_IDS) {
  const adj = buildAdjacency(links);
  const seeds = ids.filter((id) => byId.has(id));
  const out = new Set(seeds);
  let frontier = [...seeds];
  const maxHops = 3;
  const softCap = Math.min(cap * 5, 220);
  for (let hop = 0; hop < maxHops; hop++) {
    const next = [];
    for (const baseId of frontier) {
      for (const nid of adj.get(baseId) ?? []) {
        if (out.has(nid) || !byId.has(nid)) continue;
        out.add(nid);
        next.push(nid);
        if (out.size >= softCap) break;
      }
      if (out.size >= softCap) break;
    }
    frontier = next;
    if (!frontier.length) break;
  }

  const ranked = [...out].map((id) => {
    const deg = Number(adj.get(id)?.size || 0);
    const n = byId.get(id);
    const blobLen = String(/** @type {{ blob?: string }} */ (n)?.blob ?? "").trim().length;
    const labelLen = String(/** @type {{ label?: string }} */ (n)?.label ?? "").trim().length;
    const leaf = deg <= 1 ? 1 : 0;
    const shortBlob = blobLen <= 40 ? 1 : 0;
    const seedPrio = seeds.includes(id) ? 1 : 0;
    return { id, seedPrio, leaf, shortBlob, labelLen, blobLen };
  });
  ranked.sort((a, b) => {
    if (b.seedPrio !== a.seedPrio) return b.seedPrio - a.seedPrio;
    if (b.leaf !== a.leaf) return b.leaf - a.leaf;
    if (b.shortBlob !== a.shortBlob) return b.shortBlob - a.shortBlob;
    if (b.labelLen !== a.labelLen) return b.labelLen - a.labelLen;
    if (b.blobLen !== a.blobLen) return b.blobLen - a.blobLen;
    return a.id.localeCompare(b.id, undefined, { sensitivity: "base" });
  });
  return ranked.map((x) => x.id).slice(0, cap);
}

/**
 * Deterministic fallback when router LLM is unavailable or returns no ids.
 * Guarantees some Memory graph evidence reaches the main model.
 * @param {Map<string, unknown>} byId
 * @param {Array<{ id: string, category: string, label: string, blobHay: string }>} rows
 * @param {unknown[]} links
 * @param {string} userQuery
 */
function buildDeterministicSupplement(byId, rows, links, userQuery) {
  const tokens = [
    ...new Set([
      ...queryTokens(userQuery),
      ...tokenWords(userQuery),
    ]),
  ].filter(Boolean);
  const entitySignals = extractEntitySignals(userQuery);
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const adj = buildAdjacency(links);
  const scored = rows
    .map((r) => {
      const hay = `${r.category} ${r.label} ${r.blobHay}`;
      let lexical = 0;
      for (const t of tokens) {
        if (!t) continue;
        if (normText(hay).includes(normText(t))) lexical += t.length >= 6 ? 2 : 1;
      }
      let entity = 0;
      for (const sig of entitySignals) {
        if (sig && hay.includes(sig)) entity += 3;
      }
      return { id: r.id, score: lexical + entity };
    })
    .sort((a, b) => b.score - a.score);

  /** @type {string[]} */
  let ids = scored.filter((x) => x.score > 0).map((x) => x.id).slice(0, MAX_IDS);

  // Expand via 1-hop to catch list nodes connected to matched project/title nodes.
  if (ids.length > 0) {
    const exp = new Set(ids);
    for (const id of ids) {
      const ns = adj.get(id);
      if (!ns) continue;
      for (const nId of ns) {
        if (exp.size >= MAX_IDS * 2) break;
        exp.add(nId);
      }
    }
    ids = [...exp]
      .filter((id) => byId.has(id))
      .sort((a, b) => {
        const sa = Number(scored.find((x) => x.id === a)?.score || 0);
        const sb = Number(scored.find((x) => x.id === b)?.score || 0);
        if (sb !== sa) return sb - sa;
        return String(rowById.get(b)?.blobHay ?? "").length - String(rowById.get(a)?.blobHay ?? "").length;
      })
      .slice(0, MAX_IDS);
  }

  // If no lexical/entity matches at all, include richest notes so model still sees real stored facts.
  if (ids.length === 0) {
    ids = [...rows]
      .sort((a, b) => String(b.blobHay ?? "").length - String(a.blobHay ?? "").length)
      .map((r) => r.id)
      .filter((id) => byId.has(id))
      .slice(0, MAX_IDS);
  }

  const oneHop = [...new Set(expandOneGraphHop(ids, byId, links))];
  const detCap = Math.min(40, Math.max(ids.length * 3, 20));
  ids = fullyExpandHubNeighbors(oneHop, byId, links, detCap);
  if (ids.length > detCap) {
    ids = capExpandedWithAnchors(ids, oneHop, byId, links, detCap);
  }

  return buildSupplementFromNodes(
    byId,
    ids,
    "deterministic fallback: memory-graph lexical/entity + neighbor expansion.",
  );
}

/**
 * Deterministic Memory graph supplement (no LLM). Used when the router fails or returns nothing.
 * @param {{ nodes?: unknown[], links?: unknown[] }} graph
 * @param {string} userQuery
 * @returns {string}
 */
export function buildMemoryTreeDeterministicSupplement(graph, userQuery) {
  const g = graph && typeof graph === "object" ? graph : { nodes: [], links: [] };
  const rawNodes = Array.isArray(g.nodes) ? g.nodes : [];
  const links = Array.isArray(g.links) ? g.links : [];
  const q = String(userQuery ?? "").trim();
  if (!q || rawNodes.length === 0) return "";

  /** @type {Map<string, unknown>} */
  const byId = new Map();
  /** @type {Array<{ id: string, category: string, label: string, blobHay: string }>} */
  const rows = [];
  for (const raw of rawNodes) {
    if (!raw || typeof raw !== "object") continue;
    const id = String(/** @type {{ id?: string }} */ (raw).id ?? "").trim();
    if (!id) continue;
    const category = String(/** @type {{ category?: string }} */ (raw).category ?? "").trim();
    const label = String(/** @type {{ label?: string }} */ (raw).label ?? "").trim();
    const blob = String(/** @type {{ blob?: string }} */ (raw).blob ?? "").trim();
    if (!label) continue;
    byId.set(id, raw);
    rows.push({
      id,
      category,
      label,
      blobHay: blob.slice(0, LEX_RETRIEVE_HAY),
    });
  }
  if (rows.length === 0) return "";
  return buildDeterministicSupplement(byId, rows, links, q);
}

/**
 * @typedef {{ provider_id: string, promptTokens: number, completionTokens: number, totalTokens: number }} MemoryTreeRouterAnalytics
 */

/**
 * Title-scan chunks + optional rerank call; one aggregate for aux `memory_tree_router`.
 * @param {string} providerId
 * @param {{ usage?: { promptTokens: number, completionTokens: number, totalTokens: number } }} titleScan
 * @param {{ promptTokens: number, completionTokens: number, totalTokens: number } | null | undefined} rerankUsage
 * @param {string} rerankPromptForFallback
 * @param {string} rerankCompletionText
 * @returns {MemoryTreeRouterAnalytics | null}
 */
function buildMemoryTreeRouterAnalytics(
  providerId,
  titleScan,
  rerankUsage,
  rerankPromptForFallback,
  rerankCompletionText,
) {
  const ts = titleScan?.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const rerankPart =
    rerankUsage != null
      ? usageWithFallback(rerankUsage, rerankPromptForFallback, rerankCompletionText)
      : { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const promptTokens = rerankPart.promptTokens + Number(ts.promptTokens || 0);
  const completionTokens = rerankPart.completionTokens + Number(ts.completionTokens || 0);
  const totalTokens = rerankPart.totalTokens + Number(ts.totalTokens || 0);
  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) return null;
  return { provider_id: providerId, promptTokens, completionTokens, totalTokens };
}

/**
 * @param {{
 *   userQuery: string,
 *   graph: { nodes?: unknown[], links?: unknown[] },
 *   allKeys: Record<string, string>,
 *   analysisPriority?: string[],
 *   activeProviderId: string,
 *   activeApiKey: string,
 *   dialogId?: string,
 *   rerankModelOverride?: string,
 *   routerModels?: Record<string, string>,
 * }} args
 * routerModels: { providerId → default model } from Settings (fixed providers)
 * and openrouter-models.json (OR slots). REQUIRED — no hardcoded fallbacks.
 * @returns {Promise<{ supplement: string, memoryTreeRouterAnalytics: MemoryTreeRouterAnalytics | null }>}
 */
export async function fetchMemoryTreeSupplementForPrompt(args) {
  const userQuery = String(args.userQuery ?? "").trim();
  const graph = args.graph && typeof args.graph === "object" ? args.graph : { nodes: [], links: [] };
  const rawNodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const links = Array.isArray(graph.links) ? graph.links : [];
  console.log(`[memRouter] fetchMemoryTreeSupplementForPrompt — query chars=${userQuery.length} · rawNodes=${rawNodes.length} · links=${links.length}`);
  if (!userQuery || rawNodes.length === 0) {
    console.log(`[memRouter] EARLY RETURN #1 — userQuery empty=${!userQuery} · rawNodes empty=${rawNodes.length === 0}`);
    return {
      supplement: "",
      memoryTreeRouterAnalytics: null,
      routerDiag: { path: "early-1", reason: !userQuery ? "no user query" : "empty graph", rawNodes: rawNodes.length },
    };
  }

  // rerankModelOverride: for OR slots comes from openrouter-models.json via chatApi;
  // for other providers comes from localStorage via getRerankModel() in main.js
  const rerankModel = String(args.rerankModelOverride ?? "").trim();

  // routerModels: { providerId → default model } from Settings (fixed providers)
  // and JSON (OR slots). This replaces the old hardcoded ROUTER_MODEL constant.
  const routerModels = args.routerModels ?? {};

  const picked = pickRouterKey(
    args.allKeys ?? {},
    args.analysisPriority,
    args.activeProviderId,
    args.activeApiKey,
    rerankModel,
    routerModels,
  );
  const providerId = picked.providerId;
  const key = picked.key;
  const _rerankModel = picked.model || "(none)";
  console.log(`[memRouter] pickRouterKey result — providerId=${providerId || "(none)"} · key=${key ? "present" : "MISSING"} · model=${_rerankModel}`);

  /** @type {Map<string, unknown>} */
  const byId = new Map();
  /** @type {Array<{ id: string, category: string, label: string, blobHay: string }>} */
  const rows = [];
  for (const raw of rawNodes) {
    if (!raw || typeof raw !== "object") continue;
    const id = String(/** @type {{ id?: string }} */ (raw).id ?? "").trim();
    if (!id) continue;
    const category = String(/** @type {{ category?: string }} */ (raw).category ?? "").trim();
    const label = String(/** @type {{ label?: string }} */ (raw).label ?? "").trim();
    const blob = String(/** @type {{ blob?: string }} */ (raw).blob ?? "").trim();
    if (!label) continue;
    byId.set(id, raw);
    rows.push({
      id,
      category,
      label,
      blobHay: blob.slice(0, LEX_RETRIEVE_HAY),
    });
  }
  if (rows.length === 0) {
    console.log(`[memRouter] EARLY RETURN #2 — rows empty after filtering (rawNodes had ${rawNodes.length} items)`);
    return {
      supplement: "",
      memoryTreeRouterAnalytics: null,
      routerDiag: { path: "early-2", reason: "no valid rows after filtering (no id or label)", rawNodes: rawNodes.length },
    };
  }
  console.log(`[memRouter] after row build — rows=${rows.length} · providerId=${providerId || "(none)"} · key=${key ? "present" : "MISSING"}`);
  if (!providerId || !key) {
    console.log(`[memRouter] EARLY RETURN #3 — no provider/key for router LLM — using deterministic fallback`);
    const det0 = buildDeterministicSupplement(byId, rows, links, userQuery);
    const _diag3 = {
      path: "early-3",
      reason: "no provider/key for router LLM — pickRouterKey returned empty",
      pickedProviderId: providerId || "(none)",
      pickedKeyPresent: Boolean(key),
      activeProviderId: args.activeProviderId || "(none)",
      activeApiKeyPresent: Boolean(String(args.activeApiKey ?? "").trim()),
      analysisPriority: Array.isArray(args.analysisPriority) ? args.analysisPriority.join(",") : "(default)",
      allKeysAvailable: Object.keys(args.allKeys ?? {}).filter(k => String(args.allKeys?.[k] ?? "").trim()).join(",") || "(none)",
    };
    if (rows.length <= GRAPH_APPEND_TITLE_INDEX_MAX_NODES) {
      const idx0 = buildAllNodeTitleIndex(rows, 8_000);
      return {
        supplement: [det0, idx0].filter(Boolean).join("\n\n").trim(),
        memoryTreeRouterAnalytics: null,
        routerDiag: _diag3,
      };
    }
    return { supplement: det0, memoryTreeRouterAnalytics: null, routerDiag: _diag3 };
  }

  const subqueries = [userQuery];
  const queryTerms = expandWithSynonyms(
    [
      ...new Set([
        ...subqueries.flatMap((q) => tokenWords(q)),
        ...queryTokens(userQuery),
      ]),
    ]
      .filter(Boolean)
      .slice(0, 120),
  );
  const entitySignals = [...new Set(subqueries.flatMap((q) => extractEntitySignals(q)))];
  const { lexicalTop, entityTop, scoreById } = retrieveLexicalAndEntity(rows, queryTerms, entitySignals);
  console.log(`[memRouter] lexical — terms=${queryTerms.length} · top=${lexicalTop.length} · entityTop=${entityTop.length}`);

  // ── Layer 1.5: semantic candidates via pplx-embed-v1-4b ──────────────────
  // Run BEFORE small-graph full-expansion so semantic scores can influence
  // pool ordering even when all nodes are already in expandedIds.
  /** @type {Map<string, number>} node id → cosine similarity rank (topK … 1, higher = better) */
  const semanticScoreById = new Map();
  /** @type {string[]} ids that came ONLY from semantic layer (not in lexical/titleScan yet) */
  const semanticOnlyIds = [];
  try {
    const orKey = String(
      args.allKeys?.["or-1"] || args.allKeys?.["or-2"] || args.allKeys?.["or-3"] || ""
    ).trim();
    console.log(`[memRouter] semantic layer — orKey=${orKey ? "present (" + orKey.slice(0,12) + "...)" : "MISSING"} · rawNodes with embedding check…`);
    if (orKey) {
      const nodesWithEmbedding = rawNodes.filter(n => n && typeof n === "object" && n.embedding).length;
      console.log(`[memRouter] semantic layer — nodesWithEmbedding=${nodesWithEmbedding} / ${rawNodes.length}`);
      const semanticIds = await semanticCandidateIdsFromGraph(
        userQuery,
        rawNodes,
        orKey,
        20,
      );
      console.log(`[memRouter] semantic layer returned ${semanticIds.length} candidate ids`);
      // Assign rank-based scores: top result gets score = topK, last gets 1
      const n = semanticIds.length;
      semanticIds.forEach((id, idx) => {
        semanticScoreById.set(id, n - idx);
      });
    } else {
      console.log(`[memRouter] semantic layer SKIPPED — no OpenRouter key available`);
    }
  } catch (semErr) {
    console.warn(`[memRouter] semantic layer ERROR: ${semErr instanceof Error ? semErr.message : String(semErr)}`);
    // non-critical — lexical+LLM path continues
  }
  // ── End Layer 1.5 pre-pass ────────────────────────────────────────────────

  /** Small graphs: scan every node. Large graphs: lexical/entity seeds + 1-hop neighbors (Cyprus-style). */
  /** @type {Set<string>} */
  let expandedIds;
  if (rows.length <= GRAPH_FULL_NODES_FOR_RERANK) {
    expandedIds = new Set(rows.map((r) => r.id));
    console.log(`[memRouter] small graph (≤${GRAPH_FULL_NODES_FOR_RERANK}) — all ${rows.length} nodes eligible`);
  } else {
    const adj = buildAdjacency(links);
    let seedIds = [...new Set([...lexicalTop.slice(0, 80), ...entityTop.slice(0, 40)])];
    if (seedIds.length === 0) {
      seedIds = rows.map((r) => r.id).slice(0, 120);
    }
    expandedIds = new Set(seedIds);
    for (const id of seedIds) {
      const neighbors = adj.get(id);
      if (!neighbors) continue;
      for (const nId of neighbors) {
        if (expandedIds.size >= EXPAND_ID_CAP) break;
        expandedIds.add(nId);
      }
    }
    console.log(`[memRouter] large graph — seed=${seedIds.length} → expanded=${expandedIds.size}`);
  }

  // Phase 1 (fast): lexical/entity + 1-hop, skip expensive title-chunk LLM calls
  // (title-level coverage is already handled by semantic layer + final rerank)
  const titleScan = { ids: [], rationale: "lexical/entity expansion (title-chunk LLM skipped for speed)", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
  for (const id of titleScan.ids) expandedIds.add(id);
  const sizeAfterLexAndTitle = expandedIds.size;
  console.log(`[memRouter] after lex+title+semantic — expandedIds=${sizeAfterLexAndTitle} · semanticOnly=${semanticOnlyIds.length}`);

  // ── Layer 1.5 post-pass: register semantic-only newcomers & boost expandedIds ─
  // semanticScoreById is already filled above.
  // Now add any semantic candidates not yet in expandedIds (large graphs mainly),
  // and record which ones are genuinely new (not found by lexical/title).
  for (const [id] of semanticScoreById) {
    if (!expandedIds.has(id) && byId.has(id)) {
      expandedIds.add(id);
      semanticOnlyIds.push(id);
    }
  }
  // ── End Layer 1.5 ────────────────────────────────────────────────────────

  /** @type {{ id: string, category: string, label: string, blobExcerpt: string, lexicalScore: number, semanticScore: number }[]} */
  let poolFull = [...expandedIds]
    .map((id) => {
      const n = byId.get(id);
      if (!n || typeof n !== "object") return null;
      const blobFull = String(/** @type {{ blob?: string }} */ (n).blob ?? "").trim();
      return {
        id,
        category: String(/** @type {{ category?: string }} */ (n).category ?? "").trim().slice(0, 120),
        label: String(/** @type {{ label?: string }} */ (n).label ?? "").trim().slice(0, 220),
        blobExcerpt: blobFull.slice(0, BLOB_EXCERPT_RERANK),
        lexicalScore: Number(scoreById.get(id) || 0),
        semanticScore: Number(semanticScoreById.get(id) || 0),
      };
    })
    .filter(Boolean);

  poolFull.sort((a, b) => {
    // Combined score: lexical is primary signal; semantic breaks ties and boosts
    // nodes the embedding model ranked highly even when lexical scores are equal.
    const aCombined = a.lexicalScore * 100 + a.semanticScore;
    const bCombined = b.lexicalScore * 100 + b.semanticScore;
    const dCombined = bCombined - aCombined;
    if (dCombined !== 0) return dCombined;
    const dBlob = String(b.blobExcerpt ?? "").length - String(a.blobExcerpt ?? "").length;
    if (dBlob !== 0) return dBlob;
    return `${a.category}/${a.label}`.localeCompare(`${b.category}/${b.label}`, undefined, { sensitivity: "base" });
  });

  const rerankPool = poolFull.slice(0, RERANK_POOL_START);

  const poolForJson = trimRerankPoolByJsonSize(rerankPool, userQuery, 26_000);
  const userBlock =
    `USER_QUESTION:\n${userQuery.slice(0, 8000)}\n\nCANDIDATES_JSON:\n` + JSON.stringify(poolForJson);

  let rawText = "";
  let usage = null;
  let _rerankProviderUsed = providerId;
  let _rerankModelUsed = picked.model || "?";
  /** Set by native rerank: ids directly from relevance scores. */
  let _nativeRerankIds = null;
  let _nativeRerankScores = null;

  // ── Rerank with fallback: try configured model → default model → next provider ─
  // ARCHITECTURE: Fixed providers can ONLY run their own model from Settings.
  // OR slots can ONLY run OpenRouter models from JSON. Never cross-contaminate.
  const _preferred = Array.isArray(args.analysisPriority)
    ? args.analysisPriority
    : [...FIXED_PROVIDER_IDS];

  /** Build ordered list of (providerId, key, model) attempts. */
  const _attempts = [];

  // If rerankModel is an OR model (has /), the primary attempt MUST be
  // through an OR slot — fixed providers cannot route cross-vendor models.
  const rerankIsOrModel = rerankModel && isOpenRouterModel(rerankModel);

  if (rerankIsOrModel) {
    // Primary: OR slot + rerankModel (e.g. cohere/rerank-v3.5 via or-1)
    if (key && providerId) {
      _attempts.push({ pid: providerId, k: key, m: rerankModel, label: "primary" });
    }
    // Fallback: other OR slots with the same rerankModel
    for (const orSlot of OR_SLOT_IDS) {
      if (orSlot === providerId) continue;
      const orKey = String(args.allKeys?.[orSlot] ?? "").trim();
      if (!orKey) continue;
      if (_attempts.some(a => a.pid === orSlot)) continue;
      _attempts.push({ pid: orSlot, k: orKey, m: rerankModel, label: `fallback-or-${orSlot}` });
    }
    // Fallback: OR slots with their default chat-completion model (not native rerank)
    for (const orSlot of OR_SLOT_IDS) {
      const orKey = String(args.allKeys?.[orSlot] ?? "").trim();
      const orModel = routerModels[orSlot] || "";
      if (!orKey || !orModel) continue;
      if (_attempts.some(a => a.pid === orSlot)) continue;
      _attempts.push({ pid: orSlot, k: orKey, m: orModel, label: `fallback-chat-${orSlot}` });
    }
  } else {
    // rerankModel is a fixed-provider model (or empty → use routerModels[providerId])
    // Primary: picked provider + model from Settings/JSON
    const primaryModel = rerankModel || routerModels[providerId] || "";
    if (key && primaryModel) {
      _attempts.push({ pid: providerId, k: key, m: primaryModel, label: "primary" });
    }
    // Fallback: picked provider's default model (if rerankModel was different)
    const defaultModel = routerModels[providerId] || "";
    if (rerankModel && defaultModel && defaultModel !== rerankModel && key) {
      _attempts.push({ pid: providerId, k: key, m: defaultModel, label: "fallback-default-model" });
    }
  }

  // Cross-provider fallbacks: fixed providers with their own models from Settings
  for (const pid of _preferred) {
    if (pid === providerId) continue;
    if (!FIXED_PROVIDER_IDS.has(pid)) continue; // OR slots handled above
    const k = String(args.allKeys?.[pid] ?? "").trim();
    const m = routerModels[pid] || "";
    if (!k || !m) continue;
    if (_attempts.some(a => a.pid === pid)) continue;
    _attempts.push({ pid, k, m, label: `fallback-provider-${pid}` });
  }

  // Fallback: OR slots not yet tried, with their JSON model
  for (const orSlot of OR_SLOT_IDS) {
    if (_attempts.some(a => a.pid === orSlot)) continue;
    const orKey = String(args.allKeys?.[orSlot] ?? "").trim();
    const orModel = routerModels[orSlot] || "";
    if (!orKey || !orModel) continue;
    _attempts.push({ pid: orSlot, k: orKey, m: orModel, label: `fallback-or-${orSlot}` });
  }

  // Last resort: active provider (if not already tried)
  const _activeKey = String(args.activeApiKey ?? "").trim();
  if (_activeKey && args.activeProviderId && !_attempts.some(a => a.pid === args.activeProviderId)) {
    const _m = routerModels[args.activeProviderId] || "";
    if (_m) _attempts.push({ pid: args.activeProviderId, k: _activeKey, m: _m, label: "fallback-active-provider" });
  }

  let _rerankSuccess = false;
  let _rerankAttemptLog = [];
  const _rerankT0 = Date.now();
  for (const attempt of _attempts) {
    const _attT0 = Date.now();
    const _isNative = isNativeRerankModel(attempt.m);
    console.log(
      `[memRouter] rerank attempt (${attempt.label}) — provider=${attempt.pid} · model=${attempt.m}` +
      ` · pool=${poolForJson.length} candidates · mode=${_isNative ? "native-rerank" : "chat-completion"}`,
    );
    try {
      if (_isNative) {
        // ── Native rerank API path (Cohere, etc.) ──────────────────────
        const nr = await runNativeRerank(
          attempt.pid,
          attempt.k,
          attempt.m,
          userQuery,
          poolForJson,
          22,
        );
        _nativeRerankIds = nr.ids;
        _nativeRerankScores = nr.scores;
        usage = nr.usage;
        rawText = ""; // not used for native rerank
      } else {
        // ── Chat completion path (existing logic) ──────────────────────
        const out = await runRouterLlm(
          attempt.pid,
          attempt.k,
          MEMORY_TREE_RERANK_SYSTEM,
          userBlock,
          RERANK_MAX_OUT,
          attempt.m,
        );
        rawText = out.text;
        usage = out.usage;
      }
      _rerankProviderUsed = attempt.pid;
      _rerankModelUsed = attempt.m;
      _rerankSuccess = true;
      const _attDt = Date.now() - _attT0;
      _rerankAttemptLog.push(`${attempt.label} (${attempt.pid}/${String(attempt.m).split("/").pop()}): OK in ${_attDt}ms [${_isNative ? "native" : "chat"}]`);
      console.log(`[memRouter] rerank OK (${attempt.label}) — ${_attDt}ms · mode=${_isNative ? "native" : "chat"} · usage pt=${usage?.promptTokens} ct=${usage?.completionTokens}`);
      break;
    } catch (attErr) {
      const _attDt = Date.now() - _attT0;
      const msg = attErr instanceof Error ? attErr.message : String(attErr);
      _rerankAttemptLog.push(`${attempt.label} (${attempt.pid}/${String(attempt.m).split("/").pop()}): ${msg.slice(0, 120)} [${_attDt}ms]`);
      console.warn(`[memRouter] rerank attempt FAILED (${attempt.label}) — ${_attDt}ms · ${msg}`);
    }
  }
  const _rerankDt = Date.now() - _rerankT0;
  console.log(`[memRouter] rerank total: ${_rerankDt}ms · summary: ${_rerankAttemptLog.join(" · ")}`);

  if (!_rerankSuccess) {
    const det = buildDeterministicSupplement(byId, rows, links, userQuery);
    const analyticsOnRerankFail = buildMemoryTreeRouterAnalytics(providerId, titleScan, null, "", "");
    const _diagRf = {
      path: "rerank-fail",
      reason: `all ${_attempts.length} rerank attempts failed in ${_rerankDt}ms`,
      providerId,
      rerankModel: rerankModel || routerModels[providerId] || "?",
      poolSize: poolForJson.length,
      totalNodes: rows.length,
      pickedProvider: providerId,
      analysisPriority: Array.isArray(args.analysisPriority) ? args.analysisPriority.join(",") : "(default)",
      attempts: _rerankAttemptLog,
      totalMs: _rerankDt,
    };
    if (det.trim()) return { supplement: det, memoryTreeRouterAnalytics: analyticsOnRerankFail, routerDiag: _diagRf };
    throw new Error("Memory tree router failed and deterministic fallback was empty.");
  }

  // ── Parse rerank results (unified for both native and chat paths) ────────
  let validIds;
  let rationale;
  if (_nativeRerankIds) {
    // Native rerank: ids already validated against pool
    validIds = _nativeRerankIds.filter((id) => byId.has(id)).slice(0, 32);
    const topLabels = validIds.slice(0, 5).map((id) => {
      const n = byId.get(id);
      return n ? String(n.label ?? id).slice(0, 40) : id;
    });
    rationale = `native rerank top-${validIds.length} (${topLabels.join(", ")}); scores: ${(_nativeRerankScores ?? []).slice(0, 5).map(s => s.toFixed(3)).join(", ")}`;
    console.log(`[memRouter] native rerank — ids=${validIds.length} · rationale=${rationale.slice(0, 120)}`);
  } else {
    // Chat completion: parse JSON from LLM output
    const parsed = parseRouteIdsJson(String(rawText ?? ""));
    console.log(`[memRouter] parsed rerank — ids=${parsed.ids.length} · rationale=${parsed.rationale.slice(0,100) || "(none)"}`);
    validIds = parsed.ids.filter((id) => poolForJson.some((x) => x.id === id)).slice(0, 32);
    rationale = [titleScan.rationale, parsed.rationale].filter(Boolean).join(" | ");
  }
  console.log(`[memRouter] validIds after pool filter=${validIds.length}`);
  /** Title-scan ids can be cut from JSON-trimmed rerank pool; still merge them — they are title-level picks. */
  const titlePick = titleScan.ids.filter((id) => byId.has(id));
  /** Keep a wider seed set before graph hop/hub expansion (avoids dropping a sibling leaf early). */
  validIds = [...new Set([...validIds, ...titlePick])].slice(0, 48);
  if (!_nativeRerankIds) {
    rationale = [titleScan.rationale, rationale].filter(Boolean).join(" | ");
  }

  if (validIds.length === 0) {
    const fromLex = [...new Set([...lexicalTop.slice(0, 10), ...entityTop.slice(0, 6)])]
      .map((id) => {
        const n = byId.get(id);
        if (!n) return null;
        return String(/** @type {{ id?: string }} */ (n).id ?? "").trim();
      })
      .filter(Boolean)
      .slice(0, MAX_IDS);
    if (fromLex.length > 0) {
      validIds = fromLex;
      rationale = rationale || "fallback: top lexical / entity matches (rerank returned no ids).";
    } else if (poolForJson.length > 0) {
      validIds = [...poolForJson]
        .sort((a, b) => {
          const db = String(b.blobExcerpt ?? "").length - String(a.blobExcerpt ?? "").length;
          if (db !== 0) return db;
          const dl = String(b.label ?? "").length - String(a.label ?? "").length;
          if (dl !== 0) return dl;
          return String(a.id).localeCompare(String(b.id), undefined, { sensitivity: "base" });
        })
        .slice(0, 48)
        .map((x) => x.id)
        .filter(Boolean);
      rationale = rationale || "fallback: rerank returned no ids; using ranked candidate pool (includes empty-note nodes).";
    }
  }

  validIds = validIds.filter((id) => byId.has(id));
  if (validIds.length === 0) {
    console.log(`[memRouter] EARLY RETURN #4 — no valid ids after rerank + expansion, using deterministic fallback`);
    const det = buildDeterministicSupplement(byId, rows, links, userQuery);
    const analyticsAfterRerank = buildMemoryTreeRouterAnalytics(
      providerId,
      titleScan,
      usage,
      `${MEMORY_TREE_RERANK_SYSTEM}\n\n${userBlock}`,
      String(rawText ?? ""),
    );
    const _diag4 = {
      path: "early-4",
      reason: "no valid ids after rerank + expansion",
      totalNodes: rows.length,
      rerankPool: poolForJson.length,
      parsedIds: parsed.ids.length,
      rationale: parsed.rationale.slice(0, 200) || "(none)",
      rerankModel: rerankModel || routerModels[providerId] || "?",
    };
    if (det.trim()) return { supplement: det, memoryTreeRouterAnalytics: analyticsAfterRerank, routerDiag: _diag4 };
    return { supplement: "", memoryTreeRouterAnalytics: analyticsAfterRerank, routerDiag: _diag4 };
  }
  const oneHopValid = [...new Set(expandOneGraphHop(validIds, byId, links))];
  const expandCap = Math.min(48, Math.max(validIds.length * 3, 20));
  validIds = fullyExpandHubNeighbors(oneHopValid, byId, links, expandCap);
  if (validIds.length > expandCap) {
    validIds = capExpandedWithAnchors(validIds, oneHopValid, byId, links, expandCap);
  }

  let supplement = buildSupplementFromNodes(byId, validIds, rationale);
  const det = buildDeterministicSupplement(byId, rows, links, userQuery);
  if (!supplement.trim() && det.trim()) {
    supplement = det;
  } else if (det.trim() && supplement.trim() && supplement.length < 2200 && det.length > supplement.length * 1.2) {
    supplement = det;
  }

  const memoryTreeRouterAnalytics = buildMemoryTreeRouterAnalytics(
    providerId,
    titleScan,
    usage,
    `${MEMORY_TREE_RERANK_SYSTEM}\n\n${userBlock}`,
    String(rawText ?? ""),
  );

  // ── Diagnostics payload ───────────────────────────────────────────────────
  /** Final rerank picks that came exclusively from the semantic layer. */
  const semanticWinners = validIds.filter((id) => semanticScoreById.has(id));
  /** @type {import("./memoryTreeRouter.js").RouterDiag} */
  const routerDiag = {
    path: "ok",
    totalNodes:    rows.length,
    lexicalCount:  sizeAfterLexAndTitle,
    semanticNew:   semanticScoreById.size,
    rerankPool:    poolForJson.length,
    selected:      validIds.length,
    rerankModel:   _rerankModelUsed,
    rerankProvider: _rerankProviderUsed,
    rerankFallback: _rerankProviderUsed !== providerId || _rerankModelUsed !== (rerankModel || routerModels[providerId]),
    rerankMs:      _rerankDt,
    rerankMode:    _nativeRerankIds ? "native" : "chat",
    rerankAttempts: _rerankAttemptLog,
    semanticWinners: semanticWinners.map((id) => {
      const n = byId.get(id);
      if (!n || typeof n !== "object") return id;
      return `${String(n.category ?? "").trim()} / ${String(n.label ?? "").trim()}`;
    }),
    rationale: rationale.slice(0, 300),
  };
  // ── End diagnostics ───────────────────────────────────────────────────────

  if (rows.length <= GRAPH_APPEND_TITLE_INDEX_MAX_NODES) {
    const idx = buildAllNodeTitleIndex(rows, 8_000);
    supplement = [supplement, idx].filter(Boolean).join("\n\n").trim();
  }
  return { supplement, memoryTreeRouterAnalytics, routerDiag };
}
