PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT,
  name TEXT,
  picture TEXT,
  platform_role TEXT NOT NULL DEFAULT 'member' CHECK (platform_role IN ('member', 'owner')),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  allowed_email_domain TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO teams (id, slug, name, allowed_email_domain, created_at, updated_at)
VALUES ('team_default', 'lleverage', 'Lleverage', 'lleverage.ai', 0, 0);

CREATE TABLE IF NOT EXISTS team_members (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS team_members_user ON team_members(user_id, status, team_id);
DROP TRIGGER IF EXISTS default_user_team_membership;
CREATE TRIGGER default_user_team_membership
AFTER INSERT ON users
BEGIN
  INSERT OR IGNORE INTO team_members (team_id,user_id,role,status,created_at,updated_at)
  VALUES ('team_default',NEW.id,CASE WHEN NEW.platform_role='owner' THEN 'admin' ELSE 'member' END,'active',NEW.created_at,NEW.created_at);
END;

DROP TRIGGER IF EXISTS retain_active_team_admin;
CREATE TRIGGER retain_active_team_admin
BEFORE UPDATE OF role, status ON team_members
WHEN OLD.role='admin' AND OLD.status='active'
  AND (NEW.role!='admin' OR NEW.status!='active')
  AND NOT EXISTS (
    SELECT 1 FROM team_members
    WHERE team_id=OLD.team_id AND user_id<>OLD.user_id AND role='admin' AND status='active'
  )
BEGIN
  SELECT RAISE(ABORT, 'team must retain an active admin');
END;

CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES folders(id),
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (team_id, slug)
);
CREATE INDEX IF NOT EXISTS folders_parent ON folders(team_id, parent_id, name);

CREATE TABLE IF NOT EXISTS team_groups (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (team_id, slug)
);
CREATE INDEX IF NOT EXISTS team_groups_name ON team_groups(team_id, name);

CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL REFERENCES team_groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS group_members_user ON group_members(user_id, group_id);

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
  archived_at INTEGER,
  managed_by TEXT NOT NULL DEFAULT 'manual' CHECK (managed_by IN ('manual', 'git')),
  source_hash TEXT,
  d1_adopted INTEGER NOT NULL DEFAULT 0,
  r2_adopted INTEGER NOT NULL DEFAULT 0,
  team_id TEXT NOT NULL REFERENCES teams(id),
  folder_id TEXT REFERENCES folders(id),
  deployment_hash TEXT
);
CREATE INDEX IF NOT EXISTS apps_owner ON apps(owner_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS apps_updated ON apps(updated_at DESC);
CREATE INDEX IF NOT EXISTS apps_source_hash ON apps(source_hash) WHERE source_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS apps_team_folder ON apps(team_id, folder_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS apps_deployment_hash ON apps(deployment_hash) WHERE deployment_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS apps_d1_resource ON apps(d1_id) WHERE d1_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS apps_r2_resource ON apps(r2_bucket) WHERE r2_bucket IS NOT NULL;
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

CREATE TABLE IF NOT EXISTS app_user_assignments (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'editor', 'owner')),
  granted_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, user_id)
);
CREATE INDEX IF NOT EXISTS app_user_assignments_user ON app_user_assignments(user_id, app_id);

CREATE TABLE IF NOT EXISTS app_group_assignments (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES team_groups(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
  granted_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, group_id)
);
CREATE INDEX IF NOT EXISTS app_group_assignments_group ON app_group_assignments(group_id, app_id);

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
  created_at INTEGER NOT NULL,
  team_id TEXT REFERENCES teams(id)
);
CREATE INDEX IF NOT EXISTS audit_app ON audit_log(app_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_team ON audit_log(team_id, created_at DESC);

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

CREATE TRIGGER IF NOT EXISTS enforce_single_email_app
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
