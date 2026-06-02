/**
 * Maestro Context Builder — assembles real agent state for LLM injection.
 *
 * Gathers data from:
 *   - Memory graph (node/edge counts, categories, recent activity)
 *   - Maestro tasks (status, schedule info)
 *   - Providers (configured slots, OpenRouter balance)
 *   - Dialog stats (themes, dialogs, recent turns)
 *   - Rules (keeper bundle, compressed)
 *   - LocalFS (sandbox status, file listing)
 *   - System (uptime, memory, node version)
 *
 * Returns a structured text block injected as a system message before the
 * user prompt so the LLM always operates on factual data.
 */
import { db } from "../db/migrations.mjs";
import { listTasks, getMaestroStatus, resolveMaestroModel, MAESTRO_SLOT } from "./maestro.mjs";
import { readRulesKeeperBundlePayload } from "./rulesKeeper.mjs";
import { readAiModelListsCachePayload } from "./aiModelCache.mjs";
import { getToolAvailabilityStatus } from "./maestroTools.mjs";
import { resolveApiPort } from "../resolveApiPort.mjs";

const API_PORT = resolveApiPort(process.env.API_PORT);

/** Fallback model (only used if resolveMaestroModel() returns null). */
const MAESTRO_FALLBACK_MODEL = String(process.env.MAESTRO_MODEL ?? "").trim();

// ── Context section builders ───────────────────────────────────────────────────

function buildSystemContext() {
  const uptime = process.uptime();
  const mem = process.memoryUsage();
  const memMb = (mem.rss / 1024 / 1024).toFixed(1);

  // Timezone: server runs in UTC, but user is in a specific timezone.
  // MAESTRO_USER_TZ env var (e.g. "Europe/Moscow" or "UTC+3") tells Maestro
  // the user's local timezone. If not set, defaults to Europe/Moscow (UTC+3).
  const userTz = String(process.env.MAESTRO_USER_TZ ?? "Europe/Moscow").trim();
  const nowUtc = new Date();
  const utcStr = nowUtc.toISOString().replace("T", " ").slice(0, 19) + " UTC";
  // Format user-local time
  let localStr;
  try {
    localStr = nowUtc.toLocaleString("sv-SE", { timeZone: userTz }) + " " + userTz;
  } catch {
    localStr = utcStr + " (invalid TZ, using UTC)";
  }

  return [
    "## System",
    `- Node.js ${process.version}`,
    `- Uptime: ${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
    `- Memory RSS: ${memMb} MB`,
    `- API port: ${API_PORT}`,
    `- DB: SQLite (WAL mode)`,
    `- Maestro model: ${resolveMaestroModel() || MAESTRO_FALLBACK_MODEL || "(provider default)"}`,
    `- Current time (UTC): ${utcStr}`,
    `- User's local time: ${localStr}`,
    `- User timezone: ${userTz}`,
  ].join("\n");
}

function buildMemoryGraphContext() {
  try {
    const tbl = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='memory_graph_nodes'`).get();
    if (!tbl) return "## Memory Graph\n(no memory graph tables found)";

    const nodeCount = db.prepare(`SELECT COUNT(*) AS c FROM memory_graph_nodes`).get();
    const edgeCount = db.prepare(`SELECT COUNT(*) AS c FROM memory_graph_edges`).get();
    const categories = db.prepare(
      `SELECT category, COUNT(*) AS cnt FROM memory_graph_nodes GROUP BY category ORDER BY cnt DESC`,
    ).all();

    const catLines = categories.map((r) => `  ${r.category}: ${r.cnt}`).join("\n");

    // Recent nodes (last 10 updated)
    const recent = db.prepare(
      `SELECT category, label, updated_at FROM memory_graph_nodes ORDER BY updated_at DESC LIMIT 10`,
    ).all();
    const recentLines = recent.map((r) => `  [${r.category}] ${r.label}`).join("\n");

    return [
      "## Memory Graph",
      `- Nodes: ${nodeCount?.c || 0}, Edges: ${edgeCount?.c || 0}`,
      `- Categories:`,
      catLines || "  (none)",
      `- Recently updated:`,
      recentLines || "  (none)",
    ].join("\n");
  } catch (e) {
    return `## Memory Graph\n(error: ${e?.message || e})`;
  }
}

