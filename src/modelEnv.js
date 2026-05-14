/**
 * LLM calls are proxied through /api/llm/* — keys live in server process.env, not the browser.
 * On startup, initModelEnv() fetches /api/settings/configured-providers so the frontend
 * knows which providers are actually available, without exposing the real keys.
 */

/** @type {Record<string, string>} */
let _keys = {
  openai:         "",
  ollama:         "server-proxy",
  "ollama-kimi":  "server-proxy",
  "ollama-ds":    "server-proxy",
  openrouter:     "",
  "gemini-flash": "",
  anthropic:      "",
};

let _initialized = false;

/**
 * Call once at app startup. Fetches which providers have real keys on the server.
 * Safe to call multiple times — subsequent calls are no-ops.
 * @returns {Promise<void>}
 */
export async function initModelEnv() {
  if (_initialized) return;
  _initialized = true;
  try {
    const res = await fetch("/api/settings/configured-providers");
    if (!res.ok) return;
    const data = await res.json();
    const cfg = data?.configured ?? {};
    _keys = {
      openai:          cfg.openai           ? "server-proxy" : "",
      ollama:          "server-proxy",
      "ollama-kimi":   cfg.openrouter ? "server-proxy" : "",
      "ollama-ds":     cfg.openrouter ? "server-proxy" : "",
      openrouter:      cfg.openrouter       ? "server-proxy" : "",
      "gemini-flash":  cfg["gemini-flash"]  ? "server-proxy" : "",
      anthropic:       cfg.anthropic        ? "server-proxy" : "",
    };
  } catch {
    // If fetch fails (first load, offline), fall back to marking all as available.
    // The server will return 503 for unconfigured ones — AI opinion skips them.
    _keys = {
      openai:         "server-proxy",
      ollama:         "server-proxy",
      "ollama-kimi":  "server-proxy",
      "ollama-ds":    "server-proxy",
      openrouter:     "server-proxy",
      "gemini-flash": "server-proxy",
      anthropic:      "server-proxy",
    };
  }
}

export function getModelApiKeys() {
  return { ..._keys };
}

/** True if at least one key is configured (excludes ollama which needs no key). */
export function hasAnyModelApiKey() {
  return Object.entries(_keys).some(([id, v]) => id !== "ollama" && Boolean(v));
}
