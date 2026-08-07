PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT,
  name TEXT,
  picture TEXT,
  platform_role TEXT NOT NULL DEFAULT 'member' CHECK (platform_role IN ('member', 'owner')),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  app_id TEXT,
  hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS tokens_user ON tokens(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS apps (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  owner_id TEXT NOT NULL REFERENCES users(id),
  visibility TEXT NOT NULL DEFAULT 'team' CHECK (visibility IN ('private', 'team', 'public')),
  worker_name TEXT NOT NULL UNIQUE,
  d1_id TEXT,
  d1_name TEXT,
  r2_bucket TEXT,
  custom_domain_id TEXT,
  d1_delete_after INTEGER,
  r2_delete_after INTEGER,
  active_version INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE INDEX IF NOT EXISTS apps_owner ON apps(owner_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS apps_updated ON apps(updated_at DESC);
CREATE TRIGGER IF NOT EXISTS enforce_app_quota
BEFORE INSERT ON apps
WHEN (SELECT COUNT(*) FROM apps WHERE owner_id=NEW.owner_id AND archived_at IS NULL) >= 25
BEGIN
  SELECT RAISE(ABORT, 'app quota reached');
END;

CREATE TABLE IF NOT EXISTS app_members (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, user_id)
);

CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  asset_prefix TEXT NOT NULL,
  worker_key TEXT,
  worker_name TEXT,
  worker_sha256 TEXT,
  manifest_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'failed')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  UNIQUE(app_id, version)
);
CREATE INDEX IF NOT EXISTS deployments_app ON deployments(app_id, version DESC);
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_deployment_per_app ON deployments(app_id) WHERE status='pending';
CREATE TRIGGER IF NOT EXISTS enforce_deployment_quota
BEFORE INSERT ON deployments
WHEN (SELECT COUNT(*) FROM deployments WHERE app_id=NEW.app_id AND status != 'failed') >= 100
BEGIN
  SELECT RAISE(ABORT, 'deployment quota reached');
END;

CREATE TABLE IF NOT EXISTS app_secrets (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, name)
);

CREATE TABLE IF NOT EXISTS app_migrations (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  hash TEXT NOT NULL,
  version INTEGER NOT NULL,
  applied_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, name)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  app_id TEXT,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_app ON audit_log(app_id, created_at DESC);

CREATE TABLE IF NOT EXISTS platform_locks (
  name TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS orphan_resources (
  type TEXT NOT NULL CHECK (type IN ('d1', 'r2', 'worker', 'domain')),
  identifier TEXT NOT NULL,
  app_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (type, identifier)
);
