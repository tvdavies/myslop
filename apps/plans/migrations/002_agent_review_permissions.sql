-- Existing keys keep their secrets and author capabilities. Review requires
-- an explicit permission update by the signed-in key owner, not key rotation.
ALTER TABLE tokens ADD COLUMN permissions TEXT NOT NULL
  DEFAULT '["plans:read","plans:write","plans:comment","plans:resolve"]';

CREATE TABLE IF NOT EXISTS agent_reviews (
  plan_id TEXT NOT NULL REFERENCES plans(id),
  version INTEGER NOT NULL,
  token_id TEXT NOT NULL REFERENCES tokens(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  agent_name TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('approved','changes_requested')),
  note TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (plan_id, version, token_id)
);
