/**
 * Database setup entry point.
 *
 * Exports:
 *   adapter  — DbAdapter for the configured backend (sqlite | postgres).
 *              All db/* modules import this instead of creating their own.
 *   db       — raw better-sqlite3 connection (SQLite only, null for Postgres).
 *              Still used by code that has not been migrated to the adapter yet.
 *   dbPath   — resolved SQLite file path (SQLite only).
 *
 * Backend is selected via DB_ADAPTER env var (default: sqlite).
 * For Postgres, set DB_ADAPTER=postgres and DATABASE_URL=postgres://...
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { sanitizeAccessExternalEntries } from "../accessExternalServicesDb.mjs";
import { createSqliteAdapter } from "./adapter.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "../..");

export const dbPath = process.env.API_SQLITE_PATH
  ? path.resolve(process.cwd(), process.env.API_SQLITE_PATH)
  : path.join(root, "data", "mf-lab.sqlite");

const schemaPath = path.join(root, "db", "schema.sql");
const migration003 = path.join(root, "db", "migrations", "003_context_engine.sql");
const migration004 = path.join(root, "db", "migrations", "004_memory_graph.sql");
const migration005 = path.join(root, "db", "migrations", "005_assistant_error.sql");
const migration006 = path.join(root, "db", "migrations", "006_intro_pin_lock.sql");
const migration007 = path.join(root, "db", "migrations", "007_ir_panel_pin_lock.sql");
const migration008 = path.join(root, "db", "migrations", "008_access_external_services.sql");
const migration009 = path.join(root, "db", "migrations", "009_analytics_usage_archive.sql");
const migration010 = path.join(root, "db", "migrations", "010_llm_token_usage.sql");
const migration011 = path.join(root, "db", "migrations", "011_analytics_aux_llm_usage.sql");
const migration012 = path.join(root, "db", "migrations", "012_memory_graph_embeddings.sql");
const migration013 = path.join(root, "db", "migrations", "013_users.sql");
const migration014 = path.join(root, "db", "migrations", "014_dialog_or_models.sql");
const migration015 = path.join(root, "db", "migrations", "015_maestro.sql");
const migration016 = path.join(root, "db", "migrations", "016_maestro_enhancements.sql");
const migration017 = path.join(root, "db", "migrations", "017_maestro_model.sql");

function estimateTokensFromText(text) {
  const s = String(text ?? "").trim();
  if (!s) return 0;
  return Math.max(1, Math.ceil(s.length / 4));
}

function applyContextEngineMigration(database) {
  const row = database.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='rules'`).get();
  if (row) return;
  if (fs.existsSync(migration003)) {
    database.exec(fs.readFileSync(migration003, "utf8"));
  }
}

/** Assistant favorites: markdown snapshot in assistant_favorite_markdown. */
function applyAssistantFavoriteColumns(database) {
  const cols = database.prepare(`PRAGMA table_info(conversation_turns)`).all();
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("assistant_favorite")) {
    database.exec(
      `ALTER TABLE conversation_turns ADD COLUMN assistant_favorite INTEGER NOT NULL DEFAULT 0`,
    );
  }
  if (!names.has("assistant_favorite_markdown")) {
    database.exec(`ALTER TABLE conversation_turns ADD COLUMN assistant_favorite_markdown TEXT`);
  }
}

/** Attachment names for LLM / RAG context (not shown in UI). */
function applyUserAttachmentsJsonColumn(database) {
  const cols = database.prepare(`PRAGMA table_info(conversation_turns)`).all();
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("user_attachments_json")) {
    database.exec(`ALTER TABLE conversation_turns ADD COLUMN user_attachments_json TEXT`);
  }
}

function applyDialogsPurposeColumn(database) {
  const cols = database.prepare(`PRAGMA table_info(dialogs)`).all();
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("purpose")) {
    database.exec(`ALTER TABLE dialogs ADD COLUMN purpose TEXT`);
  }
}

