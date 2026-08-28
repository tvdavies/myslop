---
name: temp-email
description: Create a temporary email address on @myslop.app and wait for messages to arrive at it. Use for sign-up flows, email verification, magic links, and OTP codes when testing services that require a real receiving inbox. Supports claiming stable, memorable addresses so you can sign back into the same account later.
---

# Temp email

Any address `@myslop.app` is a working inbox. Messages are read via the
authenticated API at `https://mail.myslop.app`. Delivered mail is retained for
7 days, then deleted automatically. Addresses you use are owned by your account:
the first account to read or claim a name owns it, and others get `403` — so
your OTPs and magic links stay private.

## Token

Resolve the API token in this order:

1. `$MYSLOP_APPS_TOKEN` if set — the myslop platform token authenticates here
   directly
2. The file `${XDG_CONFIG_HOME:-$HOME/.config}/myslop-apps/token`
3. Legacy: `$MYSLOP_MAIL_TOKEN` or the file
   `${XDG_CONFIG_HOME:-$HOME/.config}/myslop-mail/token`

If none exists, or a request returns `401 unauthorized` (token revoked), have
the user run the platform setup in an interactive terminal, then retry:

```sh
curl -fsS https://myslop.cloud/setup.sh | bash
```

One platform token covers the myslop-apps CLI and every myslop app (files,
mail, plans). Every request needs `-H "Authorization: Bearer $TOKEN"`.

```sh
cfg="${XDG_CONFIG_HOME:-$HOME/.config}"
TOKEN="${MYSLOP_APPS_TOKEN:-$(cat "$cfg/myslop-apps/token" 2>/dev/null || cat "$cfg/myslop-mail/token")}"
```

## Choosing an address

- **Need to log back into the same account later?** Claim a stable, memorable
  name (below) and reuse it. Claiming makes it **permanent** — kept until you
  release it. The account on the target service is keyed to the email, so the
  same address = the same account.
- **One-off / throwaway?** Just pick any local part, e.g.
  `tmp-$(openssl rand -hex 4)@myslop.app`, and start reading it — no claim
  needed. Your account **leases** it automatically on first read: the lease is
  ~1 day, slides forward every time you read it or mail arrives, and once it
  lapses the address auto-releases and its mail is deleted. So throwaways clean
  themselves up — you never have to release them manually.

Request a longer lease with `?lease=<hours>` (up to 168 / 7 days) on any read or
stream, e.g. `.../inbox/<name>?lease=72`.

## Claim a memorable address

Reserve a name so it's recorded as yours and won't be handed out twice. Omit
`name` to get a generated `adjective-noun` name (e.g. `big-donkey`):

```sh
# Generated memorable name:
curl -sS --fail-with-body -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"note":"staging llev.dev"}' \
  https://mail.myslop.app/claim

# Or request a specific one (201 if granted, 409 if taken by another account):
curl -sS --fail-with-body -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"name":"big-donkey","note":"staging llev.dev"}' \
  https://mail.myslop.app/claim
```

Response includes `address` (e.g. `big-donkey@myslop.app`) — use that in the
sign-up form.

- List your claims: `GET https://mail.myslop.app/claims`
- Release one: `DELETE https://mail.myslop.app/claim/<name>` (also deletes its stored mail)

## Wait for a message

**Preferred — stream (push):** open an SSE stream and mail is pushed the instant
it lands. `curl -N` blocks and prints one `data:` line per message (each is the
**full** message, including `text` and `links` — no second request needed). On
connect it first replays any mail already in the inbox, then streams new
arrivals. Connect *before* triggering the sign-up email so nothing is missed.

```sh
curl -N -H "Authorization: Bearer $TOKEN" \
  "https://mail.myslop.app/inbox/<local-part>/stream"
# each event: `data: {"id","from","subject","text","html","links",...}`
```

Read until you see the message you want (match on `subject`/`from`), grab its
link or OTP, then disconnect. Reconnect if the stream drops.

**Fallback — long-poll:** for clients that can't stream, list the inbox with
`wait` (long-polls up to 50s, returns as soon as a message arrives):

```sh
curl -sS --fail-with-body -H "Authorization: Bearer $TOKEN" \
  "https://mail.myslop.app/inbox/<local-part>?wait=50"
```

Response: `{"inbox": "...", "messages": [{"id", "from", "subject", "receivedAt"}]}`.
If still empty after a timeout, repeat in a loop as the sign-up flow completes.

## Read a message

```sh
curl -sS --fail-with-body -H "Authorization: Bearer $TOKEN" \
  "https://mail.myslop.app/inbox/<local-part>/<id>"
```

Returns the full message: `from`, `subject`, `text`, `html`, and `links` — a
pre-extracted array of all URLs in the body, usually the fastest way to grab a
verification/magic link. For OTP codes, grep the `text` field.

## Clean up (optional)

- Purge an inbox's mail but keep the name: `DELETE https://mail.myslop.app/inbox/<local-part>`.
- Release the name and delete its mail: `DELETE https://mail.myslop.app/claim/<local-part>`.

Manage addresses and tokens any time at https://mail.myslop.app/dashboard.
