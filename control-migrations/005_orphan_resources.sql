-- Persist Cloudflare resource identifiers when compensating cleanup fails.
CREATE TABLE IF NOT EXISTS orphan_resources (
  type TEXT NOT NULL CHECK (type IN ('d1', 'r2', 'worker', 'domain')),
  identifier TEXT NOT NULL,
  app_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (type, identifier)
);
