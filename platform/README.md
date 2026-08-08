# Myslop Apps

A private, agent-native microcloud where applications are shared like documents.

Each app gets:

- An automatically allocated `<slug>.myslop.app` URL
- Static asset hosting when `public/` exists
- An isolated Cloudflare Worker when `worker.ts` exists
- An isolated D1 database when migrations exist or it is explicitly requested
- An isolated R2 bucket only when file storage is explicitly requested
- first-party Google authentication enforced by the platform dispatcher
- Only its declared server-side secrets
- Immutable deployments and rollback
- A browsable team app library
- A token-authenticated API and agent skill

## Architecture

`myslop.cloud` is the canonical control plane. `myslop.app` redirects to it, while a proxied wildcard route sends every first-level `<slug>.myslop.app` hostname to the dispatcher. Cloudflare Universal SSL covers this first-level wildcard, so app creation allocates a globally unique slug without provisioning per-app DNS or certificates. App requests resolve the slug, enforce its access policy, serve immutable assets from platform R2, and dispatch backend requests to the app's isolated Worker.

Private and team apps use a short-lived, one-time session exchange from `myslop.cloud` to a host-only cookie on the app hostname. Platform session identifiers are never exposed to user Workers. Deployments resolve a capability manifest from source conventions plus optional declarations, then lazily provision and bind only what that version needs. Cloudflare credentials never reach app code or deployment agents.

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

