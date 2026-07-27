---
name: myslop-files
description: Upload a local file (screenshot, recording, log, HTML artifact) to files.myslop.app and return a permanent public URL. Use whenever a shareable link to a local file is needed, e.g. for GitHub pull requests, Slack messages, or sharing HTML documents.
---

# myslop-files upload

Upload files to https://files.myslop.app and get back a permanent URL.

## Requirements

An API token in the `MYSLOP_FILES_TOKEN` environment variable. If it is not set,
tell the user to run the setup script in a terminal:

```sh
curl -fsS https://files.myslop.app/setup.sh | bash
```

It opens the dashboard (sign in with shoo.dev, generate a token), waits for the
token to be pasted, verifies it, and persists `MYSLOP_FILES_TOKEN` for
bash/zsh/fish. The token also lands in `~/.config/myslop-files/token`, so
`$(cat ~/.config/myslop-files/token)` works in the current shell right away.

## Upload

```sh
curl -sS --fail-with-body -X PUT -T <local-path> \
  -H "Authorization: Bearer $MYSLOP_FILES_TOKEN" \
  "https://files.myslop.app/<filename>"
```

- The response body is the permanent public URL (files are stored under a random,
  non-enumerable prefix, so the URL is the only handle).
- `<filename>` should be the basename you want in the URL; it does not need to match
  the local path.
- Content-Type is inferred from the file extension; pass `-H "Content-Type: ..."` to
  override.

### Private uploads

Append `?private=1` to make the file visible only to the token's owner while signed
in to the dashboard:

```sh
curl -sS --fail-with-body -X PUT -T ./notes.md \
  -H "Authorization: Bearer $MYSLOP_FILES_TOKEN" \
  "https://files.myslop.app/notes.md?private=1"
```

## After uploading

Return the URL to the user (or embed it where they asked — PR body, Slack message,
etc.). Uploaded files can be managed — made private, deleted, listed — at
https://files.myslop.app/dashboard.

## Errors

- `401 unauthorized` — token missing, revoked, or wrong. Ask the user to mint a new
  one at the dashboard.
- Any other failure: report the response body verbatim.
