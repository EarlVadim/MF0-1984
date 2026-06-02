/**
 * Maestro — orchestrator service.
 *
 * Manages scheduled tasks, purpose sessions, and will eventually drive
 * LLM calls on a self-configured schedule.
 *
 * Step 1: task CRUD, session management, run logging.
 * Step 2+: scheduler tick, LLM execution, resource access.
 */
import crypto from "node:crypto";
import { db } from "../db/migrations.mjs";
import { Cron } from "croner";

// ── Constants ──────────────────────────────────────────────────────────────────

/** The provider slot reserved for Maestro. */
export const MAESTRO_SLOT = "or-3";

/** Task types accepted by the system. */
export const TASK_TYPES = new Set(["chat", "keeper", "custom"]);

/** Task statuses. */
export const TASK_STATUSES = new Set(["idle", "running", "error", "disabled"]);

/** Run statuses. */
export const RUN_STATUSES = new Set(["running", "success", "error"]);

/** Default max context nodes injected into a Maestro prompt. */
const DEFAULT_MAX_CONTEXT_NODES = 20;

/** Default max tool-calling rounds per task execution. */
const DEFAULT_MAX_TOOL_ROUNDS = 10;

/** Stale lock threshold — if a task has been "running" longer than this, reset to idle.
 *  Must be greater than LLM_TIMEOUT_MS (600s = 10min in scheduler) to avoid
 *  resetting tasks that are still legitimately running. */
const STALE_LOCK_MINUTES = 15;

/** Whether the scheduler engine is running. */
let _schedulerRunning = false;

/** Cached model for Maestro slot, resolved from dialog or_models_json. */
let _cachedSlotModel = null;

// ── Cached schema info (populated once at init, avoids PRAGMA on every call) ──
let _runsColCache = null;   // Set<string> of maestro_runs column names
let _tasksColCache = null;  // Set<string> of maestro_tasks column names

/**
 * Populate schema caches. Called once on module init or explicitly before first use.
 * After this, no PRAGMA queries are needed in hot paths (startRun, finishRun).
 */
export function initSchemaCache() {
  if (!_runsColCache) {
    const runCols = db.prepare(`PRAGMA table_info(maestro_runs)`).all();
    _runsColCache = new Set(runCols.map((c) => c.name));
  }
  if (!_tasksColCache) {
    const taskCols = db.prepare(`PRAGMA table_info(maestro_tasks)`).all();
    _tasksColCache = new Set(taskCols.map((c) => c.name));
  }
}

/** Check if a column exists in maestro_runs (uses cache). */
function _hasRunCol(name) {
  if (!_runsColCache) initSchemaCache();
  return _runsColCache.has(name);
}

/** Check if a column exists in maestro_tasks (uses cache). */
function _hasTaskCol(name) {
  if (!_tasksColCache) initSchemaCache();
  return _tasksColCache.has(name);
}

/**
 * Resolve the current model for the Maestro slot (or-3).
 * Reads from the Maestro dialog's or_models_json first, then falls back to env var.
 * @returns {string|null}
 */
export function resolveMaestroModel() {
  try {
    const session = getOrCreateMaestroSession();
    const row = db.prepare(`SELECT or_models_json FROM dialogs WHERE id = ?`).get(session.dialogId);
    if (row?.or_models_json) {
      const models = JSON.parse(row.or_models_json);
      if (models[MAESTRO_SLOT]) {
        _cachedSlotModel = models[MAESTRO_SLOT];
        return _cachedSlotModel;
      }
    }
  } catch { /* ignore parse errors */ }
  // Fallback to env var
  return _cachedSlotModel || String(process.env.MAESTRO_MODEL ?? "").trim() || null;
}

/**
 * Check if the scheduler engine is running.
 * @returns {boolean}
 */
export function isSchedulerRunning() {
  return _schedulerRunning;
}

/**
 * Set scheduler running state (called by maestroScheduler on start/stop).
 * @param {boolean} value
 */
export function setSchedulerRunning(value) {
  _schedulerRunning = !!value;
}

// ── Purpose Session ────────────────────────────────────────────────────────────

/**
 * Get or create the Maestro purpose session (singleton dialog).
 * Follows the same pattern as intro/access/rules purpose sessions.
 * @returns {{ themeId: string, dialogId: string }}
 */