function applyMemoryGraphMigration(database) {
  const row = database
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='memory_graph_nodes'`)
    .get();
  if (row) return;
  if (fs.existsSync(migration004)) {
    database.exec(fs.readFileSync(migration004, "utf8"));
  }
}

function applyAssistantErrorColumn(database) {
  const cols = database.prepare(`PRAGMA table_info(conversation_turns)`).all();
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("assistant_error")) {
    if (fs.existsSync(migration005)) {
      database.exec(fs.readFileSync(migration005, "utf8"));
    } else {
      database.exec(`ALTER TABLE conversation_turns ADD COLUMN assistant_error INTEGER NOT NULL DEFAULT 0`);
    }
  }
}

function applyIntroPinLockMigration(database) {
  const row = database
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='intro_pin_lock'`)
    .get();
  if (row) return;
  if (fs.existsSync(migration006)) {
    database.exec(fs.readFileSync(migration006, "utf8"));
  }
}

/** Intro / Rules / Access — one PIN row per panel (`ir_panel_pin_lock`). Migrates legacy `intro_pin_lock`. */
function applyIrPanelPinLockMigration(database) {
  const hasIr = database
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='ir_panel_pin_lock'`)
    .get();
  if (hasIr) return;
  applyIntroPinLockMigration(database);
  if (!fs.existsSync(migration007)) {
    throw new Error("Missing migration 007_ir_panel_pin_lock.sql");
  }
  database.exec(fs.readFileSync(migration007, "utf8"));
  const legacy = database
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='intro_pin_lock'`)
    .get();
  if (legacy) {
    const row = database.prepare(`SELECT pin_double_hash FROM intro_pin_lock WHERE singleton = 1`).get();
    if (row?.pin_double_hash) {
      database
        .prepare(`INSERT OR REPLACE INTO ir_panel_pin_lock (panel, pin_double_hash) VALUES ('intro', ?)`)
        .run(row.pin_double_hash);
    }
    database.exec(`DROP TABLE intro_pin_lock`);
  }
}

function applyAccessExternalServicesMigration(database) {
  const row = database
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='access_external_services'`)
    .get();
  if (row) return;
  if (!fs.existsSync(migration008)) {
    throw new Error("Missing migration 008_access_external_services.sql");
  }
  database.exec(fs.readFileSync(migration008, "utf8"));
}

/**
 * One-time: import legacy JSON into SQLite when the table is empty, then remove the file.
 * @param {import("better-sqlite3").Database} database
 */
function migrateAccessExternalServicesFromJsonIfNeeded(database) {
  const accessExternalServicesPath = path.join(root, "data", "access-external-services.json");
  const n = database.prepare(`SELECT COUNT(*) AS c FROM access_external_services`).get();
  const count = Number(n?.c ?? 0);
  if (count > 0) return;
  if (!fs.existsSync(accessExternalServicesPath)) return;
  let raw;
  try {
    raw = fs.readFileSync(accessExternalServicesPath, "utf8");
  } catch {
    return;
  }
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    console.warn("[mf-lab-api] access-external-services.json: invalid JSON, skipping migration");
    return;
  }
  const entries = sanitizeAccessExternalEntries(j.entries);
  if (entries.length === 0) {
    try {
      fs.unlinkSync(accessExternalServicesPath);
    } catch {
      /* ignore */
    }
    return;
  }
  const ins = database.prepare(
    `INSERT INTO access_external_services (id, name, description, endpoint_url, access_key, notes, updated_at)
     VALUES (@id, @name, @description, @endpointUrl, @accessKey, @notes, @updatedAt)`,
  );
  const tx = database.transaction((rows) => {
    for (const e of rows) {
      ins.run({
        id: e.id,
        name: e.name,
        description: e.description,
        endpointUrl: e.endpointUrl,
        accessKey: e.accessKey,
        notes: e.notes,
        updatedAt: e.updatedAt,
      });
    }
  });
  tx(entries);
  try {
    fs.unlinkSync(accessExternalServicesPath);
    console.log(
      "[mf-lab-api] Migrated access-external-services.json → access_external_services table; legacy file removed.",
    );
  } catch (e) {
    console.warn(
      "[mf-lab-api] Migrated access JSON to DB but could not remove file:",
      e instanceof Error ? e.message : String(e),
    );
  }
}

function applyMemoryGraphEmbeddingsMigration(database) {
  const cols = database.prepare(`PRAGMA table_info(memory_graph_nodes)`).all();
  const names = new Set(cols.map((c) => c.name));
  if (names.has("embedding")) return;
  if (fs.existsSync(migration012)) {
    database.exec(fs.readFileSync(migration012, "utf8"));
  }
}

function applyAnalyticsAuxLlmUsageMigration(database) {
  const row = database
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='analytics_aux_llm_usage'`)
    .get();
  if (row) return;
  if (fs.existsSync(migration011)) {
    database.exec(fs.readFileSync(migration011, "utf8"));
  }
}

