-- myslop-files metadata. Apply with:
--   bunx wrangler d1 execute myslop-files --remote --file schema.sql

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,              -- shoo pairwise_sub
  email TEXT,
  name TEXT,
  picture TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,              -- random 128-bit hex, set as HttpOnly cookie
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY,              -- short display id
  user_id TEXT NOT NULL REFERENCES users(id),
  hash TEXT NOT NULL UNIQUE,        -- sha256 hex of the full secret
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,             -- first chars of secret, for display only
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS tokens_user ON tokens(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS files (
  key TEXT PRIMARY KEY,             -- R2 object key: <prefix>/<filename>
  user_id TEXT NOT NULL REFERENCES users(id),
  filename TEXT NOT NULL,
  size INTEGER,
  content_type TEXT,
  private INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS files_user ON files(user_id, created_at DESC);
