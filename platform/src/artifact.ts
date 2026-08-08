import { relative, resolve } from "node:path";
import { $ } from "bun";
import { normalizeAppManifest, resolveManifest, type ResolvedAppManifest, type SourceManifest } from "./manifest";
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
  if (!(await directoryExists(publicDir))) return [];
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
  const path = resolve(root, "myslop.json");
  if (!(await Bun.file(path).exists())) return {};
  try {
    return await Bun.file(path).json() as SourceManifest;
  } catch (error) {
    throw new Error(`invalid myslop.json: ${error instanceof Error ? error.message : error}`);
  }
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
  const [assets, worker, collectedMigrations, source] = await Promise.all([
    collectAssets(root),
    buildWorker(root),
    collectMigrations(root),
    readSourceManifest(root),
  ]);
  if (!assets.length && !worker) throw new Error("nothing to deploy: expected public/ assets or worker.ts");
  const migrations = options.suppressMigrations ? [] : collectedMigrations;
  const app = normalizeAppManifest(source);
  const manifest = resolveManifest(source, {
    assets: assets.length > 0,
    worker: Boolean(worker),
    migrations: migrations.length > 0,
  });
  const deployment = { manifest, assets, ...(worker ? { worker } : {}), migrations };
  const deploymentHash = await sha256Hex(JSON.stringify(stable({ runtimeAbi: RUNTIME_ABI_VERSION, deployment })));
  const sourceHash = await sha256Hex(JSON.stringify(stable({ runtimeAbi: RUNTIME_ABI_VERSION, app, deployment })));
  return { app, deployment, sourceHash, deploymentHash };
}