function buildTaskContext() {
  try {
    const tasks = listTasks();
    const status = getMaestroStatus();

    if (tasks.length === 0) {
      return "## Maestro Tasks\n(no tasks defined)";
    }

    const lines = tasks.map((t) => {
      const schedule = t.scheduleCron
        ? `cron=${t.scheduleCron} enabled=${t.scheduleEnabled} next=${t.nextRunAt || "n/a"}`
        : "one-shot";
      const retry = t.retryOnError ? ` retry=${t.consecutiveErrors}/${t.maxRetries}` : "";
      return `  [${t.status}] "${t.title}" (type=${t.taskType}, provider=${t.providerId}, ${schedule}${retry}) runs=${t.runCount} last=${t.lastRunAt || "never"}`;
    }).join("\n");

    return [
      "## Maestro Tasks",
      `- Total: ${status.totalTasks}, Scheduled: ${status.scheduledCount}, Scheduler: ${status.schedulerRunning ? "running" : "stopped"}`,
      `- Tasks:`,
      lines,
    ].join("\n");
  } catch (e) {
    return `## Maestro Tasks\n(error: ${e?.message || e})`;
  }
}

function buildProviderContext() {
  try {
    const modelCache = readAiModelListsCachePayload();
    const lists = modelCache?.lists || {};

    const slots = [
      { id: "openai", name: "OpenAI", hasKey: Boolean(String(process.env.OPENAI_API_KEY ?? "").trim()) },
      { id: "anthropic", name: "Anthropic", hasKey: Boolean(String(process.env.ANTHROPIC_API_KEY ?? "").trim()) },
      { id: "ollama", name: "Ollama (local)", hasKey: true },
      { id: "or-1", name: "OpenRouter Slot 1", hasKey: Boolean(String(process.env.OPENROUTER_API_KEY ?? "").trim()) },
      { id: "or-2", name: "OpenRouter Slot 2", hasKey: Boolean(String(process.env.OPENROUTER_API_KEY ?? "").trim()) },
      { id: "or-3", name: "OpenRouter Slot 3 (Maestro)", hasKey: Boolean(String(process.env.OPENROUTER_API_KEY ?? "").trim()) },
      { id: "gemini", name: "Gemini", hasKey: Boolean(String(process.env.GEMINI_API_KEY ?? "").trim()) },
    ];

    const slotLines = slots.map((s) => {
      const modelCount = lists[s.id] ? Object.values(lists[s.id]).flat().length : 0;
      return `  ${s.id} (${s.name}): ${s.hasKey ? "configured" : "no key"}, ${modelCount} models cached`;
    }).join("\n");

    // Build a list of known models with short aliases and full IDs.
    // This helps the LLM use correct model IDs instead of guessing.
    const knownModels = [
      { short: "deepseek-v4-flash",  full: "deepseek/deepseek-v4-flash" },
      { short: "deepseek-r1",        full: "deepseek/deepseek-r1" },
      { short: "Nemotron-free",       full: "nvidia/nemotron-3-super-120b-a12b:free" },
      { short: "Nemotron-nano",       full: "nvidia/nemotron-nano-9b-v2" },
      { short: "Kimi2.6-free",        full: "moonshotai/kimi-vl-a3b-thinking:free" },
      { short: "Llama4-Scout-free",   full: "meta-llama/llama-4-scout:free" },
      { short: "Qwen3-30B-free",      full: "qwen/qwen3-30b-a3b:free" },
      { short: "Mistral-Small-free",  full: "mistralai/mistral-small-3.1-24b-instruct:free" },
      { short: "Gemma3-27B-free",     full: "google/gemma-3-27b-it:free" },
      { short: "Phi4-free",           full: "microsoft/phi-4-reasoning-plus:free" },
    ];
    const modelLines = knownModels.map((m) => `  ${m.short} → ${m.full}`).join("\n");

    return [
      "## LLM Providers",
      slotLines,
      "",
      "## Known Models (short name → full model ID for modelId parameter)",
      "IMPORTANT: When specifying modelId in create_task or update_task, use the FULL model ID (right column).",
      modelLines,
    ].join("\n");
  } catch (e) {
    return `## LLM Providers\n(error: ${e?.message || e})`;
  }
}

