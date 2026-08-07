ALTER TABLE apps ADD COLUMN managed_by TEXT NOT NULL DEFAULT 'manual' CHECK (managed_by IN ('manual', 'git'));
ALTER TABLE apps ADD COLUMN source_hash TEXT;
ALTER TABLE apps ADD COLUMN d1_adopted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE apps ADD COLUMN r2_adopted INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS apps_source_hash ON apps(source_hash) WHERE source_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS apps_d1_resource ON apps(d1_id) WHERE d1_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS apps_r2_resource ON apps(r2_bucket) WHERE r2_bucket IS NOT NULL;

CREATE TABLE IF NOT EXISTS app_domains (
  hostname TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  cloudflare_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'deleting', 'error')),
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS app_domains_app ON app_domains(app_id, hostname);

CREATE TABLE IF NOT EXISTS app_schedules (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  expression TEXT NOT NULL,
  next_run_at INTEGER NOT NULL,
  last_run_at INTEGER,
  last_status TEXT CHECK (last_status IN ('running', 'succeeded', 'retrying', 'failed')),
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (app_id, expression)
);
CREATE INDEX IF NOT EXISTS app_schedules_due ON app_schedules(next_run_at, app_id);

CREATE TABLE IF NOT EXISTS schedule_runs (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES app_schedules(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  scheduled_at INTEGER NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'retrying', 'failed')),
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (schedule_id, scheduled_at)
);
CREATE INDEX IF NOT EXISTS schedule_runs_status ON schedule_runs(status, updated_at);

CREATE TABLE IF NOT EXISTS app_durable_objects (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  binding TEXT NOT NULL,
  class_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, version, binding),
  UNIQUE (app_id, version, class_name)
);

CREATE TABLE IF NOT EXISTS email_deliveries (
  id TEXT PRIMARY KEY,
  app_id TEXT REFERENCES apps(id) ON DELETE SET NULL,
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  spool_key TEXT NOT NULL UNIQUE,
  message_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'rejected', 'retrying', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  delivered_at INTEGER
);
CREATE INDEX IF NOT EXISTS email_deliveries_due ON email_deliveries(status, next_attempt_at);

DROP TRIGGER IF EXISTS enforce_single_email_app;
CREATE TRIGGER enforce_single_email_app
BEFORE UPDATE OF status, manifest_json ON deployments
WHEN NEW.status = 'active'
 AND json_extract(NEW.manifest_json, '$.capabilities.email') = 1
 AND EXISTS (
   SELECT 1
   FROM deployments d JOIN apps a ON a.id = d.app_id
   WHERE d.status = 'active'
     AND d.app_id != NEW.app_id
     AND d.version = a.active_version
     AND a.archived_at IS NULL
     AND json_extract(d.manifest_json, '$.capabilities.email') = 1
 )
BEGIN
  SELECT RAISE(ABORT, 'only one active app may declare email capability');
END;
