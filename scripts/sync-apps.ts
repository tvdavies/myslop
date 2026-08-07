#!/usr/bin/env bun
import { basename, dirname, resolve } from "node:path";
import { createAppArtifact, type AppArtifact } from "../platform/src/artifact";
import { validSlug } from "../platform/src/core";
import type { SourceManifest } from "../platform/src/manifest";

const ROOT = resolve(import.meta.dir, "..");
const APPS_DIR = resolve(ROOT, "apps");

export interface RemoteApp {
  id: string;
  slug: string;
  managedBy: "manual" | "git";
  sourceHash: string | null;
  deploymentHash?: string | null;
  hasDatabase?: boolean;
  hasFiles?: boolean;
}

export interface AppPlan {
  slug: string;
  action: "create" | "update" | "unchanged" | "delete";
  path?: string;
}

export function deletionConfirmations(markdown: string): Set<string> {
  const confirmations = new Set<string>();
  for (const raw of markdown.split("\n")) {
    const match = raw.trim().match(/^DELETE ([a-z][a-z0-9-]{1,46}[a-z0-9])$/);
    if (match) confirmations.add(match[1]!);
  }
  return confirmations;
}

export function addedDeletionConfirmations(diff: string): Set<string> {
  return deletionConfirmations(diff.split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n"));
}

async function currentDeletionConfirmations(base: string): Promise<Set<string>> {
  const child = Bun.spawn(["git", "diff", base, "HEAD", "--", "apps/DELETIONS.md"], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "inherit",
  });
  const diff = await new Response(child.stdout).text();
  if (await child.exited !== 0) throw new Error(`could not compare deletion confirmations against ${base}`);
  const active = deletionConfirmations(await Bun.file(resolve(APPS_DIR, "DELETIONS.md")).text());
  return new Set([...addedDeletionConfirmations(diff)].filter((slug) => active.has(slug)));
}

async function appDirectories(): Promise<{ slug: string; path: string }[]> {
  const directories: { slug: string; path: string }[] = [];
  for await (const entry of new Bun.Glob("*/myslop.json").scan({ cwd: APPS_DIR, onlyFiles: true })) {
    const slug = basename(dirname(resolve(APPS_DIR, entry)));
    const path = resolve(APPS_DIR, slug);
    if (!validSlug(slug)) throw new Error(`invalid app directory slug: ${slug}`);
    directories.push({ slug, path });
  }
  return directories.sort((left, right) => left.slug.localeCompare(right.slug));
}

export function planApps(localSlugs: string[], remoteApps: RemoteApp[], confirmations: Set<string>): AppPlan[] {
  const local = new Set(localSlugs);
  const remote = new Map(remoteApps.map((app) => [app.slug, app]));
  const plans: AppPlan[] = localSlugs.sort().map((slug) => ({
    slug,
    action: remote.has(slug) ? "update" : "create",
  }));
  for (const app of remoteApps.filter(({ managedBy }) => managedBy === "git").sort((left, right) => left.slug.localeCompare(right.slug))) {
    if (local.has(app.slug)) continue;
    if (!confirmations.has(app.slug)) throw new Error(`refusing to delete ${app.slug}: add an exact 'DELETE ${app.slug}' line to apps/DELETIONS.md`);
    plans.push({ slug: app.slug, action: "delete" });
  }
  return plans;
}

export function reconciliationBody(
  source: AppArtifact,
  sourceManifest: SourceManifest,
  slug: string,
  teamId: string,
  applyDomains: boolean,
  resources?: AppArtifact["app"]["resources"],
) {
  return {
    teamId,
    sourceHash: source.sourceHash,
    deploymentHash: source.deploymentHash,
    app: {
      name: source.app.name || slug,
      description: source.app.description,
      ...(sourceManifest.app?.visibility !== undefined ? { visibility: source.app.visibility } : {}),
      ...(source.app.folder !== undefined ? { folder: source.app.folder } : {}),
      ...(applyDomains ? { domains: source.app.domains } : {}),
    },
    ...(source.app.access ? { access: source.app.access } : {}),
    ...(resources && Object.keys(resources).length ? { resources } : {}),
    deployment: source.deployment,
  };
}

class PlatformApi {
  constructor(private readonly origin: string, private readonly token: string) {}

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.origin}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
    const body = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) throw new Error(body.error || `${response.status} ${response.statusText}`);
    return body as T;
  }
}

