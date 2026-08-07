-- Serialize dynamic custom-domain changes with control-plane deployments.
CREATE TABLE IF NOT EXISTS platform_locks (
  name TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
