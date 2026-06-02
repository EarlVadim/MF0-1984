/**
 * Maestro Tools — action interface for the orchestrator.
 *
 * Defines the tools Maestro can call during task execution.
 * Tool calls are detected in the LLM response and executed server-side.
 * Results are fed back into the conversation as tool response messages.
 *
 * Available tools (24):
 *   - read_file         — read a file from the LocalFS sandbox
 *   - read_lines        — read a specific line range from a file
 *   - list_files        — list directory contents
 *   - find_files        — find files by glob pattern
 *   - grep_file         — search inside a file for a pattern
 *   - write_file        — write content to a file in the sandbox
 *   - run_bash          — execute a shell command in the sandbox
 *   - create_task       — create a new Maestro task
 *   - update_task       — update an existing task
 *   - delete_task       — delete a Maestro task
 *   - list_tasks        — list all Maestro tasks
 *   - get_task_runs     — get run history for a task
 *   - run_task          — trigger another task to run immediately
 *   - add_memory_node   — create a new node in the memory graph
 *   - add_memory_edge   — create a relationship between two memory nodes
 *   - get_memory_nodes  — query the memory graph
 *   - get_dialogs       — list recent dialogs
 *   - get_recent_turns  — get recent conversation turns across dialogs
 *   - send_to_slot      — send a message to another LLM slot
 *   - save_report       — save a structured report to the sandbox for future comparison
 *   - read_last_report  — read the most recent saved report for this task
 *   - semantic_search   — search memory graph by semantic similarity (embeddings)
 *   - rerank            — rerank text passages by relevance (cohere/rerank-v3.5)
 *   - backfill_embeddings — compute embeddings for nodes missing them
 */
import crypto from "node:crypto";
import { db } from "../db/migrations.mjs";
import { createTask, updateTask, getTask, listTasks, deleteTask, getTaskRuns, MAESTRO_SLOT } from "./maestro.mjs";
import { resolveApiPort } from "../resolveApiPort.mjs";
import {
  embedText,
  semanticCandidateIds,
  scheduleNodeEmbedding,
  batchReindexMissingEmbeddings,
  buildNodeEmbedText,
} from "./memoryGraphEmbeddings.mjs";

const API_PORT = resolveApiPort(process.env.API_PORT);
const LOCALFS_ENABLED = String(process.env.LOCALFS_ENABLED ?? "").trim().toLowerCase() === "true";
const LOCALFS_ROOT = String(process.env.LOCALFS_ROOT ?? "").trim();

/** Rerank model on OpenRouter (env-configurable). Default: cohere/rerank-v3.5.
 *  Set MAESTRO_RERANK_MODEL to enable the rerank tool.
 *  Set to empty string or omit to disable.
 */
const MAESTRO_RERANK_MODEL = String(process.env.MAESTRO_RERANK_MODEL ?? "cohere/rerank-v3.5").trim() || null;
const RERANK_TIMEOUT_MS = 15_000;

/** Whether embedding is available (needs OPENROUTER_API_KEY, which is checked inside embedText). */
const EMBED_AVAILABLE = Boolean(String(process.env.OPENROUTER_API_KEY ?? "").trim());

// ── Tool availability check ────────────────────────────────────────────────────

/**
 * Check which tools are actually available based on runtime configuration.
 * Returns a summary for injecting into the Maestro context.
 * @returns {{ available: string[], unavailable: string[], details: object }}
 */
export function getToolAvailabilityStatus() {
  const localFsWorking = LOCALFS_ENABLED && LOCALFS_ROOT;
  const details = {
    read_file:    { available: localFsWorking, reason: localFsWorking ? null : "LocalFS not enabled or root not configured" },
    read_lines:   { available: localFsWorking, reason: localFsWorking ? null : "LocalFS not enabled or root not configured" },
    list_files:   { available: localFsWorking, reason: localFsWorking ? null : "LocalFS not enabled or root not configured" },
    find_files:   { available: localFsWorking, reason: localFsWorking ? null : "LocalFS not enabled or root not configured" },
    grep_file:    { available: localFsWorking, reason: localFsWorking ? null : "LocalFS not enabled or root not configured" },
    write_file:   { available: localFsWorking, reason: localFsWorking ? null : "LocalFS not enabled or root not configured" },
    run_bash:     { available: localFsWorking, reason: localFsWorking ? null : "LocalFS not enabled or root not configured" },
    create_task:  { available: true, reason: null },
    update_task:  { available: true, reason: null },
    delete_task:  { available: true, reason: null },
    list_tasks:   { available: true, reason: null },
    get_task_runs:{ available: true, reason: null },
    run_task:     { available: true, reason: null },
    add_memory_node: { available: true, reason: null },
    add_memory_edge: { available: true, reason: null },
    get_memory_nodes: { available: true, reason: null },
    get_dialogs:  { available: true, reason: null },
    get_recent_turns: { available: true, reason: null },
    send_to_slot: { available: true, reason: null },
    save_report:      { available: localFsWorking, reason: localFsWorking ? null : "LocalFS not enabled or root not configured" },
    read_last_report: { available: localFsWorking, reason: localFsWorking ? null : "LocalFS not enabled or root not configured" },
    semantic_search:     { available: EMBED_AVAILABLE, reason: EMBED_AVAILABLE ? null : "OPENROUTER_API_KEY not configured" },
    rerank:              { available: Boolean(MAESTRO_RERANK_MODEL), reason: MAESTRO_RERANK_MODEL ? null : "MAESTRO_RERANK_MODEL not configured" },
    backfill_embeddings: { available: EMBED_AVAILABLE, reason: EMBED_AVAILABLE ? null : "OPENROUTER_API_KEY not configured" },
  };

  const available = Object.entries(details).filter(([, v]) => v.available).map(([k]) => k);
  const unavailable = Object.entries(details).filter(([, v]) => !v.available).map(([k, v]) => `${k} (${v.reason})`);

  return { available, unavailable, details };
}

// ── Tool definitions (OpenAI function-calling format) ──────────────────────────

// ── OpenRouter Rerank helper ─────────────────────────────────────────────────

/**
 * Call the OpenRouter rerank API through the server proxy.
 * Takes a query and a list of documents, returns them ranked by relevance.
 *
 * API: POST https://openrouter.ai/api/v1/rerank
 * Through proxy: POST http://127.0.0.1:${API_PORT}/api/llm/${MAESTRO_SLOT}/api/v1/rerank
 *
 * @param {string} query - the search query
 * @param {string[]} documents - list of text documents to rank
 * @param {number} [topN=10] - max results to return
 * @returns {Promise<Array<{ index: number, relevance_score: number, document: { text: string } }>>}
 */
