CREATE TABLE identity_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  email_verified INTEGER NOT NULL CHECK (email_verified=1),
  name TEXT,
  picture TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  session_generation INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL
);
CREATE INDEX identity_users_email ON identity_users(email COLLATE NOCASE);

CREATE TABLE identity_provider_accounts (
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  identity_id TEXT NOT NULL REFERENCES identity_users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL,
  PRIMARY KEY (issuer,subject),
  UNIQUE (identity_id,issuer)
);

ALTER TABLE users ADD COLUMN identity_id TEXT REFERENCES identity_users(id);
CREATE UNIQUE INDEX users_identity_id ON users(identity_id) WHERE identity_id IS NOT NULL;

ALTER TABLE sessions ADD COLUMN identity_generation INTEGER;
ALTER TABLE app_session_exchanges ADD COLUMN app_id TEXT REFERENCES apps(id);
DELETE FROM app_session_exchanges;

CREATE TABLE oauth_transactions (
  state_hash TEXT PRIMARY KEY,
  secret_ciphertext TEXT NOT NULL,
  secret_iv TEXT NOT NULL,
  return_to TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX oauth_transactions_expiry ON oauth_transactions(expires_at);

CREATE TABLE auth_completion_codes (
  code_hash TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES identity_users(id) ON DELETE CASCADE,
  candidate_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  return_to TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX auth_completion_codes_expiry ON auth_completion_codes(expires_at);

CREATE TABLE app_sessions (
  handle_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  hostname TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (session_id,app_id,hostname)
);
CREATE INDEX app_sessions_expiry ON app_sessions(expires_at);

CREATE TABLE identity_link_requests (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES identity_users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('platform','files','mail')),
  candidate_user_id TEXT,
  email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  proof TEXT,
  reviewed_by TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (identity_id,scope)
);
CREATE INDEX identity_link_requests_status ON identity_link_requests(status,created_at);

CREATE TABLE identity_audit_log (
  id TEXT PRIMARY KEY,
  identity_id TEXT REFERENCES identity_users(id) ON DELETE SET NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  client TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX identity_audit_created ON identity_audit_log(created_at DESC);

CREATE TABLE auth_rate_limits (
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (key,window_start)
);
CREATE INDEX auth_rate_limits_expiry ON auth_rate_limits(expires_at);

DROP TRIGGER IF EXISTS default_user_team_membership;
CREATE TRIGGER default_user_team_membership
AFTER INSERT ON users
WHEN NEW.email IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO team_members (team_id,user_id,role,status,created_at,updated_at)
  SELECT id,NEW.id,CASE WHEN NEW.platform_role='owner' THEN 'admin' ELSE 'member' END,
         'active',NEW.created_at,NEW.created_at
  FROM teams
  WHERE id='team_default'
    AND allowed_email_domain IS NOT NULL
    AND lower(substr(NEW.email,instr(NEW.email,'@')+1))=lower(allowed_email_domain);
END;
