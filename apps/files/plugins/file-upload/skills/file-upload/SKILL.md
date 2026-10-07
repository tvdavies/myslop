---
name: file-upload
description: Upload a local file (screenshot, recording, log, HTML artifact) to files.myslop.app and return a permanent public URL. Use whenever a shareable link to a local file is needed, including for GitHub pull requests, Slack messages, or sharing HTML documents.
---

# file-upload

Upload files to https://files.myslop.app and get back a permanent URL.

## Token

Resolve the API token in this order:

1. `$MYSLOP_APPS_TOKEN` if set — the myslop platform token authenticates here
   directly
2. The file `${XDG_CONFIG_HOME:-$HOME/.config}/myslop-apps/token`
3. Legacy: `$MYSLOP_FILES_TOKEN` or the file
   `${XDG_CONFIG_HOME:-$HOME/.config}/myslop-files/token`

If none exists, or an upload returns `401 unauthorized` (token revoked), have
the user run the platform setup in an interactive terminal, then retry:

```sh
curl -fsS https://myslop.cloud/setup.sh | bash
```

One platform token covers the myslop-apps CLI and every myslop app (files,
mail, plans) — no per-app setup.

## Upload

```sh
cfg="${XDG_CONFIG_HOME:-$HOME/.config}"
TOKEN="${MYSLOP_APPS_TOKEN:-$(cat "$cfg/myslop-apps/token" 2>/dev/null || cat "$cfg/myslop-files/token")}"
curl -sS --fail-with-body -X PUT -T <local-path> \
  -H "Authorization: Bearer $TOKEN" \
  "https://files.myslop.app/<filename>"
```

- The response body is the permanent public URL (files are stored under a random,
  non-enumerable prefix — always use the returned URL, never construct it).
- `<filename>` is the basename you want in the URL; prefer descriptive kebab-case.
- Content-Type is inferred from the extension; pass `-H "Content-Type: ..."` to override.
- Uploaded HTML is served as a browsable page (sandboxed), so sharing HTML
  artifacts/reports works directly.
- Append `?private=1` for files only the account owner should see.

## Update a file in place

To publish a new version of a file you uploaded, PUT to its existing URL. The
URL stays the same, so links already shared show the new version:

```sh
curl -sS --fail-with-body -X PUT -T <local-path> \
  -H "Authorization: Bearer $TOKEN" \
  "https://files.myslop.app/<prefix>/<filename>"
```

- Returns `200` and the same URL. Only the owner can replace a file; an unknown
  URL or someone else's file returns `404` and nothing is created.
- Privacy is kept unless you append `?private=1` or `?private=0`.
- Public files revalidate by ETag, so readers get the new version on reload.
- Prefer this over a fresh upload whenever the file is a new version of
  something already shared.

## Delete a file

```sh
curl -sS --fail-with-body -X DELETE \
  -H "Authorization: Bearer $TOKEN" \
  "https://files.myslop.app/<prefix>/<filename>"
```

Owner only. Returns `200`, or `404` for an unknown URL or someone else's file.

## After uploading

Return the URL to the user or embed it where they asked (PR body, Slack message,
etc.). Files are managed — private, delete, list — at
https://files.myslop.app/dashboard.