async function _rerankDocuments(query, documents, topN = 10) {
  const url = `http://127.0.0.1:${API_PORT}/api/llm/${MAESTRO_SLOT}/api/v1/rerank`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RERANK_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MAESTRO_RERANK_MODEL,
        query,
        documents,
        top_n: Math.min(topN, documents.length),
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const err = await res.text().catch(() => "");
      throw new Error(`Rerank API ${res.status}: ${err.slice(0, 300)}`);
    }

    const json = await res.json();
    if (!json.results || !Array.isArray(json.results)) {
      throw new Error(`Unexpected rerank response: ${JSON.stringify(json).slice(0, 300)}`);
    }

    return json.results;
  } catch (e) {
    clearTimeout(timer);
    if (e.name === "AbortError") {
      throw new Error(`Rerank timeout (${RERANK_TIMEOUT_MS}ms)`);
    }
    throw e;
  }
}

export const MAESTRO_TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the full contents of a file from the sandboxed file system. Returns text content (max 8KB).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path within the sandbox" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_lines",
      description: "Read a specific line range from a file in the sandbox. More efficient than read_file for large files. Lines are 1-indexed.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path within the sandbox" },
          from: { type: "integer", description: "Start line number (1-indexed, default: 1)", default: 1 },
          to: { type: "integer", description: "End line number (default: from + 99)", default: 100 },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files and directories at a given path in the sandbox. Use '.' for root.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative directory path (default: root '.')" , default: "." },
          recursive: { type: "boolean", description: "List recursively", default: false },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_files",
      description: "Find files matching a glob pattern in the sandbox. Supports * (any filename) and ** (any path).",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern (e.g. '**/*.js', '*.md', 'logs/**/*.log')" },
          path: { type: "string", description: "Base directory to search from (default: root)", default: "." },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep_file",
      description: "Search for a text pattern inside a file. Returns matching lines with surrounding context and line numbers.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path within the sandbox" },
          pattern: { type: "string", description: "Search pattern (plain text or regex)" },
          regex: { type: "boolean", description: "Treat pattern as regex (default: false, plain text search)", default: false },
          context: { type: "integer", description: "Number of context lines around each match (default: 3)", default: 3 },
        },
        required: ["path", "pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file in the sandboxed file system. Creates the file and parent directories if they don't exist.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path within the sandbox" },
          content: { type: "string", description: "The text content to write" },
          append: { type: "boolean", description: "Append to file instead of overwriting (default: false)", default: false },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_bash",
      description: "Execute a shell command in the sandbox. Working directory is inside the sandbox root. Returns exitCode, stdout, stderr. Note: some commands (sudo, curl, wget, ssh) are blocked for security.",
      parameters: {
        type: "object",
        properties: {
          cmd: { type: "string", description: "The shell command to run" },
          cwd: { type: "string", description: "Working directory (relative to sandbox root, default: root)" },
        },
        required: ["cmd"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_task",
      description: "Create a new Maestro scheduled task. You can use this to set up new periodic checks, delegate work, or schedule reminders. If modelId is not specified, the current slot model is used automatically. When scheduleCron is provided, the task is enabled by default unless scheduleEnabled is explicitly set to false.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Task title" },
          description: { type: "string", description: "Task description / instructions for the task" },
          scheduleCron: { type: "string", description: "Cron expression for scheduling (e.g. '*/10 * * * *' for every 10 minutes)" },
          scheduleEnabled: { type: "boolean", description: "Enable the schedule immediately (default: true when scheduleCron is provided, false otherwise)" },
          taskType: { type: "string", enum: ["chat", "keeper", "custom"], default: "chat" },
          modelId: { type: "string", description: "Model to use for this task (e.g. 'nvidia/nemotron-3-super-120b-a12b:free'). If omitted, the current slot model is used." },
          retryOnError: { type: "boolean", description: "Auto-retry on error (default: false)" },
          maxRetries: { type: "integer", description: "Max consecutive retries before giving up (default: 3)" },
          chainTo: { type: "string", description: "Task ID to automatically trigger after THIS task completes. Creates a task pipeline. The chained task will receive this task's result as context." },
          chainCondition: { type: "string", enum: ["success", "error", "always"], description: "When to trigger the chained task: 'success' (default, only on successful run), 'error' (only on error), 'always' (on any completion)." },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_task",
      description: "Update an existing Maestro task (change schedule, enable/disable, update description, change model, etc.).",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "The task ID to update" },
          title: { type: "string", description: "New title" },
          description: { type: "string", description: "New description" },
          scheduleCron: { type: "string", description: "New cron expression" },
          scheduleEnabled: { type: "boolean", description: "Enable or disable the schedule" },
          status: { type: "string", enum: ["idle", "disabled"], description: "Task status" },
          modelId: { type: "string", description: "Change the model used for this task (e.g. 'nvidia/nemotron-3-super-120b-a12b:free'). Set to empty string to reset to slot default." },
          retryOnError: { type: "boolean", description: "Auto-retry on error" },
          maxRetries: { type: "integer", description: "Max consecutive retries before giving up" },
          chainTo: { type: "string", description: "Set the task this one chains to after completion. Pass a task ID to create a chain, or empty string to clear." },
          chainCondition: { type: "string", enum: ["success", "error", "always"], description: "When to trigger the chained task: 'success' (default), 'error', 'always'." },
        },
        required: ["taskId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_task",
      description: "Delete a Maestro task by ID. Use to remove tasks that are no longer needed.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "The task ID to delete" },
        },
        required: ["taskId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_tasks",
      description: "List all Maestro tasks with their status, schedule, and run counts. Use to see what tasks exist and their current state.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", description: "Filter by status (idle, running, error, disabled)" },
          taskType: { type: "string", description: "Filter by task type (chat, keeper, custom)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_task_runs",
      description: "Get run history for a specific Maestro task. Shows recent executions with status, tokens used, and summaries.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "The task ID to get runs for" },
          limit: { type: "integer", description: "Max runs to return (default 10, max 50)", default: 10 },
        },
        required: ["taskId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_task",
      description: "Trigger another Maestro task to run immediately (fire-and-forget). The target task will be executed by the scheduler. Returns the run ID so you can check on it later. Note: you cannot run a task that is already running.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "The task ID to trigger" },
        },
        required: ["taskId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_memory_node",
      description: "Create a new node in the memory graph. Use this to record observations, decisions, facts, or any information worth remembering for future task executions. Each node has a category, label, and optional blob (detailed content).",
      parameters: {
        type: "object",
        properties: {
          category: { type: "string", description: "Node category (e.g. 'Observation', 'Decision', 'Fact', 'Project', 'Note')" },
          label: { type: "string", description: "Short label/title for this node" },
          blob: { type: "string", description: "Detailed content or description (optional)" },
        },
        required: ["category", "label"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_memory_edge",
      description: "Create a directed relationship (edge) between two memory nodes. Use to link related concepts, e.g. 'Decision X depends on Fact Y'.",
      parameters: {
        type: "object",
        properties: {
          fromNodeId: { type: "string", description: "Source node ID" },
          toNodeId: { type: "string", description: "Target node ID" },
          relation: { type: "string", description: "Relationship type (e.g. 'related_to', 'depends_on', 'caused', 'derived_from')" },
        },
        required: ["fromNodeId", "toNodeId", "relation"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_memory_nodes",
      description: "Query the memory graph. Returns nodes by category or search term.",
      parameters: {
        type: "object",
        properties: {
          category: { type: "string", description: "Filter by category (People, Projects, Interests, etc.)" },
          search: { type: "string", description: "Search term to match against node labels" },
          limit: { type: "integer", description: "Max nodes to return (default 20, max 100)", default: 20 },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_dialogs",
      description: "Get recent dialog/conversation information.",
      parameters: {
        type: "object",
        properties: {
          purpose: { type: "string", description: "Filter by purpose (intro, rules, access, maestro, or null for regular)" },
          limit: { type: "integer", description: "Max dialogs to return (default 10)", default: 10 },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_recent_turns",
      description: "Get recent conversation turns from any dialog. Use to see what the user has been talking about recently.",
      parameters: {
        type: "object",
        properties: {
          dialogId: { type: "string", description: "Specific dialog ID (optional, returns latest from all dialogs if omitted)" },
          limit: { type: "integer", description: "Max turns to return (default 10, max 30)", default: 10 },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_to_slot",
      description: "Send a prompt to another LLM provider slot and get the response. Use to delegate work to specialized models.",
      parameters: {
        type: "object",
        properties: {
          slot: { type: "string", description: "Provider slot ID (or-1, or-2, or-3, openai, anthropic, ollama, gemini). Prefer or-3 (your own slot) for OpenRouter model availability checks." },
          prompt: { type: "string", description: "The prompt/message to send" },
          model: { type: "string", description: "Specific model ID to use (optional)" },
        },
        required: ["slot", "prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_report",
      description: "Save a structured report for this task to the sandbox. Reports are stored in reports/<task-title-slug>/ and named by timestamp. Use this at the end of periodic checks so that future runs can compare current state against previous reports. Call this AFTER you have written your final analysis.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Report title (e.g. 'Periodic check 01.06.2026 07:30')" },
          content: { type: "string", description: "Full Markdown report content to save" },
          category: { type: "string", description: "Report category for organizing (default: 'check')", default: "check" },
        },
        required: ["title", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_last_report",
      description: "Read the most recent saved report for this task. Use at the START of a periodic check to compare current state with the previous check. Returns the report content and metadata (timestamp, category). Returns null if no previous report exists.",
      parameters: {
        type: "object",
        properties: {
          category: { type: "string", description: "Filter by report category (default: any category)", default: "" },
        },
        required: [],
      },
    },
  },
  // ── Semantic search & Rerank tools ─────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "semantic_search",
      description: "Search memory graph nodes by semantic similarity using embeddings. Unlike get_memory_nodes (which uses keyword matching with LIKE), this finds nodes by meaning — e.g. 'system performance issues' will match nodes about 'slow response times' even without shared keywords. Returns nodes ranked by cosine similarity to the query.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural language search query describing what you're looking for" },
          limit: { type: "integer", description: "Max results to return (default 10, max 50)", default: 10 },
          category: { type: "string", description: "Filter by category before searching (optional, e.g. 'Observation', 'Decision')" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rerank",
      description: "Rerank a list of text passages by relevance to a query using a specialized reranking model (cohere/rerank-v3.5). Use this to improve the quality of search results — e.g. after getting_memory_nodes or semantic_search, pass the results through rerank to get the most relevant items first. Much more accurate than simple keyword matching.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The query to rank documents against" },
          documents: {
            type: "array",
            items: { type: "string" },
            description: "List of text documents/passages to rerank (max 100)",
          },
          topN: { type: "integer", description: "Number of top results to return (default 10, max 50)", default: 10 },
        },
        required: ["query", "documents"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "backfill_embeddings",
      description: "Compute and store embeddings for memory graph nodes that don't have them yet. Call this once after setting up the system, or periodically to ensure all nodes are searchable via semantic_search. Processes up to 40 nodes per call. Returns the count of nodes processed and any failures.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
];

// ── Tool executor ──────────────────────────────────────────────────────────────

/**
 * Execute a tool call and return the result string.
 *
 * @param {string} toolName
 * @param {object} args
 * @param {object} [context]
 * @param {string} [context.sourceTaskId] — ID of the task calling this tool
 * @returns {Promise<string>} JSON-serialized result
 */
export async function executeToolCall(toolName, args, context = {}) {
  try {
    // Inject context into args for tools that need it
    const enrichedArgs = { ...args, _sourceTaskId: context.sourceTaskId };

    switch (toolName) {
      case "read_file":
        return await _toolReadFile(enrichedArgs);
      case "read_lines":
        return await _toolReadLines(enrichedArgs);
      case "list_files":
        return await _toolListFiles(enrichedArgs);
      case "find_files":
        return await _toolFindFiles(enrichedArgs);
      case "grep_file":
        return await _toolGrepFile(enrichedArgs);
      case "write_file":
        return await _toolWriteFile(enrichedArgs);
      case "run_bash":
        return await _toolRunBash(enrichedArgs);
      case "create_task":
        return await _toolCreateTask(enrichedArgs);
      case "update_task":
        return await _toolUpdateTask(enrichedArgs);
      case "delete_task":
        return _toolDeleteTask(enrichedArgs);
      case "list_tasks":
        return _toolListTasks(enrichedArgs);
      case "get_task_runs":
        return _toolGetTaskRuns(enrichedArgs);
      case "run_task":
        return await _toolRunTask(enrichedArgs);
      case "add_memory_node":
        return _toolAddMemoryNode(enrichedArgs);
      case "add_memory_edge":
        return _toolAddMemoryEdge(enrichedArgs);
      case "get_memory_nodes":
        return _toolGetMemoryNodes(enrichedArgs);
      case "get_dialogs":
        return _toolGetDialogs(enrichedArgs);
      case "get_recent_turns":
        return _toolGetRecentTurns(enrichedArgs);
      case "send_to_slot":
        return await _toolSendToSlot(enrichedArgs);
      case "save_report":
        return await _toolSaveReport(enrichedArgs);
      case "read_last_report":
        return await _toolReadLastReport(enrichedArgs);
      case "semantic_search":
        return await _toolSemanticSearch(enrichedArgs);
      case "rerank":
        return await _toolRerank(enrichedArgs);
      case "backfill_embeddings":
        return await _toolBackfillEmbeddings(enrichedArgs);
      default:
        return JSON.stringify({ error: `Unknown tool: ${toolName}` });
    }
  } catch (e) {
    return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
  }
}

// ── Tool implementations ──────────────────────────────────────────────────────

async function _toolReadFile(args) {
  if (!LOCALFS_ENABLED) return JSON.stringify({ error: "LocalFS not enabled" });
  try {
    const url = `http://127.0.0.1:${API_PORT}/api/localfs/read?path=${encodeURIComponent(args.path || "")}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data.ok) return JSON.stringify({ error: data.error });
    // Truncate very large files
    const content = String(data.content || "");
    const trimmed = content.length > 8000 ? content.slice(0, 8000) + "\n...[truncated]" : content;
    return JSON.stringify({ path: data.path, sizeBytes: data.sizeBytes, content: trimmed });
  } catch (e) {
    return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
  }
}

async function _toolReadLines(args) {
  if (!LOCALFS_ENABLED) return JSON.stringify({ error: "LocalFS not enabled" });
  if (!args.path) return JSON.stringify({ error: "path is required" });
  try {
    const from = args.from || 1;
    const to = args.to || (from + 99);
    const url = `http://127.0.0.1:${API_PORT}/api/localfs/read_lines?path=${encodeURIComponent(args.path)}&from=${from}&to=${to}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data.ok) return JSON.stringify({ error: data.error });
    // Truncate content for tool response
    const content = String(data.content || "");
    const trimmed = content.length > 8000 ? content.slice(0, 8000) + "\n...[truncated]" : content;
    return JSON.stringify({ path: data.path, from: data.from, to: data.to, totalLines: data.totalLines, content: trimmed });
  } catch (e) {
    return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
  }
}

async function _toolListFiles(args) {
  if (!LOCALFS_ENABLED) return JSON.stringify({ error: "LocalFS not enabled" });
  try {
    const path = args.path || ".";
    const recursive = args.recursive ? "1" : "0";
    const url = `http://127.0.0.1:${API_PORT}/api/localfs/list?path=${encodeURIComponent(path)}&recursive=${recursive}&max=100`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data.ok) return JSON.stringify({ error: data.error });
    return JSON.stringify({ path: data.path, entries: data.entries, truncated: data.truncated });
  } catch (e) {
    return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
  }
}

async function _toolFindFiles(args) {
  if (!LOCALFS_ENABLED) return JSON.stringify({ error: "LocalFS not enabled" });
  if (!args.pattern) return JSON.stringify({ error: "pattern is required" });
  try {
    const path = args.path || ".";
    const url = `http://127.0.0.1:${API_PORT}/api/localfs/find?pattern=${encodeURIComponent(args.pattern)}&path=${encodeURIComponent(path)}&max=100`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data.ok) return JSON.stringify({ error: data.error });
    return JSON.stringify({ pattern: data.pattern, results: data.results, truncated: data.truncated });
  } catch (e) {
    return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
  }
}

async function _toolGrepFile(args) {
  if (!LOCALFS_ENABLED) return JSON.stringify({ error: "LocalFS not enabled" });
  if (!args.path) return JSON.stringify({ error: "path is required" });
  if (!args.pattern) return JSON.stringify({ error: "pattern is required" });
  try {
    const regex = args.regex ? "1" : "0";
    const context = args.context ?? 3;
    const url = `http://127.0.0.1:${API_PORT}/api/localfs/grep?path=${encodeURIComponent(args.path)}&pattern=${encodeURIComponent(args.pattern)}&regex=${regex}&context=${context}&max_matches=50`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data.ok) return JSON.stringify({ error: data.error });
    return JSON.stringify({ path: data.path, pattern: data.pattern, matchCount: data.matchCount, totalLines: data.totalLines, matches: data.matches, truncated: data.truncated });
  } catch (e) {
    return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
  }
}

async function _toolWriteFile(args) {
  if (!LOCALFS_ENABLED) return JSON.stringify({ error: "LocalFS not enabled" });
  if (!args.path) return JSON.stringify({ error: "path is required" });
  if (args.content === undefined || args.content === null) return JSON.stringify({ error: "content is required" });
  try {
    const url = `http://127.0.0.1:${API_PORT}/api/localfs/write`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: args.path,
        content: args.content,
        append: args.append ? true : false,
      }),
    });
    const data = await res.json();
    if (!data.ok) return JSON.stringify({ error: data.error });
    return JSON.stringify({ ok: true, path: data.path, bytesWritten: data.sizeBytes || data.bytesWritten });
  } catch (e) {
    return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
  }
}

async function _toolRunBash(args) {
  if (!LOCALFS_ENABLED) return JSON.stringify({ error: "LocalFS not enabled. Shell commands are unavailable." });
  if (!args.cmd) return JSON.stringify({ error: "cmd is required" });
  try {
    const url = `http://127.0.0.1:${API_PORT}/api/localfs/bash`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cmd: args.cmd, cwd: args.cwd }),
    });
    const data = await res.json();

    // LocalFS returns ok:true for all executed commands (even with non-zero exitCode).
    // ok:false means the API itself rejected the command (blocked, invalid, etc.)
    if (data.ok === false) {
      return JSON.stringify({ error: data.error || "Command rejected by sandbox", exitCode: data.exitCode });
    }

    // Command executed — return full result including exitCode
    // Non-zero exitCode is a valid result, not an error
    const stdout = (data.stdout || "").trim();
    const stderr = (data.stderr || "").trim();
    const result = {
      exitCode: data.exitCode,
      stdout: stdout.slice(0, 4000),
      stderr: stderr.slice(0, 1000),
    };
    // Add hint if command failed with no output
    if (data.exitCode !== 0 && !stdout && !stderr) {
      result.hint = "Command exited with non-zero code and produced no output. The command may not exist in the sandbox PATH or the cwd may be invalid.";
    }
    return JSON.stringify(result);
  } catch (e) {
    return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
  }
}