export function getOrCreateMaestroSession() {
  const row = db
    .prepare(`SELECT d.id AS dialog_id, d.theme_id FROM dialogs d WHERE d.purpose = ? LIMIT 1`)
    .get("maestro");
  if (row) return { themeId: row.theme_id, dialogId: row.dialog_id };

  const themeId = crypto.randomUUID();
  const dialogId = crypto.randomUUID();
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO themes (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    ).run(themeId, "Maestro", now, now);
    db.prepare(
      `INSERT INTO dialogs (id, theme_id, title, created_at, updated_at, purpose) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(dialogId, themeId, "Maestro orchestrator", now, now, "maestro");
  })();
  return { themeId, dialogId };
}

// ── Stale Lock Detection ───────────────────────────────────────────────────────

/**
 * Detect and reset tasks stuck in "running" state for too long.
 * Called by the scheduler on each tick and before manual runs.
 * @returns {number} Number of tasks that were reset.
 */
export function resetStaleTasks() {
  const cutoff = new Date(Date.now() - STALE_LOCK_MINUTES * 60_000).toISOString();
  const staleRuns = db.prepare(
    `SELECT r.id, r.task_id FROM maestro_runs r
     JOIN maestro_tasks t ON t.id = r.task_id
     WHERE t.status = 'running' AND r.status = 'running' AND r.started_at < ?`,
  ).all(cutoff);

  if (staleRuns.length === 0) return 0;

  const now = new Date().toISOString();
  const resetIds = [];

  db.transaction(() => {
    for (const run of staleRuns) {
      // Mark the run as errored (stale)
      db.prepare(
        `UPDATE maestro_runs SET finished_at = ?, status = 'error', error_message = 'Run exceeded stale lock threshold (${STALE_LOCK_MINUTES} min)' WHERE id = ?`,
      ).run(now, run.id);
      // Reset task status to idle
      db.prepare(
        `UPDATE maestro_tasks SET status = 'idle', last_error = 'Previous run exceeded stale lock threshold', updated_at = ? WHERE id = ?`,
      ).run(now, run.task_id);
      resetIds.push(run.task_id);
    }
  })();

  console.log(`[maestro] Reset ${resetIds.length} stale task(s): ${resetIds.join(", ")}`);
  return resetIds.length;
}

// ── Task CRUD ──────────────────────────────────────────────────────────────────

/**
 * Create a new Maestro task.
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} [opts.description]
 * @param {string} [opts.taskType]
 * @param {string} [opts.providerId]
 * @param {string} [opts.modelId]
 * @param {string} [opts.scheduleCron]
 * @param {number} [opts.scheduleEnabled]
 * @param {string} [opts.systemPrompt]
 * @param {object} [opts.context]
 * @param {number} [opts.maxContextNodes]
 * @returns {object} The created task row.
 */
export function createTask(opts) {
  const id = crypto.randomUUID();
  const title = String(opts?.title ?? "").trim();
  if (!title) throw new Error("title is required");

  const taskType = String(opts?.taskType ?? "chat").trim();
  if (!TASK_TYPES.has(taskType)) throw new Error(`invalid task_type: ${taskType}`);

  const providerId = String(opts?.providerId ?? MAESTRO_SLOT).trim();
  const modelId = opts?.modelId ? String(opts.modelId).trim() : null;
  // If no explicit model, pick up the current slot model as default_model
  const defaultModel = opts?.defaultModel ? String(opts.defaultModel).trim() : (modelId ? null : resolveMaestroModel());
  const scheduleCron = opts?.scheduleCron ? String(opts.scheduleCron).trim() : null;
  // Validate cron expression if provided
  if (scheduleCron) {
    try { new Cron(scheduleCron); } catch (e) { throw new Error(`Invalid cron expression: ${e.message}`); }
  }
  const scheduleEnabled = scheduleCron ? (opts?.scheduleEnabled !== undefined ? (opts.scheduleEnabled ? 1 : 0) : 1) : 0;
  const systemPrompt = opts?.systemPrompt ? String(opts.systemPrompt).trim() : null;
  const contextJson = opts?.context ? JSON.stringify(opts.context) : null;
  const maxContextNodes =
    Number(opts?.maxContextNodes) > 0 ? Number(opts.maxContextNodes) : DEFAULT_MAX_CONTEXT_NODES;
  const retryOnError = opts?.retryOnError ? 1 : 0;
  const maxRetries = Number(opts?.maxRetries) > 0 ? Number(opts.maxRetries) : 3;
  const now = new Date().toISOString();

  // Single INSERT with all columns — migrations 015-018 guarantee these columns exist.
  // If a column is added in the future, add it here with a sensible DEFAULT rather than
  // introducing PRAGMA-based branching (which is fragile and already caused bugs).
  db.prepare(
    `INSERT INTO maestro_tasks
       (id, title, description, task_type, provider_id, model_id, default_model,
        schedule_cron, schedule_enabled, system_prompt, context_json,
        max_context_nodes, retry_on_error, max_retries, consecutive_errors,
        chain_to, chain_condition, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'idle', ?, ?)`,
  ).run(
    id, title,
    opts?.description ? String(opts.description).trim() : null,
    taskType, providerId, modelId, defaultModel,
    scheduleCron, scheduleEnabled, systemPrompt, contextJson,
    maxContextNodes, retryOnError, maxRetries,
    opts?.chainTo ? String(opts.chainTo).trim() : null,
    opts?.chainCondition ? String(opts.chainCondition).trim().toLowerCase() : 'success',
    now, now,
  );

  return getTask(id);
}

/**
 * Get a single task by id.
 * @param {string} id
 * @returns {object|null}
 */
export function getTask(id) {
  const row = db.prepare(`SELECT * FROM maestro_tasks WHERE id = ?`).get(id);
  return row ? _marshalTask(row) : null;
}

/**
 * List tasks with optional filters.
 * @param {object} [filters]
 * @param {string} [filters.status]
 * @param {string} [filters.taskType]
 * @param {number} [filters.scheduleEnabled]
 * @returns {object[]}
 */
export function listTasks(filters = {}) {
  let sql = `SELECT * FROM maestro_tasks`;
  const clauses = [];
  const params = [];

  if (filters.status) {
    clauses.push(`status = ?`);
    params.push(filters.status);
  }
  if (filters.taskType) {
    clauses.push(`task_type = ?`);
    params.push(filters.taskType);
  }
  if (filters.scheduleEnabled !== undefined) {
    clauses.push(`schedule_enabled = ?`);
    params.push(filters.scheduleEnabled ? 1 : 0);
  }

  if (clauses.length) sql += ` WHERE ` + clauses.join(" AND ");
  sql += ` ORDER BY created_at DESC`;

  return db.prepare(sql).all(...params).map(_marshalTask);
}

/**
 * Update a task.
 * @param {string} id
 * @param {object} patch
 * @returns {object|null} Updated task, or null if not found.
 */
export function updateTask(id, patch) {
  const existing = db.prepare(`SELECT * FROM maestro_tasks WHERE id = ?`).get(id);
  if (!existing) return null;

  const sets = [];
  const params = [];

  const apply = (field, value, validator) => {
    if (value === undefined) return;
    const v = validator ? validator(value) : value;
    sets.push(`${field} = ?`);
    params.push(v);
  };

  apply("title", patch.title, (v) => { const s = String(v).trim(); if (!s) throw new Error("title cannot be empty"); return s; });
  apply("description", patch.description, (v) => String(v).trim());
  apply("task_type", patch.taskType, (v) => { const s = String(v).trim(); if (!TASK_TYPES.has(s)) throw new Error(`invalid task_type: ${s}`); return s; });
  apply("provider_id", patch.providerId, (v) => String(v).trim());
  apply("model_id", patch.modelId, (v) => v ? String(v).trim() : null);
  apply("schedule_cron", patch.scheduleCron, (v) => {
    const s = v ? String(v).trim() : null;
    if (s) { try { new Cron(s); } catch (e) { throw new Error(`Invalid cron expression: ${e.message}`); } }
    return s;
  });
  apply("system_prompt", patch.systemPrompt, (v) => v ? String(v).trim() : null);
  apply("context_json", patch.context, (v) => v ? JSON.stringify(v) : null);
  apply("max_context_nodes", patch.maxContextNodes, (v) => Number(v) > 0 ? Number(v) : DEFAULT_MAX_CONTEXT_NODES);
  apply("default_model", patch.defaultModel, (v) => v ? String(v).trim() : null);
  apply("retry_on_error", patch.retryOnError, (v) => v ? 1 : 0);
  apply("max_retries", patch.maxRetries, (v) => Number(v) > 0 ? Number(v) : 3);
  apply("status", patch.status, (v) => { const s = String(v).trim(); if (!TASK_STATUSES.has(s)) throw new Error(`invalid status: ${s}`); return s; });
  apply("last_error", patch.lastError, (v) => v ? String(v).trim() : null);
  apply("chain_to", patch.chainTo, (v) => {
    if (!v) return null;
    const id = String(v).trim();
    // Validate target task exists
    const target = db.prepare(`SELECT id FROM maestro_tasks WHERE id = ?`).get(id);
    if (!target) throw new Error(`chain_to target task not found: ${id}`);
    // Prevent direct circular chains (A→B→A)
    const targetChain = db.prepare(`SELECT chain_to FROM maestro_tasks WHERE id = ?`).get(id);
    if (targetChain?.chain_to === existing.id) throw new Error(`Circular chain detected: task ${id} already chains back to this task`);
    return id;
  });
  apply("chain_condition", patch.chainCondition, (v) => {
    const valid = new Set(["success", "error", "always"]);
    const s = v ? String(v).trim().toLowerCase() : "success";
    if (!valid.has(s)) throw new Error(`invalid chain_condition: ${s}. Must be one of: success, error, always`);
    return s;
  });

  // scheduleEnabled: if cron is cleared, force disable
  if (patch.scheduleEnabled !== undefined) {
    const cronVal = patch.scheduleCron !== undefined ? patch.scheduleCron : existing.schedule_cron;
    const enabled = cronVal ? (patch.scheduleEnabled ? 1 : 0) : 0;
    sets.push(`schedule_enabled = ?`);
    params.push(enabled);
  }

  if (sets.length === 0) return _marshalTask(existing);

  sets.push(`updated_at = ?`);
  params.push(new Date().toISOString());
  params.push(id);

  db.prepare(`UPDATE maestro_tasks SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return getTask(id);
}

/**
 * Delete a task and its run history.
 * @param {string} id
 * @returns {boolean} True if deleted.
 */
export function deleteTask(id) {
  const result = db.prepare(`DELETE FROM maestro_tasks WHERE id = ?`).run(id);
  return result.changes > 0;
}

// ── Run Logging ────────────────────────────────────────────────────────────────

/**
 * Start a new run record.
 * @param {string} taskId
 * @param {object} [opts]
 * @param {string} [opts.sourceTaskId] — ID of the task that triggered this run (via run_task tool)
 * @returns {string} Run id.
 */
export function startRun(taskId, opts = {}) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  // Use cached schema info instead of PRAGMA per call
  const hasSourceTaskId = _hasRunCol("source_task_id");

  if (hasSourceTaskId && opts.sourceTaskId) {
    db.prepare(
      `INSERT INTO maestro_runs (id, task_id, started_at, status, source_task_id) VALUES (?, ?, ?, 'running', ?)`,
    ).run(id, taskId, now, opts.sourceTaskId);
  } else {
    db.prepare(
      `INSERT INTO maestro_runs (id, task_id, started_at, status) VALUES (?, ?, ?, 'running')`,
    ).run(id, taskId, now);
  }

  // Update task status to running, reset consecutive_errors on new run start
  const hasConsecutiveErrors = _hasTaskCol("consecutive_errors");

  if (hasConsecutiveErrors) {
    db.prepare(
      `UPDATE maestro_tasks SET status = 'running', consecutive_errors = 0, updated_at = ? WHERE id = ?`,
    ).run(now, taskId);
  } else {
    db.prepare(
      `UPDATE maestro_tasks SET status = 'running', updated_at = ? WHERE id = ?`,
    ).run(now, taskId);
  }

  return id;
}