Most apps need no manifest. Static assets, runtimes, and databases with migrations are inferred. Use `myslop.json` for organizational policy and capabilities that source layout cannot reveal:

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
    "secrets": ["HUBSPOT_TOKEN"],
    "network": ["api.hubapi.com"]
  }
}
```

Folder and group slugs refer to centrally managed objects in the app's team. `access.audience` is the source of truth for sharing; the legacy `app.visibility` field is optional and must agree with the declared audience when both are present. Git-managed app metadata, folder placement, audience, and assignments are read-only in the dashboard; group membership remains centrally editable. Omitting `app.folder` or `access` preserves an existing app's policy during reconciliation.

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

Verified user identity and effective app role are injected into non-public app requests as `x-myslop-user-id`, `x-myslop-user-email`, `x-myslop-user-name`, and `x-myslop-app-role`. Client-supplied versions of all `x-myslop-*` headers are stripped by the dispatcher. Public apps keep their own cookies and bearer-token authentication and receive no synthesized platform identity.

## Local checks

```sh
bun install
bun test
bun run typecheck
```

Local API development requires a local D1 database and fake session rows. App creation is control-plane-only because wildcard routing allocates the default hostname from the unique app slug.

## Deploying the platform

Workers for Platforms must first be enabled on the Cloudflare account (currently a $25/month product). Without it, Cloudflare rejects dispatch namespace creation with API error `10121`.

Provision the platform resources once:

```sh
bunx wrangler d1 create myslop-apps
bunx wrangler r2 bucket create myslop-app-assets
bunx wrangler r2 bucket create myslop-mail-spool
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
# Generate independently with: openssl rand -base64 32
bunx wrangler secret put INTERNAL_DISPATCH_SECRET
```

App secrets are encrypted with AES-256-GCM in the control database so they can be rebound to immutable versioned Workers. The encryption key exists only as a platform Worker secret; app Workers receive only their own decrypted bindings.

Deploy only through the project script:

```sh
bun run deploy
```

It deploys the outbound egress-policy Worker first and generates a unique temporary Wrangler configuration that preserves legacy and explicitly attached domains during the migration window. Do not run `wrangler deploy` directly while those compatibility domains remain.

`myslop.cloud` is the control-plane Custom Domain. The `*.myslop.app/*` Worker route sits behind one proxied wildcard DNS record; Universal SSL covers these first-level app hosts. `myslop.app` and the legacy `apps.myslop.app` hostname redirect to the canonical platform. App slugs are first-come and globally unique. Platform labels and existing exact service hosts (`apps`, `events`, `hello`, `os`, `state`, `storage`, `todo`, and `www`) are reserved. The wildcard Worker passes those service requests through to their exact Custom Domain Workers.

## Agent workflow

Install the standalone CLI and obtain a token:

```sh
curl -fsS https://myslop.cloud/setup.sh | bash
```

The script opens `https://myslop.cloud/setup` for first-party Google authentication, verifies and stores the one-time token at `~/.config/myslop-apps/token`, and installs the CLI into `~/.local/bin`. Then:

```sh
myslop-apps create hello "Hello"
myslop-apps update hello --description "Example app"
myslop-apps deploy hello ./examples/hello
myslop-apps secret hello ANTHROPIC_API_KEY
myslop-apps rollback hello 1
myslop-apps prune hello --confirm hello
myslop-apps destroy hello --confirm hello
```

The raw installable skill is served at `https://myslop.cloud/skill.md`. It is also included with the Files and Mail skills in the public [Myslop Skills registry](https://github.com/tvdavies/myslop-skills):

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

The dashboard is a compact team directory with nested organizational folders, search, audience/role filters, and separate **Open** and **Settings** actions. Settings is a full page with overview, access, connected resources, deployments, secrets, activity, and destructive operations. Team admins maintain the folder tree, people, reusable groups, and group membership centrally.

The resources view uses product concepts—App / runtime, Database, Storage, Schedules, Domain, Email, and Secrets—rather than exposing provider resource names as the primary interface.

### Permissions

Apps have a Public, Team, or Restricted audience and one effective role per person. The highest applicable role from primary ownership, direct assignment, group assignment, audience baseline, or platform-owner override wins.

- Viewers can open an app and inspect its read-only settings, connected resources, and access explanation; deployment manifests and activity history stay with editors and owners.
- Editors can update manual app metadata and runtime configuration, deploy, rotate secrets, and roll back.
- Owners can additionally move a manual app, change its audience and assignments, prune resources, archive, and delete it.
- Group assignments grant viewer or editor; owner assignments are individual only.
- Folders organize apps but do not inherit or grant access.
- Git-managed metadata, access, folder, deployment, and destruction policy must be changed in `myslop.json`; permitted editors/owners may still configure secrets.
- Agent tokens carry the issuing user's effective permissions. App-scoped tokens are restricted to one app and cannot reach team management endpoints.
- Destructive actions and CLI commands require the exact app slug.

`destroy` removes all immutable Worker versions and static assets, the app D1 database, every object in its R2 bucket and the bucket itself, encrypted secret records, app-scoped tokens, optional attached domain records, deployments, and operational control records. A minimal immutable audit tombstone is retained for security and accountability.

## Identity assertion key rotation

Identity assertions use a versioned, per-app key derived from the platform identity master. Rotate without an authentication gap:

1. Set `IDENTITY_DISPATCH_SECRET_NEXT` to the new master and reconcile identity-capable apps. They receive current and next verification keys while the platform still signs with the current version.
2. Promote the new value to `INTERNAL_DISPATCH_SECRET`, move the old value to `IDENTITY_DISPATCH_SECRET_PREVIOUS`, increment `IDENTITY_ASSERTION_KEY_VERSION`, and deploy the platform.
3. Reconcile the apps again, wait longer than the 30-second assertion lifetime, then remove the previous secret.

Never promote the next key until every identity-capable app has been rebound. Rollback app versions are rebound with the active overlap keys by the platform.

## Current MVP boundaries

- Worker runtime is JavaScript/TypeScript and Web API compatible. Python/FastAPI functions require a port or a future container runtime.
- App sharing supports Public, Team, or Restricted audiences plus direct user and reusable group assignments. Folder placement is organizational only and has no inherited permissions.
- Accounts are capped at 25 apps and apps at 100 retained deployments in this MVP.
- Outbound `fetch()` is denied by default. Declare exact hostnames in `capabilities.network`; the platform outbound Worker enforces the allowlist.
- Logs and scheduled jobs are not exposed in the control-plane UI yet.
- Database migrations are forward-only; rollback changes code/assets, not database state.