async function _toolCreateTask(args) {
  try {
    const task = createTask({
      title: args.title,
      description: args.description,
      scheduleCron: args.scheduleCron,
      scheduleEnabled: args.scheduleEnabled,
      taskType: args.taskType,
      modelId: args.modelId,
      retryOnError: args.retryOnError,
      maxRetries: args.maxRetries,
      chainTo: args.chainTo || null,
      chainCondition: args.chainCondition || undefined,
    });

    // If the task has a cron schedule, calculate next_run_at so the scheduler picks it up.
    // Without this, next_run_at stays NULL and the scheduler never runs the task.
    let nextRunAt = null;
    if (task.scheduleCron) {
      try {
        const { recalcNextRunAt } = await import("./maestroScheduler.mjs");
        nextRunAt = recalcNextRunAt(task.id);
      } catch (e) {
        console.warn(`[maestro-tools] Could not recalcNextRunAt for task ${task.id}:`, e.message);
      }
    }

    return JSON.stringify({ ok: true, task: { id: task.id, title: task.title, scheduleCron: task.scheduleCron, scheduleEnabled: task.scheduleEnabled, status: task.status, modelId: task.modelId, defaultModel: task.defaultModel, nextRunAt: nextRunAt || task.nextRunAt, retryOnError: task.retryOnError, maxRetries: task.maxRetries, chainTo: task.chainTo, chainCondition: task.chainCondition } });
  } catch (e) {
    return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
  }
}

