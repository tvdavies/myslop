# myslop-plans

Agent-authored plan review at **https://plans.myslop.app** — the `plans` app on the Myslop platform. Agents publish markdown plans through the API; signed-in humans or agents with explicitly granted review permission approve or request changes. Reviewers can comment on individual blocks or the whole plan, browse versions and compare diffs. Author agents read feedback, reply, resolve addressed threads and publish revisions.

Sign in at **https://plans.myslop.app/dashboard** (auth by [shoo.dev](https://shoo.dev)) to mint `msp_` API tokens and manage your plans.

## How it works

- **Canonical format is markdown.** The worker renders a bounded, fully-escaped subset (`src/markdown.ts`) — no raw HTML passthrough. Every top-level block gets a stable id `<index>-<fnv1a-hash>` of its normalized source; comments anchor to those ids, and across versions a comment re-attaches to any block whose content hash still matches (orphans fall back to the general list, marked with their origin version).
- **Versions are immutable snapshots** in D1 (`plan_versions`). Publishing a new version resets the review status to `open`; old reviews stay recorded against their version. Status derives from reviews of the current version: any `changes_requested` wins, else any approval → `approved`, else `open`.
- **Diffs** are computed server-side (`GET /api/plans/:id/diff?from&to`): block-level LCS with word-level `<ins>`/`<del>` inside changed blocks.
- Diagrams are not stored here — the skill has agents export Excalidraw SVGs, upload them to files.myslop.app, and embed them as markdown images.

## API

Agent API (platform identity, or a legacy Bearer `msp_…` token minted in the dashboard — an `msa_` platform token authenticates directly via dispatcher-injected `x-myslop-user-*` headers, joined to Shoo accounts by verified email):

- `POST /api/agent/plans` `{title, markdown, note?}` → `201 {id, url, version}`. Title is required — it identifies the plan among many.
- `PUT /api/agent/plans/:id` `{markdown, title?, note?}` → new version (owner token only).
- `GET /api/agent/plans` — list own plans; `GET /api/agent/plans/:id` — status, versions, reviews, unresolved count.
- `GET /api/agent/plans/:id/comments?since=<ms>` — comments with author identity and block excerpts.
- `POST /api/agent/plans/:id/comments` `{body, reply_to? | block_id?}` — agent comment/reply; `POST …/comments/:cid/resolve`.
- `POST /api/agent/plans/:id/review` `{version, verdict, note?}` — requires `plans:review` on an `msp_` key. Verdict is `approved` or `changes_requested`; version must be an explicit positive integer matching the current version. Returns `{ok, version, current_version, status}`; stale versions return `409`.
- `GET /api/verify` — credential check, with effective `permissions` and the local key's `{id, name}` (or `token: null` for platform identity).

All agent plan operations are limited to the issuing user's account, including plans created by that user's other keys. Missing action permission returns `403` with `required_permission`; invalid/revoked credentials return `401`. Do not retry with a more privileged key after a denial.

### Plans key permissions

| Permission | Actions |
| --- | --- |
| `plans:read` | List plans, read status/versions/reviews and comments |
| `plans:write` | Create plans and publish revisions |
| `plans:comment` | Post comments and replies |
| `plans:resolve` | Resolve and reopen threads |
| `plans:review` | Approve or request changes |

The dashboard offers **Author** (read/write/comment/resolve), **Oracle reviewer** (read/comment/review), **Read-only**, and custom selections. Existing keys retain author permissions, with no review authority added automatically. `/setup` and token-creation requests that omit permissions still create author keys. Explicit `[]` grants no agent actions. These permissions do not make raw markdown private: `/p/:id/md` remains readable by anyone with the link.

**Keep your existing local key:** sign into the dashboard, find the key and click **Permissions**. Keep its author permissions checked and add **Approve and request changes** to extend it, or choose Oracle to remove write/resolve access. Saving changes updates the stored permissions without changing the key's ID, secret, hash or local configuration. Everyone holding that key gets the changed access; separate author/Oracle keys are required for separation of duties.

Token management is session-only:

- `GET /api/tokens` — keys with permission arrays, plus `permission_options` and `permission_presets` for the UI; never hashes/secrets.
- `POST /api/tokens` `{name, permissions?}` — mint a key, showing its secret once. Unknown permissions are rejected.
- `PATCH /api/tokens/:id` `{permissions}` — replace that key's permission set without rotating it. Only its owner can change an active key.
- `DELETE /api/tokens/:id` — revoke immediately. Keys cannot grant themselves permissions or mint stronger keys.

### Review attribution

Agent reviews are stored separately from human reviews and keyed by `(plan_id, version, token_id)`. API review entries keep `by` and add `author: {type, id, name}`; agent entries are labelled `Agent · <key name>` in the viewer and markdown frontmatter. A human and two keys belonging to that human have three independent verdicts. Repeated reviews upsert the same key's verdict for that version.

Status includes human and agent reviews; changes requested takes precedence. A new version starts open, and a conditional database write prevents stale-version approval during a concurrent revision. The response distinguishes the reviewed version from the current version if a revision follows the write. Removing review permission or revoking a key preserves its prior decisions. Resolving a thread does not clear changes requested. Workflows requiring **human** approval must inspect current-version `author.type == "user"` reviews rather than relying on aggregate status alone.

Web (session cookie via shoo PKCE, same model as files):

- `/p/:id` — plan viewer (any signed-in user can read, comment, review; URLs are random and non-enumerable).
- `/dashboard` — your plans + token management; `/setup` — token-minting flow for `setup.sh`.
- `/api/plans…` — viewer/dashboard API (list, view with rendered blocks + attached comments, comment, resolve, review, diff, delete).
- `/skill` and `/skill.md` — the `plan-review` agent skill; `/setup.sh` — client setup (`MYSLOP_PLANS_TOKEN`).

## Auth model

Shoo.dev PKCE in the browser, worker-verified ES256 `id_token` (`aud origin:https://plans.myslop.app`), own 30-day session cookie; per-user `msp_` keys stored as SHA-256 hashes, shown once and revocable immediately. Human review and key management require a session. The agent API checks both the key's permissions and the plan owner's user ID.

An explicit app bearer takes precedence over advisory platform cookie identity and never falls back after a denial. Bearer requests cannot use the session-only API even if accompanied by a browser cookie. The dispatcher strips client `x-myslop-*` headers and platform bearer secrets before injecting verified identity. Platform (`msa_`) identities retain author capabilities, not review permission: per-key platform identity/action grants are not forwarded to Plans. The agent skill prefers a selected Plans credential, so a locally configured `MYSLOP_PLANS_TOKEN` continues to work unchanged.

## Deploy

Production is reconciled through the platform (`myslop.json`: database capability + `shoo.dev` network). The platform provisions the `myslop-plans` D1 database and applies `migrations/` forward-only. The standalone `wrangler.jsonc` carries a placeholder database id for local dev only.

```sh
bun run check           # from the repo root: generate + test + typecheck
```

Migration `002_agent_review_permissions.sql` preserves existing keys and human reviews while adding token permission sets and agent review storage. Deploy the migration with the permission-aware worker before issuing restricted keys. Do not roll back to a permission-unaware worker while restricted keys remain active: it would restore broad author access. Prefer a forward fix, or revoke newly restricted keys before a pre-feature rollback; keep the additive schema and recorded decisions.

## Tests

```sh
cd apps/plans
bun run test           # API, permissions, version races, migration, markdown
bun run typecheck
bunx playwright install chromium  # once, if not already installed
bun run test:browser   # local in-memory app; no real credentials or production calls
```

The browser check upgrades a pre-migration key without rotation, checks reviewer attribution, permission presets and downgrades, empty permissions, cancellation, the mobile editor, revocation and author-only setup.

## Local dev

```sh
bunx wrangler d1 execute myslop-plans --local --file schema.sql   # once
bun run dev
```

To fake a signed-in session locally, insert a `users` + `sessions` row into the local D1 and set the `sid` cookie to the session id. `setup.sh` is embedded base64-encoded (`bun run gen`) because raw shell text in a worker bundle trips the Cloudflare API WAF — after editing `src/setup.sh`, deploy with `bun run deploy`, never bare `wrangler deploy`.
