---
name: plan-review
description: Author an implementation plan as markdown, publish it to plans.myslop.app for human review, then poll for comments and approvals, reply to feedback, and publish revised versions. Use whenever a plan, design, or proposal should be reviewed and approved by a human before implementation.
---

# plan-review

Publish plans to https://plans.myslop.app where humans review them: they comment
on individual blocks (paragraphs, list items, headings), approve, or request
changes. You poll for feedback, reply as the agent, resolve addressed comments,
and publish new versions until the plan is approved. Reviewers see every
version and can diff them.

## Token

Resolve the API token in this order:

1. `$MYSLOP_PLANS_TOKEN` if set
2. The file `${XDG_CONFIG_HOME:-$HOME/.config}/myslop-plans/token` (shell-agnostic
   fallback — works even if the user's shell never exported the variable)

If neither exists, or a request returns `401 unauthorized` (token revoked), have
the user run this in an interactive terminal, then retry:

```sh
curl -fsS https://plans.myslop.app/setup.sh | bash
```

It opens a page that signs them in and mints a token automatically; they
copy-paste it once and the script persists it for future shells.

```sh
TOKEN="${MYSLOP_PLANS_TOKEN:-$(cat "${XDG_CONFIG_HOME:-$HOME/.config}/myslop-plans/token")}"
```

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

Returns `{"id": "…", "url": "https://plans.myslop.app/p/…", "raw_url": "https://plans.myslop.app/p/….md", "version": 1, …}`.
**Give the `url` to the user** — that's where they review. Reviewers must sign
in (shoo.dev), and anyone signed in with the link can comment and review.

## Raw markdown

Every plan's markdown is served as plain text at its `raw_url` — **no
authentication required**, so any agent or tool with the link can read the
plan without your API token:

```sh
curl -fsS https://plans.myslop.app/p/<id>.md        # current version
curl -fsS "https://plans.myslop.app/p/<id>.md?v=2"  # a specific version
```

Use it to hand the current plan text to subagents or other tools, or to
recover the exact markdown you're about to revise. The response is the
markdown alone (`text/markdown`); the served version is echoed in the
`x-plan-version` header.

## Check status and pull feedback

```sh
curl -sS -H "Authorization: Bearer $TOKEN" \
  https://plans.myslop.app/api/agent/plans/<id>
```

Returns `status` (`open` | `approved` | `changes_requested` — derived from
reviews of the current version), `versions`, `reviews` (who approved / requested
changes, with notes), and `unresolved_comment_count`.

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

## Workflow summary

1. Write `plan.md`, publish with a meaningful title, share the returned URL.
2. Poll status/comments. Reply to questions; resolve addressed threads.
3. On `changes_requested` (or actionable comments): revise, `PUT` a new
   version with a `note`, and tell the user it's ready for re-review.
4. On `approved`: proceed with the work. Plans are managed (list, delete) at
   https://plans.myslop.app/dashboard.