async function _toolUpdateTask(args) {
  try {
    const patch = {
      title: args.title,
      description: args.description,
      scheduleCron: args.scheduleCron,
      scheduleEnabled: args.scheduleEnabled,
      status: args.status,
      retryOnError: args.retryOnError,
      maxRetries: args.maxRetries,
      chainTo: args.chainTo !== undefined ? (args.chainTo || null) : undefined,
      chainCondition: args.chainCondition || undefined,
    };
    // modelId: if explicitly set (including empty string to reset), pass it through
    if (args.modelId !== undefined) {
      patch.modelId = args.modelId || null;  // empty string → null → clear model override
    }
    const task = updateTask(args.taskId, patch);
    if (!task) return JSON.stringify({ error: "Task not found" });

    // If schedule was enabled or cron changed, recalculate next_run_at
    if (task.scheduleCron && task.scheduleEnabled) {
      try {
        const { recalcNextRunAt } = await import("./maestroScheduler.mjs");
        recalcNextRunAt(task.id);
      } catch (e) {
        console.warn(`[maestro-tools] Could not recalcNextRunAt for task ${task.id}:`, e.message);
      }
    }

    return JSON.stringify({ ok: true, task: { id: task.id, title: task.title, scheduleCron: task.scheduleCron, scheduleEnabled: task.scheduleEnabled, status: task.status, modelId: task.modelId, defaultModel: task.defaultModel, retryOnError: task.retryOnError, maxRetries: task.maxRetries, chainTo: task.chainTo, chainCondition: task.chainCondition } });
  } catch (e) {
    return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
  }
}

