---
name: file-upload
description: Upload a local file (screenshot, recording, log, HTML artifact) to files.myslop.app and return a permanent public URL. Use whenever a shareable link to a local file is needed, including for GitHub pull requests, Slack messages, or sharing HTML documents.
---

# file-upload

Upload files to https://files.myslop.app and get back a permanent URL.

## Token

Resolve the API token in this order:

1. `$MYSLOP_FILES_TOKEN` if set
2. The file `${XDG_CONFIG_HOME:-$HOME/.config}/myslop-files/token` (shell-agnostic
   fallback — works even if the user's shell never exported the variable)

If neither exists, or an upload returns `401 unauthorized` (token revoked), have
the user run this in an interactive terminal, then retry:

```sh
curl -fsS https://files.myslop.app/setup.sh | bash
```

It opens a page that signs them in and mints a token automatically (named after
their machine); they copy-paste it once and the script persists it for future
shells and writes the fallback file.

## Upload

```sh
TOKEN="${MYSLOP_FILES_TOKEN:-$(cat "${XDG_CONFIG_HOME:-$HOME/.config}/myslop-files/token")}"
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

## After uploading

Return the URL to the user or embed it where they asked (PR body, Slack message,
etc.). Files are managed — private, delete, list — at
https://files.myslop.app/dashboard.
