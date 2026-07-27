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

1. `$MYSLOP_MAIL_TOKEN` if set
2. The file `${XDG_CONFIG_HOME:-$HOME/.config}/myslop-mail/token`

If neither exists, or a request returns `401 unauthorized` (token revoked), have
the user run this in an interactive terminal, then retry:

```sh
curl -fsS https://mail.myslop.app/setup.sh | bash
```

It opens a page that signs them in and mints a token automatically; they
copy-paste it once and the script persists it. Every request needs
`-H "Authorization: Bearer $MYSLOP_MAIL_TOKEN"`.

```sh
TOKEN="${MYSLOP_MAIL_TOKEN:-$(cat "${XDG_CONFIG_HOME:-$HOME/.config}/myslop-mail/token")}"
```

## Choosing an address

- **Need to log back into the same account later?** Claim a stable, memorable
  name (below) and reuse it. The account on the target service is keyed to the
  email, so the same address = the same account.
- **One-off / throwaway?** Just pick any local part, e.g.
  `tmp-$(openssl rand -hex 4)@myslop.app`, and start reading it — no claim
  needed. Your account owns it automatically on first read.

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
- Release one: `DELETE https://mail.myslop.app/claim/<name>`

## Wait for a message

List the inbox (local part only, no `@domain`). `wait` long-polls up to 50s,
returning as soon as a message arrives:

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

Purge stored mail for an inbox: `DELETE https://mail.myslop.app/inbox/<local-part>`.
Manage addresses and tokens any time at https://mail.myslop.app/dashboard.