/** So turn-cost popup can attach voice_reply_tts even after the user sent a follow-up message. */
function applyAnalyticsAuxConversationTurnIdColumn(database) {
  const row = database
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='analytics_aux_llm_usage'`)
    .get();
  if (!row) return;
  const cols = database.prepare(`PRAGMA table_info(analytics_aux_llm_usage)`).all();
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("conversation_turn_id")) {
    database.exec(`ALTER TABLE analytics_aux_llm_usage ADD COLUMN conversation_turn_id TEXT`);
    database.exec(
      `CREATE INDEX IF NOT EXISTS idx_analytics_aux_llm_usage_turn ON analytics_aux_llm_usage(conversation_turn_id)`,
    );
  }
}

/**
 * Older voice_reply_tts rows lack conversation_turn_id; match by token estimate + time so the popup can find them.
 */
function applyAnalyticsAuxDialogIdColumn(database) {
  const row = database
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='analytics_aux_llm_usage'`)
    .get();
  if (!row) return;
  const cols = database.prepare(`PRAGMA table_info(analytics_aux_llm_usage)`).all();
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("dialog_id")) {
    database.exec(`ALTER TABLE analytics_aux_llm_usage ADD COLUMN dialog_id TEXT`);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_analytics_aux_llm_usage_dialog ON analytics_aux_llm_usage(dialog_id)`);
  }
}

/** Fill dialog_id on aux rows that already have conversation_turn_id (e.g. voice TTS). */
function backfillAuxDialogIdFromConversationTurn(database) {
  try {
    database.exec(`
      UPDATE analytics_aux_llm_usage
      SET dialog_id = (
        SELECT dialog_id FROM conversation_turns WHERE conversation_turns.id = analytics_aux_llm_usage.conversation_turn_id
      )
      WHERE conversation_turn_id IS NOT NULL AND TRIM(conversation_turn_id) != ''
        AND (dialog_id IS NULL OR TRIM(dialog_id) = '')
    `);
  } catch (e) {
    console.warn("[mf-lab-api] backfill aux dialog_id from turn:", e);
  }
}

function backfillVoiceReplyTtsConversationTurnIds(database) {
  try {
    const orphans = database
      .prepare(
        `SELECT id, created_at, llm_prompt_tokens FROM analytics_aux_llm_usage
         WHERE request_kind = 'voice_reply_tts'
           AND (conversation_turn_id IS NULL OR conversation_turn_id = '')`,
      )
      .all();
    if (!orphans.length) return;
    const turnRows = database
      .prepare(
        `SELECT id, assistant_text, assistant_message_at FROM conversation_turns
         WHERE assistant_text IS NOT NULL AND TRIM(assistant_text) != ''`,
      )
      .all();
    const upd = database.prepare(`UPDATE analytics_aux_llm_usage SET conversation_turn_id = ? WHERE id = ?`);
    for (const r of orphans) {
      const pt = Math.max(0, Number(r.llm_prompt_tokens) || 0);
      const cms = Date.parse(String(r.created_at ?? ""));
      if (!Number.isFinite(cms)) continue;
      let bestId = "";
      let bestAms = -Infinity;
      for (const t of turnRows) {
        const est = estimateTokensFromText(String(t.assistant_text ?? ""));
        if (est !== pt) continue;
        const ams = Date.parse(String(t.assistant_message_at ?? ""));
        if (!Number.isFinite(ams) || ams > cms) continue;
        if (ams > bestAms) {
          bestAms = ams;
          bestId = String(t.id ?? "").trim();
        }
      }
      if (bestId) upd.run(bestId, String(r.id ?? ""));
    }
  } catch (e) {
    console.warn("[mf-lab-api] backfill voice_reply_tts conversation_turn_id:", e);
  }
}

function applyLlmTokenUsageMigration(database) {
  const cols = database.prepare(`PRAGMA table_info(conversation_turns)`).all();
  const names = new Set(cols.map((c) => c.name));
  if (names.has("llm_total_tokens")) return;
  if (fs.existsSync(migration010)) {
    database.exec(fs.readFileSync(migration010, "utf8"));
  }
}

/** Adds responding_model_id column to conversation_turns for per-model token/cost tracking. */
function applyRespondingModelIdColumn(database) {
  const cols = database.prepare(`PRAGMA table_info(conversation_turns)`).all();
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("responding_model_id")) {
    database.exec(`ALTER TABLE conversation_turns ADD COLUMN responding_model_id TEXT`);
  }
}

function applyAnalyticsUsageArchiveMigration(database) {
  const row = database
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='analytics_usage_archive'`)
    .get();
  if (row) return;
  if (fs.existsSync(migration009)) {
    database.exec(fs.readFileSync(migration009, "utf8"));
  }
}