/**
 * Finish a run record.
 * @param {string} runId
 * @param {object} opts
 * @param {string} opts.status  'success' | 'error'
 * @param {string} [opts.resultSummary]
 * @param {number} [opts.promptTokens]
 * @param {number} [opts.completionTokens]
 * @param {number} [opts.totalTokens]
 * @param {string} [opts.errorMessage]
 * @param {string} [opts.toolTrace]  JSON string of tool call trace
 */
export function finishRun(runId, opts) {
  const status = String(opts?.status ?? "success");
  if (!RUN_STATUSES.has(status) || status === "running") throw new Error(`invalid finish status: ${status}`);

  const now = new Date().toISOString();
  const run = db.prepare(`SELECT task_id FROM maestro_runs WHERE id = ?`).get(runId);
  if (!run) return;

  // Use cached schema info instead of PRAGMA per call
  const hasToolTrace = _hasRunCol("tool_trace");
  const hasModelId = _hasRunCol("model_id");

  if (hasToolTrace && hasModelId && opts?.toolTrace) {
    db.prepare(
      `UPDATE maestro_runs
         SET finished_at = ?, status = ?, result_summary = ?,
             prompt_tokens = ?, completion_tokens = ?, total_tokens = ?,
             error_message = ?, tool_trace = ?, model_id = ?
       WHERE id = ?`,
    ).run(
      now, status,
      opts?.resultSummary ? String(opts.resultSummary).trim() : null,
      Number(opts?.promptTokens) || 0,
      Number(opts?.completionTokens) || 0,
      Number(opts?.totalTokens) || 0,
      opts?.errorMessage ? String(opts.errorMessage).trim() : null,
      String(opts.toolTrace),
      opts?.modelId ? String(opts.modelId) : null,
      runId,
    );
  } else if (hasToolTrace && opts?.toolTrace) {
    db.prepare(
      `UPDATE maestro_runs
         SET finished_at = ?, status = ?, result_summary = ?,
             prompt_tokens = ?, completion_tokens = ?, total_tokens = ?,
             error_message = ?, tool_trace = ?
       WHERE id = ?`,
    ).run(
      now, status,
      opts?.resultSummary ? String(opts.resultSummary).trim() : null,
      Number(opts?.promptTokens) || 0,
      Number(opts?.completionTokens) || 0,
      Number(opts?.totalTokens) || 0,
      opts?.errorMessage ? String(opts.errorMessage).trim() : null,
      String(opts.toolTrace),
      runId,
    );
  } else {
    db.prepare(
      `UPDATE maestro_runs
         SET finished_at = ?, status = ?, result_summary = ?,
             prompt_tokens = ?, completion_tokens = ?, total_tokens = ?,
             error_message = ?
       WHERE id = ?`,
    ).run(
      now, status,
      opts?.resultSummary ? String(opts.resultSummary).trim() : null,
      Number(opts?.promptTokens) || 0,
      Number(opts?.completionTokens) || 0,
      Number(opts?.totalTokens) || 0,
      opts?.errorMessage ? String(opts.errorMessage).trim() : null,
      runId,
    );
  }

  // Update task status back to idle (or error) and increment run_count
  // With retry support: on error, check if task should auto-retry
  const hasConvHistory = _hasTaskCol("conversation_history");
  const hasConsecutiveErrors = _hasTaskCol("consecutive_errors");
  const hasRetryOnError = _hasTaskCol("retry_on_error");
  const hasMaxRetries = _hasTaskCol("max_retries");

  // Determine task status — on error, check if auto-retry applies
  let taskStatus;
  let shouldRetry = false;
  if (status === "success") {
    taskStatus = "idle";
  } else {
    // Error case — check retry policy
    if (hasRetryOnError && hasMaxRetries && hasConsecutiveErrors) {
      const task = db.prepare(
        `SELECT retry_on_error, max_retries, consecutive_errors FROM maestro_tasks WHERE id = ?`,
      ).get(run.task_id);
      const retryOnError = task?.retry_on_error ? true : false;
      const maxRetries = Number(task?.max_retries) || 3;
      const currentErrors = Number(task?.consecutive_errors) || 0;

      if (retryOnError && currentErrors < maxRetries) {
        // Auto-retry: set status to idle (so scheduler picks it up again)
        // consecutive_errors will be incremented below
        taskStatus = "idle";
        shouldRetry = true;
        console.log(`[maestro] Task ${run.task_id} error, auto-retry ${currentErrors + 1}/${maxRetries}`);
      } else {
        taskStatus = "error";
      }
    } else {
      taskStatus = "error";
    }
  }

  // Build the UPDATE statement dynamically based on available columns
  const sets = [
    "status = ?",
    "last_run_at = ?",
    "run_count = run_count + 1",
    "last_error = ?",
    "updated_at = ?",
  ];
  const params = [
    taskStatus, now,
    opts?.errorMessage ? String(opts.errorMessage).trim() : null,
    now,
  ];

  // Add consecutive_errors handling
  if (hasConsecutiveErrors) {
    if (status === "success") {
      sets.push("consecutive_errors = 0");
    } else {
      sets.push("consecutive_errors = consecutive_errors + 1");
    }
  }

  // Add conversation_history for successful runs
  if (hasConvHistory && status === "success" && opts?.resultSummary) {
    const task = db.prepare(`SELECT conversation_history FROM maestro_tasks WHERE id = ?`).get(run.task_id);
    let history = [];
    try {
      history = task?.conversation_history ? JSON.parse(task.conversation_history) : [];
    } catch { history = []; }
    history.push({
      at: now,
      summary: String(opts.resultSummary).trim().slice(0, 1000),
      tokens: Number(opts?.totalTokens) || 0,
      status,
    });
    // Keep only last 10 entries
    if (history.length > 10) history = history.slice(-10);
    sets.push("conversation_history = ?");
    params.push(JSON.stringify(history));
  }

  params.push(run.task_id);
  db.prepare(
    `UPDATE maestro_tasks SET ${sets.join(", ")} WHERE id = ?`,
  ).run(...params);

  // If auto-retry, recalculate next_run_at to schedule immediate retry
  if (shouldRetry) {
    // Set next_run_at to 1 minute from now for retry
    const retryAt = new Date(Date.now() + 60_000).toISOString();
    db.prepare(
      `UPDATE maestro_tasks SET next_run_at = ? WHERE id = ? AND schedule_cron IS NOT NULL`,
    ).run(retryAt, run.task_id);
  }
}

