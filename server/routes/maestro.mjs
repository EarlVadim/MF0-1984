/**
 * Maestro API routes — task CRUD, run history, status, scheduler control.
 *
 * All routes are under /api/maestro.
 */
import { Router } from "express";
import {
  getOrCreateMaestroSession,
  createTask,
  getTask,
  listTasks,
  updateTask,
  deleteTask,
  getTaskRuns,
  getRun,
  getMaestroStatus,
  resolveMaestroModel,
  getTaskChain,
  getTaskChainParents,
  getChainGraph,
  MAESTRO_SLOT,
} from "../services/maestro.mjs";
import { executeTask, startScheduler, stopScheduler, recalcNextRunAt } from "../services/maestroScheduler.mjs";
import { setSchedulerRunning, isSchedulerRunning } from "../services/maestro.mjs";
import { buildMaestroContext, buildMaestroContextAsync, getMaestroContextPayload } from "../services/maestroContext.mjs";
import { MAESTRO_TOOL_DEFINITIONS, executeToolCall } from "../services/maestroTools.mjs";

const router = Router();

// ── Rate Limiter for /maestro/chat ──────────────────────────────────────────────
// Simple in-memory rate limiter: max 10 requests per minute per IP.
// Prevents runaway clients or bugs from spawning hundreds of LLM calls.
const _chatRateLimitMap = new Map(); // ip → { count, resetAt }
const CHAT_RATE_LIMIT_MAX = 10;
const CHAT_RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute

function _checkChatRateLimit(ip) {
  const now = Date.now();
  let entry = _chatRateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + CHAT_RATE_LIMIT_WINDOW_MS };
    _chatRateLimitMap.set(ip, entry);
  }
  entry.count++;
  if (entry.count > CHAT_RATE_LIMIT_MAX) return false;
  return true;
}

// Periodically clean up old entries
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of _chatRateLimitMap) {
    if (now > entry.resetAt) _chatRateLimitMap.delete(ip);
  }
}, 120_000).unref?.();

// ── Purpose Session ────────────────────────────────────────────────────────────

