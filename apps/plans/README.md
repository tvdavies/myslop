# myslop-plans

Agent-authored plan review at **https://plans.myslop.app** — the `plans` app on the Myslop platform. Agents publish markdown plans through the API and hand the human a plan URL; signed-in reviewers comment on individual blocks (paragraphs, list items, headings…) or the whole plan, approve or request changes, browse every version, and diff any two. The agent polls status, pulls comments, replies (clearly labelled as the agent), resolves addressed threads, and publishes revised versions.

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
- `GET /api/verify` — token check for `setup.sh`.

Web (session cookie via shoo PKCE, same model as files):

- `/p/:id` — plan viewer (any signed-in user can read, comment, review; URLs are random and non-enumerable).
- `/dashboard` — your plans + token management; `/setup` — token-minting flow for `setup.sh`.
- `/api/plans…` — viewer/dashboard API (list, view with rendered blocks + attached comments, comment, resolve, review, diff, delete).
- `/skill` and `/skill.md` — the `plan-review` agent skill; `/setup.sh` — client setup (`MYSLOP_PLANS_TOKEN`).

## Auth model

Identical to files: shoo.dev PKCE in the browser, worker-verified ES256 `id_token` (`aud origin:https://plans.myslop.app`), own 30-day session cookie; per-user `msp_` tokens stored as SHA-256 hashes, shown once, revocable immediately. Reviews and comments require a session; the agent API requires a token owned by the plan's creator (except comment reads, also owner-only).

## Deploy

Production is reconciled through the platform (`myslop.json`: database capability + `shoo.dev` network). The platform provisions the `myslop-plans` D1 database and applies `migrations/` forward-only. The standalone `wrangler.jsonc` carries a placeholder database id for local dev only.

```sh
bun run check           # from the repo root: generate + test + typecheck
```

## Local dev

```sh
bunx wrangler d1 execute myslop-plans --local --file schema.sql   # once
bun run dev
```

To fake a signed-in session locally, insert a `users` + `sessions` row into the local D1 and set the `sid` cookie to the session id. `setup.sh` is embedded base64-encoded (`bun run gen`) because raw shell text in a worker bundle trips the Cloudflare API WAF — after editing `src/setup.sh`, deploy with `bun run deploy`, never bare `wrangler deploy`.