/**
 * Get runs for a task.
 * @param {string} taskId
 * @param {object} [opts]
 * @param {number} [opts.limit]
 * @param {string} [opts.status]
 * @returns {object[]}
 */
export function getTaskRuns(taskId, opts = {}) {
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200);
  let sql = `SELECT * FROM maestro_runs WHERE task_id = ?`;
  const params = [taskId];

  if (opts.status) {
    sql += ` AND status = ?`;
    params.push(opts.status);
  }

  sql += ` ORDER BY started_at DESC LIMIT ?`;
  params.push(limit);

  return db.prepare(sql).all(...params).map(_marshalRun);
}

/**
 * Get a single run by id.
 * @param {string} runId
 * @returns {object|null}
 */
export function getRun(runId) {
  const row = db.prepare(`SELECT * FROM maestro_runs WHERE id = ?`).get(runId);
  return row ? _marshalRun(row) : null;
}

// ── Chain Resolution ──────────────────────────────────────────────────────────

/**
 * Resolve the full task chain starting from a given task.
 * Returns an array of tasks in chain order: [this, next, next.next, ...]
 * Detects cycles and stops if one is found.
 * @param {string} taskId
 * @param {number} [maxDepth=10]
 * @returns {object[]}
 */
export function getTaskChain(taskId, maxDepth = 10) {
  const chain = [];
  const visited = new Set();
  let currentId = taskId;

  for (let i = 0; i < maxDepth && currentId; i++) {
    if (visited.has(currentId)) break; // cycle detected
    visited.add(currentId);
    const task = db.prepare(`SELECT * FROM maestro_tasks WHERE id = ?`).get(currentId);
    if (!task) break;
    chain.push(_marshalTask(task));
    currentId = task.chain_to;
  }

  return chain;
}