/** GET /api/maestro/session — get or create the Maestro purpose session. */
router.get("/maestro/session", (_req, res) => {
  try {
    const s = getOrCreateMaestroSession();
    res.json({ ok: true, themeId: s.themeId, dialogId: s.dialogId, slot: MAESTRO_SLOT });
  } catch (e) {
    console.error("[maestro] session:", e);
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// ── Status ─────────────────────────────────────────────────────────────────────

/** GET /api/maestro/status — overall Maestro status summary. */
router.get("/maestro/status", (_req, res) => {
  try {
    res.json({ ok: true, ...getMaestroStatus(), slotModel: resolveMaestroModel() });
  } catch (e) {
    console.error("[maestro] status:", e);
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// ── Current Model ──────────────────────────────────────────────────────────────

/** GET /api/maestro/current-model — get the model currently assigned to the Maestro slot (or-3). */
router.get("/maestro/current-model", (_req, res) => {
  try {
    const model = resolveMaestroModel();
    res.json({ ok: true, slot: MAESTRO_SLOT, model });
  } catch (e) {
    console.error("[maestro] current-model:", e);
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// ── Scheduler Control ──────────────────────────────────────────────────────────

/** POST /api/maestro/scheduler/start — start the scheduler tick loop. */
router.post("/maestro/scheduler/start", (_req, res) => {
  try {
    startScheduler();
    setSchedulerRunning(true);
    res.json({ ok: true, running: true });
  } catch (e) {
    console.error("[maestro] scheduler start:", e);
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

/** POST /api/maestro/scheduler/stop — stop the scheduler tick loop. */
router.post("/maestro/scheduler/stop", (_req, res) => {
  try {
    stopScheduler();
    setSchedulerRunning(false);
    res.json({ ok: true, running: false });
  } catch (e) {
    console.error("[maestro] scheduler stop:", e);
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// ── Task CRUD ──────────────────────────────────────────────────────────────────

/** GET /api/maestro/tasks — list tasks with optional filters. */
router.get("/maestro/tasks", (req, res) => {
  try {
    const filters = {};
    if (req.query.status) filters.status = String(req.query.status);
    if (req.query.taskType) filters.taskType = String(req.query.taskType);
    if (req.query.scheduled !== undefined) filters.scheduleEnabled = req.query.scheduled === "1";
    const tasks = listTasks(filters);
    res.json({ ok: true, tasks });
  } catch (e) {
    console.error("[maestro] list tasks:", e);
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

/** POST /api/maestro/tasks — create a new task. */
router.post("/maestro/tasks", (req, res) => {
  try {
    const task = createTask(req.body);
    // If the task has a cron schedule, recalculate next_run_at
    if (task.scheduleCron) {
      recalcNextRunAt(task.id);
    }
    const freshTask = getTask(task.id);
    res.status(201).json({ ok: true, task: freshTask });
  } catch (e) {
    console.error("[maestro] create task:", e);
    const msg = e instanceof Error ? e.message : String(e);
    res.status(400).json({ ok: false, error: msg });
  }
});

/** GET /api/maestro/tasks/:id — get a single task. */
router.get("/maestro/tasks/:id", (req, res) => {
  try {
    const task = getTask(String(req.params.id));
    if (!task) return res.status(404).json({ ok: false, error: "Task not found" });
    res.json({ ok: true, task });
  } catch (e) {
    console.error("[maestro] get task:", e);
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

/** PUT /api/maestro/tasks/:id — update a task. */
router.put("/maestro/tasks/:id", (req, res) => {
  try {
    const task = updateTask(String(req.params.id), req.body);
    if (!task) return res.status(404).json({ ok: false, error: "Task not found" });
    // Recalculate next_run_at if schedule changed
    if (task.scheduleCron && task.scheduleEnabled) {
      recalcNextRunAt(task.id);
    }
    const freshTask = getTask(task.id);
    res.json({ ok: true, task: freshTask });
  } catch (e) {
    console.error("[maestro] update task:", e);
    const msg = e instanceof Error ? e.message : String(e);
    res.status(400).json({ ok: false, error: msg });
  }
});

/** DELETE /api/maestro/tasks/:id — delete a task. */
router.delete("/maestro/tasks/:id", (req, res) => {
  try {
    const deleted = deleteTask(String(req.params.id));
    if (!deleted) return res.status(404).json({ ok: false, error: "Task not found" });
    res.json({ ok: true });
  } catch (e) {
    console.error("[maestro] delete task:", e);
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// ── Manual Run Trigger ─────────────────────────────────────────────────────────

/** POST /api/maestro/tasks/:id/run — manually trigger a task run (actual LLM call).
 *  Query params: ?force=1 — force-run even if task is already running (resets stale lock) */
router.post("/maestro/tasks/:id/run", async (req, res) => {
  try {
    const task = getTask(String(req.params.id));
    if (!task) return res.status(404).json({ ok: false, error: "Task not found" });

    const force = req.query.force === "1";

    // Execute the task (actual LLM call through the proxy)
    const result = await executeTask(task.id, { force });
    const updatedTask = getTask(task.id);
    const run = getRun(result.runId);

    res.json({
      ok: result.success,
      run,
      task: updatedTask,
      ...(result.success ? { summary: result.summary } : { error: result.error }),
    });
  } catch (e) {
    console.error("[maestro] manual run:", e);
    // Return 409 for "already running" so caller can decide to retry with force
    if (e.message && e.message.includes("already running")) {
      return res.status(409).json({ ok: false, error: e.message, hint: "Retry with ?force=1 to override" });
    }
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// ── Context & Tools ───────────────────────────────────────────────────────────

/** GET /api/maestro/context — get the current Maestro agent context (for debugging). */
router.get("/maestro/context", async (req, res) => {
  try {
    const format = String(req.query.format ?? "json").trim().toLowerCase();
    if (format === "text") {
      const text = await buildMaestroContextAsync();
      res.type("text/plain").send(text);
    } else {
      res.json({ ok: true, ...getMaestroContextPayload() });
    }
  } catch (e) {
    console.error("[maestro] context:", e);
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

/** GET /api/maestro/tools — list available Maestro tools. */
router.get("/maestro/tools", (_req, res) => {
  res.json({ ok: true, tools: MAESTRO_TOOL_DEFINITIONS });
});

/** POST /api/maestro/tools/execute — manually execute a tool call (for testing). */
router.post("/maestro/tools/execute", async (req, res) => {
  try {
    const { tool, args } = req.body ?? {};
    if (!tool) return res.status(400).json({ ok: false, error: "tool name required" });
    const result = await executeToolCall(String(tool), args || {});
    res.json({ ok: true, tool, result: JSON.parse(result) });
  } catch (e) {
    console.error("[maestro] tool execute:", e);
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// ── Run History ────────────────────────────────────────────────────────────────

/** GET /api/maestro/tasks/:id/runs — get run history for a task. */
router.get("/maestro/tasks/:id/runs", (req, res) => {
  try {
    const task = getTask(String(req.params.id));
    if (!task) return res.status(404).json({ ok: false, error: "Task not found" });
    const limit = Number(req.query.limit) || 50;
    const status = req.query.status ? String(req.query.status) : undefined;
    const runs = getTaskRuns(task.id, { limit, status });
    res.json({ ok: true, runs });
  } catch (e) {
    console.error("[maestro] task runs:", e);
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

/** GET /api/maestro/tasks/:id/chain — get the full chain starting from this task. */
router.get("/maestro/tasks/:id/chain", (req, res) => {
  try {
    const task = getTask(String(req.params.id));
    if (!task) return res.status(404).json({ ok: false, error: "Task not found" });
    const chain = getTaskChain(task.id);
    const parents = getTaskChainParents(task.id);
    res.json({ ok: true, chain, parents });
  } catch (e) {
    console.error("[maestro] task chain:", e);
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

/** GET /api/maestro/chains — get the global chain graph (all nodes + edges). */
router.get("/maestro/chains", (_req, res) => {
  try {
    const graph = getChainGraph();
    res.json({ ok: true, ...graph });
  } catch (e) {
    console.error("[maestro] chains graph:", e);
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

/** GET /api/maestro/runs/:runId — get a single run. */
router.get("/maestro/runs/:runId", (req, res) => {
  try {
    const run = getRun(String(req.params.runId));
    if (!run) return res.status(404).json({ ok: false, error: "Run not found" });
    res.json({ ok: true, run });
  } catch (e) {
    console.error("[maestro] get run:", e);
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// ── Quick Chat ────────────────────────────────────────────────────────────────

/** POST /api/maestro/chat — send a one-off message to Maestro for immediate execution.
 *  Uses the same Maestro-OR-3 interceptor as the main dialog: injects system prompt,
 *  agent context, and tools. No task is created unless Maestro itself calls create_task.
 *  Returns { ok, summary, error, toolTrace, modelId, tokens }. */
router.post("/maestro/chat", async (req, res) => {
  try {
    // Rate limit check
    const clientIp = req.ip || req.connection?.remoteAddress || "unknown";
    if (!_checkChatRateLimit(clientIp)) {
      return res.status(429).json({ ok: false, error: "Rate limit exceeded. Max 10 Maestro chat requests per minute." });
    }

    const { message, modelId } = req.body ?? {};
    if (!message?.trim()) return res.status(400).json({ ok: false, error: "message is required" });

    // Use the OR-3 Maestro interceptor directly (same logic as main dialog)
    const apiKey = String(process.env.OPENROUTER_API_KEY ?? "").trim();
    if (!apiKey) {
      return res.status(503).json({ ok: false, error: "OpenRouter API key not configured" });
    }

    // Import the shared Maestro dialog logic from llm.mjs
    const { resolveMaestroModel } = await import("../services/maestro.mjs");
    const { MAESTRO_TOOL_DEFINITIONS, executeToolCall: execTool, getToolAvailabilityStatus } = await import("../services/maestroTools.mjs");
    const { buildMaestroContextAsync } = await import("../services/maestroContext.mjs");

    const agentContext = await buildMaestroContextAsync();
    const availableTools = MAESTRO_TOOL_DEFINITIONS.filter(
      (t) => !getToolAvailabilityStatus().unavailable.includes(t.function?.name || t.name),
    );

    const MAESTRO_CHAT_PROMPT = [
      "You are Maestro, the orchestrator agent of MF0-1984.",
      "You have access to agent resources including memory graph, tasks, file system, and other LLM slots.",
      "When you need information or want to take action, use the provided tools (function calls).",
      "Always base your responses on actual data from the context and tool results.",
      "",
      "TIMEZONE RULE — CRITICAL:",
      "The server runs in UTC. The agent context includes the user's local timezone and current local/UTC time.",
      "When the user mentions a time (e.g. 'at 8:51'), they ALWAYS mean their LOCAL time.",
      "You MUST convert the user's local time to UTC before setting cron expressions.",
      "",
      "OUTPUT FORMATTING:",
      "1. Your FINAL text response must be a complete, structured Markdown report when tools are called.",
      "2. For simple conversational replies (no tools), respond naturally and concisely.",
      "3. When using tools for analysis, interpret the results — don't just dump raw data.",
      "4. Write in the SAME LANGUAGE as the user's message.",
    ].join("\n");

    const model = modelId || resolveMaestroModel() || "deepseek/deepseek-v4-flash";
    const messages = [
      { role: "system", content: MAESTRO_CHAT_PROMPT },
      { role: "system", content: `Current agent state:\n\n${agentContext}` },
      { role: "user", content: message.trim() },
    ];

    // Tool-calling loop
    const MAX_ROUNDS = 10;
    const toolTrace = [];
    let loopMessages = [...messages];
    let lastResponse = null;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const body = {
        model,
        messages: loopMessages,
        tools: availableTools.length > 0 ? availableTools : undefined,
        stream: false,
      };
      if (round === MAX_ROUNDS - 1) delete body.tools;

      const url = "https://openrouter.ai/api/v1/chat/completions";
      const llmRes = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${apiKey}`,
          "http-referer": String(process.env.OPENROUTER_REFERER ?? "http://localhost:1984"),
          "x-title": String(process.env.OPENROUTER_APP_TITLE ?? "MF0-1984"),
        },
        body: JSON.stringify(body),
      });
      if (!llmRes.ok) {
        const errText = await llmRes.text();
        throw new Error(`OpenRouter HTTP ${llmRes.status}: ${errText.slice(0, 300)}`);
      }
      lastResponse = await llmRes.json();

      const choice = lastResponse.choices?.[0];
      if (!choice) break;

      const toolCalls = choice.message?.tool_calls;
      if (!toolCalls || toolCalls.length === 0) break;

      loopMessages.push(choice.message);

      for (const tc of toolCalls) {
        const toolName = tc.function?.name;
        let toolArgs = {};
        try { toolArgs = JSON.parse(tc.function?.arguments || "{}"); } catch {}

        let toolResult;
        try {
          toolResult = await execTool(toolName, toolArgs, { sourceTaskId: "maestro-chat" });
        } catch (e) {
          toolResult = JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
        }

        const resultStr = typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult);
        toolTrace.push({ round: round + 1, tool: toolName, args: toolArgs, result: resultStr.length > 500 ? resultStr.slice(0, 500) + "..." : resultStr });

        loopMessages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: resultStr,
        });
      }
    }

    const finalContent = lastResponse?.choices?.[0]?.message?.content || "";
    const finalUsage = lastResponse?.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    const finalModel = lastResponse?.model || model;

    res.json({
      ok: true,
      summary: finalContent,
      error: null,
      run: {
        toolTrace,
        modelId: finalModel,
        totalTokens: finalUsage.total_tokens || 0,
      },
    });
  } catch (e) {
    console.error("[maestro] chat:", e);
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

export default router;