function _toolDeleteTask(args) {
  try {
    if (!args.taskId) return JSON.stringify({ error: "taskId is required" });
    // Prevent self-deletion: a task cannot delete itself while running (Roadmap step 10)
    if (args._sourceTaskId && args._sourceTaskId === args.taskId) {
      return JSON.stringify({ error: "Cannot delete the task that is currently running (self-deletion protection)" });
    }
    const deleted = deleteTask(args.taskId);
    return JSON.stringify({ ok: true, deleted });
  } catch (e) {
    return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
  }
}

function _toolListTasks(args) {
  try {
    const filters = {};
    if (args.status) filters.status = args.status;
    if (args.taskType) filters.taskType = args.taskType;
    const tasks = listTasks(filters);
    // Return a compact view to save tokens
    const compact = tasks.map((t) => ({
      id: t.id,
      title: t.title,
      type: t.taskType,
      status: t.status,
      cron: t.scheduleCron,
      enabled: t.scheduleEnabled,
      nextRun: t.nextRunAt,
      runs: t.runCount,
      lastRun: t.lastRunAt,
      chainTo: t.chainTo || null,
      chainCondition: t.chainCondition || "success",
    }));
    return JSON.stringify({ count: compact.length, tasks: compact });
  } catch (e) {
    return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
  }
}

function _toolGetTaskRuns(args) {
  try {
    if (!args.taskId) return JSON.stringify({ error: "taskId is required" });
    const task = getTask(args.taskId);
    if (!task) return JSON.stringify({ error: "Task not found" });
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);
    const runs = getTaskRuns(args.taskId, { limit });
    // Compact view
    const compact = runs.map((r) => ({
      id: r.id,
      status: r.status,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      tokens: r.totalTokens,
      summary: (r.resultSummary || "").slice(0, 200),
      error: r.errorMessage,
    }));
    return JSON.stringify({ count: compact.length, runs: compact });
  } catch (e) {
    return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
  }
}

async function _toolRunTask(args) {
  try {
    if (!args.taskId) return JSON.stringify({ error: "taskId is required" });
    // Prevent recursive execution: a task cannot trigger itself (ping-pong protection)
    if (args._sourceTaskId && args._sourceTaskId === args.taskId) {
      return JSON.stringify({ error: "Cannot run the same task that is currently running (self-trigger protection)" });
    }
    const task = getTask(args.taskId);
    if (!task) return JSON.stringify({ error: "Task not found" });
    if (task.status === "running") return JSON.stringify({ error: "Task is already running", hint: "Try again later or use the scheduler" });

    // Import executeTask lazily to avoid circular import at module level
    const { executeTask } = await import("./maestroScheduler.mjs");
    const result = await executeTask(args.taskId, { sourceTaskId: args._sourceTaskId });

    return JSON.stringify({
      ok: result.success,
      runId: result.runId,
      taskId: args.taskId,
      ...(result.success ? { summary: (result.summary || "").slice(0, 300) } : { error: result.error }),
    });
  } catch (e) {
    return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
  }
}

function _toolAddMemoryNode(args) {
  try {
    if (!args.category) return JSON.stringify({ error: "category is required" });
    if (!args.label) return JSON.stringify({ error: "label is required" });

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const category = String(args.category).trim();
    const label = String(args.label).trim();
    const blob = args.blob ? String(args.blob).trim() : null;

    // Check if the memory graph table exists
    const tbl = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='memory_graph_nodes'`).get();
    if (!tbl) return JSON.stringify({ error: "Memory graph tables not found" });

    db.prepare(
      `INSERT INTO memory_graph_nodes (id, category, label, blob, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, category, label, blob, now, now);

    // Fire-and-forget: schedule embedding computation for this node
    if (EMBED_AVAILABLE) {
      scheduleNodeEmbedding(id, category, label, blob || "");
    }

    return JSON.stringify({
      ok: true,
      node: { id, category, label, blob: blob ? blob.slice(0, 200) : null },
      embeddingScheduled: EMBED_AVAILABLE,
    });
  } catch (e) {
    return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
  }
}

