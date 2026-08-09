ALTER TABLE users ADD COLUMN identity_id TEXT;
CREATE UNIQUE INDEX users_identity_id ON users(identity_id) WHERE identity_id IS NOT NULL;
CREATE TABLE identity_links (
  identity_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  method TEXT NOT NULL CHECK (method IN ('new','legacy_session','api_token','operator')),
  linked_at INTEGER NOT NULL,
  UNIQUE (user_id)
);