function buildDialogContext() {
  try {
    const themes = db.prepare(`SELECT COUNT(*) AS c FROM themes`).get();
    const dialogs = db.prepare(`SELECT COUNT(*) AS c FROM dialogs`).get();
    const turns = db.prepare(`SELECT COUNT(*) AS c FROM conversation_turns`).get();

    // Recent dialogs (last 5)
    const recent = db.prepare(
      `SELECT d.title, d.purpose, d.updated_at, t.title AS theme_title
       FROM dialogs d
       JOIN themes t ON t.id = d.theme_id
       ORDER BY d.updated_at DESC LIMIT 5`,
    ).all();
    const recentLines = recent.map((r) => {
      const purpose = r.purpose ? ` [${r.purpose}]` : "";
      return `  "${r.title}"${purpose} (theme: ${r.themeTitle})`;
    }).join("\n");

    // Purpose sessions
    const purposes = db.prepare(
      `SELECT purpose, COUNT(*) AS cnt FROM dialogs WHERE purpose IS NOT NULL GROUP BY purpose`,
    ).all();
    const purposeLines = purposes.map((r) => `  ${r.purpose}: ${r.cnt} session(s)`).join("\n");

    // Turn stats (last 24h)
    const turns24h = db.prepare(
      `SELECT COUNT(*) AS c FROM conversation_turns WHERE user_message_at >= datetime('now', '-24 hours')`,
    ).get();

    return [
      "## Dialogs & Conversations",
      `- Themes: ${themes?.c || 0}, Dialogs: ${dialogs?.c || 0}, Turns: ${turns?.c || 0}`,
      `- Turns last 24h: ${turns24h?.c || 0}`,
      `- Purpose sessions:`,
      purposeLines || "  (none)",
      `- Recent dialogs:`,
      recentLines || "  (none)",
    ].join("\n");
  } catch (e) {
    return `## Dialogs & Conversations\n(error: ${e?.message || e})`;
  }
}

function buildRulesContext() {
  try {
    const bundle = readRulesKeeperBundlePayload();
    const sections = [];

    for (const [key, items] of Object.entries(bundle)) {
      if (!Array.isArray(items) || items.length === 0) continue;
      // Compress: just list the first line of each rule
      const compressed = items.slice(0, 20).map((it) => {
        const text = String(it?.text ?? it ?? "").trim();
        // Take just the first sentence or first 120 chars
        const first = text.split(/[.\n]/)[0].trim().slice(0, 120);
        return `  - ${first}`;
      }).join("\n");
      const overflow = items.length > 20 ? `\n  ... and ${items.length - 20} more` : "";
      sections.push(`### ${key} (${items.length} rules)\n${compressed}${overflow}`);
    }

    if (sections.length === 0) return "## Rules\n(no rules defined)";

    return ["## Rules", ...sections].join("\n\n");
  } catch (e) {
    return `## Rules\n(error: ${e?.message || e})`;
  }
}

function buildLocalFsContext() {
  const enabled = String(process.env.LOCALFS_ENABLED ?? "").trim().toLowerCase() === "true";
  const root = String(process.env.LOCALFS_ROOT ?? "").trim();

  if (!enabled) return "## File System\n(LocalFS not enabled)";

  return [
    "## File System",
    `- LocalFS enabled, root: ${root}`,
    `- Maestro tools: read_file, read_lines, list_files, find_files, grep_file, write_file, run_bash, create_task, update_task, delete_task, list_tasks, get_task_runs, run_task, add_memory_node, add_memory_edge, get_memory_nodes, get_dialogs, get_recent_turns, send_to_slot, save_report, read_last_report, semantic_search, rerank, backfill_embeddings`,
  ].join("\n");
}

