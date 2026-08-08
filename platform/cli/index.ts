#!/usr/bin/env bun
import { resolve } from "node:path";
import { createAppArtifact } from "../src/artifact";

const API = process.env.MYSLOP_APPS_API || "https://myslop.cloud";
const configHome = process.env.XDG_CONFIG_HOME || `${process.env.HOME}/.config`;
const tokenFile = `${configHome}/myslop-apps/token`;
const TOKEN = process.env.MYSLOP_APPS_TOKEN || await Bun.file(tokenFile).text().catch(() => "");

function fail(message: string): never {
  console.error(`myslop: ${message}`);
  process.exit(1);
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!TOKEN.trim()) fail(`set MYSLOP_APPS_TOKEN or ${tokenFile}`);
  let response: Response;
  try {
    response = await fetch(API + path, {
      ...init,
      headers: {
        authorization: `Bearer ${TOKEN.trim()}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
  } catch (error) {
    fail(`cannot reach ${API}: ${error instanceof Error ? error.message : error}`);
  }
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) fail(body.error || `${response.status} ${response.statusText}`);
  return body as T;
}

interface App {
  id: string;
  slug: string;
  name: string;
  url: string;
  visibility: string;
  activeVersion: number | null;
}

async function apps(): Promise<App[]> {
  return (await api<{ apps: App[] }>("/api/apps")).apps;
}

async function findApp(slug: string): Promise<App> {
  const app = (await apps()).find((item) => item.slug === slug || item.id === slug);
  if (!app) fail(`app '${slug}' not found`);
  return app;
}

function usage(): never {
  console.log(`Myslop Apps CLI

  apps
  create <slug> [name] [--visibility private|team|public]
  update <slug> [--name <name>] [--description <text>] [--visibility private|team|public]
  deploy <slug> [directory]
  secret <slug> <BINDING_NAME>
  rollback <slug> <version>
  prune <slug> --confirm <slug>
  destroy <slug> --confirm <slug>

Environment:
  MYSLOP_APPS_TOKEN   agent token from ${API}
  MYSLOP_APPS_API     API origin override
`);
  process.exit(0);
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const [command, ...args] = process.argv.slice(2);
if (!command || command === "help" || command === "--help") usage();

if (command === "apps") {
  for (const app of await apps()) {
    console.log(`${app.slug.padEnd(28)} v${String(app.activeVersion ?? "—").padEnd(4)} ${app.visibility.padEnd(8)} ${app.url}`);
  }
} else if (command === "create") {
  const slug = args[0];
  if (!slug) usage();
  const visibilityIndex = args.indexOf("--visibility");
  const visibility = visibilityIndex >= 0 ? args[visibilityIndex + 1] : "team";
  const name = args[1] && !args[1].startsWith("--") ? args[1] : slug;
  const { app } = await api<{ app: App }>("/api/apps", {
    method: "POST",
    body: JSON.stringify({ slug, name, visibility }),
  });
  console.log(`Created ${app.name}\n${app.url}\nApp id: ${app.id}`);
} else if (command === "update") {
  const slug = args[0];
  if (!slug) usage();
  const app = await findApp(slug);
  const body = {
    name: option(args, "--name"),
    description: option(args, "--description"),
    visibility: option(args, "--visibility"),
  };
  if (!body.name && !body.description && !body.visibility) fail("provide --name, --description, or --visibility");
  const result = await api<{ app: App }>(`/api/apps/${app.id}`, { method: "PATCH", body: JSON.stringify(body) });
  console.log(`Updated ${result.app.name}\n${result.app.url}`);
} else if (command === "deploy") {
  const slug = args[0];
  if (!slug) usage();
  const root = resolve(args[1] || ".");
  const app = await findApp(slug);
  let artifact;
  try {
    artifact = await createAppArtifact(root);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const { manifest, assets, worker, migrations } = artifact.deployment;
  const detected = [
    assets.length ? `${assets.length} assets` : null,
    worker ? "Worker" : null,
    manifest.capabilities.database ? `database${migrations.length ? ` (${migrations.length} migrations)` : ""}` : null,
    manifest.capabilities.files ? "file storage" : null,
    manifest.capabilities.secrets.length ? `secrets: ${manifest.capabilities.secrets.join(", ")}` : null,
  ].filter(Boolean).join(", ");
  console.error(`Resolved capabilities: ${detected}`);
  const { deployment } = await api<{ deployment: { version: number; url: string } }>(`/api/apps/${app.id}/deployments`, {
    method: "POST",
    body: JSON.stringify({ manifest, assets, worker, migrations }),
  });
  console.log(`Deployed v${deployment.version}\n${deployment.url}`);
} else if (command === "rollback") {
  const [slug, rawVersion] = args;
  if (!slug || !rawVersion) usage();
  const app = await findApp(slug);
  const result = await api<{ version: number; url: string }>(`/api/apps/${app.id}/rollback`, {
    method: "POST",
    body: JSON.stringify({ version: Number(rawVersion) }),
  });
  console.log(`Rolled back to v${result.version}\n${result.url}`);
} else if (command === "prune") {
  const slug = args[0];
  if (!slug || option(args, "--confirm") !== slug) fail(`repeat the slug: prune ${slug || "<slug>"} --confirm ${slug || "<slug>"}`);
  const app = await findApp(slug);
  const result = await api<{ removed: string[] }>(`/api/apps/${app.id}/prune`, {
    method: "POST",
    body: JSON.stringify({ confirm: slug }),
  });
  console.log(result.removed.length ? `Removed: ${result.removed.join(", ")}` : "No unused resources to remove");
} else if (command === "destroy") {
  const slug = args[0];
  if (!slug || option(args, "--confirm") !== slug) fail(`repeat the slug: destroy ${slug || "<slug>"} --confirm ${slug || "<slug>"}`);
  const app = await findApp(slug);
  await api(`/api/apps/${app.id}`, { method: "DELETE", body: JSON.stringify({ confirm: slug }) });
  console.log(`Deleted ${slug} and its Cloudflare resources`);
} else if (command === "secret") {
  const [slug, name] = args;
  if (!slug || !name) usage();
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) fail("secret name must be an uppercase binding name");
  const app = await findApp(slug);
  let value = process.env.MYSLOP_SECRET_VALUE || "";
  if (!value) {
    const result = Bun.spawnSync(["bash", "-c", `read -rsp "$1" value; printf '%s' "$value"`, "--", `Value for ${name}: `], {
      stdin: "inherit",
      stdout: "pipe",
      stderr: "inherit",
    });
    console.error();
    value = result.stdout.toString();
  }
  if (!value) fail("secret value is empty");
  await api(`/api/apps/${app.id}/secrets/${encodeURIComponent(name)}`, {
    method: "PUT",
    body: JSON.stringify({ value }),
  });
  console.log(`Updated ${name} for ${app.slug}`);
} else {
  fail(`unknown command '${command}'`);
}