/**
 * Get tasks that chain TO a given task (i.e. upstream parents).
 * @param {string} taskId
 * @returns {object[]}
 */
export function getTaskChainParents(taskId) {
  const rows = db.prepare(
    `SELECT * FROM maestro_tasks WHERE chain_to = ?`,
  ).all(taskId);
  return rows.map(_marshalTask);
}

/**
 * Get the global chain graph — all tasks as nodes, chain links as edges.
 * Used by the frontend chain graph visualization.
 * @returns {{ nodes: object[], edges: object[] }}
 */
export function getChainGraph() {
  const tasks = db.prepare(
    `SELECT id, title, status, chain_to, chain_condition, task_type, schedule_cron, schedule_enabled FROM maestro_tasks`,
  ).all();

  const nodes = tasks.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    taskType: t.task_type,
    scheduleCron: t.schedule_cron,
    scheduleEnabled: !!t.schedule_enabled,
  }));

  const edges = [];
  for (const t of tasks) {
    if (t.chain_to) {
      // Verify target exists
      const target = tasks.find((tt) => tt.id === t.chain_to);
      if (target) {
        edges.push({
          from: t.id,
          to: t.chain_to,
          condition: t.chain_condition || "success",
        });
      }
    }
  }

  return { nodes, edges };
}