/**
 * Build LocalFS context with async directory listing support.
 */
async function buildLocalFsContextAsync() {
  const enabled = String(process.env.LOCALFS_ENABLED ?? "").trim().toLowerCase() === "true";
  const root = String(process.env.LOCALFS_ROOT ?? "").trim();

  if (!enabled) return "## File System\n(LocalFS not enabled)";

  const lines = [
    "## File System",
    `- LocalFS enabled, root: ${root}`,
    `- Maestro tools: read_file, read_lines, list_files, find_files, grep_file, write_file, run_bash, create_task, update_task, delete_task, list_tasks, get_task_runs, run_task, add_memory_node, add_memory_edge, get_memory_nodes, get_dialogs, get_recent_turns, send_to_slot, save_report, read_last_report, semantic_search, rerank, backfill_embeddings`,
  ];

  // Get a quick directory listing of the sandbox root
  try {
    const url = `http://127.0.0.1:${API_PORT}/api/localfs/list?path=.&max=30`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.ok && data.entries && data.entries.length > 0) {
      const fileLines = data.entries.slice(0, 30).map((e) => {
        const size = e.type === "file" ? ` (${(e.size / 1024).toFixed(1)}KB)` : "/";
        return `  ${e.type === "dir" ? "[DIR]" : "[FILE]"} ${e.path}${size}`;
      }).join("\n");
      lines.push(`- Sandbox contents (${data.entries.length} entries):`);
      lines.push(fileLines);
      if (data.truncated) lines.push("  ... (more entries)");
    } else if (data.ok) {
      lines.push("- Sandbox is empty (no files yet)");
    } else {
      lines.push(`- Sandbox error: ${data.error}`);
    }
  } catch (e) {
    lines.push("- (could not list sandbox contents)");
  }

  return lines.join("\n");
}

function buildAnalyticsContext() {
  try {
    // Quick token usage stats
    const tokenTotal = db.prepare(
      `SELECT
         SUM(COALESCE(llm_prompt_tokens, 0)) AS p,
         SUM(COALESCE(llm_completion_tokens, 0)) AS c,
         SUM(COALESCE(llm_total_tokens, 0)) AS t
       FROM conversation_turns`,
    ).get();

    const auxTotal = db.prepare(
      `SELECT
         SUM(COALESCE(llm_prompt_tokens, 0)) AS p,
         SUM(COALESCE(llm_completion_tokens, 0)) AS c
       FROM analytics_aux_llm_usage`,
    ).get();

    const auxP = Number(auxTotal?.p) || 0;
    const auxC = Number(auxTotal?.c) || 0;

    const promptT = Number(tokenTotal?.p || 0) + auxP;
    const completionT = Number(tokenTotal?.c || 0) + auxC;

    // Aux by kind (last 7 days)
    const auxByKind = db.prepare(
      `SELECT request_kind, COUNT(*) AS cnt, SUM(COALESCE(llm_total_tokens, 0)) AS tokens
       FROM analytics_aux_llm_usage
       WHERE created_at >= datetime('now', '-7 days')
       GROUP BY request_kind ORDER BY cnt DESC`,
    ).all();
    const kindLines = auxByKind.map((r) => `  ${r.request_kind}: ${r.cnt} calls, ${r.tokens} tokens`).join("\n");

    return [
      "## Analytics (7-day window)",
      `- Total tokens: prompt=${promptT.toLocaleString()}, completion=${completionT.toLocaleString()}`,
      `- Auxiliary LLM calls (7 days):`,
      kindLines || "  (none)",
    ].join("\n");
  } catch (e) {
    return `## Analytics\n(error: ${e?.message || e})`;
  }
}

function buildToolAvailabilityContext() {
  try {
    const status = getToolAvailabilityStatus();
    const parts = [];

    if (status.available.length > 0) {
      parts.push(`Available: ${status.available.join(", ")}`);
    }
    if (status.unavailable.length > 0) {
      parts.push(`UNAVAILABLE (do NOT call these — they will fail): ${status.unavailable.join(", ")}`);
    }

    return [
      "## Tool Availability",
      parts.join("\n"),
      "IMPORTANT: Only call tools that are listed as Available. Calling unavailable tools wastes your tool-calling rounds.",
    ].join("\n");
  } catch (e) {
    return `## Tool Availability\n(error: ${e?.message || e})`;
  }
}

