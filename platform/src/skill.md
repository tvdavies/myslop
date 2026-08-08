---
name: myslop-apps
description: Create, deploy, inspect, secure, and roll back full-stack apps on the Myslop internal microcloud. Use when building a dashboard, internal tool, live document, or team app without a Git repository or infrastructure setup.
---

# Myslop Apps

Myslop Apps hosts static assets and Cloudflare-compatible Workers with Lleverage authentication, immutable versions, rollback, and optional isolated database and file storage.

## Authentication and CLI setup

Resolve the API token in this order:

1. `$MYSLOP_APPS_TOKEN` if set.
2. `${XDG_CONFIG_HOME:-$HOME/.config}/myslop-apps/token`.

If neither exists, the token is rejected with `401`, or the `myslop-apps` CLI is missing, ask the user to run this in an interactive terminal:

```sh
curl -fsS https://myslop.cloud/setup.sh | bash
```

It opens https://myslop.cloud/setup, signs the user in, creates a machine-named token, verifies and stores it, and installs the standalone `myslop-apps` CLI in `~/.local/bin`. Never print, commit, or put the token in app source.

## Convention-first app layout

The CLI infers common capabilities from the directory:

```text
my-app/
  public/                  # present → static assets
    index.html
  worker.ts                # present → Worker
  migrations/             # SQL present → isolated D1 database
    001_initial.sql
  myslop.json              # optional non-obvious capabilities only
```

A static page needs only `public/index.html`. It receives no Worker, database, file bucket, or secrets.

A database-backed app needs `worker.ts` and migrations. The database is inferred; no manifest is required.

## Optional `myslop.json`

Git-managed apps may declare organization, access, and capabilities that source layout cannot reveal:

```json
{
  "$schema": "https://myslop.cloud/schema/v1.json",
  "version": 1,
  "app": {
    "name": "Commercial Dashboard",
    "folder": "business-apps"
  },
  "access": {
    "audience": "restricted",
    "users": [
      { "email": "owner@lleverage.ai", "role": "owner" }
    ],
    "groups": [
      { "slug": "sales", "role": "editor" }
    ]
  },
  "capabilities": {
    "files": true,
    "secrets": ["HUBSPOT_TOKEN", "ANTHROPIC_API_KEY"],
    "network": ["api.hubapi.com", "api.anthropic.com"]
  }
}
```

`app.folder` and group slugs must already exist in the app's team. Audiences are `public`, `team`, or `restricted`. User roles are viewer/editor/owner; group roles are viewer/editor. Group membership is centrally managed and never duplicated in the manifest. Omitting folder/access preserves existing policy during reconciliation.

Supported capability fields:

- `database: true` — request D1 when there are no migrations yet; migrations infer this automatically.
- `files: true` — provision and bind an isolated R2 bucket as `env.FILES`.
- `secrets: string[]` — bind only these configured secrets. Deployment stops and reports missing names.
- `network: string[]` — allow exact outbound `fetch()` hostnames. Egress is denied by default and enforced by the platform outbound Worker.

Database and file resources are provisioned lazily on the first deployment that needs them. Removing a capability immediately detaches its binding and starts a seven-day recovery grace period. Re-adding the capability cancels deletion. The owner can delete unused resources immediately with `prune`, or delete the complete app with `destroy`.

## CLI

```sh
myslop-apps apps
myslop-apps create my-dashboard "My Dashboard" --visibility team
myslop-apps update my-dashboard --description "Live pipeline dashboard"
myslop-apps deploy my-dashboard ./my-app
myslop-apps secret my-dashboard HUBSPOT_TOKEN
myslop-apps rollback my-dashboard 2
myslop-apps prune my-dashboard --confirm my-dashboard
myslop-apps destroy my-dashboard --confirm my-dashboard
```

Deployment prints the resolved capabilities before provisioning. `secret` prompts without echo and sends the value directly to the platform; Myslop stores only AES-256-GCM encrypted ciphertext.

## Worker example

```ts
interface Env {
  DB: D1Database;  // only when database was requested/inferred
  FILES: R2Bucket; // only when files:true was declared
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/me") {
      return Response.json({
        id: request.headers.get("x-myslop-user-id"),
        email: request.headers.get("x-myslop-user-email"),
      });
    }
    return new Response("not found", { status: 404 });
  },
};
```

Use Web APIs and Worker-compatible packages. Do not use Node servers such as Express or FastAPI. Bundle dependencies into the Worker through the CLI.

## Ownership and lifecycle

- Viewers can open an app and inspect read-only settings; deployment manifests and activity history require editor access.
- Editors can update manual app metadata/runtime configuration, deploy, rotate secrets, and roll back.
- Owners can additionally move a manual app, change access assignments, prune resources, archive, and delete it.
- The highest role granted by primary ownership, individual assignment, reusable group assignment, audience baseline, or platform-owner override wins.
- Git-managed metadata, access, folder, runtime, and destruction policy must be changed in `myslop.json`; configured secrets remain operational state.
- Global agent tokens inherit the issuing user's effective role. App-scoped tokens remain restricted to their assigned app and cannot call team management endpoints.
- `prune` and `destroy` require the slug to be repeated with `--confirm`.
- Destroy removes every runtime version, static artifact, database, storage object and container, secrets, tokens, domain, deployments, and operational control records. A minimal immutable audit tombstone is retained.

## Security

Apps default to Team audience. Do not implement a second password gate. For Team and Restricted apps, treat `x-myslop-user-id`, `x-myslop-user-email`, `x-myslop-user-name`, and `x-myslop-app-role` as authoritative because the dispatcher strips client-supplied copies. Public apps receive no synthesized identity and retain their own cookies and bearer-token authentication. Still enforce row ownership in app code when records should be private to individual users.
