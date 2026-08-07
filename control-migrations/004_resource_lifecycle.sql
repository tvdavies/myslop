-- Track unused resources through a recovery grace period before deletion.
ALTER TABLE apps ADD COLUMN d1_delete_after INTEGER;
ALTER TABLE apps ADD COLUMN r2_delete_after INTEGER;
CREATE INDEX IF NOT EXISTS apps_d1_cleanup ON apps(d1_delete_after) WHERE d1_delete_after IS NOT NULL;
CREATE INDEX IF NOT EXISTS apps_r2_cleanup ON apps(r2_delete_after) WHERE r2_delete_after IS NOT NULL;