// ── Status ─────────────────────────────────────────────────────────────────────

/**
 * Get overall Maestro status summary.
 * @returns {object}
 */
export function getMaestroStatus() {
  const taskCounts = db.prepare(
    `SELECT status, COUNT(*) AS cnt FROM maestro_tasks GROUP BY status`,
  ).all();

  const totalTasks = taskCounts.reduce((sum, r) => sum + Number(r.cnt), 0);
  const byStatus = {};
  for (const r of taskCounts) byStatus[r.status] = Number(r.cnt);

  const scheduledCount = db.prepare(
    `SELECT COUNT(*) AS cnt FROM maestro_tasks WHERE schedule_enabled = 1`,
  ).get();

  const nextDue = db.prepare(
    `SELECT id, title, next_run_at FROM maestro_tasks
     WHERE schedule_enabled = 1 AND status = 'idle' AND next_run_at IS NOT NULL
     ORDER BY next_run_at ASC LIMIT 1`,
  ).get();

  const recentRuns = db.prepare(
    `SELECT COUNT(*) AS cnt FROM maestro_runs WHERE started_at >= datetime('now', '-24 hours')`,
  ).get();

  const lastRun = db.prepare(
    `SELECT r.*, t.title AS task_title FROM maestro_runs r
     JOIN maestro_tasks t ON t.id = r.task_id
     ORDER BY r.started_at DESC LIMIT 1`,
  ).get();

  return {
    slot: MAESTRO_SLOT,
    schedulerRunning: _schedulerRunning,
    totalTasks,
    byStatus,
    scheduledCount: Number(scheduledCount?.cnt || 0),
    nextDue: nextDue ? { id: nextDue.id, title: nextDue.title, nextRunAt: nextDue.next_run_at } : null,
    recentRuns24h: Number(recentRuns?.cnt || 0),
    lastRun: lastRun ? _marshalRun(lastRun) : null,
  };
}

