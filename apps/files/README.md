# myslop-files

Public file host at **https://files.myslop.app** — the `files` app on the Myslop platform, backed by the adopted `myslop-files` R2 bucket and D1 database for users, API tokens, and file metadata.

Sign in at **https://files.myslop.app/dashboard** (auth by [shoo.dev](https://shoo.dev)) to mint upload tokens, see your files, make them private, or delete them.

## API

- `PUT /<filename>` with `Authorization: Bearer <msf_token>` (or `X-Upload-Token: <msf_token>`) — stores the file under a random 10-char prefix, records it to your account, and returns the permanent URL in the response body (`201`). Append `?private=1` to make it owner-only.
- `GET /<prefix>/<filename>` — serves the file with extension-inferred Content-Type and `immutable` caching. Private files 404 unless requested with the owner's dashboard session cookie (served `no-store`).
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
- **Uploads**: per-user tokens (`msf_…`, 256-bit) minted/revoked in the dashboard. Only a SHA-256 hash is stored; the secret is shown once. Revocation is immediate.
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
