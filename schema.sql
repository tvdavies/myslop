-- myslop-mail metadata. Apply with:
--   bunx wrangler d1 execute myslop-mail --remote --file schema.sql

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

-- Ownership registry for inbox names (local parts). A row is created either by
-- an explicit claim or automatically the first time a user reads an inbox.
-- Mail delivery is a global catch-all and is NOT gated by this table; ownership
-- only gates who may READ/list/release a given name.
CREATE TABLE IF NOT EXISTS inboxes (
  name TEXT PRIMARY KEY,            -- local part, lowercased
  user_id TEXT NOT NULL REFERENCES users(id),
  note TEXT NOT NULL DEFAULT '',
  claimed INTEGER NOT NULL DEFAULT 0,  -- 1 = explicit claim (kept), 0 = auto-owned on read
  created_at INTEGER NOT NULL,
  last_read_at INTEGER
);
CREATE INDEX IF NOT EXISTS inboxes_user ON inboxes(user_id, created_at DESC);
