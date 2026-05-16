-- Auth: users table (login / password-hash / sessions)
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT  NOT NULL,
  role        TEXT    NOT NULL DEFAULT 'user',   -- 'admin' | 'user'
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  last_login  TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY NOT NULL,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id  ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires  ON sessions (expires_at);