export async function syncApps(options: {
  apiOrigin: string;
  token: string;
  team: string;
  dryRun?: boolean;
  applyDomains?: boolean;
  adoptResources?: boolean;
  deletionBase?: string;
  appFilter?: string;
}): Promise<AppPlan[]> {
  if (!options.token) throw new Error("MYSLOP_APPS_TOKEN is required");
  if (!options.team) throw new Error("MYSLOP_TEAM is required");
  const api = new PlatformApi(options.apiOrigin.replace(/\/$/, ""), options.token);
  const compatibility = await api.request<{
    features?: { teamReconciliation?: number; reviewedResourceAdoption?: number };
  }>("/api/verify");
  if (
    compatibility.features?.teamReconciliation !== 1 ||
    compatibility.features?.reviewedResourceAdoption !== 1
  ) {
    throw new Error("platform must be deployed with team-scoped reconciliation before syncing apps");
  }
  const me = await api.request<{ teams: { id: string; slug: string; name: string }[] }>("/api/me");
  const team = me.teams.find(({ id, slug }) => id === options.team || slug === options.team);
  if (!team) throw new Error(`team not available to deployment token: ${options.team}`);
  const [{ apps: remoteApps }, directories, confirmations] = await Promise.all([
    api.request<{ apps: RemoteApp[] }>(`/api/apps?teamId=${encodeURIComponent(team.id)}`),
    appDirectories(),
    currentDeletionConfirmations(options.deletionBase || "HEAD^"),
  ]);
  const selectedDirectories = options.appFilter ? directories.filter(({ slug }) => slug === options.appFilter) : directories;
  if (options.appFilter && !selectedDirectories.length) throw new Error(`app directory not found: ${options.appFilter}`);
  const selectedRemoteApps = options.appFilter ? remoteApps.filter(({ slug }) => slug === options.appFilter) : remoteApps;
  const plans = planApps(selectedDirectories.map(({ slug }) => slug), selectedRemoteApps, confirmations);
  const paths = new Map(selectedDirectories.map((directory) => [directory.slug, directory.path]));
  const remote = new Map(selectedRemoteApps.map((app) => [app.slug, app]));

  for (const plan of plans.filter(({ action }) => action !== "delete")) {
    const path = paths.get(plan.slug)!;
    const packageJson = await Bun.file(resolve(path, "package.json")).json().catch(() => null) as { scripts?: { gen?: string } } | null;
    if (packageJson?.scripts?.gen) {
      const generated = Bun.spawn(["bun", "run", "gen"], { cwd: path, stdout: "inherit", stderr: "inherit" });
      if (await generated.exited !== 0) throw new Error(`generation failed for ${plan.slug}`);
    }
    const existing = remote.get(plan.slug);
    if (existing && existing.managedBy !== "git") throw new Error(`refusing to reconcile ${plan.slug}: it is manually managed`);
    const sourceManifest = await Bun.file(resolve(path, "myslop.json")).json() as SourceManifest;
    const source = await createAppArtifact(path, {
      suppressMigrations: Boolean(sourceManifest.app?.resources?.database) && (!existing || !existing.sourceHash),
    });
    const needsResourceAdoption = Boolean(
      (source.app.resources.database && !existing?.hasDatabase) ||
      (source.app.resources.bucket && !existing?.hasFiles),
    );
    if (needsResourceAdoption && !options.adoptResources && !options.dryRun) {
      throw new Error(`refusing to adopt production resources for ${plan.slug}: set MYSLOP_ADOPT_RESOURCES=true for the reviewed migration`);
    }
    const adoptionResources = options.adoptResources ? {
      ...(source.app.resources.database && !existing?.hasDatabase
        ? { database: source.app.resources.database }
        : {}),
      ...(source.app.resources.bucket && !existing?.hasFiles
        ? { bucket: source.app.resources.bucket }
        : {}),
    } : undefined;
    plan.path = path;
    if (existing?.sourceHash === source.sourceHash) plan.action = "unchanged";
    console.log(`${options.dryRun ? "PLAN" : "SYNC"} ${plan.action.padEnd(9)} ${plan.slug}`);
    if (options.dryRun) continue;
    const result = await api.request<{ changed: boolean }>(`/api/reconcile/apps/${encodeURIComponent(plan.slug)}`, {
      method: "PUT",
      body: JSON.stringify(reconciliationBody(
        source,
        sourceManifest,
        plan.slug,
        team.id,
        options.applyDomains === true,
        adoptionResources,
      )),
    });
    plan.action = result.changed ? (existing ? "update" : "create") : "unchanged";
  }

  for (const plan of plans.filter(({ action }) => action === "delete")) {
    console.log(`${options.dryRun ? "PLAN" : "SYNC"} delete    ${plan.slug}`);
    if (!options.dryRun) {
      await api.request(`/api/reconcile/apps/${encodeURIComponent(plan.slug)}`, {
        method: "DELETE",
        body: JSON.stringify({ confirm: plan.slug, teamId: team.id }),
      });
    }
  }
  return plans;
}

if (import.meta.main) {
  const dryRun = process.argv.includes("--dry-run");
  await syncApps({
    apiOrigin: process.env.MYSLOP_APPS_API || "https://apps.myslop.app",
    token: process.env.MYSLOP_APPS_TOKEN || "",
    team: process.env.MYSLOP_TEAM || "",
    dryRun,
    applyDomains: process.env.MYSLOP_APPLY_DOMAINS === "true",
    adoptResources: process.env.MYSLOP_ADOPT_RESOURCES === "true",
    deletionBase: process.env.MYSLOP_DEPLOY_BASE || undefined,
    appFilter: process.env.MYSLOP_APP_FILTER || undefined,
  }).catch((error) => {
    console.error(`sync-apps: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}
