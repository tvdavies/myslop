# myslop-mail

Disposable email at **https://mail.myslop.app** — the `mail` app on the Myslop platform, backed by the adopted `myslop-mail` R2 bucket (raw messages) and D1 database (users, API tokens, inbox ownership). Any address `<name>@myslop.app` receives mail via a catch-all; the API lets you wait for and read it.

Sign in at **https://mail.myslop.app/dashboard** through first-party Myslop authentication to mint API tokens, claim addresses, and read mail.

## Ownership & lease model

Mail delivery is a global catch-all — anyone can send to any `@myslop.app` address. **Reading** is per-user: the first account to read or claim a name owns it, and other accounts get `403`. So your OTPs and magic links stay private. Ownership rows live in D1.

Two tiers:

- **Leased (throwaway)** — created automatically the first time you read/stream a name. Carries a sliding `lease_expires_at` (default 1 day, `?lease=<hours>` up to 7). Every read, stream connect, or incoming mail extends it; once it lapses the nightly sweep releases the name and deletes its mail. Throwaways clean themselves up — no manual release.
- **Permanent (claimed)** — `POST /claim` sets `claimed=1` and clears the lease. Kept until you release it. Use for addresses you sign back into later.

## Push (SSE) via Durable Objects

`email()` (delivery) and `fetch()` (reads) are separate stateless invocations, so pushing a delivered message to a waiting client needs shared state: an **`InboxHub` Durable Object per inbox name**. On subscribe it replays the R2 snapshot then holds the SSE connection open; `email()` calls the DO's `/push` and it fans the message out to every connected client. Same endpoint serves agents (`curl -N`) and the web (`EventSource`):

- `GET /inbox/<name>/stream` — agent SSE (Bearer). Snapshot then live; each event's `data` is the full message.
- `GET /api/addresses/<name>/stream` — dashboard SSE (session cookie).

The `?wait=` long-poll stays as a fallback.

## Agent API (Bearer `msm_` tokens)

Mint tokens in the dashboard. Every request needs `Authorization: Bearer <msm_token>`.

- `POST /claim` `{name?, note?}` — reserve a name (generated `adjective-noun` if omitted). `201` granted, `200` if you already own it, `409` if another account owns it.
- `GET /claims` — your owned names.
- `DELETE /claim/<name>` — release a name you own and delete its stored mail.
- `GET /inbox/<name>/stream` — **Server-Sent Events**: R2 snapshot then live push. Preferred over polling. `?lease=<hours>` extends the lease.
- `GET /inbox/<name>?wait=<0-50>` — list messages, long-polling until one arrives. Auto-owns (leases) the name on first read.
- `GET /inbox/<name>/<id>` — full message (`from`, `subject`, `text`, `html`, `links`).
- `DELETE /inbox/<name>` — purge stored mail (keeps the ownership row).

## Dashboard & web surfaces

- `GET /dashboard` — first-party Google sign-in through Myslop, address list with per-inbox message viewer, token management.
- `GET /setup` — signs in and auto-mints a token named from `?name=`, shown on a clean copy page (used by `setup.sh`).
- `GET /setup.sh` — client setup: `curl -fsS https://mail.myslop.app/setup.sh | bash` opens `/setup`, waits for the pasted token, verifies via `GET /api/verify`, and persists `MYSLOP_MAIL_TOKEN` (bash/zsh/fish/profile + `~/.config/myslop-mail/token`).
- `GET /skill` — human-readable page rendering the skill verbatim + install options.
- `GET /skill.md` — raw agent skill.
- `/api/*` — dashboard API (session-cookie authed).

## Auth model

- **Dashboard**: Google authorization-code + PKCE runs server-side at `auth.myslop.app`. `myslop.cloud` owns the host-only root session and explicitly hands a distinct app session to Mail. The dispatcher signs a short-lived, app-bound identity assertion; Mail verifies it before resolving the immutable Myslop identity. Existing local user IDs remain attached to all inboxes and tokens.
- **API tokens**: per-user `msm_…` (256-bit), only a SHA-256 hash stored, shown once, revocable. The old shared `API_TOKEN` secret was **retired** (2026-07-27) — only minted tokens authorize.

## Agent setup

`curl -fsS https://mail.myslop.app/setup.sh | bash`, then point agents at `https://mail.myslop.app/skill.md`, or install the Claude Code plugin:

```
/plugin marketplace add tvdavies/myslop-mail
/plugin install temp-email@myslop-mail
```

The plugin lives at `plugins/temp-email/`; `src/skill.md` is canonical and mirrored into it by `scripts/gen-setup.ts` on build (edit `src/skill.md`, not the plugin copy). Validate with `claude plugin validate --strict .claude-plugin/marketplace.json` and `... plugins/temp-email`.

## Deploy

```sh
bun run deploy        # regenerates src/setup-sh.generated.ts + mirrors skill, then wrangler deploy
bunx wrangler d1 execute myslop-mail --remote --file schema.sql   # schema changes
```

`setup.sh` is embedded base64-encoded (Cloudflare's API WAF 403s raw shell text in bundles) — always deploy with `bun run deploy`, not bare `wrangler deploy`.

## Local dev

```sh
bunx wrangler d1 execute myslop-mail --local --file schema.sql   # once
bun run dev
```

Note: `wrangler r2 object put --local` writes don't reliably show up in a running `wrangler dev` (miniflare caches R2 in memory); test mail reads against a real inbound message instead.

## Retention

Delivered mail is deleted after 7 days by a nightly cron (`scheduled`). Ownership rows are kept until released.

## Platform rollback

The default standalone config has no web route. During the rollback window, `bunx wrangler deploy --config wrangler.rollback.jsonc` restores the more-specific `mail.myslop.app/*` web route. Email delivery is switched independently by restoring the Cloudflare Email Routing catch-all target to `myslop-mail`; restore its `17 3 * * *` cron only while the standalone Worker owns maintenance.
