# Myslop

Myslop is an agent-native microcloud built on Cloudflare Workers for Platforms. This monorepo contains the platform and the first production apps that run on it.

## Repository layout

- `platform/` — the control plane, dispatcher, CLI, schema, and deployment tooling currently served at `apps.myslop.app`.
- `apps/files/` — Files, including its dashboard, `msf_` token API, upload/download service, setup script, and skill.
- `apps/mail/` — Mail, including its dashboard, `msm_` token API, Email Routing ingestion, inbox storage, long-polling, SSE, setup script, and skill.
- `scripts/sync-apps.ts` — reconciles the declarative app directories with the platform.

The three source repositories were grafted without squashing, so their original histories remain in this repository.

## Development

Install the workspace with Bun:

```sh
bun install
```

Run the complete local verification suite:

```sh
bun run check
```

Package-specific commands remain available from their directories, for example:

```sh
bun --cwd platform test
bun --cwd apps/files run gen
bun --cwd apps/mail run dev
```

## Apps as code

Each direct child of `apps/` is one platform app. Its `myslop.json` can declare metadata, organizational folder, Public/Team/Restricted audience, direct user and reusable group assignments, and runtime capabilities; runtime source, assets, and forward-only migrations live beside it. CI compares both policy and deployable hashes so access or folder changes reconcile without uploading a new runtime version.

Deleting a directory does not silently delete its production app. A git-managed app may only be destroyed when the same change adds an exact active confirmation to `apps/DELETIONS.md`.

Secrets are declarations, not repository values. CI fails when a declared secret has not already been provisioned on the platform. Production deployment is manual and scoped (`platform`, `apps`, or `all`); alias reconciliation is a separate `apply_domains` cutover switch and can target Files or Mail independently.

## Deployment safety

Local development and CI validation do not mutate production. These actions require separate explicit approval:

1. creating or pushing the public `tvdavies/myslop` repository;
2. deploying platform schema, bindings, routes, or runtime changes;
3. adopting or deleting production D1 databases and R2 buckets;
4. moving `files.myslop.app`, `mail.myslop.app`, or Email Routing;
5. archiving any source repository.

The platform Worker keeps its existing Cloudflare service, dispatch namespace, D1, R2, and outbound-worker identities. The monorepo layout must never create a parallel production platform by accident.

## License

MIT
