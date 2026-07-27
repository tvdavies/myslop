# myslop-files

Public file host at **https://files.myslop.app** — a Cloudflare Worker (Lleverage account) in front of the `myslop-files` R2 bucket, with a D1 database for users, API tokens, and file metadata.

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

Run `curl -fsS https://files.myslop.app/setup.sh | bash` on any machine to configure `MYSLOP_FILES_TOKEN`, then point agents at `https://files.myslop.app/skill.md`. The local `file-upload` skill (`~/.claude/skills/file-upload/SKILL.md`) uses the same variable.

## Deploy

```sh
bun run deploy        # regenerates src/setup-sh.generated.ts, then wrangler deploy
# schema changes:
bunx wrangler d1 execute myslop-files --remote --file schema.sql
```

`setup.sh` is embedded base64-encoded (via `scripts/gen-setup.ts`) because Cloudflare's API WAF 403s worker bundles containing raw shell-script text. After editing `src/setup.sh`, always deploy with `bun run deploy` (or run `bun run gen` first); `bunx wrangler deploy` alone ships the stale generated copy.

Auth comes from `CLOUDFLARE_API_TOKEN` (set in `~/.config/fish/conf.d/cloudflare.fish`). The token needs: Workers Scripts Edit, Workers R2 Storage Edit, D1 Edit, and Zone → Workers Routes Edit on `myslop.app`.

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
