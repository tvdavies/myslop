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
curl -fsS https://apps.myslop.app/setup.sh | bash
```

It opens https://apps.myslop.app/setup, signs the user in, creates a machine-named token, verifies and stores it, and installs the standalone `myslop-apps` CLI in `~/.local/bin`. Never print, commit, or put the token in app source.

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

Declare only capabilities that source layout cannot reveal:

```json
{
  "$schema": "https://apps.myslop.app/schema/v1.json",
  "capabilities": {
    "files": true,
    "secrets": ["HUBSPOT_TOKEN", "ANTHROPIC_API_KEY"],
    "network": ["api.hubapi.com", "api.anthropic.com"]
  }
}
```

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

- Owners and editors can update metadata, deploy, rotate secrets, and roll back.
- Team visibility grants view access only; it does not grant edit rights.
- App owners and platform owners can prune stored resources or destroy an app.
- Global agent tokens inherit the issuing user's role, including platform-owner access. App-scoped tokens remain restricted to their assigned app.
- `prune` and `destroy` require the slug to be repeated with `--confirm`.
- Destroy removes every Worker version, static artifact, D1 database, all R2 objects and the bucket, secrets, tokens, DNS/TLS domain, deployments, and operational control records. A minimal immutable audit tombstone is retained.

## Security

Apps default to team-only. Do not implement a second password gate. Treat injected identity headers as authoritative because the dispatcher strips client-supplied copies. Still enforce row ownership in app code when records should be private to individual users.