/**
 * Open the SQLite file at `filePath`, apply all idempotent migrations, and return the connection.
 * @param {string} filePath
 * @returns {import("better-sqlite3").Database}
 */
export function createDatabase(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const database = new Database(filePath);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  const ver = database.prepare("PRAGMA user_version").pluck().get();
  if (ver === 0) {
    const sql = fs.readFileSync(schemaPath, "utf8");
    database.exec(sql);
  }
  applyContextEngineMigration(database);
  applyAssistantFavoriteColumns(database);
  applyUserAttachmentsJsonColumn(database);
  applyDialogsPurposeColumn(database);
  applyMemoryGraphMigration(database);
  applyAssistantErrorColumn(database);
  applyIrPanelPinLockMigration(database);
  applyAccessExternalServicesMigration(database);
  migrateAccessExternalServicesFromJsonIfNeeded(database);
  applyAnalyticsUsageArchiveMigration(database);
  applyLlmTokenUsageMigration(database);
  applyAnalyticsAuxLlmUsageMigration(database);
  applyMemoryGraphEmbeddingsMigration(database);
  applyAnalyticsAuxConversationTurnIdColumn(database);
  applyAnalyticsAuxDialogIdColumn(database);
  backfillVoiceReplyTtsConversationTurnIds(database);
  backfillAuxDialogIdFromConversationTurn(database);
  applyRespondingModelIdColumn(database);
  // 013: users + sessions tables (auth)
  if (fs.existsSync(migration013)) {
    database.exec(fs.readFileSync(migration013, "utf8"));
  }
  if (fs.existsSync(migration014)) {
    try { database.exec(fs.readFileSync(migration014, "utf8")); } catch (e) {
      // Column may already exist if DB was manually altered
      if (!String(e?.message).includes("duplicate column")) throw e;
    }
  }
  // 015: Maestro task scheduler tables
  if (fs.existsSync(migration015)) {
    database.exec(fs.readFileSync(migration015, "utf8"));
  }
  // 016: Maestro enhancements — tool_trace, conversation_history, max_tool_rounds
  if (fs.existsSync(migration016)) {
    try { database.exec(fs.readFileSync(migration016, "utf8")); } catch (e) {
      if (!String(e?.message).includes("duplicate column")) throw e;
    }
  }
  // 017: Maestro — model_id in runs, default_model in tasks
  if (fs.existsSync(migration017)) {
    try { database.exec(fs.readFileSync(migration017, "utf8")); } catch (e) {
      if (!String(e?.message).includes("duplicate column")) throw e;
    }
  }
  // 017b: Task chaining — chain_to + chain_condition (consolidated from old 017_maestro_task_chain.sql)
  {
    const p = path.join(root, "db", "migrations", "017_maestro_task_chain.sql");
    if (fs.existsSync(p)) {
      try { database.exec(fs.readFileSync(p, "utf8")); } catch (e) {
        if (!String(e?.message).includes("duplicate column")) throw e;
      }
    }
  }
  // 018: Maestro self-management — retry policy, source_task_id
  {
    const p = path.join(root, "db", "migrations", "018_maestro_self_management.sql");
    if (fs.existsSync(p)) {
      try { database.exec(fs.readFileSync(p, "utf8")); } catch (e) {
        if (!String(e?.message).includes("duplicate column")) throw e;
      }
    }
  }
  // 019: Maestro model backfill (no-op SQL, documentation only)
  {
    const p = path.join(root, "db", "migrations", "019_maestro_model_backfill.sql");
    if (fs.existsSync(p)) {
      try { database.exec(fs.readFileSync(p, "utf8")); } catch (e) {
        // no-op migration, ignore any errors
      }
    }
  }
  // 020: Maestro default_model backfill (no-op SQL, documentation only)
  {
    const p = path.join(root, "db", "migrations", "020_maestro_default_model_backfill.sql");
    if (fs.existsSync(p)) {
      try { database.exec(fs.readFileSync(p, "utf8")); } catch (e) {
        // no-op migration, ignore any errors
      }
    }
  }
  // 021: Task chain (consolidated into 017, now a no-op)
  {
    const p = path.join(root, "db", "migrations", "021_maestro_task_chain.sql");
    if (fs.existsSync(p)) {
      try { database.exec(fs.readFileSync(p, "utf8")); } catch (e) {
        if (!String(e?.message).includes("duplicate column")) throw e;
      }
    }
  }
  // 022: Backfill responding_model_id for Maestro conversation turns
  {
    const p = path.join(root, "db", "migrations", "022_maestro_responding_model_backfill.sql");
    if (fs.existsSync(p)) {
      try { database.exec(fs.readFileSync(p, "utf8")); } catch (e) {
        // May fail if maestro_runs or conversation_turns data is inconsistent; non-critical
        console.warn("[mf-lab-api] Migration 022 warning:", e?.message || e);
      }
    }
  }
  // 023: Add index on memory_graph_nodes.label for faster LIKE queries
  {
    const migration023 = path.join(root, "db", "migrations", "023_memory_graph_node_label_index.sql");
    if (fs.existsSync(migration023)) {
      try { database.exec(fs.readFileSync(migration023, "utf8")); } catch (e) {
        // Index may already exist
        if (!String(e?.message).includes("already exists")) throw e;
      }
    }
  }
  return database;
}

/** Default singleton SQLite connection (env-configured path). null when DB_ADAPTER=postgres. */
export const db = (process.env.DB_ADAPTER ?? "sqlite").toLowerCase().trim() !== "postgres"
  ? createDatabase(dbPath)
  : null;

// ---------------------------------------------------------------------------
// Adapter factory — selects SQLite or Postgres based on DB_ADAPTER env var.
// Top-level await is valid in ES modules: Postgres setup is async, SQLite is sync.
// ---------------------------------------------------------------------------

const _which = (process.env.DB_ADAPTER ?? "sqlite").toLowerCase().trim();

/** Shared DbAdapter for the configured backend. Import this in all db/* modules. */
export const adapter = await (async () => {
  if (_which === "sqlite") {
    return createSqliteAdapter(db);
  }
  if (_which === "postgres") {
    const { createPostgresSetup } = await import("./postgres.mjs");
    return createPostgresSetup();
  }
  throw new Error(`Unknown DB_ADAPTER="${_which}". Allowed values: sqlite, postgres`);
})();
