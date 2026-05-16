/**
 * server/db/auth.mjs
 * User + session persistence. Uses the shared adapter (SQLite or Postgres).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// Lazy adapter reference — resolved on first use, not at import time
let _adapter = null;
async function getAdapter() {
  if (!_adapter) {
    const m = await import("./migrations.mjs");
    _adapter = m.adapter;
  }
  return _adapter;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** bcrypt-lite: PBKDF2-SHA512, 100k iterations, 32-byte key, stored as hex */
function hashPassword(password, salt) {
  const s = salt ?? randomBytes(16).toString("hex");
  let h = createHash("sha512").update(s + ":" + password).digest("hex");
  for (let i = 0; i < 100_000; i++) {
    h = createHash("sha512").update(h + s).digest("hex");
  }
  return `sha512:${s}:${h}`;
}

function verifyPassword(password, stored) {
  const parts = stored.split(":");
  if (parts.length !== 3) return false;
  const [, salt] = parts;
  const expected = hashPassword(password, salt);
  // constant-time compare
  const a = Buffer.from(expected);
  const b = Buffer.from(stored);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function generateToken() {
  return randomBytes(32).toString("hex");
}

function expiresAt(days = 30) {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

// ── Users ────────────────────────────────────────────────────────────────────

export async function countUsers() {
  const db = await getAdapter();
  const row = await db.get("SELECT COUNT(*) AS n FROM users");
  return Number(row?.n ?? 0);
}

export async function createUser(username, password, role = "user") {
  const db = await getAdapter();
  const hash = hashPassword(password);
  await db.run(
    "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    [username.trim(), hash, role],
  );
  return db.get(
    "SELECT id, username, role FROM users WHERE username = ? COLLATE NOCASE",
    [username.trim()],
  );
}

export async function findUserByUsername(username) {
  const db = await getAdapter();
  return db.get(
    "SELECT id, username, password_hash, role FROM users WHERE username = ? COLLATE NOCASE",
    [username.trim()],
  );
}

export async function authenticateUser(username, password) {
  const user = await findUserByUsername(username);
  if (!user) return null;
  if (!verifyPassword(password, user.password_hash)) return null;
  const db = await getAdapter();
  await db.run("UPDATE users SET last_login = datetime('now') WHERE id = ?", [user.id]);
  return { id: user.id, username: user.username, role: user.role };
}

// ── Sessions ─────────────────────────────────────────────────────────────────

export async function createSession(userId, days = 30) {
  const db = await getAdapter();
  const token = generateToken();
  const exp   = expiresAt(days);
  await db.run(
    "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)",
    [token, userId, exp],
  );
  return token;
}

export async function getSession(token) {
  if (!token) return null;
  const db = await getAdapter();
  const row = await db.get(
    `SELECT s.token, s.user_id, s.expires_at, u.username, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_at > datetime('now')`,
    [token],
  );
  return row ?? null;
}

export async function deleteSession(token) {
  const db = await getAdapter();
  await db.run("DELETE FROM sessions WHERE token = ?", [token]);
}

export async function pruneExpiredSessions() {
  const db = await getAdapter();
  await db.run("DELETE FROM sessions WHERE expires_at <= datetime('now')");
}
