-- Initial myslop-plans schema. Applied forward-only by the platform.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,              -- shoo pairwise_sub
  email TEXT,
  name TEXT,
  picture TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS users_verified_email ON users(email COLLATE NOCASE) WHERE email IS NOT NULL;

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

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,              -- random 10-char hex, non-enumerable
  user_id TEXT NOT NULL REFERENCES users(id),   -- owner: the token minter
  title TEXT NOT NULL,
  current_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS plans_user ON plans(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS plan_versions (
  plan_id TEXT NOT NULL REFERENCES plans(id),
  version INTEGER NOT NULL,         -- 1..n, immutable once written
  title TEXT NOT NULL,
  markdown TEXT NOT NULL,
  note TEXT,                        -- optional agent changelog line
  created_at INTEGER NOT NULL,
  PRIMARY KEY (plan_id, version)
);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id),
  version INTEGER NOT NULL,         -- version the comment was made against
  block_id TEXT,                    -- NULL = general comment
  parent_id TEXT REFERENCES comments(id),       -- NULL = thread root
  author_type TEXT NOT NULL CHECK (author_type IN ('user','agent')),
  user_id TEXT REFERENCES users(id),            -- NULL for agent comments
  agent_name TEXT,                  -- token name, shown as "Agent · <name>"
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS comments_plan ON comments(plan_id, created_at);

CREATE TABLE IF NOT EXISTS reviews (
  plan_id TEXT NOT NULL REFERENCES plans(id),
  version INTEGER NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  verdict TEXT NOT NULL CHECK (verdict IN ('approved','changes_requested')),
  note TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (plan_id, version, user_id)
);
