/**
 * Server-side LLM proxy — forwards /api/llm/<provider>/* to provider APIs.
 * Reads API keys from process.env; the browser never sees the real keys.
 *
 * OR-3 (Maestro) interceptor: chat/completions requests to OR-3 are intercepted
 * and enriched with Maestro system prompt, agent context, and tool definitions.
 * If the model returns tool_calls, a server-side tool-calling loop executes them
 * and returns the final response. Otherwise, the response is streamed as SSE.
 */
import { Router } from "express";
import https from "node:https";
import http  from "node:http";  // added for Ollama local proxy
import { URL } from "node:url";

const router = Router();
const TIMEOUT_MS = 300_000;

// ── Maestro imports ──────────────────────────────────────────────────────────
import { resolveMaestroModel, MAESTRO_SLOT } from "../services/maestro.mjs";
import { MAESTRO_TOOL_DEFINITIONS, executeToolCall, getToolAvailabilityStatus } from "../services/maestroTools.mjs";
import { buildMaestroContextAsync } from "../services/maestroContext.mjs";

/** Maestro system prompt for OR-3 dialog (lighter than the full scheduler version). */
const MAESTRO_DIALOG_SYSTEM_PROMPT = [
  "You are Maestro, the orchestrator agent of MF0-1984.",
  "You are running on the OpenRouter slot OR-3 (or-3).",
  "You have access to agent resources including memory graph, tasks, file system, and other LLM slots.",
  "When you need information or want to take action, use the provided tools (function calls).",
  "Always base your responses on actual data from the context and tool results.",
  "",
  "SLOT AWARENESS:",
  "You are on slot or-3. All OpenRouter slots (or-1, or-2, or-3) share the same OpenRouter API key.",
  "When checking model availability or sending requests to other models, prefer using or-3 (your own slot).",
  "Only use or-1/or-2 if you specifically need a DIFFERENT provider slot for some reason.",
  "",
  "TASK CREATION RULES:",
  "1. When creating a task, ONLY call create_task ONCE. Do NOT call it again to 'fix' or 'enable' the same task.",
  "2. If a task was created but schedule is wrong, use update_task to modify it — never create_task again.",
  "3. When specifying modelId, ALWAYS use the full model ID from the Known Models section of the context (e.g. 'nvidia/nemotron-nano-9b-v2', NOT 'Nemotron-nano' or 'ntron-nano').",
  "4. If the user uses a short name (e.g. 'Nemotron-nano'), look it up in the Known Models section and use the full ID.",
  "",
  "TIMEZONE RULE — CRITICAL:",
  "The server runs in UTC. The agent context includes the user's local timezone and current local/UTC time.",
  "When the user mentions a time (e.g. 'at 8:51', 'tomorrow at 10'), they ALWAYS mean their LOCAL time.",
  "You MUST convert the user's local time to UTC before setting cron expressions or next_run_at.",
  "NEVER assume the user means UTC unless they explicitly say 'UTC'.",
  "",
  "OUTPUT FORMATTING:",
  "1. Your FINAL text response must be a complete, structured Markdown report when tools are called.",
  "2. For simple conversational replies (no tools), respond naturally and concisely.",
  "3. When using tools for analysis, interpret the results — don't just dump raw data.",
  "4. Write in the SAME LANGUAGE as the user's message.",
].join("\n");

/** Max tool-calling rounds for OR-3 dialog. */
const MAESTRO_DIALOG_MAX_ROUNDS = 10;

// Headers not forwarded from the browser request to the upstream provider.
const SKIP_REQ_HEADERS = new Set([
  "host", "connection", "transfer-encoding", "te",
  "anthropic-dangerous-direct-browser-access",
  "origin", "referer", "cookie",
  "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site",
  "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform",
  "sec-gpc", "dnt",
  "accept-language",
  "accept-encoding",
]);

// Headers not forwarded from the upstream response back to the browser.
const SKIP_RES_HEADERS = new Set(["transfer-encoding", "connection", "keep-alive"]);

