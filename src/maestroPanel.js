/**
 * Maestro Dashboard Modal — task management + quick chat UI for the orchestrator.
 *
 * Follows the same modal pattern as Settings:
 *   - Fixed overlay dialog, open/close via hidden attribute
 *   - Renders into #maestro-panel-root via innerHTML
 *   - Fetches data from /api/maestro/* via chatPersistence.apiUrl()
 *   - Exports init, close, and refresh functions
 *   - Wires up event handlers for task CRUD, manual runs, scheduler control
 *
 * Navigation: Task List ↔ Chat (tab-based), Task Detail → Run Detail (drill-down)
 */
import { apiUrl } from "./chatPersistence.js";
import { escapeHtml } from "./escapeHtml.js";
import { renderAssistantMarkdown } from "./markdown.js";
import { fetchOpenRouterModelEntries } from "./fetchRemoteModelLists.js";

// ── State ─────────────────────────────────────────────────────────────────────

let maestroOpen = false;
let refreshMaestroViewIfOpenImpl = async () => {};
let appendActivityLog = null;

/** @type {Array<{id: string, shortName?: string}>} */
let openRouterModels = [];

/** Load OpenRouter models once and cache them. */
async function ensureModelList() {
  if (openRouterModels.length > 0) return;
  try {
    const entries = await fetchOpenRouterModelEntries();
    if (Array.isArray(entries) && entries.length > 0) {
      openRouterModels = entries;
    }
  } catch {
    /* ignore */ }
  }

/** Build <option> HTML for model <select>. Includes a "(slot default)" empty option. */
function buildModelOptions(selectedId) {
  const opts = [`<option value="" ${!selectedId ? "selected" : ""}>(slot default)</option>`];
  if (openRouterModels.length === 0) {
    // Models not loaded yet — show a placeholder if a model is set
    if (selectedId) {
      opts.push(`<option value="${escapeHtml(selectedId)}" selected>${escapeHtml(selectedId)}</option>`);
    }
    opts.push(`<option value="" disabled>Loading models…</option>`);
    return opts.join("");
  }
  for (const m of openRouterModels) {
    const label = m.shortName ? `${m.shortName} — ${m.id}` : m.id;
    const sel = m.id === selectedId ? " selected" : "";
    opts.push(`<option value="${escapeHtml(m.id)}"${sel}>${escapeHtml(label)}</option>`);
  }
  return opts.join("");
}

/** Build <option> HTML for chain-to <select>. Excludes the given task ID (prevent self-link). */
function buildChainTargetOptions(excludeId, selectedId) {
  const opts = [`<option value="" ${!selectedId ? "selected" : ""}>(none)</option>`];
  for (const t of allTasksCache) {
    if (t.id === excludeId) continue; // prevent self-link
    const label = `${truncate(t.title, 40)} (${t.id.slice(0, 8)}…)`;
    const sel = t.id === selectedId ? " selected" : "";
    opts.push(`<option value="${escapeHtml(t.id)}"${sel}>${escapeHtml(label)}</option>`);
  }
  return opts.join("");
}

/** Load task list cache from API. Used by chain dropdowns and chain graph. */
async function ensureTaskListCache() {
  if (allTasksCache.length > 0) return;
  try {
    const data = await apiGet("api/maestro/tasks");
    if (data.ok && Array.isArray(data.tasks)) {
      allTasksCache = data.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status }));
    }
  } catch {
    /* ignore */
  }
}

/** @type {"list" | "chat" | "chains" | "task-detail" | "run-detail"} */
let viewMode = "list";
/** Current task being viewed (full task object) */
let currentTask = null;
/** Current run being viewed (full run object) */
let currentRun = null;
/** Runs list for current task */
let currentTaskRuns = [];
/** Chat messages: { role: 'user'|'assistant', content: string, at: string, toolTrace?: [], modelId?: string, tokens?: number, error?: string } */
let chatMessages = [];
/** Whether a chat request is in flight */
let chatSending = false;
/** Current tab: "tasks" | "chat" | "chains" */
let activeTab = "tasks";
/** Cached task list for dropdowns (id + title) */
let allTasksCache = [];

// ── API helpers ───────────────────────────────────────────────────────────────

