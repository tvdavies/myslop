---
name: plan-review
description: Publish markdown plans to plans.myslop.app, read feedback, reply and revise. With an explicitly permissioned Plans key, review plans in your account as a labelled agent. Follow the caller's requirements for human versus agent approval.
---

# plan-review

Publish plans to https://plans.myslop.app for review by humans or authorized
agents. Reviewers comment on individual blocks, approve, or request changes.
Read feedback, reply as the agent, resolve addressed comments, and publish
revisions. Reviewers see every version and can diff them. Review permission
is separate from authoring permission; do not review unless the caller has
authorized you to do so.

## Token

Use the caller's selected credential. Otherwise prefer the dedicated Plans key:

1. `$MYSLOP_PLANS_TOKEN`
2. `${XDG_CONFIG_HOME:-$HOME/.config}/myslop-plans/token`
3. `$MYSLOP_APPS_TOKEN`, then `${XDG_CONFIG_HOME:-$HOME/.config}/myslop-apps/token`
   (authoring only; platform keys cannot review)

```sh
cfg="${XDG_CONFIG_HOME:-$HOME/.config}"
if [ -n "${MYSLOP_PLANS_TOKEN:-}" ]; then
  TOKEN="$MYSLOP_PLANS_TOKEN"
elif [ -r "$cfg/myslop-plans/token" ]; then
  TOKEN="$(cat "$cfg/myslop-plans/token")"
elif [ -n "${MYSLOP_APPS_TOKEN:-}" ]; then
  TOKEN="$MYSLOP_APPS_TOKEN"
else
  TOKEN="$(cat "$cfg/myslop-apps/token")"
fi
```

Existing Plans keys and their local files keep working unchanged. The signed-in
owner can edit a key's **Permissions** at https://plans.myslop.app/dashboard
without rotating its secret. To add review while retaining current authoring
access, keep the existing boxes checked and enable **Approve and request
changes**. The **Oracle reviewer** preset instead grants read, comment and
review only. Everyone holding the same key shares its permissions; use separate
keys when authors must not be able to approve.

`GET /api/verify` returns the selected key's ID/name and effective `permissions`.
A `401` means the selected credential is invalid or revoked. A `403` with
`required_permission` means it lacks that action: ask the owner to change its
permissions, and never retry using a more privileged credential automatically.
If no credential exists, the user can create an author key in an interactive
terminal with `curl -fsS https://plans.myslop.app/setup.sh | bash`; setup never
grants review permission.

Permissions are `plans:read`, `plans:write`, `plans:comment`, `plans:resolve`
and `plans:review`. Agent API access stays within the issuing user's account,
including plans authored with that user's other keys. Raw markdown URLs remain
readable by anyone with the link.

## Authoring the plan

Write the plan as a **markdown document**. The service renders a bounded
subset: ATX headings (`#`…`######`), paragraphs, fenced code blocks, `-`/`1.`
lists (nesting allowed), blockquotes, pipe tables, `---` rules, images, links,
and inline code/bold/italic/strikethrough. Raw HTML is escaped, not rendered —
don't use it. Avoid setext headings (`===` underlines).

Structure that reviews well:

- A short, specific **title** (passed separately, not a heading) — it identifies
  the plan among many, e.g. "Plans service: block-anchored review comments",
  not "Plan".
- Open with a 2–4 sentence summary, then **Goals / Non-goals**, the design,
  phased implementation steps, risks, and open questions.
- Keep paragraphs and list items focused: each one is an individually
  commentable block, so one idea per block gives reviewers precise anchors.

**Diagrams**: build them with the excalidraw skill, export as SVG (or PNG),
upload with the file-upload skill to files.myslop.app, and embed the returned
URL as a markdown image: `![architecture](https://files.myslop.app/…/arch.svg)`.

## Publish

```sh
jq -n --arg title "Your specific plan title" --rawfile md plan.md \
  '{title: $title, markdown: $md}' \
| curl -sS --fail-with-body -X POST \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d @- https://plans.myslop.app/api/agent/plans
```

Returns `{"id": "…", "url": "https://plans.myslop.app/p/…", "raw_url": "https://plans.myslop.app/p/…/md", "version": 1, …}`.
**Give the `url` to the user** — that's where they review. Reviewers must sign
in (shoo.dev), and anyone signed in with the link can comment and review.

## Raw markdown

Every plan's markdown is served as plain text at its `raw_url` — **no
authentication required**, so any agent or tool with the link can read the
plan without your API token:

```sh
curl -fsS https://plans.myslop.app/p/<id>/md            # current version, with frontmatter
curl -fsS "https://plans.myslop.app/p/<id>/md?v=2"      # a specific version
curl -fsS "https://plans.myslop.app/p/<id>/md?plain=1"  # stored markdown only, no frontmatter
```

