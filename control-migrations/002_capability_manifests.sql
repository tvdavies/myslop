-- Upgrade deployments created before convention-first capability manifests.
ALTER TABLE deployments ADD COLUMN manifest_json TEXT NOT NULL DEFAULT '{}';

UPDATE deployments
SET manifest_json = (
  SELECT json_object(
    'version', 1,
    'assets', CASE WHEN deployments.asset_prefix != '' THEN json('true') ELSE json('false') END,
    'worker', CASE WHEN deployments.worker_key IS NOT NULL THEN json('true') ELSE json('false') END,
    'capabilities', json_object(
      'database', CASE WHEN apps.d1_id IS NOT NULL THEN json('true') ELSE json('false') END,
      'files', CASE WHEN apps.r2_bucket IS NOT NULL THEN json('true') ELSE json('false') END,
      'secrets', json_array(),
      'network', json_array()
    )
  )
  FROM apps WHERE apps.id = deployments.app_id
);

CREATE UNIQUE INDEX IF NOT EXISTS one_pending_deployment_per_app
ON deployments(app_id) WHERE status='pending';