const PROVIDERS = {
  openai: {
    host: "api.openai.com",
    envKey: () => String(process.env.OPENAI_API_KEY ?? "").trim(),
    injectAuth: (h, k) => { h["authorization"] = `Bearer ${k}`; },
  },
  anthropic: {
    host: "api.anthropic.com",
    envKey: () => String(process.env.ANTHROPIC_API_KEY ?? "").trim(),
    injectAuth: (h, k) => { h["x-api-key"] = k; },
  },
  ollama: {
    host:      "127.0.0.1",
    port:      11434,
    protocol:  "http",
    envKey:    () => "ollama",
    injectAuth: null,
  },
  "or-1": {
    host:      "openrouter.ai",
    protocol:  "https",
    envKey:    () => String(process.env.OPENROUTER_API_KEY ?? "").trim(),
    injectAuth: (h, k) => {
      h["authorization"] = `Bearer ${k}`;
      h["http-referer"]  = String(process.env.OPENROUTER_REFERER ?? "http://localhost:1984");
      h["x-title"]       = String(process.env.OPENROUTER_APP_TITLE ?? "MF0-1984");
    },
  },
  "or-2": {
    host:      "openrouter.ai",
    protocol:  "https",
    envKey:    () => String(process.env.OPENROUTER_API_KEY ?? "").trim(),
    injectAuth: (h, k) => {
      h["authorization"] = `Bearer ${k}`;
      h["http-referer"]  = String(process.env.OPENROUTER_REFERER ?? "http://localhost:1984");
      h["x-title"]       = String(process.env.OPENROUTER_APP_TITLE ?? "MF0-1984");
    },
  },
  "or-3": {
    host:      "openrouter.ai",
    protocol:  "https",
    envKey:    () => String(process.env.OPENROUTER_API_KEY ?? "").trim(),
    injectAuth: (h, k) => {
      h["authorization"] = `Bearer ${k}`;
      h["http-referer"]  = String(process.env.OPENROUTER_REFERER ?? "http://localhost:1984");
      h["x-title"]       = String(process.env.OPENROUTER_APP_TITLE ?? "MF0-1984");
    },
  },
  gemini: {
    host: "generativelanguage.googleapis.com",
    envKey: () => String(process.env.GEMINI_API_KEY ?? "").trim(),
    injectAuth: null,
    keyInQuery: true,
  },
};

// ── Maestro OR-3 interceptor ─────────────────────────────────────────────────

/**
 * Send a non-streaming request to OpenRouter and return the parsed JSON response.
 * @param {object} body - The request body to send.
 * @param {string} apiKey - The API key.
 * @returns {Promise<object>} Parsed JSON response.
 */
