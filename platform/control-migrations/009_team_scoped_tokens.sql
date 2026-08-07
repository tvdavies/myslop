-- Allow production automation credentials to be restricted to one team.
ALTER TABLE tokens ADD COLUMN team_id TEXT REFERENCES teams(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS tokens_team ON tokens(team_id, revoked_at, expires_at);

CREATE TRIGGER tokens_single_scope_insert
BEFORE INSERT ON tokens
WHEN NEW.app_id IS NOT NULL AND NEW.team_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'token cannot be scoped to both an app and a team');
END;

CREATE TRIGGER tokens_single_scope_update
BEFORE UPDATE OF app_id,team_id ON tokens
WHEN NEW.app_id IS NOT NULL AND NEW.team_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'token cannot be scoped to both an app and a team');
END;