By default the document is prefixed with YAML frontmatter carrying metadata
only: `title`, `author`, `status`, `version` / `current_version` (plus the
version note and publish time), `created` / `updated` timestamps, review
verdicts, and `open_comment_threads` / `resolved_comment_threads` counts.
Comment bodies are **not** embedded — when `open_comment_threads` is non-zero,
pull them (with block excerpts) from the comments API above. Use `?plain=1`
whenever you need the stored markdown untouched (for example as the base text
for a revision). The served version is echoed in the `x-plan-version` header.

## Check status and pull feedback

```sh
curl -sS -H "Authorization: Bearer $TOKEN" \
  https://plans.myslop.app/api/agent/plans/<id>
```

Returns `status` (`open` | `approved` | `changes_requested` — derived from
reviews of the current version), `versions`, `reviews` (who approved / requested
changes, with notes and `author: {type, id, name}`), and
`unresolved_comment_count`. `author.type` is `user` or `agent`; agent IDs are
stable key IDs, separate from human reviewer IDs. Do not infer human approval
from aggregate `status`: when the caller requires a human decision, inspect
current-version reviews with `author.type == "user"`.

```sh
curl -sS -H "Authorization: Bearer $TOKEN" \
  "https://plans.myslop.app/api/agent/plans/<id>/comments?since=<ms-timestamp>"
```

Each comment has `body`, `author` (`type` is `user` or `agent`), optional
`block_id` + `block_excerpt` (the text of the block it anchors to), `parent_id`
for replies, and `resolved`. Omit `since` for everything.

Poll every 30–60 s while waiting; stop when `status` is no longer `open` or new
comments arrive.

## Reply and resolve

Your comments are labelled as agent comments in the UI.

```sh
# Reply in a thread
jq -n --arg body "Good catch — switched to a queue in v2." --arg to "<comment-id>" \
  '{body: $body, reply_to: $to}' \
| curl -sS --fail-with-body -X POST \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d @- https://plans.myslop.app/api/agent/plans/<id>/comments

# Mark a thread addressed
curl -sS -X POST -H "Authorization: Bearer $TOKEN" \
  https://plans.myslop.app/api/agent/plans/<id>/comments/<comment-id>/resolve
```

Only resolve a comment after actually addressing it (in a reply or a new
version). New comments may also be block-anchored: `{body, block_id}`.

## Publish a revision

After addressing feedback, publish the **full revised markdown** (versions are
immutable snapshots) with a one-line `note` describing what changed:

```sh
jq -n --rawfile md plan.md --arg note "v2: switched storage to D1 per Tom's comments" \
  '{markdown: $md, note: $note}' \
| curl -sS --fail-with-body -X PUT \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d @- https://plans.myslop.app/api/agent/plans/<id>
```

Publishing a new version resets the status to `open` (earlier approvals apply
to earlier versions); reviewers can diff any two versions in the UI. Keep
block wording stable where nothing changed so their comments stay anchored.
Don't publish micro-revisions — batch feedback into one version.

## Review as an authorized agent

This requires `plans:review` on a Plans (`msp_`) key. It does not require a
browser session. Read the current version and fetch its pinned markdown
(`/p/<id>/md?v=N&plain=1`) before evaluating it; post detailed findings as
comments and use the review note for a short summary.

```sh
jq -n --argjson version 3 --arg verdict approved --arg note "Rollback is covered." \
  '{version: $version, verdict: $verdict, note: $note}' \
| curl -sS --fail-with-body -X POST \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d @- https://plans.myslop.app/api/agent/plans/<id>/review
```

Use `changes_requested` instead of `approved` to request a revision. The
response includes `ok`, the reviewed `version`, `current_version` and `status`.
A `409` means that version is no longer current: fetch and review the new
version, never simply substitute the new number on the old verdict. A revision
published immediately after your write may also make a successful review's
`version` older than `current_version`; the old approval does not carry over.

Reviews are labelled `Agent · <key name>`. Each key can update its own verdict
for a version without overwriting another key or its owner's human review.
Changes requested takes precedence over approvals. Resolving a comment does
not clear a changes-requested verdict. Revoking a key or removing its review
permission blocks future submissions but preserves decisions already recorded.

## Workflow summary

1. Write `plan.md`, publish with a meaningful title, share the returned URL.
2. Poll status/comments. Reply to questions; resolve addressed threads.
3. On `changes_requested` (or actionable comments): revise, `PUT` a new
   version with a `note`, and tell the user it's ready for re-review.
4. On `approved`: report the version and reviewer identity. Implement only
   when the caller separately authorized implementation and the required human
   or agent review condition is satisfied. Plans and key permissions are managed
   at https://plans.myslop.app/dashboard.