function _toolAddMemoryEdge(args) {
  try {
    if (!args.fromNodeId) return JSON.stringify({ error: "fromNodeId is required" });
    if (!args.toNodeId) return JSON.stringify({ error: "toNodeId is required" });
    if (!args.relation) return JSON.stringify({ error: "relation is required" });

    // Verify both nodes exist
    const fromNode = db.prepare(`SELECT id, label FROM memory_graph_nodes WHERE id = ?`).get(args.fromNodeId);
    if (!fromNode) return JSON.stringify({ error: `Source node not found: ${args.fromNodeId}` });

    const toNode = db.prepare(`SELECT id, label FROM memory_graph_nodes WHERE id = ?`).get(args.toNodeId);
    if (!toNode) return JSON.stringify({ error: `Target node not found: ${args.toNodeId}` });

    // Check if the edge table exists
    const tbl = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='memory_graph_edges'`).get();
    if (!tbl) return JSON.stringify({ error: "Memory graph edge table not found" });

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const relation = String(args.relation).trim();

    db.prepare(
      `INSERT INTO memory_graph_edges (id, source_node_id, target_node_id, relation, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, args.fromNodeId, args.toNodeId, relation, now);

    return JSON.stringify({
      ok: true,
      edge: { id, from: fromNode.label, to: toNode.label, relation },
    });
  } catch (e) {
    return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
  }
}

function _toolGetMemoryNodes(args) {
  try {
    const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
    let rows;

    if (args.category) {
      rows = db.prepare(
        `SELECT id, category, label, blob, updated_at FROM memory_graph_nodes
         WHERE category = ? ORDER BY updated_at DESC LIMIT ?`,
      ).all(args.category, limit);
    } else if (args.search) {
      const like = `%${args.search}%`;
      rows = db.prepare(
        `SELECT id, category, label, blob, updated_at FROM memory_graph_nodes
         WHERE label LIKE ? OR blob LIKE ? ORDER BY updated_at DESC LIMIT ?`,
      ).all(like, like, limit);
    } else {
      rows = db.prepare(
        `SELECT id, category, label, blob, updated_at FROM memory_graph_nodes
         ORDER BY updated_at DESC LIMIT ?`,
      ).all(limit);
    }

    const nodes = rows.map((r) => ({
      id: r.id,
      category: r.category,
      label: r.label,
      blob: String(r.blob).slice(0, 200),
      updatedAt: r.updated_at,
    }));

    return JSON.stringify({ count: nodes.length, nodes });
  } catch (e) {
    return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
  }
}

function _toolGetDialogs(args) {
  try {
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);
    let rows;

    if (args.purpose) {
      rows = db.prepare(
        `SELECT d.id, d.title, d.purpose, d.updated_at, t.title AS theme_title,
                (SELECT COUNT(*) FROM conversation_turns ct WHERE ct.dialog_id = d.id) AS turn_count
         FROM dialogs d JOIN themes t ON t.id = d.theme_id
         WHERE d.purpose = ?
         ORDER BY d.updated_at DESC LIMIT ?`,
      ).all(args.purpose, limit);
    } else {
      rows = db.prepare(
        `SELECT d.id, d.title, d.purpose, d.updated_at, t.title AS theme_title,
                (SELECT COUNT(*) FROM conversation_turns ct WHERE ct.dialog_id = d.id) AS turn_count
         FROM dialogs d JOIN themes t ON t.id = d.theme_id
         ORDER BY d.updated_at DESC LIMIT ?`,
      ).all(limit);
    }

    const dialogs = rows.map((r) => ({
      id: r.id,
      title: r.title,
      purpose: r.purpose || null,
      themeTitle: r.theme_title,
      turnCount: r.turn_count,
      updatedAt: r.updated_at,
    }));

    return JSON.stringify({ count: dialogs.length, dialogs });
  } catch (e) {
    return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
  }
}

function _toolGetRecentTurns(args) {
  try {
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 30);
    let rows;

    if (args.dialogId) {
      rows = db.prepare(
        `SELECT id, dialog_id, user_text, assistant_text, user_message_at, assistant_message_at,
                requested_provider_id, responding_provider_id, llm_total_tokens
         FROM conversation_turns
         WHERE dialog_id = ?
         ORDER BY user_message_at DESC LIMIT ?`,
      ).all(args.dialogId, limit);
    } else {
      rows = db.prepare(
        `SELECT id, dialog_id, user_text, assistant_text, user_message_at, assistant_message_at,
                requested_provider_id, responding_provider_id, llm_total_tokens
         FROM conversation_turns
         ORDER BY user_message_at DESC LIMIT ?`,
      ).all(limit);
    }

    const turns = rows.map((r) => ({
      id: r.id,
      dialogId: r.dialog_id,
      userText: String(r.user_text || "").slice(0, 200),
      assistantText: String(r.assistant_text || "").slice(0, 200),
      at: r.assistant_message_at || r.user_message_at,
      provider: r.responding_provider_id || r.requested_provider_id,
      tokens: r.llm_total_tokens,
    }));

    return JSON.stringify({ count: turns.length, turns });
  } catch (e) {
    return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
  }
}