async function _maestroLlmCall(body, apiKey) {
  const url = "https://openrouter.ai/api/v1/chat/completions";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${apiKey}`,
      "http-referer": String(process.env.OPENROUTER_REFERER ?? "http://localhost:1984"),
      "x-title": String(process.env.OPENROUTER_APP_TITLE ?? "MF0-1984"),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    let errMsg = `OpenRouter HTTP ${res.status}`;
    try {
      const errJson = JSON.parse(errText);
      errMsg += `: ${errJson.error?.message ?? errJson.message ?? errText.slice(0, 300)}`;
    } catch {
      errMsg += `: ${errText.slice(0, 300)}`;
    }
    throw new Error(errMsg);
  }
  return res.json();
}

/**
 * Handle OR-3 chat/completions with Maestro capabilities.
 * Injects system prompt + agent context + tools.
 * If model returns tool_calls → executes them in a loop.
 * Returns the response as SSE stream to the client (compatible with OpenAI streaming format).
 */
async function handleMaestroOr3Chat(req, res) {
  const apiKey = PROVIDERS["or-3"].envKey();
  if (!apiKey) {
    return res.status(503).json({ ok: false, error: "OpenRouter API key not configured for OR-3" });
  }

  const reqBody = req.body;
  if (!reqBody || !reqBody.messages) {
    return res.status(400).json({ ok: false, error: "Missing messages in request body" });
  }

  try {
    // 1. Build Maestro-augmented request
    const agentContext = await buildMaestroContextAsync();
    const availableTools = MAESTRO_TOOL_DEFINITIONS.filter(
      (t) => !getToolAvailabilityStatus().unavailable.includes(t.function?.name || t.name),
    );

    // 2. Inject Maestro system prompt + agent context as the first system messages
    const messages = [...reqBody.messages];
    // Remove any existing system messages — we replace them
    const nonSystem = messages.filter((m) => m.role !== "system");
    const augmentedMessages = [
      { role: "system", content: MAESTRO_DIALOG_SYSTEM_PROMPT },
      { role: "system", content: `Current agent state:\n\n${agentContext}` },
      ...nonSystem,
    ];

    const model = reqBody.model || resolveMaestroModel() || "deepseek/deepseek-v4-flash";
    const isStreaming = reqBody.stream === true;

    // 3. Build request body for OpenRouter (non-streaming for tool-calling detection)
    const llmBody = {
      model,
      messages: augmentedMessages,
      tools: availableTools.length > 0 ? availableTools : undefined,
      stream: false,  // Always non-streaming first to detect tool_calls
    };
    if (reqBody.temperature != null) llmBody.temperature = reqBody.temperature;
    if (reqBody.max_tokens) llmBody.max_tokens = reqBody.max_tokens;

    // 4. Tool-calling loop
    let loopMessages = [...augmentedMessages];
    let lastResponse = null;
    let totalToolCalls = 0;

    for (let round = 0; round < MAESTRO_DIALOG_MAX_ROUNDS; round++) {
      llmBody.messages = loopMessages;
      lastResponse = await _maestroLlmCall(llmBody, apiKey);

      const choice = lastResponse.choices?.[0];
      if (!choice) break;

      const toolCalls = choice.message?.tool_calls;
      if (!toolCalls || toolCalls.length === 0) {
        // No tool calls — final text response
        break;
      }

      // Execute tool calls
      totalToolCalls += toolCalls.length;
      loopMessages.push(choice.message);  // Add assistant message with tool_calls

      for (const tc of toolCalls) {
        const toolName = tc.function?.name;
        let toolArgs = {};
        try {
          toolArgs = JSON.parse(tc.function?.arguments || "{}");
        } catch { /* ignore parse errors */ }

        let toolResult;
        try {
          toolResult = await executeToolCall(toolName, toolArgs, { sourceTaskId: "or-3-dialog" });
        } catch (e) {
          toolResult = JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
        }

        loopMessages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult),
        });
      }

      // On the last round, remove tools to force a text summary
      if (round === MAESTRO_DIALOG_MAX_ROUNDS - 1) {
        delete llmBody.tools;
      }
    }

    // 5. Return response to client
    const finalChoice = lastResponse?.choices?.[0];
    const finalContent = finalChoice?.message?.content || "";
    const finalUsage = lastResponse?.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    if (isStreaming) {
      // Return as SSE stream (compatible with OpenAI streaming format)
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
        "connection": "keep-alive",
      });

      // Send the content as a single SSE chunk (simulated streaming)
      const chunk = {
        id: lastResponse?.id || `maestro-${Date.now()}`,
        object: "chat.completion.chunk",
        created: lastResponse?.created || Math.floor(Date.now() / 1000),
        model: lastResponse?.model || model,
        choices: [{
          index: 0,
          delta: { content: finalContent },
          finish_reason: "stop",
        }],
        usage: finalUsage,
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();

      if (totalToolCalls > 0) {
        console.log(`[maestro-or3] Dialog completed: ${totalToolCalls} tool calls across loop, ${finalUsage.total_tokens} tokens`);
      }
    } else {
      // Non-streaming response (passthrough format)
      res.json({
        id: lastResponse?.id || `maestro-${Date.now()}`,
        object: "chat.completion",
        created: lastResponse?.created || Math.floor(Date.now() / 1000),
        model: lastResponse?.model || model,
        choices: [{
          index: 0,
          message: { role: "assistant", content: finalContent },
          finish_reason: "stop",
        }],
        usage: finalUsage,
      });
    }
  } catch (e) {
    console.error("[maestro-or3] Dialog error:", e);
    if (!res.headersSent) {
      res.status(500).json({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    } else {
      res.destroy();
    }
  }
}

// ── Standard proxy handler ───────────────────────────────────────────────────

function makeProxyHandler(providerName) {
  const cfg = PROVIDERS[providerName];

  return (req, res) => {
    const apiKey = cfg.envKey();
    if (!apiKey) {
      return res.status(503).json({ ok: false, error: `${providerName} API key not configured on server` });
    }

    // Strip /llm/<provider> prefix, keep query string
    const prefix = `/llm/${providerName}`;
    let upstreamPath = req.url.startsWith(prefix) ? req.url.slice(prefix.length) : req.url;
    if (!upstreamPath.startsWith("/")) upstreamPath = "/" + upstreamPath;

    // Gemini uses ?key= query param — replace whatever the client sent with the real key
    if (cfg.keyInQuery) {
      try {
        const u = new URL(upstreamPath, "https://placeholder.com");
        u.searchParams.set("key", apiKey);
        upstreamPath = u.pathname + (u.search || "");
      } catch { /* passthrough on malformed URL */ }
    }

    // Build request headers: copy client headers, skip hop-by-hop, inject auth
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!SKIP_REQ_HEADERS.has(k.toLowerCase())) headers[k] = v;
    }
    if (cfg.injectAuth) cfg.injectAuth(headers, apiKey);

    // Body source: express.json() parses application/json bodies; re-serialize for forwarding.
    const ct = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    const isJsonBody = ct === "application/json" || ct === "text/json";
    let bodyBuf = null;
    if (isJsonBody) {
      bodyBuf = Buffer.from(JSON.stringify(req.body));
      headers["content-length"] = String(bodyBuf.length);
      headers["content-type"] = "application/json";
    }

    const diag = {
      provider: providerName,
      upstreamTarget: `${cfg.protocol}://${cfg.host}:${cfg.port ?? (cfg.protocol === "http" ? 80 : 443)}`,
      upstreamPath,
      method: req.method,
      browserHeaders: { ...req.headers },
      forwardedHeaders: { ...headers },
      bodyPreview: bodyBuf ? (bodyBuf.length > 1000 ? bodyBuf.slice(0, 1000).toString() + '...[truncated]' : bodyBuf.toString()) : null,
      upstreamStatus: null,
      upstreamStatusText: null,
      upstreamResponseHeaders: null,
      upstreamBody: null,
    };

    const lib = cfg.protocol === "http" ? http : https;
    const proxyReq = lib.request({
      hostname: cfg.host,
      port:     cfg.port ?? (cfg.protocol === "http" ? 80 : 443),
      path: upstreamPath,
      method: req.method,
      headers,
      timeout: TIMEOUT_MS,
    });

    res.on("close", () => { if (!res.writableEnded) proxyReq.destroy(); });

    proxyReq.on("response", (proxyRes) => {
      const resCt = String(proxyRes.headers["content-type"] || "").toLowerCase();
      const isStreaming =
        resCt.includes("text/event-stream") ||
        resCt.includes("application/x-ndjson") ||
        upstreamPath.includes("streamGenerateContent");

      diag.upstreamStatus = proxyRes.statusCode;
      diag.upstreamStatusText = proxyRes.statusMessage;
      diag.upstreamResponseHeaders = { ...proxyRes.headers };

      if (proxyRes.statusCode && proxyRes.statusCode >= 400) {
        const chunks = [];
        proxyRes.on("data", (chunk) => chunks.push(chunk));
        proxyRes.on("end", () => {
          diag.upstreamBody = Buffer.concat(chunks).toString().slice(0, 4000);
          let upstreamErrorMsg = "";
          try {
            const j = JSON.parse(diag.upstreamBody);
            upstreamErrorMsg = j.error?.message ?? j.message ?? (typeof j.error === "string" ? j.error : "") ?? "";
          } catch {
            upstreamErrorMsg = diag.upstreamBody.slice(0, 500);
          }
          if (!res.headersSent) {
            res.status(proxyRes.statusCode).json({
              ok: false,
              error: upstreamErrorMsg || proxyRes.statusMessage || `HTTP ${proxyRes.statusCode}`,
              diagnostics: diag,
            });
          }
        });
        return;
      }

      const resHeaders = {};
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        if (!SKIP_RES_HEADERS.has(k.toLowerCase())) resHeaders[k] = v;
      }
      if (isStreaming) {
        delete resHeaders["content-length"];
        resHeaders["cache-control"] = "no-cache, no-transform";
        resHeaders["x-accel-buffering"] = "no";
      }

      res.writeHead(proxyRes.statusCode ?? 200, resHeaders);
      proxyRes.pipe(res, { end: true });
      proxyRes.on("error", () => res.destroy());
    });

    proxyReq.on("error", (e) => {
      diag.upstreamBody = e.message;
      if (!res.headersSent) {
        res.status(502).json({
          ok: false,
          error: e.message,
          diagnostics: diag,
        });
      } else {
        res.destroy();
      }
    });

    proxyReq.on("timeout", () => {
      proxyReq.destroy();
      diag.upstreamBody = "Upstream timeout";
      if (!res.headersSent) {
        res.status(504).json({
          ok: false,
          error: "Upstream timeout",
          diagnostics: diag,
        });
      } else {
        res.destroy();
      }
    });

    if (bodyBuf) {
      proxyReq.end(bodyBuf);
    } else {
      req.pipe(proxyReq);
    }
  };
}

// ── Route registration ───────────────────────────────────────────────────────

// OR-3 gets a special handler for chat/completions (Maestro interceptor)
router.post("/llm/or-3/api/v1/chat/completions", (req, res) => {
  // Maestro interceptor — handles prompt injection, tools, and tool-calling loop
  handleMaestroOr3Chat(req, res);
});

// All other OR-3 routes (rerank, models, etc.) go through the standard proxy
router.all("/llm/or-3/*splat", makeProxyHandler("or-3"));

// All other providers use the standard proxy
for (const name of Object.keys(PROVIDERS)) {
  if (name === "or-3") continue;  // Already registered above
  router.all(`/llm/${name}/*splat`, makeProxyHandler(name));
}

export default router;
