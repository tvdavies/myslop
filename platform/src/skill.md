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

The CLI infers common capabilities from the directory. A complete client-server app with a database is four files:

```text
my-app/
  index.html               # app shell; scripts and styles it references are bundled at deploy
  worker.ts                # present → Worker (serves /api; assets are served by the platform)
  schema.sql               # present → isolated D1 database with a declarative schema
  myslop.json              # optional non-obvious capabilities only; myslop.yaml also works
```

A static page needs only `index.html` (or a `public/` directory). It receives no Worker, database, file bucket, or secrets.

A root `index.html` is bundled at deploy time: `<script src="./app.tsx">` and `<link rel="stylesheet" href="./app.css">` references are compiled (TypeScript and JSX included) and uploaded with the rewritten HTML. `worker.ts`, `schema.sql`, and other unreferenced files are never uploaded as assets. When a `public/` directory exists it is served raw instead and no bundling happens; use it for favicons, images, and pre-built files.

### Declarative schema

`schema.sql` holds only `CREATE TABLE` and `CREATE INDEX` statements describing the desired schema. On every deployment the platform diffs it against the last applied schema and applies additive changes automatically: new tables, new columns (nullable or with a `DEFAULT`), and new, changed, or removed indexes. Edit `schema.sql` directly and redeploy; do not write migrations for additive changes.

Destructive changes (dropped or redefined columns or tables, changed constraints, adding `UNIQUE`/`PRIMARY KEY`/undefaulted `NOT NULL` columns) fail the deployment with the exact reason. To perform one, add a forward-only migration in `migrations/` that does the change and deploy it together with the updated `schema.sql`; the platform applies the migration and adopts the new schema as the baseline. Legacy apps can keep using `migrations/` exclusively.

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

- `database: true` — request D1 before schema.sql or migrations exist; either file infers this automatically.
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
myslop-apps db my-dashboard "SELECT * FROM todos ORDER BY created_at DESC LIMIT 20"
myslop-apps secret my-dashboard HUBSPOT_TOKEN
myslop-apps rollback my-dashboard 2
myslop-apps prune my-dashboard --confirm my-dashboard
myslop-apps destroy my-dashboard --confirm my-dashboard
```

Deployment prints the resolved capabilities before provisioning. `secret` prompts without echo and sends the value directly to the platform; Myslop stores only AES-256-GCM encrypted ciphertext.

`db` runs SQL against the app's database as an editor and prints JSON rows. Inspect real data before guessing: check what a table actually contains, verify a write landed, or debug a bad row without deploying instrumentation.

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

Apps default to Team audience. Do not implement a second password gate. Treat `x-myslop-user-id`, `x-myslop-user-email`, `x-myslop-user-name`, and `x-myslop-app-role` as authoritative wherever they appear because the dispatcher strips client-supplied copies. Still enforce row ownership in app code when records should be private to individual users.

## Calling apps as an agent

The platform agent token authenticates directly against any app hostname. Send `Authorization: Bearer $MYSLOP_APPS_TOKEN` to `https://<slug>.myslop.app/...`: the dispatcher verifies the token, resolves the caller's role on that app, and injects the identity headers above. The bearer itself never reaches app code, so apps need no token handling of their own. App-scoped and team-scoped tokens are rejected outside their scope.

Public apps serve anonymous requests without identity headers, and requests carrying a platform token or platform session receive them. Cookie-derived identity is dropped (not rejected) on cross-origin mutations, so webhooks and anonymous POSTs keep working. An app can distinguish signed-in visitors by checking for `x-myslop-user-id` and treat everyone else as anonymous.
