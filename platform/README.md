# Myslop Apps

A private, agent-native microcloud where applications are shared like documents.

Each app gets:

- A predictable `<slug>.apps.myslop.app` URL
- Static asset hosting when `public/` exists
- An isolated Cloudflare Worker when `worker.ts` exists
- An isolated D1 database when migrations exist or it is explicitly requested
- An isolated R2 bucket only when file storage is explicitly requested
- Shoo/Google team authentication enforced by the platform dispatcher
- Only its declared server-side secrets
- Immutable deployments and rollback
- A browsable team app library
- A token-authenticated API and agent skill

## Architecture

`apps.myslop.app` is both the control plane and the dynamic dispatch Worker. The root hostname serves the app library and deployment API. Creating an app attaches its exact `<slug>.apps.myslop.app` hostname to the control Worker as a Cloudflare Custom Domain, which provisions DNS and TLS automatically. App requests resolve the app, enforce its access policy, serve immutable assets from the platform R2 bucket, and dispatch backend requests to the app's isolated Worker.

App creation provisions only its control-plane record, access policy, DNS, and TLS. Deployments resolve a capability manifest from source conventions plus optional declarations, then lazily provision and bind only what that version needs. Cloudflare credentials never reach app code or deployment agents.

## Application layout

```text
my-app/
  public/                   # optional static assets
    index.html
  worker.ts                 # optional module Worker
  migrations/              # present → D1, migrations applied in name order
    001_initial.sql
  myslop.json               # optional non-obvious capabilities
```

Most apps need no manifest. Static assets, Workers, and databases with migrations are inferred. Use `myslop.json` only for capabilities source layout cannot reveal:

```json
{
  "$schema": "https://apps.myslop.app/schema/v1.json",
  "capabilities": {
    "files": true,
    "secrets": ["HUBSPOT_TOKEN"],
    "network": ["api.hubapi.com"]
  }
}
```

Worker bindings are capability-dependent:

```ts
interface Env {
  DB?: D1Database;
  FILES?: R2Bucket;
  MYSLOP_APP_ID: string;
  MYSLOP_APP_ORIGIN: string;
}
```

Removing a capability from a later deployment detaches its binding immediately and starts a seven-day recovery period. Re-adding it cancels deletion. An hourly control-plane sweep removes expired D1/R2 resources; the owner can remove them immediately with `prune`.

Verified user identity is injected into requests as `x-myslop-user-id`, `x-myslop-user-email`, and `x-myslop-user-name`. Client-supplied versions of these headers are stripped by the dispatcher.

## Local checks

```sh
bun install
bun test
bun run typecheck
```

Local API development requires a local D1 database and fake session rows. App creation also calls the Cloudflare provisioning API, so it requires development values for `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`.

## Deploying the platform

Workers for Platforms must first be enabled on the Cloudflare account (currently a $25/month product). Without it, Cloudflare rejects dispatch namespace creation with API error `10121`.

Provision the platform resources once:

```sh
bunx wrangler d1 create myslop-apps
bunx wrangler r2 bucket create myslop-app-assets
bunx wrangler dispatch-namespace create myslop-apps-production
```

Put the returned D1 id in `wrangler.jsonc`, then apply the schema for a fresh installation:

```sh
bunx wrangler d1 execute myslop-apps --remote --file schema.sql
```

For an existing installation, apply each new file in `control-migrations/` exactly once before deploying the matching code. Do not reapply `schema.sql` as an upgrade mechanism.

Set the control-plane Cloudflare credentials. Use a dedicated token restricted to D1, R2, and Workers for Platforms resources in the Lleverage account:

```sh
bunx wrangler secret put CLOUDFLARE_ACCOUNT_ID
bunx wrangler secret put CLOUDFLARE_API_TOKEN
# Generate once with: openssl rand -base64 32
bunx wrangler secret put SECRET_ENCRYPTION_KEY
```

App secrets are encrypted with AES-256-GCM in the control database so they can be rebound to immutable versioned Workers. The encryption key exists only as a platform Worker secret; app Workers receive only their own decrypted bindings.

Deploy only through the project script:

```sh
bun run deploy
```

It deploys the outbound egress-policy Worker first, serializes domain changes, and generates a unique temporary Wrangler configuration containing every active app domain. Do not run `wrangler deploy` directly: Wrangler would reconcile away dynamically attached app domains.

`apps.myslop.app` is the control-plane custom domain. Do not create a wildcard CNAME: Cloudflare Universal SSL does not cover second-level wildcard names such as `*.apps.myslop.app`. The control plane attaches each app hostname as an exact Worker Custom Domain, giving it managed DNS and an exact TLS certificate. Verify a newly created app hostname before launch.

## Agent workflow

Install the standalone CLI and obtain a token:

```sh
curl -fsS https://apps.myslop.app/setup.sh | bash
```

The script opens `https://apps.myslop.app/setup` for Shoo authentication, verifies and stores the one-time token at `~/.config/myslop-apps/token`, and installs the CLI into `~/.local/bin`. Then:

```sh
myslop-apps create hello "Hello"
myslop-apps update hello --description "Example app"
myslop-apps deploy hello ./examples/hello
myslop-apps secret hello ANTHROPIC_API_KEY
myslop-apps rollback hello 1
myslop-apps prune hello --confirm hello
myslop-apps destroy hello --confirm hello
```

The raw installable skill is served at `https://apps.myslop.app/skill.md`. It is also included with the Files and Mail skills in the public [Myslop Skills registry](https://github.com/tvdavies/myslop-skills):

```sh
# Claude Code
claude plugin marketplace add tvdavies/myslop-skills
claude plugin install myslop@myslop

# Codex
codex plugin marketplace add tvdavies/myslop-skills
codex plugin add myslop@myslop

# Portable Agent Skills installer
bunx skills add tvdavies/myslop-skills --skill '*' --agent claude-code codex --global --yes
```

### Dashboard management

App cards are direct links to the apps. Use **Manage apps** in the header for the separate operational view: active capability badges, resource status, metadata, deployment and rollback history, audit history, pruning, and deletion. App owners and editors can manage their assigned apps; platform owners can manage every team app, including private apps. Destructive actions stay disabled until an app or platform owner types the exact app slug.

### Permissions

- Owners and editors can update metadata, deploy, rotate secrets, and roll back.
- Team/public visibility grants viewing only.
- App owners and platform owners can prune data resources or destroy an app.
- Agent tokens carry the issuing user's permissions. App-scoped tokens are restricted to one app.
- Destructive CLI commands require an exact repeated slug.

`destroy` removes all immutable Worker versions and static assets, the app D1 database, every object in its R2 bucket and the bucket itself, encrypted secret records, app-scoped tokens, custom DNS/TLS domain, deployments, and operational control records. A minimal immutable audit tombstone is retained for security and accountability.

## Current MVP boundaries

- Worker runtime is JavaScript/TypeScript and Web API compatible. Python/FastAPI functions require a port or a future container runtime.
- App sharing currently supports private, whole-team, or public. The schema supports explicit members; the sharing UI/API is the next slice.
- Accounts are capped at 25 apps and apps at 100 retained deployments in this MVP.
- Outbound `fetch()` is denied by default. Declare exact hostnames in `capabilities.network`; the platform outbound Worker enforces the allowlist.
- Logs and scheduled jobs are not exposed in the control-plane UI yet.
- Database migrations are forward-only; rollback changes code/assets, not database state.
