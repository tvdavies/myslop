ALTER TABLE deployments ADD COLUMN internal_secret_version INTEGER NOT NULL DEFAULT 1;

CREATE UNIQUE INDEX IF NOT EXISTS users_verified_email
ON users(email COLLATE NOCASE)
WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS app_session_exchanges (
  code_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  hostname TEXT NOT NULL,
  return_to TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS app_session_exchanges_expiry
ON app_session_exchanges(expires_at);

CREATE TABLE IF NOT EXISTS reserved_app_slugs (
  slug TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO reserved_app_slugs (slug,reason,created_at) VALUES
  ('apps','legacy platform hostname',0),
  ('events','existing Myslop service',0),
  ('hello','existing Myslop service',0),
  ('os','existing Myslop service',0),
  ('state','existing Myslop service',0),
  ('storage','existing Myslop service',0),
  ('todo','existing Myslop service',0),
  ('www','platform redirect',0);

CREATE TRIGGER IF NOT EXISTS reject_reserved_app_slug
BEFORE INSERT ON apps
WHEN EXISTS (SELECT 1 FROM reserved_app_slugs WHERE slug=NEW.slug)
BEGIN
  SELECT RAISE(ABORT, 'app slug is reserved');
END;

CREATE TRIGGER IF NOT EXISTS reject_app_slug_alias_collision
BEFORE INSERT ON apps
WHEN EXISTS (
  SELECT 1 FROM app_domains WHERE hostname = NEW.slug || '.myslop.app'
)
BEGIN
  SELECT RAISE(ABORT, 'app hostname is already claimed as an alias');
END;

CREATE TRIGGER IF NOT EXISTS reject_alias_default_hostname_collision
BEFORE INSERT ON app_domains
WHEN EXISTS (
  SELECT 1 FROM apps WHERE NEW.hostname = slug || '.myslop.app' AND id<>NEW.app_id
)
BEGIN
  SELECT RAISE(ABORT, 'hostname is already allocated to an app');
END;
