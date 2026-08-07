#!/usr/bin/env bun
import { basename, dirname, resolve } from "node:path";
import { createAppArtifact } from "../platform/src/artifact";
import { validSlug } from "../platform/src/core";

const ROOT = resolve(import.meta.dir, "..");
const APPS_DIR = resolve(ROOT, "apps");

export interface RemoteApp {
  id: string;
  slug: string;
  managedBy: "manual" | "git";
  sourceHash: string | null;
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
  dryRun?: boolean;
  applyDomains?: boolean;
  appFilter?: string;
}): Promise<AppPlan[]> {
  if (!options.token) throw new Error("MYSLOP_APPS_TOKEN is required");
  const api = new PlatformApi(options.apiOrigin.replace(/\/$/, ""), options.token);
  const [{ apps: remoteApps }, directories, deletionText] = await Promise.all([
    api.request<{ apps: RemoteApp[] }>("/api/apps"),
    appDirectories(),
    Bun.file(resolve(APPS_DIR, "DELETIONS.md")).text(),
  ]);
  const selectedDirectories = options.appFilter ? directories.filter(({ slug }) => slug === options.appFilter) : directories;
  if (options.appFilter && !selectedDirectories.length) throw new Error(`app directory not found: ${options.appFilter}`);
  const selectedRemoteApps = options.appFilter ? remoteApps.filter(({ slug }) => slug === options.appFilter) : remoteApps;
  const plans = planApps(selectedDirectories.map(({ slug }) => slug), selectedRemoteApps, deletionConfirmations(deletionText));
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
    const sourceManifest = await Bun.file(resolve(path, "myslop.json")).json() as { app?: { resources?: { database?: unknown } } };
    const source = await createAppArtifact(path, {
      suppressMigrations: Boolean(sourceManifest.app?.resources?.database) && (!existing || !existing.sourceHash),
    });
    plan.path = path;
    if (existing?.sourceHash === source.sourceHash) plan.action = "unchanged";
    console.log(`${options.dryRun ? "PLAN" : "SYNC"} ${plan.action.padEnd(9)} ${plan.slug}`);
    if (options.dryRun) continue;
    const result = await api.request<{ changed: boolean }>(`/api/reconcile/apps/${encodeURIComponent(plan.slug)}`, {
      method: "PUT",
      body: JSON.stringify({
        sourceHash: source.sourceHash,
        app: {
          name: source.app.name || plan.slug,
          description: source.app.description,
          visibility: source.app.visibility,
          ...(options.applyDomains ? { domains: source.app.domains } : {}),
        },
        resources: source.app.resources,
        deployment: source.deployment,
      }),
    });
    plan.action = result.changed ? (existing ? "update" : "create") : "unchanged";
  }

  for (const plan of plans.filter(({ action }) => action === "delete")) {
    console.log(`${options.dryRun ? "PLAN" : "SYNC"} delete    ${plan.slug}`);
    if (!options.dryRun) {
      await api.request(`/api/reconcile/apps/${encodeURIComponent(plan.slug)}`, {
        method: "DELETE",
        body: JSON.stringify({ confirm: plan.slug }),
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
    dryRun,
    applyDomains: process.env.MYSLOP_APPLY_DOMAINS === "true",
    appFilter: process.env.MYSLOP_APP_FILTER || undefined,
  }).catch((error) => {
    console.error(`sync-apps: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}
