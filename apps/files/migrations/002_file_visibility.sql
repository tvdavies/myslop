-- Files gain a third, signed-in-only visibility, which becomes the default for
-- new uploads. Existing files keep what they had: private stays private and
-- everything else stays public.
ALTER TABLE files ADD COLUMN visibility TEXT CHECK (visibility IN ('private', 'protected', 'public'));
UPDATE files SET visibility = CASE WHEN private = 1 THEN 'private' ELSE 'public' END;

-- Builds from before this migration write only `private`: the old worker in
-- the deploy window, or any build after a rollback. New code always writes
-- both columns together, so these fire for legacy writes only and give them
-- their old meaning instead of the new default.
CREATE TRIGGER IF NOT EXISTS files_legacy_insert AFTER INSERT ON files
WHEN NEW.visibility IS NULL
BEGIN
  UPDATE files SET visibility = CASE WHEN NEW.private = 1 THEN 'private' ELSE 'public' END
  WHERE key = NEW.key;
END;

CREATE TRIGGER IF NOT EXISTS files_legacy_private AFTER UPDATE OF private ON files
WHEN NEW.private IS NOT OLD.private AND NEW.visibility IS OLD.visibility
BEGIN
  UPDATE files SET visibility = CASE WHEN NEW.private = 1 THEN 'private' ELSE 'public' END
  WHERE key = NEW.key;
END;
