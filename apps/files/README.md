# myslop-files

File host at **https://files.myslop.app** — the `files` app on the Myslop platform, backed by the adopted `myslop-files` R2 bucket and D1 database for users, API tokens, and file metadata.

Sign in at **https://files.myslop.app/dashboard** (auth by [shoo.dev](https://shoo.dev)) to mint upload tokens, see your files, change who can open them, or delete them.

## Visibility

Each file is `protected` (anyone signed in to myslop; the default), `public` (anyone with the link) or `private` (the uploader only). Protected and private files are checked on every request against platform identity (a platform session on this host or an `msa_` token, injected by the dispatcher) or this app's own dashboard session. A browser without either is redirected to sign in at myslop.cloud and returned to the file; other clients get `401`. Files that predate the visibility column kept their old setting (private or public). The legacy `private` column mirrors `visibility <> 'public'` so a rollback to an older build fails closed, and triggers from `migrations/002_file_visibility.sql` give writes from such a build (which set only `private`) their old private/public meaning.

## API

- `PUT /<filename>` with `Authorization: Bearer <msf_token>` (or `X-Upload-Token: <msf_token>`) — stores the file under a random 10-char prefix, records it to your account, and returns the permanent URL in the response body (`201`). Append `?visibility=public|protected|private` to choose who can open it (default `protected`); the legacy `?private=1` / `?private=0` mean private / public.
- `PUT /<prefix>/<filename>` with the same credentials — replaces an existing upload in place (owner only), keeping its URL; `200` with the URL, `404` for an unknown or foreign key. `?visibility=` changes visibility; otherwise it is kept.
- `DELETE /<prefix>/<filename>` with the same credentials — deletes an upload (owner only); `200`, or `404` for an unknown or foreign key.
- `GET /<prefix>/<filename>` — serves the file with extension-inferred Content-Type. Public files are `public, no-cache` and protected files `private, no-cache`, both with an ETag (`304` on `If-None-Match`), so replacements show up on reload. The ETag covers the content type as well as the bytes. Files served before this change were cached as `immutable` for a year, so a browser that already fetched one may keep its old copy until a hard refresh. Private files 404 unless requested by the owner, through the dashboard session or platform identity (served `no-store`). Protected files need any signed-in user, as above.
- `GET /skill.md` — installable agent skill describing the upload flow.
- `GET /setup.sh` — client setup script: `curl -fsS https://files.myslop.app/setup.sh | bash` opens the dashboard, waits for a pasted token, verifies it via `GET /api/verify` (Bearer-authed), and persists `MYSLOP_FILES_TOKEN` (bash/zsh/fish + `~/.config/myslop-files/token`).
- `PUT /app-upload/<filename>` with a per-app HMAC token (`EVENTS_SECRET`, shared with myslop events/storage) — scoped browser uploads for myslop apps, unchanged.
- `/api/*` — dashboard API (session, files, tokens); cookie-authenticated.

```sh
curl -sS --fail-with-body -X PUT -T ./screenshot.png \
  -H "Authorization: Bearer $MYSLOP_FILES_TOKEN" \
  https://files.myslop.app/screenshot.png
```

## Auth model

- **Dashboard**: shoo.dev PKCE flow in the browser (`/authorize` → `/token`); the worker verifies the ES256 `id_token` against shoo's JWKS (`iss https://shoo.dev`, `aud origin:https://files.myslop.app`) and issues its own 30-day session (random id in D1, `HttpOnly` `Secure` `SameSite=Lax` cookie). Users are keyed by shoo's `pairwise_sub`.
- **Platform identity** (preferred): requests authenticated at the dispatcher — an `msa_` platform token or platform session — arrive with verified `x-myslop-user-*` headers and need no app token. Accounts are joined to Shoo users by verified email, so one platform token covers every myslop app.
- **Uploads**: platform identity, or legacy per-user tokens (`msf_…`, 256-bit) minted/revoked in the dashboard. Only a SHA-256 hash is stored; the secret is shown once. Revocation is immediate.
- **Legacy shared token**: retired (2026-07-27). The `UPLOAD_TOKEN` secret was deleted and the code path removed — only minted `msf_` tokens authorize uploads, so every upload is tracked to an account.

## Agent setup

Run `curl -fsS https://files.myslop.app/setup.sh | bash` on any machine to configure `MYSLOP_FILES_TOKEN`.

The `file-upload` agent skill is served three ways:

- `GET /skill` — human-readable page rendering the skill verbatim plus install options.
- `GET /skill.md` — raw markdown agents fetch and install.
- **Claude Code plugin** — this repo is also a plugin marketplace:

  ```
  /plugin marketplace add tvdavies/myslop-files
  /plugin install file-upload@myslop-files
  ```

The plugin lives at `plugins/file-upload/` (`.claude-plugin/plugin.json` + `skills/file-upload/SKILL.md`); the marketplace manifest is `.claude-plugin/marketplace.json`. The skill file is mirrored from `src/skill.md` by `scripts/gen-setup.ts` on every build, so the served copy and the plugin copy never drift — **edit `src/skill.md`, not the plugin copy.** Validate both manifests with `claude plugin validate --strict .claude-plugin/marketplace.json` and `... plugins/file-upload`.

## Deploy

```sh
bun run deploy        # regenerates src/setup-sh.generated.ts, then wrangler deploy
# schema changes:
bunx wrangler d1 execute myslop-files --remote --file schema.sql
```

`setup.sh` is embedded base64-encoded (via `scripts/gen-setup.ts`) because Cloudflare's API WAF 403s worker bundles containing raw shell-script text. After editing `src/setup.sh`, always deploy with `bun run deploy` (or run `bun run gen` first); `bunx wrangler deploy` alone ships the stale generated copy.

Production is reconciled through the platform with the team-scoped `MYSLOP_APPS_TOKEN`. The default standalone config has no web route. During the rollback window, `bunx wrangler deploy --config wrangler.rollback.jsonc` adds the more-specific `files.myslop.app/*` route back to the standalone Worker without removing the platform wildcard.

## Local dev

```sh
bunx wrangler d1 execute myslop-files --local --file schema.sql   # once
bunx wrangler dev
```

`.dev.vars` holds dev-only `UPLOAD_TOKEN` / `EVENTS_SECRET`. To fake a signed-in session locally, insert a `users` + `sessions` row into the local D1 and set the `sid` cookie to the session id.

## Delete a file

Owners can delete from the dashboard; admin fallback:

```sh
bunx wrangler r2 object delete myslop-files/<prefix>/<filename> --remote
# and, if tracked: bunx wrangler d1 execute myslop-files --remote \
#   --command "DELETE FROM files WHERE key='<prefix>/<filename>'"
```