async function apiGet(path) {
  const res = await fetch(apiUrl(path));
  if (!res.ok) throw new Error(`Maestro API ${res.status}: ${path}`);
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(apiUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function apiPut(path, body) {
  const res = await fetch(apiUrl(path), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function apiDelete(path) {
  const res = await fetch(apiUrl(path), { method: "DELETE" });
  return res.json();
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function statusBadge(status) {
  const colors = {
    idle: "maestro-status--idle",
    running: "maestro-status--running",
    error: "maestro-status--error",
    disabled: "maestro-status--disabled",
    success: "maestro-status--success",
  };
  const cls = colors[status] || "maestro-status--idle";
  return `<span class="maestro-status-badge ${cls}">${escapeHtml(status)}</span>`;
}

function relativeTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return `${Math.floor(diff / 86400_000)}d ago`;
}

function formatTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString();
}

function truncate(s, len = 120) {
  const t = String(s || "").trim();
  return t.length > len ? t.slice(0, len) + "…" : t;
}

function formatTokens(n) {
  if (!n) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function runStatusBadge(status) {
  const colors = {
    success: "maestro-status--success",
    error: "maestro-status--error",
    running: "maestro-status--running",
  };
  const cls = colors[status] || "maestro-status--idle";
  return `<span class="maestro-status-badge ${cls}">${escapeHtml(status || "unknown")}</span>`;
}

// ── Render: Task List ─────────────────────────────────────────────────────────

function renderMaestro(root, data) {
  const status = data.status || {};
  const tasks = data.tasks || [];
  const schedulerRunning = status.schedulerRunning;
  const totalTasks = status.totalTasks || 0;
  const scheduledCount = status.scheduledCount || 0;
  const nextDue = status.nextDue;
  const recentRuns24h = status.recentRuns24h || 0;
  const byStatus = status.byStatus || {};

  const slotModel = status.slotModel || null;

  const taskCardsHtml = tasks.length === 0
    ? `<div class="maestro-empty">No tasks yet. Create one to get started.</div>`
    : tasks.map((t) => {
        const scheduleInfo = t.scheduleCron
          ? `<span class="maestro-task-cron" title="Cron: ${escapeHtml(t.scheduleCron)}">${escapeHtml(t.scheduleCron)}</span>`
          : `<span class="maestro-task-once">one-shot</span>`;
        const retryInfo = t.retryOnError
          ? `<span class="maestro-task-retry" title="Auto-retry on error, ${t.consecutiveErrors || 0}/${t.maxRetries || 3}">retry ${t.consecutiveErrors || 0}/${t.maxRetries || 3}</span>`
          : "";
        const nextRun = t.scheduleCron && t.nextRunAt ? `<span class="maestro-task-next">next: ${relativeTime(t.nextRunAt)}</span>` : "";
        const lastRunInfo = t.lastRunAt ? `<span class="maestro-task-last">last: ${relativeTime(t.lastRunAt)}</span>` : "";
        const desc = t.description ? `<p class="maestro-task-desc">${escapeHtml(truncate(t.description, 200))}</p>` : "";
        const effectiveModel = t.modelId || t.defaultModel || slotModel || "—";
        const modelLabel = t.modelId ? "model" : (t.defaultModel ? "default" : "slot");
        const modelHtml = `<span class="maestro-task-model" title="Model (${modelLabel}): ${escapeHtml(effectiveModel)}">${escapeHtml(truncate(effectiveModel, 35))}</span>`;
        const chainHtml = t.chainTo ? `<span class="maestro-task-chain" title="Chains to another task">&#x1F517;</span>` : "";

        return `
          <div class="maestro-task-card" data-task-id="${escapeHtml(t.id)}">
            <div class="maestro-task-header">
              <div class="maestro-task-title-row">
                ${statusBadge(t.status)}
                <h3 class="maestro-task-title">${escapeHtml(t.title)}</h3>
                ${chainHtml}
              </div>
              <div class="maestro-task-meta">
                <span class="maestro-task-type">${escapeHtml(t.taskType)}</span>
                ${scheduleInfo}
                ${t.scheduleCron ? `<span class="maestro-task-enabled">${t.scheduleEnabled ? "ON" : "OFF"}</span>` : ""}
                ${retryInfo}
                ${modelHtml}
              </div>
            </div>
            ${desc}
            <div class="maestro-task-footer">
              <span class="maestro-task-runs">${t.runCount || 0} runs</span>
              ${lastRunInfo}
              ${nextRun}
            </div>
            <div class="maestro-task-actions">
              <button type="button" class="maestro-btn maestro-btn--detail" data-action="task-detail" data-id="${escapeHtml(t.id)}">Details</button>
              <button type="button" class="maestro-btn maestro-btn--run" data-action="run" data-id="${escapeHtml(t.id)}" ${t.status === "running" ? "disabled" : ""}>Run</button>
              <button type="button" class="maestro-btn maestro-btn--toggle" data-action="toggle" data-id="${escapeHtml(t.id)}">${t.scheduleCron ? (t.scheduleEnabled ? "Disable" : "Enable") : ""}</button>
              <button type="button" class="maestro-btn maestro-btn--delete" data-action="delete" data-id="${escapeHtml(t.id)}">Delete</button>
            </div>
          </div>`;
      }).join("");

  const statusSummaryHtml = Object.entries(byStatus).map(([k, v]) =>
    `<div class="maestro-stat-card"><div class="maestro-stat-value">${v}</div><div class="maestro-stat-label">${escapeHtml(k)}</div></div>`
  ).join("");

  root.innerHTML = `
    <div class="maestro-inner">
      <div class="maestro-tabs">
        <button type="button" class="maestro-tab maestro-tab--active" data-action="tab-tasks">Tasks</button>
        <button type="button" class="maestro-tab" data-action="tab-chains">Chains</button>
        <button type="button" class="maestro-tab" data-action="tab-chat">Chat</button>
        <div class="maestro-tab-actions">
          <button type="button" class="maestro-btn maestro-btn--scheduler" data-action="${schedulerRunning ? "stop-scheduler" : "start-scheduler"}">${schedulerRunning ? "Stop" : "Start"}</button>
          <button type="button" class="maestro-btn maestro-btn--refresh" data-action="refresh">Refresh</button>
        </div>
      </div>

      <section class="maestro-status-bar">
        <div class="maestro-status-section">
          <div class="maestro-stat-card maestro-stat-card--highlight">
            <div class="maestro-stat-value">${schedulerRunning ? "●" : "○"}</div>
            <div class="maestro-stat-label">${schedulerRunning ? "Running" : "Stopped"}</div>
          </div>
          ${statusSummaryHtml}
          <div class="maestro-stat-card"><div class="maestro-stat-value">${recentRuns24h}</div><div class="maestro-stat-label">Runs 24h</div></div>
          <div class="maestro-stat-card"><div class="maestro-stat-value">${scheduledCount}</div><div class="maestro-stat-label">Scheduled</div></div>
          <div class="maestro-stat-card"><div class="maestro-stat-value">${totalTasks}</div><div class="maestro-stat-label">Total</div></div>
        </div>
      </section>

      ${nextDue ? `<div class="maestro-next-due">Next due: <strong>${escapeHtml(nextDue.title)}</strong> at ${relativeTime(nextDue.nextRunAt)}</div>` : ""}

      <section class="maestro-tasks-section">
        <div class="maestro-tasks-header">
          <h3 class="maestro-section-title">Tasks</h3>
          <button type="button" class="maestro-btn maestro-btn--create" data-action="create-task">+ New Task</button>
        </div>
        <div class="maestro-tasks-list" id="maestro-tasks-list">
          ${taskCardsHtml}
        </div>
      </section>

      <!-- Create task form (hidden by default) -->
      <div class="maestro-create-form" id="maestro-create-form" hidden>
        <h3 class="maestro-section-title">New Task</h3>
        <div class="maestro-form-row">
          <label for="maestro-create-title">Title *</label>
          <input type="text" id="maestro-create-title" class="maestro-input" placeholder="Task title" required />
        </div>
        <div class="maestro-form-row">
          <label for="maestro-create-desc">Description</label>
          <textarea id="maestro-create-desc" class="maestro-input maestro-textarea" placeholder="What should Maestro do?"></textarea>
        </div>
        <div class="maestro-form-row">
          <label for="maestro-create-cron">Schedule (cron)</label>
          <input type="text" id="maestro-create-cron" class="maestro-input" placeholder="*/5 * * * * (optional)" />
        </div>
        <div class="maestro-form-row">
          <label for="maestro-create-model">Model</label>
          <select id="maestro-create-model" class="maestro-input maestro-select">${buildModelOptions("")}</select>
        </div>
        <div class="maestro-form-row">
          <label for="maestro-create-chain-to">Chain to</label>
          <select id="maestro-create-chain-to" class="maestro-input maestro-select">${buildChainTargetOptions(null, "")}</select>
        </div>
        <div class="maestro-form-row">
          <label for="maestro-create-chain-condition">Chain condition</label>
          <select id="maestro-create-chain-condition" class="maestro-input maestro-select">
            <option value="success" selected>On success</option>
            <option value="error">On error</option>
            <option value="always">Always</option>
          </select>
        </div>
        <div class="maestro-form-row maestro-form-row--inline">
          <label><input type="checkbox" id="maestro-create-retry" /> Auto-retry on error</label>
        </div>
        <div class="maestro-form-actions">
          <button type="button" class="maestro-btn maestro-btn--primary" data-action="submit-create">Create</button>
          <button type="button" class="maestro-btn" data-action="cancel-create">Cancel</button>
        </div>
      </div>
    </div>`;

  wireEventHandlers(root);
}

// ── Render: Chat ──────────────────────────────────────────────────────────────

function renderChat(root, statusData) {
  const schedulerRunning = statusData?.schedulerRunning || false;
  const slotModel = statusData?.slotModel || null;

  const messagesHtml = chatMessages.length === 0
    ? `<div class="maestro-chat-empty">Send a message to Maestro. It will execute your instruction with full tool access and real agent context.</div>`
    : chatMessages.map((msg, idx) => {
        if (msg.role === "user") {
          return `
            <div class="maestro-chat-msg maestro-chat-msg--user">
              <div class="maestro-chat-msg-content">${escapeHtml(msg.content)}</div>
              <div class="maestro-chat-msg-time">${relativeTime(msg.at)}</div>
            </div>`;
        }

        // Assistant message
        const traceHtml = msg.toolTrace && msg.toolTrace.length > 0
          ? `<details class="maestro-chat-trace">
              <summary class="maestro-chat-trace-summary">${msg.toolTrace.length} tool call${msg.toolTrace.length !== 1 ? "s" : ""}</summary>
              <div class="maestro-chat-trace-list">
                ${msg.toolTrace.map((t, i) => {
                  const argsStr = JSON.stringify(t.args, null, 2);
                  const resultStr = JSON.stringify(t.result, null, 2);
                  const displayArgs = argsStr.length > 500 ? argsStr.slice(0, 500) + "\n…" : argsStr;
                  const displayResult = resultStr.length > 800 ? resultStr.slice(0, 800) + "\n…" : resultStr;
                  return `
                    <div class="maestro-chat-trace-item">
                      <div class="maestro-chat-trace-header">
                        <span class="maestro-chat-trace-round">R${t.round ?? i + 1}</span>
                        <span class="maestro-chat-trace-tool">${escapeHtml(t.tool)}</span>
                      </div>
                      <details class="maestro-chat-trace-details">
                        <summary>Args</summary>
                        <pre class="maestro-chat-trace-code">${escapeHtml(displayArgs)}</pre>
                      </details>
                      <details class="maestro-chat-trace-details" open>
                        <summary>Result</summary>
                        <pre class="maestro-chat-trace-code">${escapeHtml(displayResult)}</pre>
                      </details>
                    </div>`;
                }).join("")}
              </div>
            </details>`
          : "";

        const metaParts = [];
        if (msg.modelId) metaParts.push(`<span>${escapeHtml(truncate(msg.modelId, 30))}</span>`);
        if (msg.tokens) metaParts.push(`<span>${formatTokens(msg.tokens)} tok</span>`);
        const metaHtml = metaParts.length > 0
          ? `<div class="maestro-chat-msg-meta">${metaParts.join("")}</div>`
          : "";

        const contentHtml = msg.error
          ? `<div class="maestro-chat-msg-error">${escapeHtml(msg.error)}</div>`
          : `<div class="maestro-chat-msg-content maestro-chat-msg-content--md">${renderAssistantMarkdown(msg.content)}</div>`;

        return `
          <div class="maestro-chat-msg maestro-chat-msg--assistant">
            ${contentHtml}
            ${metaHtml}
            ${traceHtml}
            <div class="maestro-chat-msg-time">${relativeTime(msg.at)}</div>
          </div>`;
      }).join("");

  const thinkingHtml = chatSending
    ? `<div class="maestro-chat-msg maestro-chat-msg--assistant maestro-chat-msg--thinking">
        <div class="maestro-chat-thinking-dots"><span></span><span></span><span></span></div>
        <div class="maestro-chat-msg-time">thinking…</div>
      </div>`
    : "";

  root.innerHTML = `
    <div class="maestro-inner">
      <div class="maestro-tabs">
        <button type="button" class="maestro-tab" data-action="tab-tasks">Tasks</button>
        <button type="button" class="maestro-tab" data-action="tab-chains">Chains</button>
        <button type="button" class="maestro-tab maestro-tab--active" data-action="tab-chat">Chat</button>
        <div class="maestro-tab-actions">
          <button type="button" class="maestro-btn maestro-btn--scheduler" data-action="${schedulerRunning ? "stop-scheduler" : "start-scheduler"}">${schedulerRunning ? "Stop" : "Start"}</button>
          <button type="button" class="maestro-btn maestro-btn--refresh" data-action="refresh">Refresh</button>
        </div>
      </div>

      <div class="maestro-chat-model-bar">
        <label for="maestro-chat-model-select" class="maestro-chat-model-label">Model:</label>
        <select id="maestro-chat-model-select" class="maestro-select maestro-chat-model-select">${buildModelOptions(localStorage.getItem("maestro-chat-model") || null)}</select>
      </div>

      <div class="maestro-chat-messages" id="maestro-chat-messages">
        ${messagesHtml}
        ${thinkingHtml}
      </div>

      <div class="maestro-chat-input-bar">
        <input type="text" id="maestro-chat-input" class="maestro-input maestro-chat-input" placeholder="Ask Maestro anything…" ${chatSending ? "disabled" : ""} />
        <button type="button" class="maestro-btn maestro-btn--primary maestro-chat-send" data-action="chat-send" ${chatSending ? "disabled" : ""}>Send</button>
      </div>
    </div>`;

  wireEventHandlers(root);

  // Auto-scroll to bottom
  const msgsEl = document.getElementById("maestro-chat-messages");
  if (msgsEl) msgsEl.scrollTop = msgsEl.scrollHeight;

  // Focus the input
  if (!chatSending) {
    const input = document.getElementById("maestro-chat-input");
    if (input) input.focus();
  }
}

// ── Render: Chain Graph ───────────────────────────────────────────────────────

/**
 * Layout the chain graph using a simple topological layering algorithm.
 * Returns positioned nodes with x, y coordinates.
 */
function _layoutChainGraph(nodes, edges) {
  if (nodes.length === 0) return { positionedNodes: [], svgWidth: 400, svgHeight: 200 };

  // Build adjacency
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const inDegree = new Map(nodes.map((n) => [n.id, 0]));
  const adj = new Map(nodes.map((n) => [n.id, []]));

  for (const e of edges) {
    if (nodeMap.has(e.from) && nodeMap.has(e.to)) {
      adj.get(e.from).push(e.to);
      inDegree.set(e.to, (inDegree.get(e.to) || 0) + 1);
    }
  }

  // Topological sort with layer assignment (BFS-based)
  const layers = new Map();
  const queue = [];
  for (const n of nodes) {
    if (inDegree.get(n.id) === 0) {
      queue.push(n.id);
      layers.set(n.id, 0);
    }
  }

  let idx = 0;
  while (idx < queue.length) {
    const cur = queue[idx++];
    const curLayer = layers.get(cur) || 0;
    for (const next of adj.get(cur) || []) {
      layers.set(next, Math.max(layers.get(next) || 0, curLayer + 1));
      const deg = inDegree.get(next) - 1;
      inDegree.set(next, deg);
      if (deg === 0) queue.push(next);
    }
  }

  // Handle any remaining nodes (cycles) — assign them max layer + 1
  let maxLayer = 0;
  for (const n of nodes) {
    if (layers.has(n.id)) {
      maxLayer = Math.max(maxLayer, layers.get(n.id));
    }
  }
  for (const n of nodes) {
    if (!layers.has(n.id)) {
      maxLayer++;
      layers.set(n.id, maxLayer);
    }
  }

  // Group by layers
  const layerGroups = new Map();
  for (const n of nodes) {
    const l = layers.get(n.id) || 0;
    if (!layerGroups.has(l)) layerGroups.set(l, []);
    layerGroups.get(l).push(n);
  }

  // Assign positions
  const nodeW = 170;
  const nodeH = 52;
  const gapX = 60;
  const gapY = 40;
  const positionedNodes = [];

  for (let l = 0; l <= maxLayer; l++) {
    const group = layerGroups.get(l) || [];
    const totalW = group.length * nodeW + (group.length - 1) * gapX;
    const startX = -totalW / 2 + nodeW / 2;
    for (let i = 0; i < group.length; i++) {
      positionedNodes.push({
        ...group[i],
        x: startX + i * (nodeW + gapX),
        y: l * (nodeH + gapY),
        layer: l,
      });
    }
  }

  const svgWidth = Math.max(400, (maxLayer > 0 ? maxLayer + 1 : 1) * (nodeW + gapX));
  const svgHeight = Math.max(200, (maxLayer + 1) * (nodeH + gapY) + 40);

  return { positionedNodes, svgWidth, svgHeight, nodeW, nodeH };
}

function renderChains(root, statusData, graphData) {
  const schedulerRunning = statusData?.schedulerRunning || false;
  const nodes = graphData?.nodes || [];
  const edges = graphData?.edges || [];

  const { positionedNodes, svgWidth, svgHeight, nodeW, nodeH } = _layoutChainGraph(nodes, edges);

  // Build node position lookup
  const posMap = new Map(positionedNodes.map((n) => [n.id, n]));

  // Center the graph
  const offsetX = svgWidth / 2;
  const offsetY = 30;

  // Render SVG edges
  const edgeSvg = edges.map((e) => {
    const from = posMap.get(e.from);
    const to = posMap.get(e.to);
    if (!from || !to) return "";
    const x1 = from.x + offsetX;
    const y1 = from.y + offsetY + nodeH / 2;
    const x2 = to.x + offsetX;
    const y2 = to.y + offsetY - nodeH / 2;
    // Bezier curve
    const midY = (y1 + y2) / 2;
    const condColor = e.condition === "success" ? "#22c55e" : e.condition === "error" ? "#ef4444" : "#a855f7";
    const condSymbol = e.condition === "success" ? "✓" : e.condition === "error" ? "✗" : "★";
    return `
      <path d="M${x1},${y1} C${x1},${midY} ${x2},${midY} ${x2},${y2}"
        stroke="${condColor}" stroke-width="2" fill="none" marker-end="url(#arrowhead-${e.condition})" />
      <text x="${(x1 + x2) / 2}" y="${midY - 4}" fill="${condColor}" font-size="11" text-anchor="middle" font-weight="600">${condSymbol}</text>`;
  }).join("");

  // Render SVG nodes
  const statusColors = {
    idle: { bg: "#f1f5f9", border: "#94a3b8", text: "#475569" },
    running: { bg: "#dbeafe", border: "#3b82f6", text: "#1d4ed8" },
    success: { bg: "#dcfce7", border: "#22c55e", text: "#166534" },
    error: { bg: "#fee2e2", border: "#ef4444", text: "#991b1b" },
    disabled: { bg: "#f3f4f6", border: "#9ca3af", text: "#6b7280" },
  };

  const nodeSvg = positionedNodes.map((n) => {
    const cx = n.x + offsetX;
    const cy = n.y + offsetY;
    const colors = statusColors[n.status] || statusColors.idle;
    const rx = nodeW / 2;
    const ry = nodeH / 2;
    const titleLines = _splitText(n.title, 18);
    return `
      <g class="maestro-chain-graph-node" data-task-id="${escapeHtml(n.id)}" style="cursor:pointer">
        <rect x="${cx - rx}" y="${cy - ry}" width="${nodeW}" height="${nodeH}" rx="8" ry="8"
          fill="${colors.bg}" stroke="${colors.border}" stroke-width="1.5" />
        ${titleLines.map((line, i) =>
          `<text x="${cx}" y="${cy - 4 + i * 14}" fill="${colors.text}" font-size="11" text-anchor="middle" font-weight="600">${escapeHtml(line)}</text>`
        ).join("")}
        <text x="${cx}" y="${cy + (titleLines.length - 1) * 14 + 10}" fill="${colors.text}" font-size="8" text-anchor="middle" opacity="0.6">${escapeHtml(n.id.slice(0, 8))}… ${escapeHtml(n.status)}</text>
      </g>`;
  }).join("");

  // Arrow marker definitions
  const markers = `
    <marker id="arrowhead-success" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
      <polygon points="0 0, 8 3, 0 6" fill="#22c55e" />
    </marker>
    <marker id="arrowhead-error" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
      <polygon points="0 0, 8 3, 0 6" fill="#ef4444" />
    </marker>
    <marker id="arrowhead-always" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
      <polygon points="0 0, 8 3, 0 6" fill="#a855f7" />
    </marker>`;

  const graphContent = nodes.length === 0
    ? `<div class="maestro-empty">No tasks yet. Create tasks and link them with chains.</div>`
    : `<div class="maestro-chain-graph-scroll">
        <svg class="maestro-chain-graph-svg" viewBox="0 0 ${svgWidth} ${svgHeight}" width="${svgWidth}" height="${svgHeight}">
          <defs>${markers}</defs>
          <g class="maestro-chain-graph-edges">${edgeSvg}</g>
          <g class="maestro-chain-graph-nodes">${nodeSvg}</g>
        </svg>
      </div>`;

  // Legend
  const legendHtml = `
    <div class="maestro-chain-legend">
      <span class="maestro-chain-legend-item"><span class="maestro-chain-legend-dot" style="background:#22c55e"></span> On success</span>
      <span class="maestro-chain-legend-item"><span class="maestro-chain-legend-dot" style="background:#ef4444"></span> On error</span>
      <span class="maestro-chain-legend-item"><span class="maestro-chain-legend-dot" style="background:#a855f7"></span> Always</span>
      <span class="maestro-chain-legend-hint">Click a node to view task details</span>
    </div>`;

  root.innerHTML = `
    <div class="maestro-inner">
      <div class="maestro-tabs">
        <button type="button" class="maestro-tab" data-action="tab-tasks">Tasks</button>
        <button type="button" class="maestro-tab maestro-tab--active" data-action="tab-chains">Chains</button>
        <button type="button" class="maestro-tab" data-action="tab-chat">Chat</button>
        <div class="maestro-tab-actions">
          <button type="button" class="maestro-btn maestro-btn--scheduler" data-action="${schedulerRunning ? "stop-scheduler" : "start-scheduler"}">${schedulerRunning ? "Stop" : "Start"}</button>
          <button type="button" class="maestro-btn maestro-btn--refresh" data-action="refresh">Refresh</button>
        </div>
      </div>

      <div class="maestro-chain-summary">
        <strong>${nodes.length}</strong> tasks, <strong>${edges.length}</strong> chain links
      </div>

      ${legendHtml}
      ${graphContent}
    </div>`;

  wireEventHandlers(root);

  // Wire SVG node clicks
  root.querySelectorAll(".maestro-chain-graph-node").forEach((g) => {
    g.addEventListener("click", () => {
      const taskId = g.dataset.taskId;
      if (taskId) navigateToTaskDetail(taskId);
    });
  });
}

/** Split text into lines of maxChar characters, up to 2 lines. */
function _splitText(text, maxChar) {
  if (!text) return [""];
  if (text.length <= maxChar) return [text];
  const first = text.slice(0, maxChar - 1) + "…";
  const rest = text.slice(maxChar - 1);
  if (rest.length <= maxChar) return [first.slice(0, -1), rest.length > maxChar ? rest.slice(0, maxChar - 1) + "…" : rest];
  return [text.slice(0, maxChar), text.slice(maxChar, maxChar * 2) + "…"];
}

// ── Render: Task Detail (Run History) ─────────────────────────────────────────

function renderTaskDetail(root, task, runs, slotModel) {
  const scheduleInfo = task.scheduleCron
    ? `<span class="maestro-task-cron">${escapeHtml(task.scheduleCron)}</span> <span class="maestro-task-enabled">${task.scheduleEnabled ? "ON" : "OFF"}</span>`
    : `<span class="maestro-task-once">one-shot</span>`;
  const desc = task.description ? `<p class="maestro-detail-desc">${escapeHtml(task.description)}</p>` : "";
  const effectiveModel = task.modelId || task.defaultModel || slotModel || "—";
  const modelLabel = task.modelId ? "override" : (task.defaultModel ? "default" : "slot");

  const runsHtml = runs.length === 0
    ? `<div class="maestro-empty">No runs yet.</div>`
    : runs.map((r) => {
        const duration = r.startedAt && r.finishedAt
          ? `${((new Date(r.finishedAt) - new Date(r.startedAt)) / 1000).toFixed(1)}s`
          : "—";
        const toolCount = r.toolTrace ? r.toolTrace.length : 0;
        const summary = r.resultSummary ? truncate(r.resultSummary, 120) : (r.errorMessage ? truncate(r.errorMessage, 120) : "—");

        return `
          <div class="maestro-run-card" data-run-id="${escapeHtml(r.id)}">
            <div class="maestro-run-header">
              <div class="maestro-run-title-row">
                ${runStatusBadge(r.status)}
                <span class="maestro-run-time">${formatTime(r.startedAt)}</span>
              </div>
              <div class="maestro-run-meta">
                <span class="maestro-run-duration">${duration}</span>
                <span class="maestro-run-tokens">${formatTokens(r.totalTokens)} tok</span>
                <span class="maestro-run-tools">${toolCount} tool${toolCount !== 1 ? "s" : ""}</span>
                ${r.modelId ? `<span class="maestro-run-model">${escapeHtml(truncate(r.modelId, 30))}</span>` : ""}
              </div>
            </div>
            <p class="maestro-run-summary">${escapeHtml(summary)}</p>
            <div class="maestro-run-actions">
              <button type="button" class="maestro-btn maestro-btn--detail" data-action="run-detail" data-run-id="${escapeHtml(r.id)}" data-task-id="${escapeHtml(task.id)}">View</button>
            </div>
          </div>`;
      }).join("");

  root.innerHTML = `
    <div class="maestro-inner">
      <div class="maestro-nav">
        <button type="button" class="maestro-btn maestro-btn--back" data-action="back-to-list">← Tasks</button>
      </div>

      <div class="maestro-detail-header">
        <div class="maestro-detail-title-row">
          ${statusBadge(task.status)}
          <h3 class="maestro-detail-title">${escapeHtml(task.title)}</h3>
        </div>
        <div class="maestro-detail-meta">
          <span class="maestro-task-type">${escapeHtml(task.taskType)}</span>
          ${scheduleInfo}
          ${task.retryOnError ? `<span class="maestro-task-retry">retry ${task.consecutiveErrors || 0}/${task.maxRetries || 3}</span>` : ""}
          <span class="maestro-task-runs">${task.runCount || 0} runs</span>
        </div>
        <div class="maestro-detail-model">
          <span class="maestro-detail-model-label">Model (${modelLabel}):</span>
          <span class="maestro-detail-model-value">${escapeHtml(effectiveModel)}</span>
          <select id="maestro-edit-model" class="maestro-input maestro-input--inline maestro-select">${buildModelOptions(task.modelId || "")}</select>
          <button type="button" class="maestro-btn maestro-btn--small" data-action="set-model" data-id="${escapeHtml(task.id)}">Set</button>
        </div>

        <div class="maestro-detail-chain">
          <span class="maestro-detail-chain-label">Chain:</span>
          <div class="maestro-detail-chain-config">
            <select id="maestro-edit-chain-to" class="maestro-input maestro-input--inline maestro-select">${buildChainTargetOptions(task.id, task.chainTo || "")}</select>
            <select id="maestro-edit-chain-condition" class="maestro-input maestro-input--inline maestro-select">
              <option value="success" ${task.chainCondition === "success" ? "selected" : ""}>On success</option>
              <option value="error" ${task.chainCondition === "error" ? "selected" : ""}>On error</option>
              <option value="always" ${task.chainCondition === "always" ? "selected" : ""}>Always</option>
            </select>
            <button type="button" class="maestro-btn maestro-btn--small" data-action="set-chain" data-id="${escapeHtml(task.id)}">Set</button>
            <button type="button" class="maestro-btn maestro-btn--small" data-action="clear-chain" data-id="${escapeHtml(task.id)}">Clear</button>
          </div>
          <div id="maestro-chain-visualization" class="maestro-chain-vis"></div>
        </div>

        ${desc}
      </div>

      <div class="maestro-detail-actions">
        <button type="button" class="maestro-btn maestro-btn--run" data-action="run" data-id="${escapeHtml(task.id)}" ${task.status === "running" ? "disabled" : ""}>Run Now</button>
        <button type="button" class="maestro-btn maestro-btn--toggle" data-action="toggle" data-id="${escapeHtml(task.id)}">${task.scheduleCron ? (task.scheduleEnabled ? "Disable" : "Enable") : ""}</button>
        <button type="button" class="maestro-btn maestro-btn--refresh" data-action="refresh-task-detail">Refresh</button>
      </div>

      <section class="maestro-runs-section">
        <h4 class="maestro-section-title">Run History</h4>
        <div class="maestro-runs-list">
          ${runsHtml}
        </div>
      </section>
    </div>`;

  wireEventHandlers(root);
}

// ── Render: Run Detail ────────────────────────────────────────────────────────

function renderRunDetail(root, task, run) {
  const duration = run.startedAt && run.finishedAt
    ? `${((new Date(run.finishedAt) - new Date(run.startedAt)) / 1000).toFixed(1)}s`
    : "—";

  const toolTraceHtml = !run.toolTrace || run.toolTrace.length === 0
    ? `<div class="maestro-empty">No tool calls in this run.</div>`
    : run.toolTrace.map((t, i) => {
        const argsStr = JSON.stringify(t.args, null, 2);
        const resultStr = JSON.stringify(t.result, null, 2);
        // Truncate very long results for display
        const displayArgs = argsStr.length > 800 ? argsStr.slice(0, 800) + "\n…" : argsStr;
        const displayResult = resultStr.length > 1500 ? resultStr.slice(0, 1500) + "\n…" : resultStr;

        return `
          <div class="maestro-trace-item">
            <div class="maestro-trace-header">
              <span class="maestro-trace-round">R${t.round ?? i}</span>
              <span class="maestro-trace-tool">${escapeHtml(t.tool)}</span>
            </div>
            <details class="maestro-trace-details">
              <summary class="maestro-trace-summary">Arguments</summary>
              <pre class="maestro-trace-code">${escapeHtml(displayArgs)}</pre>
            </details>
            <details class="maestro-trace-details" open>
              <summary class="maestro-trace-summary">Result</summary>
              <pre class="maestro-trace-code">${escapeHtml(displayResult)}</pre>
            </details>
          </div>`;
      }).join("");

  const summaryText = run.resultSummary || run.errorMessage || "No summary available.";

  root.innerHTML = `
    <div class="maestro-inner">
      <div class="maestro-nav">
        <button type="button" class="maestro-btn maestro-btn--back" data-action="back-to-task" data-task-id="${escapeHtml(task.id)}">← ${escapeHtml(task.title)}</button>
      </div>

      <div class="maestro-detail-header">
        <div class="maestro-detail-title-row">
          ${runStatusBadge(run.status)}
          <h3 class="maestro-detail-title">Run ${run.id ? run.id.slice(0, 8) : ""}</h3>
        </div>
        <div class="maestro-detail-meta">
          <span>Started: ${formatTime(run.startedAt)}</span>
          <span>Duration: ${duration}</span>
          ${run.modelId ? `<span>Model: ${escapeHtml(run.modelId)}</span>` : ""}
        </div>
      </div>

      <div class="maestro-run-stats">
        <div class="maestro-stat-card">
          <div class="maestro-stat-value">${formatTokens(run.promptTokens)}</div>
          <div class="maestro-stat-label">Prompt</div>
        </div>
        <div class="maestro-stat-card">
          <div class="maestro-stat-value">${formatTokens(run.completionTokens)}</div>
          <div class="maestro-stat-label">Completion</div>
        </div>
        <div class="maestro-stat-card">
          <div class="maestro-stat-value">${formatTokens(run.totalTokens)}</div>
          <div class="maestro-stat-label">Total</div>
        </div>
        <div class="maestro-stat-card">
          <div class="maestro-stat-value">${run.toolTrace ? run.toolTrace.length : 0}</div>
          <div class="maestro-stat-label">Tool Calls</div>
        </div>
      </div>

      <section class="maestro-summary-section">
        <h4 class="maestro-section-title">Summary</h4>
        <div class="maestro-summary-text maestro-summary-text--md">${renderAssistantMarkdown(summaryText)}</div>
      </section>

      ${run.errorMessage ? `
        <section class="maestro-error-section">
          <h4 class="maestro-section-title">Error</h4>
          <div class="maestro-error">${escapeHtml(run.errorMessage)}</div>
        </section>
      ` : ""}

      <section class="maestro-trace-section">
        <h4 class="maestro-section-title">Tool Trace</h4>
        <div class="maestro-trace-list">
          ${toolTraceHtml}
        </div>
      </section>
    </div>`;

  wireEventHandlers(root);
}

// ── Event handlers ────────────────────────────────────────────────────────────

function wireEventHandlers(root) {
  root.querySelectorAll("[data-action]").forEach((btn) => {
    const el = btn instanceof HTMLElement ? btn : null;
    if (!el) return;
    el.addEventListener("click", handleAction);
  });

  // Chat input: Enter to send
  const chatInput = root.querySelector("#maestro-chat-input");
  if (chatInput) {
    chatInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleChatSend();
      }
    });
  }
}

async function handleAction(e) {
  const btn = e.currentTarget instanceof HTMLElement ? e.currentTarget : null;
  if (!btn) return;
  const action = btn.dataset.action;
  const id = btn.dataset.id;
  const runId = btn.dataset.runId;
  const taskId = btn.dataset.taskId;

  const root = document.getElementById("maestro-panel-root");

  switch (action) {
    // ── Tab navigation ───────────────────────────────────────────────────

    case "tab-tasks": {
      activeTab = "tasks";
      viewMode = "list";
      currentTask = null;
      currentRun = null;
      await refresh();
      break;
    }

    case "tab-chat": {
      activeTab = "chat";
      viewMode = "chat";
      await refreshChatView();
      break;
    }

    case "tab-chains": {
      activeTab = "chains";
      viewMode = "chains";
      await refreshChainsView();
      break;
    }

    // ── Chat ────────────────────────────────────────────────────────────

    case "chat-send": {
      await handleChatSend();
      break;
    }

    // ── Navigation ──────────────────────────────────────────────────────

    case "task-detail": {
      if (!id) break;
      await navigateToTaskDetail(id);
      break;
    }

    case "run-detail": {
      if (!runId) break;
      await navigateToRunDetail(runId, taskId || (currentTask ? currentTask.id : null));
      break;
    }

    case "back-to-list": {
      viewMode = "list";
      activeTab = "tasks";
      currentTask = null;
      currentTaskRuns = [];
      await refresh();
      break;
    }

    case "back-to-task": {
      if (taskId || currentTask) {
        await navigateToTaskDetail(taskId || currentTask.id);
      } else {
        viewMode = "list";
        await refresh();
      }
      break;
    }

    // ── Task actions ────────────────────────────────────────────────────

    case "refresh":
      await refresh();
      break;

    case "refresh-task-detail": {
      if (currentTask) {
        await navigateToTaskDetail(currentTask.id);
      }
      break;
    }

    case "set-model": {
      if (!id) break;
      const modelInput = document.getElementById("maestro-edit-model");
      const newModel = modelInput?.value?.trim() || null;
      await apiPut(`api/maestro/tasks/${encodeURIComponent(id)}`, { modelId: newModel });
      if (appendActivityLog) appendActivityLog(`Maestro task model set to: ${newModel || "slot default"}`);
      if (currentTask) {
        await navigateToTaskDetail(currentTask.id);
      }
      break;
    }

    case "set-chain": {
      if (!id) break;
      const chainToSelect = document.getElementById("maestro-edit-chain-to");
      const chainCondSelect = document.getElementById("maestro-edit-chain-condition");
      const chainTo = chainToSelect?.value?.trim() || null;
      const chainCondition = chainCondSelect?.value || "success";
      try {
        await apiPut(`api/maestro/tasks/${encodeURIComponent(id)}`, { chainTo, chainCondition });
        if (appendActivityLog) appendActivityLog(`Maestro chain set: ${chainTo ? `→ ${chainTo.slice(0, 8)}… (${chainCondition})` : "cleared"}`);
        // Invalidate cache so dropdowns update
        allTasksCache = [];
        if (currentTask) {
          await navigateToTaskDetail(currentTask.id);
        }
      } catch (e) {
        alert(`Chain error: ${e instanceof Error ? e.message : String(e)}`);
      }
      break;
    }

    case "clear-chain": {
      if (!id) break;
      await apiPut(`api/maestro/tasks/${encodeURIComponent(id)}`, { chainTo: null });
      if (appendActivityLog) appendActivityLog("Maestro chain cleared");
      allTasksCache = [];
      if (currentTask) {
        await navigateToTaskDetail(currentTask.id);
      }
      break;
    }

    case "start-scheduler": {
      const r = await apiPost("api/maestro/scheduler/start");
      if (r.ok) {
        if (appendActivityLog) appendActivityLog("Maestro scheduler started");
        await refresh();
      } else {
        if (appendActivityLog) appendActivityLog(`Maestro scheduler start failed: ${r.error}`);
      }
      break;
    }

    case "stop-scheduler": {
      const r = await apiPost("api/maestro/scheduler/stop");
      if (r.ok) {
        if (appendActivityLog) appendActivityLog("Maestro scheduler stopped");
        await refresh();
      } else {
        if (appendActivityLog) appendActivityLog(`Maestro scheduler stop failed: ${r.error}`);
      }
      break;
    }

    case "run": {
      if (!id) break;
      btn.disabled = true;
      btn.textContent = "Running…";
      const r = await apiPost(`api/maestro/tasks/${encodeURIComponent(id)}/run`);
      if (r.ok || r.run) {
        if (appendActivityLog) appendActivityLog(`Maestro task ran: ${r.run?.id?.slice(0, 8) || "ok"}`);
        const summary = r.summary ? truncate(r.summary, 200) : (r.error || "Task executed");
        btn.textContent = "Done";
        btn.title = summary;
      } else {
        btn.textContent = "Error";
        btn.title = r.error || "Unknown error";
        if (appendActivityLog) appendActivityLog(`Maestro run error: ${r.error}`);
      }
      setTimeout(() => { btn.disabled = false; btn.textContent = "Run"; btn.title = ""; }, 3000);
      // Refresh current view
      setTimeout(() => {
        if (viewMode === "task-detail" && currentTask) {
          navigateToTaskDetail(currentTask.id);
        } else {
          refresh();
        }
      }, 4000);
      break;
    }

    case "toggle": {
      if (!id) break;
      const task = await apiGet(`api/maestro/tasks/${encodeURIComponent(id)}`);
      if (!task.task) break;
      const newEnabled = !task.task.scheduleEnabled;
      await apiPut(`api/maestro/tasks/${encodeURIComponent(id)}`, { scheduleEnabled: newEnabled });
      if (appendActivityLog) appendActivityLog(`Maestro task "${task.task.title}" ${newEnabled ? "enabled" : "disabled"}`);
      if (viewMode === "task-detail" && currentTask) {
        await navigateToTaskDetail(currentTask.id);
      } else {
        await refresh();
      }
      break;
    }

    case "delete": {
      if (!id) break;
      if (!confirm("Delete this task and all its run history?")) break;
      const r = await apiDelete(`api/maestro/tasks/${encodeURIComponent(id)}`);
      if (r.ok) {
        if (appendActivityLog) appendActivityLog("Maestro task deleted");
        allTasksCache = [];
        viewMode = "list";
        currentTask = null;
        await refresh();
      } else {
        if (appendActivityLog) appendActivityLog(`Maestro delete error: ${r.error}`);
      }
      break;
    }

    case "create-task": {
      const form = document.getElementById("maestro-create-form");
      if (form) form.hidden = false;
      const titleInput = document.getElementById("maestro-create-title");
      if (titleInput) titleInput.focus();
      break;
    }

    case "cancel-create": {
      const form = document.getElementById("maestro-create-form");
      if (form) form.hidden = true;
      break;
    }

    case "submit-create": {
      const title = document.getElementById("maestro-create-title")?.value?.trim();
      if (!title) {
        alert("Title is required");
        break;
      }
      const description = document.getElementById("maestro-create-desc")?.value?.trim() || undefined;
      const scheduleCron = document.getElementById("maestro-create-cron")?.value?.trim() || undefined;
      const modelId = document.getElementById("maestro-create-model")?.value?.trim() || undefined;
      const retryOnError = document.getElementById("maestro-create-retry")?.checked || false;
      const chainTo = document.getElementById("maestro-create-chain-to")?.value?.trim() || undefined;
      const chainCondition = document.getElementById("maestro-create-chain-condition")?.value || undefined;

      const body = { title, description, scheduleCron, taskType: "chat", modelId, retryOnError };
      if (chainTo) body.chainTo = chainTo;
      if (chainTo && chainCondition) body.chainCondition = chainCondition;
      if (scheduleCron) body.scheduleEnabled = true;

      const r = await apiPost("api/maestro/tasks", body);
      if (r.ok) {
        if (appendActivityLog) appendActivityLog(`Maestro task created: "${title}"`);
        allTasksCache = [];
        await refresh();
      } else {
        alert(`Create task error: ${r.error || "Unknown"}`);
        if (appendActivityLog) appendActivityLog(`Maestro create error: ${r.error}`);
      }
      break;
    }
  }
}

// ── Chat send handler ─────────────────────────────────────────────────────────

async function handleChatSend() {
  if (chatSending) return;
  const input = document.getElementById("maestro-chat-input");
  if (!input) return;
  const message = input.value?.trim();
  if (!message) return;

  // Capture model selection BEFORE re-render destroys the DOM
  const modelSelect = document.getElementById("maestro-chat-model-select");
  const modelId = modelSelect?.value || null;
  // Remember last used model for Chat
  if (modelId) { localStorage.setItem("maestro-chat-model", modelId); }
  else { localStorage.removeItem("maestro-chat-model"); }

  // Add user message to state
  chatMessages.push({ role: "user", content: message, at: new Date().toISOString() });
  chatSending = true;

  // Re-render with "thinking" indicator
  await refreshChatView();

  try {
    const r = await apiPost("api/maestro/chat", { message, modelId });

    chatSending = false;

    if (r.ok) {
      chatMessages.push({
        role: "assistant",
        content: r.summary || "(no summary)",
        at: new Date().toISOString(),
        toolTrace: r.run?.toolTrace || [],
        modelId: r.run?.modelId || null,
        tokens: r.run?.totalTokens || 0,
      });
    } else {
      chatMessages.push({
        role: "assistant",
        content: "",
        at: new Date().toISOString(),
        error: r.error || "Unknown error",
      });
    }
  } catch (e) {
    chatSending = false;
    chatMessages.push({
      role: "assistant",
      content: "",
      at: new Date().toISOString(),
      error: e instanceof Error ? e.message : String(e),
    });
  }

  await refreshChatView();
}

// ── Navigation helpers ────────────────────────────────────────────────────────

async function navigateToTaskDetail(taskId) {
  const root = document.getElementById("maestro-panel-root");
  if (!root) return;
  try {
    const [taskData, runsData, statusData, chainData] = await Promise.all([
      apiGet(`api/maestro/tasks/${encodeURIComponent(taskId)}`),
      apiGet(`api/maestro/tasks/${encodeURIComponent(taskId)}/runs?limit=50`),
      apiGet("api/maestro/status"),
      apiGet(`api/maestro/tasks/${encodeURIComponent(taskId)}/chain`).catch(() => ({ ok: false })),
      ensureModelList(),
      ensureTaskListCache(),
    ]);
    currentTask = taskData.task;
    currentTaskRuns = runsData.runs || [];
    currentRun = null;
    viewMode = "task-detail";
    renderTaskDetail(root, currentTask, currentTaskRuns, statusData.slotModel || null);

    // Render chain visualization if chain data is available
    if (chainData.ok) {
      _renderChainVis(chainData.chain || [], chainData.parents || []);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    root.innerHTML = `<div class="maestro-error">Error loading task: ${escapeHtml(msg)}</div>`;
  }
}

/**
 * Render chain visualization (pipeline diagram) in the task detail view.
 */
function _renderChainVis(chain, parents) {
  const visEl = document.getElementById("maestro-chain-visualization");
  if (!visEl) return;

  const parts = [];

  // Render parent chain (upstream)
  if (parents.length > 0) {
    for (const p of parents.reverse()) {
      parts.push(`<div class="maestro-chain-node maestro-chain-node--parent">${escapeHtml(truncate(p.title, 30))}</div>`);
      parts.push(`<div class="maestro-chain-arrow">&darr;</div>`);
    }
  }

  // Current task
  if (chain.length > 0) {
    parts.push(`<div class="maestro-chain-node maestro-chain-node--current">${escapeHtml(truncate(chain[0].title, 30))}</div>`);
    for (let i = 1; i < chain.length; i++) {
      const cond = chain[i - 1].chainCondition || "success";
      const condLabel = cond === "success" ? "&#x2713;" : cond === "error" ? "&#x2717;" : "*";
      parts.push(`<div class="maestro-chain-arrow" title="${cond}">${condLabel} &rarr;</div>`);
      parts.push(`<div class="maestro-chain-node maestro-chain-node--child">${escapeHtml(truncate(chain[i].title, 30))}</div>`);
    }
  }

  visEl.innerHTML = parts.length > 0
    ? `<div class="maestro-chain-pipeline">${parts.join("")}</div>`
    : `<span class="maestro-chain-none">No chain configured</span>`;
}

async function navigateToRunDetail(runId, taskId) {
  const root = document.getElementById("maestro-panel-root");
  if (!root) return;
  try {
    const runData = await apiGet(`api/maestro/runs/${encodeURIComponent(runId)}`);
    currentRun = runData.run;
    // If we don't have the task, fetch it
    if (!currentTask || currentTask.id !== taskId) {
      if (taskId) {
        const taskData = await apiGet(`api/maestro/tasks/${encodeURIComponent(taskId)}`);
        currentTask = taskData.task;
      } else if (currentRun && currentRun.taskId) {
        const taskData = await apiGet(`api/maestro/tasks/${encodeURIComponent(currentRun.taskId)}`);
        currentTask = taskData.task;
      }
    }
    viewMode = "run-detail";
    renderRunDetail(root, currentTask, currentRun);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    root.innerHTML = `<div class="maestro-error">Error loading run: ${escapeHtml(msg)}</div>`;
  }
}

// ── Modal open/close ──────────────────────────────────────────────────────────

function setOpen(open) {
  const modal = document.getElementById("maestro-modal");
  const btn = document.getElementById("btn-ir-maestro");
  if (!modal) return;
  maestroOpen = open;
  modal.hidden = !open;
  if (btn) {
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  }
  // Reset to list view when closing
  if (!open) {
    viewMode = "list";
    activeTab = "tasks";
    currentTask = null;
    currentRun = null;
    currentTaskRuns = [];
    chatMessages = [];
  }
}

export function closeMaestroView() {
  if (!maestroOpen) return;
  setOpen(false);
}

export async function refreshMaestroViewIfOpen() {
  return refreshMaestroViewIfOpenImpl();
}

async function refreshChatView() {
  const root = document.getElementById("maestro-panel-root");
  if (!root) return;
  try {
    const statusData = await apiGet("api/maestro/status");
    renderChat(root, statusData);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    root.innerHTML = `<div class="maestro-error">Error: ${escapeHtml(msg)}</div>`;
  }
}

async function refreshChainsView() {
  const root = document.getElementById("maestro-panel-root");
  if (!root) return;
  try {
    const [statusData, graphData] = await Promise.all([
      apiGet("api/maestro/status"),
      apiGet("api/maestro/chains"),
      ensureTaskListCache(),
    ]);
    renderChains(root, statusData, graphData);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    root.innerHTML = `<div class="maestro-error">Error: ${escapeHtml(msg)}</div>`;
  }
}

async function refresh() {
  const root = document.getElementById("maestro-panel-root");
  if (!root) return;

  // Preload model list and task list in the background (non-blocking)
  void ensureModelList();
  void ensureTaskListCache();

  // If we're in the chat view, refresh that
  if (activeTab === "chat" && viewMode === "chat") {
    await refreshChatView();
    return;
  }

  // If we're in the chains view, refresh that
  if (activeTab === "chains" && viewMode === "chains") {
    await refreshChainsView();
    return;
  }

  // If we're in a detail view, refresh that instead
  if (viewMode === "task-detail" && currentTask) {
    await navigateToTaskDetail(currentTask.id);
    return;
  }
  if (viewMode === "run-detail" && currentRun) {
    await navigateToRunDetail(currentRun.id, currentTask ? currentTask.id : null);
    return;
  }

  try {
    const [statusData, tasksData] = await Promise.all([
      apiGet("api/maestro/status"),
      apiGet("api/maestro/tasks"),
    ]);
    renderMaestro(root, {
      status: statusData,
      tasks: tasksData.tasks || [],
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    root.innerHTML = `<div class="maestro-error">Error loading Maestro: ${escapeHtml(msg)}</div>`;
    if (appendActivityLog) appendActivityLog(`Maestro: ${msg}`);
  }
}

/**
 * @param {{ appendActivityLog: (s: string) => void }} deps
 */
export function initMaestroPanel(deps) {
  appendActivityLog = typeof deps.appendActivityLog === "function" ? deps.appendActivityLog : null;

  const modal = document.getElementById("maestro-modal");
  const btn = document.getElementById("btn-ir-maestro");
  const closeBtn = document.getElementById("maestro-modal-close");
  if (!modal || !btn || !closeBtn) return;

  refreshMaestroViewIfOpenImpl = async () => {
    if (!maestroOpen) return;
    await refresh();
  };

  // Open button
  btn.addEventListener("click", () => {
    const opening = !maestroOpen;
    if (opening) {
      setOpen(true);
      refresh();
    } else {
      setOpen(false);
    }
  });

  // Close button (X)
  closeBtn.addEventListener("click", () => {
    setOpen(false);
  });

  // Close on Escape
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && maestroOpen) {
      setOpen(false);
      e.preventDefault();
    }
  });
}
