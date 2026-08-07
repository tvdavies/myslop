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

INSERT OR IGNORE INTO team_members (team_id, user_id, role, status, created_at, updated_at)
SELECT 'team_default', id, CASE WHEN platform_role='owner' THEN 'admin' ELSE 'member' END, 'active', created_at, created_at
FROM users;

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

ALTER TABLE apps ADD COLUMN team_id TEXT REFERENCES teams(id);
ALTER TABLE apps ADD COLUMN folder_id TEXT REFERENCES folders(id);
ALTER TABLE apps ADD COLUMN deployment_hash TEXT;

UPDATE apps SET team_id='team_default' WHERE team_id IS NULL;

CREATE INDEX IF NOT EXISTS apps_team_folder ON apps(team_id, folder_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS apps_deployment_hash ON apps(deployment_hash) WHERE deployment_hash IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS default_app_team_insert
AFTER INSERT ON apps
WHEN NEW.team_id IS NULL
BEGIN
  UPDATE apps SET team_id='team_default' WHERE id=NEW.id;
  INSERT OR IGNORE INTO app_user_assignments (app_id,user_id,role,granted_by,created_at,updated_at)
  VALUES (NEW.id,NEW.owner_id,'owner',NEW.owner_id,NEW.created_at,NEW.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS require_app_team_update
BEFORE UPDATE OF team_id ON apps
WHEN NEW.team_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'app team is required');
END;

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

INSERT OR IGNORE INTO app_user_assignments (app_id, user_id, role, granted_by, created_at, updated_at)
SELECT id, owner_id, 'owner', owner_id, created_at, updated_at FROM apps;

INSERT OR IGNORE INTO app_user_assignments (app_id, user_id, role, granted_by, created_at, updated_at)
SELECT m.app_id, m.user_id, m.role, a.owner_id, m.created_at, m.created_at
FROM app_members m JOIN apps a ON a.id=m.app_id;

ALTER TABLE audit_log ADD COLUMN team_id TEXT REFERENCES teams(id);
UPDATE audit_log
SET team_id=(SELECT team_id FROM apps WHERE apps.id=audit_log.app_id)
WHERE team_id IS NULL AND app_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_team ON audit_log(team_id, created_at DESC);
