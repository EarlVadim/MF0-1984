/**
 * OpenRouter Models Editor — full CRUD UI inside a modal dialog.
 * Layout: left panel (model list by shortName) + right panel (edit form).
 * Each model entry has a `keeperModel` field — the model to use for Keeper
 * calls when this model is selected in an OR slot. Empty = use dialogue model.
 * Responsive: on narrow screens the panels stack vertically.
 */

import { fetchOpenRouterModelEntries } from "./fetchRemoteModelLists.js";

// ── State ────────────────────────────────────────────────────────────────────

/** @type {Array<object>} */
let modelsCache = [];

/** Index of the currently selected model in modelsCache, or -1 */
let selectedIndex = -1;

/** True if the edit form has unsaved changes */
let dirty = false;

/** Callback after a successful save — lets main.js refresh openRouterEntries etc. */
let afterSaveCallback = null;

// ── DOM helpers ──────────────────────────────────────────────────────────────

function $(sel) { return document.querySelector(sel); }
function $id(id) { return document.getElementById(id); }

// ── API ──────────────────────────────────────────────────────────────────────

async function apiGetModels() {
  const res = await fetch("/api/settings/openrouter-models");
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return Array.isArray(data.models) ? data.models : [];
}

async function apiPutModels(models) {
  const res = await fetch("/api/settings/openrouter-models", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ models }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function apiPostModel(entry) {
  const res = await fetch("/api/settings/openrouter-models", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(entry),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function apiDeleteModel(id) {
  const res = await fetch(`/api/settings/openrouter-models/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ── Deep clone helper for modes ──────────────────────────────────────────────

function deepClone(obj) {
  try { return structuredClone(obj); } catch { return JSON.parse(JSON.stringify(obj)); }
}

// ── Build default modes object for a new model ──────────────────────────────

function defaultModes(modelId) {
  return {
    dialogue: { model: modelId },
    search: {
      model: modelId,
      tools: [{ type: "openrouter:web_search", parameters: { max_results: 5, max_total_results: 20 } }],
    },
    research: {
      model: modelId,
      tools: [
        { type: "openrouter:web_search", parameters: { max_results: 10, max_total_results: 50 } },
        { type: "openrouter:web_fetch", parameters: { max_uses: 5, max_content_tokens: 50000 } },
      ],
    },
  };
}

// ── Render: model list (left panel) ─────────────────────────────────────────

function renderModelList() {
  const listEl = $id("or-models-list");
  if (!listEl) return;
  listEl.replaceChildren();

  if (!modelsCache.length) {
    const empty = document.createElement("div");
    empty.className = "or-models-list-empty";
    empty.textContent = "No models";
    listEl.appendChild(empty);
    return;
  }

  modelsCache.forEach((m, i) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "or-models-list-item" + (i === selectedIndex ? " selected" : "");
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", i === selectedIndex ? "true" : "false");

    const nameSpan = document.createElement("span");
    nameSpan.className = "or-models-list-name";
    nameSpan.textContent = m.shortName || m.id.split("/").pop();

    const descSpan = document.createElement("span");
    descSpan.className = "or-models-list-desc";
    descSpan.textContent = m.desc || `${m.inputPer1M}/${m.outputPer1M}`;

    item.append(nameSpan, descSpan);
    item.addEventListener("click", () => selectModel(i));
    listEl.appendChild(item);
  });
}

// ── Select a model ───────────────────────────────────────────────────────────

function selectModel(index) {
  if (dirty && selectedIndex !== index) {
    if (!confirm("Unsaved changes will be lost. Continue?")) return;
  }
  selectedIndex = index;
  dirty = false;
  renderModelList();
  renderEditForm();
}

// ── Render: edit form (right panel) ──────────────────────────────────────────

function renderEditForm() {
  const formEl = $id("or-models-form");
  if (!formEl) return;

  const m = selectedIndex >= 0 ? modelsCache[selectedIndex] : null;

  if (!m) {
    formEl.innerHTML = '<div class="or-models-form-empty">Select a model to edit, or add a new one.</div>';
    syncActionButtons();
    return;
  }

  formEl.innerHTML = "";

  // — Field: id
  formEl.appendChild(makeField("id", "Model ID", m.id, "text", "e.g. deepseek/deepseek-v4-flash", true));
  // — Field: shortName
  formEl.appendChild(makeField("shortName", "Short Name", m.shortName, "text", "e.g. DS4 Flash"));
  // — Field: desc
  formEl.appendChild(makeField("desc", "Description", m.desc, "text", "e.g. 0.12/0.25"));
  // — Field: inputPer1M
  formEl.appendChild(makeField("inputPer1M", "Input $/1M tokens", String(m.inputPer1M), "number", "0.00", false, "step", "0.001"));
  // — Field: outputPer1M
  formEl.appendChild(makeField("outputPer1M", "Output $/1M tokens", String(m.outputPer1M), "number", "0.00", false, "step", "0.001"));
  // — Field: rerankModel
  formEl.appendChild(makeField("rerankModel", "Rerank Model", m.rerankModel || "", "text", "e.g. cohere/rerank-v3.5"));
  // — Field: keeperModel
  formEl.appendChild(makeField("keeperModel", "Keeper Model", m.keeperModel || "", "text", "e.g. deepseek/deepseek-v4-flash (empty = dialogue model)"));

  // — Modes section
  const modesSection = document.createElement("div");
  modesSection.className = "or-models-form-section";
  const modesTitle = document.createElement("h4");
  modesTitle.className = "or-models-form-section-title";
  modesTitle.textContent = "Modes";
  modesSection.appendChild(modesTitle);

  const modes = m.modes && typeof m.modes === "object" ? m.modes : {};
  for (const modeName of ["dialogue", "search", "research"]) {
    const modeConf = modes[modeName] || {};
    modesSection.appendChild(renderModeBlock(modeName, modeConf));
  }
  formEl.appendChild(modesSection);

  // Bind change listeners
  formEl.querySelectorAll("input, textarea").forEach((el) => {
    el.addEventListener("input", () => {
      dirty = true;
      syncActionButtons();
    });
  });

  syncActionButtons();
}

/**
 * @param {string} key
 * @param {string} label
 * @param {string} value
 * @param {string} type
 * @param {string} [placeholder]
 * @param {boolean} [readonly]
 * @param {string} [extraAttrKey]
 * @param {string} [extraAttrVal]
 */
function makeField(key, label, value, type, placeholder, readonly, extraAttrKey, extraAttrVal) {
  const wrap = document.createElement("div");
  wrap.className = "or-models-form-field";

  const lab = document.createElement("label");
  lab.className = "or-models-form-label";
  lab.htmlFor = `or-model-field-${key}`;
  lab.textContent = label;

  const inp = document.createElement("input");
  inp.className = "or-models-form-input";
  inp.id = `or-model-field-${key}`;
  inp.type = type;
  inp.value = value;
  inp.dataset.field = key;
  if (placeholder) inp.placeholder = placeholder;
  if (readonly) inp.readOnly = true;
  if (extraAttrKey && extraAttrVal) inp.setAttribute(extraAttrKey, extraAttrVal);

  wrap.append(lab, inp);
  return wrap;
}

/**
 * Render a single mode block (dialogue/search/research).
 * @param {string} modeName
 * @param {object} modeConf
 */
function renderModeBlock(modeName, modeConf) {
  const block = document.createElement("div");
  block.className = "or-models-mode-block";
  block.dataset.mode = modeName;

  const header = document.createElement("div");
  header.className = "or-models-mode-header";

  const title = document.createElement("span");
  title.className = "or-models-mode-title";
  title.textContent = modeName.charAt(0).toUpperCase() + modeName.slice(1);

  const modelField = document.createElement("input");
  modelField.className = "or-models-mode-model-input";
  modelField.type = "text";
  modelField.value = modeConf.model || "";
  modelField.dataset.modeField = "model";
  modelField.placeholder = "model id (defaults to entry id)";

  header.append(title, modelField);
  block.appendChild(header);

  // Tools JSON textarea
  const tools = Array.isArray(modeConf.tools) ? modeConf.tools : [];
  const toolsLabel = document.createElement("label");
  toolsLabel.className = "or-models-mode-tools-label";
  toolsLabel.textContent = "Tools (JSON)";
  toolsLabel.htmlFor = `or-model-mode-${modeName}-tools`;

  const toolsArea = document.createElement("textarea");
  toolsArea.className = "or-models-mode-tools";
  toolsArea.id = `or-model-mode-${modeName}-tools`;
  toolsArea.dataset.modeField = "tools";
  toolsArea.rows = 4;
  toolsArea.spellcheck = false;
  try {
    toolsArea.value = tools.length ? JSON.stringify(tools, null, 2) : "";
  } catch {
    toolsArea.value = "";
  }

  block.append(toolsLabel, toolsArea);
  return block;
}

// ── Read current form values into a model entry ─────────────────────────────

function readFormValues() {
  const m = selectedIndex >= 0 ? deepClone(modelsCache[selectedIndex]) : null;
  if (!m) return null;

  // Simple fields
  for (const key of ["shortName", "desc", "inputPer1M", "outputPer1M", "rerankModel", "keeperModel"]) {
    const inp = document.querySelector(`#or-model-field-${key}`);
    if (!inp) continue;
    const val = inp.value.trim();
    if (key === "inputPer1M" || key === "outputPer1M") {
      m[key] = Number(val) || 0;
    } else {
      m[key] = val;
    }
  }

  // Modes
  const formEl = $id("or-models-form");
  if (!formEl) return m;
  const modeBlocks = formEl.querySelectorAll(".or-models-mode-block");
  if (!m.modes || typeof m.modes !== "object") m.modes = {};

  for (const block of modeBlocks) {
    const modeName = block.dataset.mode;
    if (!modeName) continue;
    const modeConf = m.modes[modeName] && typeof m.modes[modeName] === "object"
      ? m.modes[modeName]
      : {};

    const modelInput = block.querySelector('[data-mode-field="model"]');
    if (modelInput) modeConf.model = modelInput.value.trim() || m.id;

    const toolsArea = block.querySelector('[data-mode-field="tools"]');
    if (toolsArea) {
      const raw = toolsArea.value.trim();
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          modeConf.tools = Array.isArray(parsed) ? parsed : [];
        } catch {
          // Keep existing tools if JSON is invalid
        }
      } else {
        modeConf.tools = [];
      }
    }

    m.modes[modeName] = modeConf;
  }

  return m;
}

// ── Action buttons state ─────────────────────────────────────────────────────

function syncActionButtons() {
  const saveBtn = $id("or-models-save-btn");
  const deleteBtn = $id("or-models-delete-btn");
  if (saveBtn) saveBtn.disabled = !dirty || selectedIndex < 0;
  if (deleteBtn) deleteBtn.disabled = selectedIndex < 0;
}

// ── Save current model ──────────────────────────────────────────────────────

async function saveCurrentModel() {
  if (selectedIndex < 0) return;
  const updated = readFormValues();
  if (!updated) return;

  // Write the full list back (replace entry at selectedIndex)
  const allModels = [...modelsCache];
  allModels[selectedIndex] = updated;

  try {
    const result = await apiPutModels(allModels);
    modelsCache = Array.isArray(result.models) ? result.models : allModels;
    dirty = false;
    renderModelList();
    renderEditForm();
    afterSaveCallback?.();
  } catch (e) {
    alert("Save failed: " + (e instanceof Error ? e.message : String(e)));
  }
}

// ── Add new model ────────────────────────────────────────────────────────────

async function addNewModel() {
  const id = prompt("Enter the new model ID (e.g. vendor/model-name):");
  if (!id || !id.trim()) return;

  const entry = {
    id: id.trim(),
    shortName: id.split("/").pop() || id.trim(),
    desc: "",
    inputPer1M: 0,
    outputPer1M: 0,
    rerankModel: "",
    keeperModel: "",
    modes: defaultModes(id.trim()),
  };

  try {
    const result = await apiPostModel(entry);
    modelsCache = Array.isArray(result.models) ? result.models : [...modelsCache, entry];
    selectedIndex = modelsCache.findIndex((m) => m.id === entry.id);
    dirty = false;
    renderModelList();
    renderEditForm();
    afterSaveCallback?.();
  } catch (e) {
    alert("Add failed: " + (e instanceof Error ? e.message : String(e)));
  }
}

// ── Delete current model ─────────────────────────────────────────────────────

async function deleteCurrentModel() {
  if (selectedIndex < 0) return;
  const m = modelsCache[selectedIndex];
  if (!m) return;

  if (!confirm(`Delete model "${m.shortName || m.id}"?`)) return;

  try {
    const result = await apiDeleteModel(m.id);
    modelsCache = Array.isArray(result.models) ? result.models : modelsCache.filter((x) => x.id !== m.id);
    selectedIndex = -1;
    dirty = false;
    renderModelList();
    renderEditForm();
    afterSaveCallback?.();
  } catch (e) {
    alert("Delete failed: " + (e instanceof Error ? e.message : String(e)));
  }
}

// ── Open / close modal ───────────────────────────────────────────────────────

function openModal() {
  const modal = $id("or-models-modal");
  if (!modal) return;
  modal.hidden = false;
  selectedIndex = -1;
  dirty = false;
  renderModelList();
  renderEditForm();
  // Fetch fresh data in background
  apiGetModels().then((fresh) => {
    modelsCache = fresh;
    selectedIndex = -1;
    dirty = false;
    renderModelList();
    renderEditForm();
  }).catch(() => {});
}

function closeModal() {
  if (dirty) {
    if (!confirm("Unsaved changes will be lost. Close anyway?")) return;
  }
  const modal = $id("or-models-modal");
  if (modal) modal.hidden = true;
  dirty = false;
  selectedIndex = -1;
}

// ── Public init ──────────────────────────────────────────────────────────────

/**
 * Initialize the OpenRouter Models Editor.
 * Call once on app boot. Wires up button listeners inside the modal.
 * @param {{ afterSave?: () => void }} [opts]
 */
export function initOpenRouterModelsEditor(opts = {}) {
  afterSaveCallback = opts.afterSave ?? null;

  // Open button (in Settings)
  const openBtn = $id("settings-or-models-btn");
  if (openBtn) {
    openBtn.addEventListener("click", () => openModal());
  }

  // Close button (modal header)
  const closeBtn = $id("or-models-modal-close");
  if (closeBtn) {
    closeBtn.addEventListener("click", () => closeModal());
  }

  // Overlay click — do NOT close (same UX as Settings)
  const overlay = $id("or-models-modal-overlay");
  // intentionally no close on overlay click

  // Action buttons
  const saveBtn = $id("or-models-save-btn");
  if (saveBtn) {
    saveBtn.addEventListener("click", () => saveCurrentModel());
  }
  const addBtn = $id("or-models-add-btn");
  if (addBtn) {
    addBtn.addEventListener("click", () => addNewModel());
  }
  const deleteBtn = $id("or-models-delete-btn");
  if (deleteBtn) {
    deleteBtn.addEventListener("click", () => deleteCurrentModel());
  }

  // Escape key
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const modal = $id("or-models-modal");
    if (!modal || modal.hidden) return;
    closeModal();
    e.stopPropagation();
  }, true);
}

/**
 * Return the current in-memory models cache (used by main.js to update openRouterEntries).
 * @returns {Array<object>}
 */
export function getOrModelsCache() {
  return modelsCache;
}