// ── Marshal helpers ────────────────────────────────────────────────────────────

function _marshalTask(row) {
  const o = { ...row };
  o.scheduleEnabled = !!o.schedule_enabled;
  o.scheduleCron = o.schedule_cron;
  o.taskType = o.task_type;
  o.providerId = o.provider_id;
  o.modelId = o.model_id;
  o.systemPrompt = o.system_prompt;
  o.contextJson = o.context_json;
  o.maxContextNodes = o.max_context_nodes;
  o.lastRunAt = o.last_run_at;
  o.nextRunAt = o.next_run_at;
  o.runCount = o.run_count;
  o.lastError = o.last_error;
  o.createdAt = o.created_at;
  o.updatedAt = o.updated_at;
  o.maxToolRounds = o.max_tool_rounds || DEFAULT_MAX_TOOL_ROUNDS;
  o.defaultModel = o.default_model || null;
  o.retryOnError = !!o.retry_on_error;
  o.maxRetries = o.max_retries || 3;
  o.consecutiveErrors = o.consecutive_errors || 0;
  o.chainTo = o.chain_to || null;
  o.chainCondition = o.chain_condition || 'success';
  // parse context_json
  if (o.context_json) {
    try { o.context = JSON.parse(o.context_json); } catch { o.context = null; }
  } else {
    o.context = null;
  }
  // parse conversation_history
  if (o.conversation_history) {
    try { o.conversationHistory = JSON.parse(o.conversation_history); } catch { o.conversationHistory = []; }
  } else {
    o.conversationHistory = [];
  }
  return o;
}

function _marshalRun(row) {
  const o = { ...row };
  o.taskId = o.task_id;
  o.startedAt = o.started_at;
  o.finishedAt = o.finished_at;
  o.resultSummary = o.result_summary;
  o.promptTokens = o.prompt_tokens;
  o.completionTokens = o.completion_tokens;
  o.totalTokens = o.total_tokens;
  o.errorMessage = o.error_message;
  o.modelId = o.model_id || null;
  o.sourceTaskId = o.source_task_id || null;
  o.createdAt = o.created_at;
  // parse tool_trace
  if (o.tool_trace) {
    try { o.toolTrace = JSON.parse(o.tool_trace); } catch { o.toolTrace = null; }
  } else {
    o.toolTrace = null;
  }
  return o;
}