async function _toolSendToSlot(args) {
  const slot = args.slot;
  const prompt = args.prompt;
  if (!slot || !prompt) return JSON.stringify({ error: "slot and prompt are required" });

  try {
    const messages = [
      { role: "system", content: "You are responding to a request delegated by the Maestro orchestrator. Be concise and factual." },
      { role: "user", content: prompt },
    ];

    const requestBody = { messages, max_tokens: 2048 };
    if (args.model) requestBody.model = args.model;

    // When sending to the Maestro slot (or-3), call OpenRouter directly
    // to avoid the Maestro interceptor (which would cause infinite tool-calling recursion).
    // For all other slots, use the server proxy as before.
    let url;
    let fetchHeaders = { "Content-Type": "application/json" };

    if (slot === MAESTRO_SLOT) {
      const apiKey = String(process.env.OPENROUTER_API_KEY ?? "").trim();
      if (!apiKey) return JSON.stringify({ error: "OpenRouter API key not configured for or-3" });
      url = "https://openrouter.ai/api/v1/chat/completions";
      fetchHeaders["authorization"] = `Bearer ${apiKey}`;
      fetchHeaders["http-referer"] = String(process.env.OPENROUTER_REFERER ?? "http://localhost:1984");
      fetchHeaders["x-title"] = String(process.env.OPENROUTER_APP_TITLE ?? "MF0-1984");
      // Ensure model is set for or-3
      if (!requestBody.model) requestBody.model = "deepseek/deepseek-v4-flash";
    } else {
      url = `http://127.0.0.1:${API_PORT}/api/llm/${slot}/api/v1/chat/completions`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);

    const res = await fetch(url, {
      method: "POST",
      headers: fetchHeaders,
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return JSON.stringify({ error: `Slot ${slot} returned ${res.status}: ${errText.slice(0, 300)}` });
    }

    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content || "";
    const usage = json?.usage || {};

    return JSON.stringify({
      slot,
      model: args.model || "default",
      response: String(content).slice(0, 4000),
      tokens: { prompt: usage.prompt_tokens, completion: usage.completion_tokens },
    });
  } catch (e) {
    return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
  }
}

// ── Report Persistence Tools ──────────────────────────────────────────────────

/**
 * Convert a task title to a filesystem-safe slug.
 * E.g. "Periodic check" → "periodic-check"
 */
function _titleSlug(title) {
  return String(title || "untitled")
    .toLowerCase()
    .replace(/[^a-zа-яё0-9\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "task";
}

/**
 * Build a report directory path that is unique per task (uses task ID)
 * to avoid collisions between tasks with the same title.
 * @param {string} taskId
 * @param {string} [title]
 * @returns {string}
 */
function _reportDir(taskId, title) {
  const slug = _titleSlug(title);
  // Include first 8 chars of task ID to guarantee uniqueness
  return `reports/${slug}-${taskId.slice(0, 8)}`;
}

/**
 * save_report — save a structured Markdown report to the sandbox.
 * Reports are stored in: reports/<task-slug>/<timestamp>.md
 * A _latest.md symlink/copy is maintained for quick access.
 * Old reports are pruned to keep the last 20 per task.
 */
async function _toolSaveReport(args) {
  if (!LOCALFS_ENABLED) return JSON.stringify({ error: "LocalFS not enabled" });
  if (!args.content) return JSON.stringify({ error: "content is required" });
  if (!args.title) return JSON.stringify({ error: "title is required" });

  try {
    // Resolve the task for the report directory (unique per task ID)
    const sourceTaskId = args._sourceTaskId;
    let taskTitle = "unknown";
    let taskId = sourceTaskId || "unknown";
    if (sourceTaskId) {
      const task = getTask(sourceTaskId);
      if (task) { taskTitle = task.title; taskId = task.id; }
    }

    const category = String(args.category || "check").trim().toLowerCase();
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const reportDir = _reportDir(taskId, taskTitle);
    const reportPath = `${reportDir}/${timestamp}.md`;
    const latestPath = `${reportDir}/_latest.md`;

    // Build report content with metadata header
    const taskSlug = _titleSlug(taskTitle);
    const metaHeader = [
      `---`,
      `title: ${args.title}`,
      `task: ${taskSlug}`,
      `task_id: ${taskId}`,
      `category: ${category}`,
      `timestamp: ${now.toISOString()}`,
      `---`,
      ``,
    ].join("\n");

    const fullContent = metaHeader + String(args.content);

    // Write the report file
    const writeUrl = `http://127.0.0.1:${API_PORT}/api/localfs/write`;
    const writeRes = await fetch(writeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: reportPath, content: fullContent }),
    });
    const writeData = await writeRes.json();
    if (!writeData.ok) return JSON.stringify({ error: `Failed to write report: ${writeData.error}` });

    // Also write _latest.md (copy of the current report for quick access)
    await fetch(writeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: latestPath, content: fullContent }),
    }).catch(() => {}); // ignore errors for _latest

    // Prune old reports (keep last 20)
    try {
      const listUrl = `http://127.0.0.1:${API_PORT}/api/localfs/list?path=${encodeURIComponent(reportDir)}&max=50`;
      const listRes = await fetch(listUrl);
      const listData = await listRes.json();
      if (listData.ok && listData.entries) {
        const reportFiles = listData.entries
          .filter((e) => e.type === "file" && e.name.endsWith(".md") && e.name !== "_latest.md")
          .sort((a, b) => a.name.localeCompare(b.name)); // oldest first
        // Delete oldest if more than 20 — use localfs/delete API instead of bash rm
        // to avoid potential path injection through file names containing quotes
        while (reportFiles.length > 20) {
          const oldest = reportFiles.shift();
          const delUrl = `http://127.0.0.1:${API_PORT}/api/localfs/delete?path=${encodeURIComponent(`${reportDir}/${oldest.name}`)}`;
          await fetch(delUrl, { method: "DELETE" }).catch(() => {});
        }
      }
    } catch {
      // pruning failure is non-critical
    }

    return JSON.stringify({
      ok: true,
      path: reportPath,
      latestPath,
      sizeBytes: fullContent.length,
      taskSlug: _titleSlug(taskTitle),
      taskId,
      category,
    });
  } catch (e) {
    return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * read_last_report — read the most recent saved report for this task.
 * Checks _latest.md first, then falls back to listing the report directory.
 */
async function _toolReadLastReport(args) {
  if (!LOCALFS_ENABLED) return JSON.stringify({ error: "LocalFS not enabled" });

  try {
    const sourceTaskId = args._sourceTaskId;
    let taskTitle = "unknown";
    let taskId = sourceTaskId || "unknown";
    if (sourceTaskId) {
      const task = getTask(sourceTaskId);
      if (task) { taskTitle = task.title; taskId = task.id; }
    }

    const reportDir = _reportDir(taskId, taskTitle);
    const latestPath = `${reportDir}/_latest.md`;

    // Try reading _latest.md first
    const readUrl = `http://127.0.0.1:${API_PORT}/api/localfs/read?path=${encodeURIComponent(latestPath)}`;
    const readRes = await fetch(readUrl);
    const readData = await readRes.json();

    if (readData.ok && readData.content) {
      const content = String(readData.content);
      // Parse metadata header
      const metaMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
      const meta = {};
      if (metaMatch) {
        for (const line of metaMatch[1].split("\n")) {
          const [key, ...rest] = line.split(":");
          if (key && rest.length) meta[key.trim()] = rest.join(":").trim();
        }
      }
      // Return content without meta header for comparison
      const bodyContent = metaMatch ? content.slice(metaMatch[0].length) : content;

      return JSON.stringify({
        ok: true,
        found: true,
        path: latestPath,
        title: meta.title || null,
        category: meta.category || null,
        timestamp: meta.timestamp || null,
        content: bodyContent.slice(0, 8000), // limit for context window
      });
    }

    // No _latest.md — check if reports directory exists at all
    const listUrl = `http://127.0.0.1:${API_PORT}/api/localfs/list?path=${encodeURIComponent(reportDir)}&max=5`;
    const listRes = await fetch(listUrl);
    const listData = await listRes.json();

    if (!listData.ok || !listData.entries || listData.entries.length === 0) {
      return JSON.stringify({
        ok: true,
        found: false,
        message: "No previous reports found for this task. This appears to be the first run with report persistence.",
        taskSlug: _titleSlug(taskTitle),
        taskId,
      });
    }

    // Directory exists but _latest.md missing — try to find the most recent .md file
    const mdFiles = listData.entries
      .filter((e) => e.type === "file" && e.name.endsWith(".md"))
      .sort((a, b) => b.name.localeCompare(a.name)); // newest first

    if (mdFiles.length === 0) {
      return JSON.stringify({
        ok: true,
        found: false,
        message: "No previous reports found for this task.",
        taskSlug: _titleSlug(taskTitle),
        taskId,
      });
    }

    // Read the most recent report
    const mostRecent = `${reportDir}/${mdFiles[0].name}`;
    const recentRes = await fetch(`http://127.0.0.1:${API_PORT}/api/localfs/read?path=${encodeURIComponent(mostRecent)}`);
    const recentData = await recentRes.json();

    if (recentData.ok && recentData.content) {
      const content = String(recentData.content);
      const metaMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
      const meta = {};
      if (metaMatch) {
        for (const line of metaMatch[1].split("\n")) {
          const [key, ...rest] = line.split(":");
          if (key && rest.length) meta[key.trim()] = rest.join(":").trim();
        }
      }
      const bodyContent = metaMatch ? content.slice(metaMatch[0].length) : content;

      return JSON.stringify({
        ok: true,
        found: true,
        path: mostRecent,
        title: meta.title || null,
        category: meta.category || null,
        timestamp: meta.timestamp || null,
        content: bodyContent.slice(0, 8000),
      });
    }

    return JSON.stringify({
      ok: true,
      found: false,
      message: "Could not read the previous report file.",
      taskSlug: _titleSlug(taskTitle),
      taskId,
    });
  } catch (e) {
    return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
  }
}

// ── Semantic search, Rerank, Embedding backfill ────────────────────────────────

/**
 * semantic_search tool: search memory graph nodes by semantic similarity.
 * Uses the existing memoryGraphEmbeddings module which calls
 * perplexity/pplx-embed-v1-4b through the OpenRouter proxy.
 */
async function _toolSemanticSearch(args) {
  try {
    if (!EMBED_AVAILABLE) return JSON.stringify({ error: "Embedding not available (OPENROUTER_API_KEY not configured)" });
    if (!args.query) return JSON.stringify({ error: "query is required" });

    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);
    const category = args.category || null;

    // Get candidate IDs from semantic search
    const topK = category ? limit * 3 : limit * 2; // overfetch if we need to filter by category
    let candidateIds = await semanticCandidateIds(args.query, topK);

    // If category filter is specified, filter the candidates
    if (category && candidateIds.length > 0) {
      const placeholders = candidateIds.map(() => "?").join(",");
      const rows = db.prepare(
        `SELECT id FROM memory_graph_nodes WHERE id IN (${placeholders}) AND category = ?`,
      ).all(...candidateIds, category);
      const filteredIds = new Set(rows.map(r => r.id));
      candidateIds = candidateIds.filter(id => filteredIds.has(id));
    }

    // Fetch full node data for the matched IDs
    if (candidateIds.length === 0) {
      return JSON.stringify({ count: 0, nodes: [], query: args.query });
    }

    const finalIds = candidateIds.slice(0, limit);
    const placeholders = finalIds.map(() => "?").join(",");
    const rows = db.prepare(
      `SELECT id, category, label, blob, updated_at FROM memory_graph_nodes WHERE id IN (${placeholders})`,
    ).all(...finalIds);

    // Preserve the ranking order from semantic search
    const orderMap = new Map(finalIds.map((id, idx) => [id, idx]));
    const nodes = rows
      .map(r => ({
        id: r.id,
        category: r.category,
        label: r.label,
        blob: String(r.blob || "").slice(0, 300),
        updatedAt: r.updated_at,
        rank: orderMap.get(r.id) ?? 999,
      }))
      .sort((a, b) => a.rank - b.rank);

    return JSON.stringify({ count: nodes.length, nodes, query: args.query });
  } catch (e) {
    return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * rerank tool: rerank a list of text passages by relevance to a query.
 * Uses cohere/rerank-v3.5 through the OpenRouter proxy.
 */
async function _toolRerank(args) {
  try {
    if (!MAESTRO_RERANK_MODEL) return JSON.stringify({ error: "Rerank not available (MAESTRO_RERANK_MODEL not configured)" });
    if (!args.query) return JSON.stringify({ error: "query is required" });
    if (!Array.isArray(args.documents) || args.documents.length === 0) {
      return JSON.stringify({ error: "documents must be a non-empty array of strings" });
    }

    const documents = args.documents
      .map(d => String(d ?? "").trim())
      .filter(d => d.length > 0)
      .slice(0, 100); // cap at 100

    if (documents.length === 0) {
      return JSON.stringify({ error: "No valid documents after filtering" });
    }

    const topN = Math.min(Math.max(Number(args.topN) || 10, 1), 50);
    const results = await _rerankDocuments(args.query, documents, topN);

    // Format results with document text included
    const ranked = results.map(r => ({
      index: r.index,
      relevanceScore: Math.round((r.relevance_score ?? 0) * 1000) / 1000,
      text: String(documents[r.index] || "").slice(0, 300),
    }));

    return JSON.stringify({ count: ranked.length, results: ranked, query: args.query, model: MAESTRO_RERANK_MODEL });
  } catch (e) {
    return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * backfill_embeddings tool: compute embeddings for nodes that don't have them yet.
 * Delegates to the existing batchReindexMissingEmbeddings function.
 */
async function _toolBackfillEmbeddings(args) {
  try {
    if (!EMBED_AVAILABLE) return JSON.stringify({ error: "Embedding not available (OPENROUTER_API_KEY not configured)" });

    const result = await batchReindexMissingEmbeddings();

    // Also report how many nodes still lack embeddings
    const total = db.prepare(`SELECT COUNT(*) AS c FROM memory_graph_nodes`).get();
    const withEmbedding = db.prepare(`SELECT COUNT(*) AS c FROM memory_graph_nodes WHERE embedding IS NOT NULL`).get();

    return JSON.stringify({
      ok: true,
      processed: result.done,
      failed: result.failed,
      totalNodes: total?.c || 0,
      withEmbedding: withEmbedding?.c || 0,
      withoutEmbedding: (total?.c || 0) - (withEmbedding?.c || 0),
    });
  } catch (e) {
    return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
  }
}
