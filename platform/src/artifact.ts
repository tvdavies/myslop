import { relative, resolve } from "node:path";
import { $ } from "bun";
import { normalizeAppManifest, resolveManifest, type ResolvedAppManifest, type SourceManifest } from "./manifest";
import { parseSchemaSql } from "./schema-diff";
import { sha256Hex } from "./core";

const RUNTIME_ABI_VERSION = 2;

export interface AppAsset {
  path: string;
  contentType?: string;
  data: string;
}

export interface AppMigration {
  name: string;
  sql: string;
}

export interface AppArtifact {
  app: ResolvedAppManifest;
  deployment: {
    manifest: ReturnType<typeof resolveManifest>;
    assets: AppAsset[];
    worker?: string;
    schema?: string;
    migrations: AppMigration[];
  };
  sourceHash: string;
  deploymentHash: string;
}

async function directoryExists(path: string): Promise<boolean> {
  return $`test -d ${path}`.quiet().nothrow().then((result) => result.exitCode === 0);
}

export async function collectAssets(root: string): Promise<AppAsset[]> {
  const publicDir = resolve(root, "public");
  if (await directoryExists(publicDir)) {
    const assets: AppAsset[] = [];
    for await (const path of new Bun.Glob("**/*").scan({ cwd: publicDir, onlyFiles: true, dot: true })) {
      const file = Bun.file(resolve(publicDir, path));
      assets.push({
        path: relative(publicDir, resolve(publicDir, path)).replaceAll("\\", "/"),
        contentType: file.type || undefined,
        data: Buffer.from(await file.arrayBuffer()).toString("base64"),
      });
    }
    return assets.sort((left, right) => left.path.localeCompare(right.path));
  }
  return bundleRootIndex(root);
}

// A root-level index.html without public/ is bundled at deploy time: scripts
// (including .ts/.tsx with JSX) and stylesheets it references are compiled and
// emitted alongside the rewritten HTML. worker.ts, schema.sql, and other
// unreferenced files are never included.
async function bundleRootIndex(root: string): Promise<AppAsset[]> {
  const entry = resolve(root, "index.html");
  if (!(await Bun.file(entry).exists())) return [];
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "esm",
    minify: false,
    sourcemap: "none",
  });
  if (!result.success) throw new Error(result.logs.map(String).join("\n"));
  const assets = await Promise.all(result.outputs.map(async (output) => ({
    path: output.path.replace(/^\.\//, ""),
    contentType: output.type || undefined,
    data: Buffer.from(await output.arrayBuffer()).toString("base64"),
  })));
  return assets.sort((left, right) => left.path.localeCompare(right.path));
}

export async function buildWorker(root: string): Promise<string | undefined> {
  const candidates = ["worker.ts", "worker.js", "worker.mjs"].map((name) => resolve(root, name));
  const entry = (await Promise.all(candidates.map(async (path) => await Bun.file(path).exists() ? path : null))).find(Boolean);
  if (!entry) return undefined;
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "esm",
    minify: false,
    sourcemap: "none",
    loader: { ".html": "text", ".md": "text" },
  });
  if (!result.success) throw new Error(result.logs.map(String).join("\n"));
  return result.outputs[0]!.text();
}

export async function readSourceManifest(root: string): Promise<SourceManifest> {
  const candidates = ["myslop.json", "myslop.yaml", "myslop.yml"];
  const present: string[] = [];
  for (const name of candidates) {
    if (await Bun.file(resolve(root, name)).exists()) present.push(name);
  }
  if (present.length > 1) throw new Error(`use a single manifest file (found ${present.join(" and ")})`);
  const name = present[0];
  if (!name) return {};
  try {
    const file = Bun.file(resolve(root, name));
    if (name.endsWith(".json")) return await file.json() as SourceManifest;
    const parsed = Bun.YAML.parse(await file.text());
    if (parsed === null || parsed === undefined) return {};
    if (typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("manifest must be a mapping");
    return parsed as SourceManifest;
  } catch (error) {
    throw new Error(`invalid ${name}: ${error instanceof Error ? error.message : error}`);
  }
}

// Root-level schema.sql declares the desired database schema. It is validated
// locally so agents get parse errors before a deployment round-trip.
export async function collectSchema(root: string): Promise<string | undefined> {
  const file = Bun.file(resolve(root, "schema.sql"));
  if (!(await file.exists())) return undefined;
  const sql = await file.text();
  if (!sql.trim()) return undefined;
  parseSchemaSql(sql);
  return sql;
}

export async function collectMigrations(root: string): Promise<AppMigration[]> {
  const dir = resolve(root, "migrations");
  if (!(await directoryExists(dir))) return [];
  const paths: string[] = [];
  for await (const path of new Bun.Glob("*.sql").scan({ cwd: dir, onlyFiles: true })) paths.push(path);
  paths.sort();
  return Promise.all(paths.map(async (path) => ({ name: path, sql: await Bun.file(resolve(dir, path)).text() })));
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, stable(entry)]));
}

export async function createAppArtifact(root: string, options: { suppressMigrations?: boolean } = {}): Promise<AppArtifact> {
  const [assets, worker, collectedMigrations, source, schema] = await Promise.all([
    collectAssets(root),
    buildWorker(root),
    collectMigrations(root),
    readSourceManifest(root),
    collectSchema(root),
  ]);
  if (!assets.length && !worker) throw new Error("nothing to deploy: expected index.html, public/ assets, or worker.ts");
  const migrations = options.suppressMigrations ? [] : collectedMigrations;
  const app = normalizeAppManifest(source);
  const manifest = resolveManifest(source, {
    assets: assets.length > 0,
    worker: Boolean(worker),
    migrations: migrations.length > 0,
    schema: Boolean(schema),
  });
  const deployment = { manifest, assets, ...(worker ? { worker } : {}), ...(schema ? { schema } : {}), migrations };
  const deploymentHash = await sha256Hex(JSON.stringify(stable({ runtimeAbi: RUNTIME_ABI_VERSION, deployment })));
  const sourceHash = await sha256Hex(JSON.stringify(stable({ runtimeAbi: RUNTIME_ABI_VERSION, app, deployment })));
  return { app, deployment, sourceHash, deploymentHash };
}