// ── Main builder ───────────────────────────────────────────────────────────────

const CONTEXT_MAX_CHARS = 12_000;  // trim total context to avoid token bloat

/**
 * Build the full Maestro context string.
 * When { async: true }, uses buildLocalFsContextAsync which includes
 * the actual sandbox directory listing; otherwise uses the sync version.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.sections] - which sections to include (default: all)
 * @param {boolean} [opts.async] - use async LocalFS builder (with listing)
 * @returns {string|Promise<string>}
 */
export function buildMaestroContext(opts = {}) {
  const allSections = {
    toolAvailability: buildToolAvailabilityContext,
    system: buildSystemContext,
    memoryGraph: buildMemoryGraphContext,
    tasks: buildTaskContext,
    providers: buildProviderContext,
    dialogs: buildDialogContext,
    rules: buildRulesContext,
    fileSystem: opts.async ? buildLocalFsContextAsync : buildLocalFsContext,
    analytics: buildAnalyticsContext,
  };

  const wanted = opts.sections || Object.keys(allSections);
  const parts = [];

  for (const key of wanted) {
    const builder = allSections[key];
    if (builder) {
      try {
        const text = builder();
        if (text) parts.push(text);
      } catch (e) {
        parts.push(`## ${key}\n(error: ${e?.message || e})`);
      }
    }
  }

  let result = parts.join("\n\n");

  // Trim if too long
  if (result.length > CONTEXT_MAX_CHARS) {
    result = result.slice(0, CONTEXT_MAX_CHARS) + "\n\n[...context trimmed to fit token budget]";
  }

  return result;
}

/**
 * Build the full Maestro context string with async LocalFS listing.
 * This is the preferred version for task execution — it includes
 * the actual sandbox contents in the context.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.sections] - which sections to include (default: all)
 * @returns {Promise<string>}
 */
export async function buildMaestroContextAsync(opts = {}) {
  const allSections = {
    toolAvailability: buildToolAvailabilityContext,
    system: buildSystemContext,
    memoryGraph: buildMemoryGraphContext,
    tasks: buildTaskContext,
    providers: buildProviderContext,
    dialogs: buildDialogContext,
    rules: buildRulesContext,
    fileSystem: buildLocalFsContextAsync,  // async version with listing
    analytics: buildAnalyticsContext,
  };

  const wanted = opts.sections || Object.keys(allSections);
  const parts = [];

  for (const key of wanted) {
    const builder = allSections[key];
    if (builder) {
      try {
        const text = await builder();
        if (text) parts.push(text);
      } catch (e) {
        parts.push(`## ${key}\n(error: ${e?.message || e})`);
      }
    }
  }

  let result = parts.join("\n\n");

  // Trim if too long
  if (result.length > CONTEXT_MAX_CHARS) {
    result = result.slice(0, CONTEXT_MAX_CHARS) + "\n\n[...context trimmed to fit token budget]";
  }

  return result;
}

/**
 * Get the context as a structured JSON object (for the /api/maestro/context endpoint).
 * @returns {object}
 */
export function getMaestroContextPayload() {
  return {
    system: _safeJson(buildSystemContext),
    memoryGraph: _safeJson(buildMemoryGraphContext),
    tasks: _safeJson(buildTaskContext),
    providers: _safeJson(buildProviderContext),
    dialogs: _safeJson(buildDialogContext),
    rules: _safeJson(buildRulesContext),
    fileSystem: _safeJson(buildLocalFsContext),
    analytics: _safeJson(buildAnalyticsContext),
    toolAvailability: _safeJson(buildToolAvailabilityContext),
  };
}

function _safeJson(fn) {
  try { return fn(); } catch (e) { return `error: ${e?.message || e}`; }
}
