import dashboardHtml from "./dashboard.html";
import skillMd from "./skill.md";
import cliB64 from "./cli.generated";
import setupShB64 from "./setup-sh.generated";
import { authenticate, exchangeSession, getSessionUser, mintToken, signOut, type Principal } from "./auth";
import {
  attachCustomDomain,
  createD1,
  createR2Bucket,
  getD1,
  getR2Bucket,
  deleteCustomDomain,
  deleteD1,
  deleteR2Bucket,
  deleteUserWorker,
  queryD1,
  runD1Batch,
  runD1Sql,
  uploadUserWorker,
} from "./cloudflare";
import {
  contentType,
  decodeBase64,
  json,
  randomHex,
  safeAssetPath,
  sha256Hex,
  validBindingName,
  validSlug,
} from "./core";
import { MANIFEST_SCHEMA, normalizeAppDomain, parseResolvedManifest, type ResolvedManifest } from "./manifest";
import { acceptEmail, dispatchDueSchedules, reconcileAppSchedules, retryEmailDeliveries } from "./runtime";
import { encryptSecret, loadAppSecrets } from "./secrets";
import type { AppRow, DeploymentRow, Env, User } from "./types";

interface AssetInput {
  path: string;
  contentType?: string;
  data: string;
}

interface MigrationInput {
  name: string;
  sql: string;
}

interface DeployInput {
  manifest?: unknown;
  worker?: string;
  assets?: AssetInput[];
  migrations?: MigrationInput[];
}

function appUrl(slug: string): string {
  return `https://${slug}.apps.myslop.app`;
}

function publicApp(app: AppRow) {
  return {
    id: app.id,
    slug: app.slug,
    name: app.name,
    description: app.description,
    visibility: app.visibility,
    url: appUrl(app.slug),
    activeVersion: app.active_version,
    hasDatabase: Boolean(app.d1_id),
    hasFiles: Boolean(app.r2_bucket),
    databaseDeleteAfter: app.d1_delete_after,
    filesDeleteAfter: app.r2_delete_after,
    databaseAdopted: Boolean(app.d1_adopted),
    filesAdopted: Boolean(app.r2_adopted),
    managedBy: app.managed_by,
    sourceHash: app.source_hash,
    createdAt: app.created_at,
    updatedAt: app.updated_at,
  };
}

function manifestComponents(manifestJson: string | null) {
  if (!manifestJson) return { assets: false, worker: false, database: false, files: false, secrets: 0, network: 0, email: false, schedules: 0, durableObjects: 0 };
  try {
    const manifest = parseResolvedManifest(JSON.parse(manifestJson));
    return {
      assets: manifest.assets,
      worker: manifest.worker,
      database: manifest.capabilities.database,
      files: manifest.capabilities.files,
      secrets: manifest.capabilities.secrets.length,
      network: manifest.capabilities.network.length,
      email: manifest.capabilities.email,
      schedules: manifest.capabilities.schedules.length,
      durableObjects: manifest.capabilities.durableObjects.length,
    };
  } catch {
    return { assets: false, worker: false, database: false, files: false, secrets: 0, network: 0, email: false, schedules: 0, durableObjects: 0 };
  }
}

function isPlatformOwner(principal: Principal): boolean {
  return principal.user.platform_role === "owner";
}

function canDestroy(app: AppRow, principal: Principal): boolean {
  return isPlatformOwner(principal) || app.owner_id === principal.user.id;
}

async function publicAppFor(env: Env, app: AppRow, principal: Principal) {
  return {
    ...publicApp(app),
    permissions: {
      manage: await canManage(env, app, principal),
      destroy: canDestroy(app, principal),
    },
  };
}

async function audit(env: Env, userId: string, action: string, appId: string | null, detail?: unknown) {
  try {
    await env.CONTROL_DB.prepare(
      "INSERT INTO audit_log (id,app_id,user_id,action,detail,created_at) VALUES (?,?,?,?,?,?)",
    ).bind(randomHex(12), appId, userId, action, detail ? JSON.stringify(detail) : null, Date.now()).run();
  } catch (error) {
    console.error("audit write failed", { action, appId, error });
  }
}

async function recordOrphan(
  env: Env,
  type: "d1" | "r2" | "worker" | "domain",
  identifier: string,
  appId: string | null,
  error: unknown,
): Promise<void> {
  try {
    await env.CONTROL_DB.prepare(
      `INSERT INTO orphan_resources (type,identifier,app_id,error,created_at) VALUES (?,?,?,?,?)
       ON CONFLICT(type,identifier) DO UPDATE SET error=excluded.error`,
    ).bind(type, identifier, appId, error instanceof Error ? error.message : String(error), Date.now()).run();
  } catch (recordError) {
    console.error("orphan resource could not be recorded", { type, identifier, appId, error, recordError });
  }
}

async function getAppById(env: Env, id: string): Promise<AppRow | null> {
  return (await env.CONTROL_DB.prepare("SELECT * FROM apps WHERE id=? AND archived_at IS NULL").bind(id).first<AppRow>()) ?? null;
}

async function getAppBySlug(env: Env, slug: string): Promise<AppRow | null> {
  return (await env.CONTROL_DB.prepare("SELECT * FROM apps WHERE slug=? AND archived_at IS NULL").bind(slug).first<AppRow>()) ?? null;
}

async function getAppIncludingArchived(env: Env, id: string): Promise<AppRow | null> {
  return (await env.CONTROL_DB.prepare("SELECT * FROM apps WHERE id=?").bind(id).first<AppRow>()) ?? null;
}

async function getAppBySlugIncludingArchived(env: Env, slug: string): Promise<AppRow | null> {
  return (await env.CONTROL_DB.prepare("SELECT * FROM apps WHERE slug=?").bind(slug).first<AppRow>()) ?? null;
}

async function canManage(env: Env, app: AppRow, principal: Principal): Promise<boolean> {
  if (principal.appId && principal.appId !== app.id) return false;
  if (isPlatformOwner(principal) || app.owner_id === principal.user.id) return true;
  const member = await env.CONTROL_DB.prepare(
    "SELECT role FROM app_members WHERE app_id=? AND user_id=?",
  ).bind(app.id, principal.user.id).first<{ role: string }>();
  return member?.role === "editor";
}

async function canView(env: Env, app: AppRow, user: User | null): Promise<boolean> {
  if (app.visibility === "public") return true;
  if (!user) return false;
  if (user.platform_role === "owner" || app.visibility === "team" || app.owner_id === user.id) return true;
  return Boolean(await env.CONTROL_DB.prepare(
    "SELECT 1 ok FROM app_members WHERE app_id=? AND user_id=?",
  ).bind(app.id, user.id).first());
}

function ensureCsrf(req: Request, principal: Principal): Response | null {
  if (principal.tokenId || req.method === "GET" || req.method === "HEAD") return null;
  const origin = req.headers.get("origin");
  return origin === "https://apps.myslop.app" || origin === "http://localhost:8787"
    ? null
    : json({ error: "bad origin" }, 403);
}

async function acquirePlatformLock(env: Env, name: string, holder: string, ttlMs: number): Promise<boolean> {
  const now = Date.now();
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare("DELETE FROM platform_locks WHERE name=? AND expires_at<?").bind(name, now),
    env.CONTROL_DB.prepare("INSERT OR IGNORE INTO platform_locks (name,holder,expires_at) VALUES (?,?,?)")
      .bind(name, holder, now + ttlMs),
  ]);
  const row = await env.CONTROL_DB.prepare("SELECT holder FROM platform_locks WHERE name=?")
    .bind(name).first<{ holder: string }>();
  return row?.holder === holder;
}

async function releasePlatformLock(env: Env, name: string, holder: string): Promise<void> {
  await env.CONTROL_DB.prepare("DELETE FROM platform_locks WHERE name=? AND holder=?").bind(name, holder).run();
}

async function handleCreateApp(req: Request, env: Env, principal: Principal): Promise<Response> {
  const holder = `create-${randomHex(12)}`;
  if (!(await acquirePlatformLock(env, "domains", holder, 10 * 60_000))) {
    return json({ error: "platform deployment in progress; retry shortly" }, 503, { "retry-after": "10" });
  }
  try {
    return await handleCreateAppLocked(req, env, principal);
  } finally {
    await releasePlatformLock(env, "domains", holder).catch((error) => console.error("lock release failed", error));
  }
}

async function handleCreateAppLocked(req: Request, env: Env, principal: Principal): Promise<Response> {
  let body: { slug?: string; name?: string; description?: string; visibility?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid body" }, 400);
  }
  if (!validSlug(body.slug)) return json({ error: "slug must be 3-48 lowercase letters, numbers, and hyphens" }, 400);
  const name = String(body.name || body.slug).trim().slice(0, 100);
  const description = String(body.description || "").trim().slice(0, 500);
  const visibility = body.visibility || "team";
  if (!name || !["private", "team", "public"].includes(visibility)) return json({ error: "invalid app" }, 400);
  const owned = await env.CONTROL_DB.prepare(
    "SELECT COUNT(*) count FROM apps WHERE owner_id=? AND archived_at IS NULL",
  ).bind(principal.user.id).first<{ count: number }>();
  if (Number(owned?.count || 0) >= 25) return json({ error: "app quota reached (25)" }, 429);

  const id = randomHex(12);
  const now = Date.now();
  const workerName = `app-${id}`;
  try {
    await env.CONTROL_DB.prepare(
      `INSERT INTO apps (id,slug,name,description,owner_id,visibility,worker_name,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).bind(id, body.slug, name, description, principal.user.id, visibility, workerName, now, now).run();
  } catch (error) {
    return json({ error: String(error).includes("UNIQUE") ? "slug already exists" : "could not create app" }, 409);
  }

  let customDomain: { id: string } | null = null;
  try {
    customDomain = await attachCustomDomain(env, `${body.slug}.apps.myslop.app`);
    await env.CONTROL_DB.prepare("UPDATE apps SET custom_domain_id=? WHERE id=?")
      .bind(customDomain.id, id).run();
  } catch (error) {
    if (customDomain) await deleteCustomDomain(env, customDomain.id).catch((cleanup) => recordOrphan(env, "domain", customDomain!.id, id, cleanup));
    await env.CONTROL_DB.prepare("DELETE FROM apps WHERE id=?").bind(id).run();
    return json({ error: `domain provisioning failed: ${error instanceof Error ? error.message : error}` }, 502);
  }

  const app = await getAppById(env, id);
  await audit(env, principal.user.id, "app.created", id, { slug: body.slug });
  return json({ app: publicApp(app!) }, 201);
}

async function ensureCapabilities(env: Env, app: AppRow, manifest: ResolvedManifest): Promise<AppRow> {
  let current = app;
  if (manifest.capabilities.database && !current.d1_id) {
    const name = `myslop-app-${app.id.slice(0, 12)}`;
    const database = await createD1(env, name);
    try {
      await env.CONTROL_DB.prepare("UPDATE apps SET d1_id=?,d1_name=? WHERE id=? AND d1_id IS NULL")
        .bind(database.uuid, database.name, app.id).run();
    } catch (error) {
      await deleteD1(env, database.uuid).catch((cleanup) => recordOrphan(env, "d1", database.uuid, app.id, cleanup));
      throw error;
    }
    current = (await getAppById(env, app.id))!;
  }
  if (manifest.capabilities.files && !current.r2_bucket) {
    const bucket = `myslop-app-${app.id.slice(0, 12)}`;
    await createR2Bucket(env, bucket);
    try {
      await env.CONTROL_DB.prepare("UPDATE apps SET r2_bucket=? WHERE id=? AND r2_bucket IS NULL")
        .bind(bucket, app.id).run();
    } catch (error) {
      await deleteR2Bucket(env, bucket).catch((cleanup) => recordOrphan(env, "r2", bucket, app.id, cleanup));
      throw error;
    }
    current = (await getAppById(env, app.id))!;
  }
  return current;
}

const RESOURCE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

async function scheduleUnusedResources(env: Env, app: AppRow, manifest: ResolvedManifest): Promise<void> {
  const deleteAfter = Date.now() + RESOURCE_GRACE_MS;
  await env.CONTROL_DB.prepare(
    `UPDATE apps SET
       d1_delete_after=CASE
         WHEN ? THEN NULL
         WHEN d1_id IS NOT NULL AND d1_delete_after IS NULL THEN ?
         ELSE d1_delete_after END,
       r2_delete_after=CASE
         WHEN ? THEN NULL
         WHEN r2_bucket IS NOT NULL AND r2_delete_after IS NULL THEN ?
         ELSE r2_delete_after END
     WHERE id=?`,
  ).bind(
    manifest.capabilities.database ? 1 : 0,
    deleteAfter,
    manifest.capabilities.files ? 1 : 0,
    deleteAfter,
    app.id,
  ).run();
}

async function emptyAppBucket(env: Env, app: AppRow): Promise<void> {
  if (!app.r2_bucket) return;
  const workerName = `cleanup-${app.id}-${randomHex(6)}`;
  const manifest: ResolvedManifest = {
    version: 1,
    assets: false,
    worker: true,
    capabilities: { database: false, files: true, secrets: [], network: [], email: false, schedules: [], durableObjects: [] },
  };
  const source = `export default { async fetch(_request, env) {
    for (let page = 0; page < 400; page++) {
      const listed = await env.FILES.list({ limit: 1000 });
      const keys = listed.objects.map((object) => object.key);
      if (!keys.length) return Response.json({ deleted: true });
      await env.FILES.delete(keys);
    }
    return Response.json({ error: "bucket cleanup limit exceeded" }, { status: 507 });
  } }`;
  await uploadUserWorker(env, { app, workerName, manifest, source });
  try {
    const worker = env.DISPATCHER.get(workerName, {}, {
      limits: { cpuMs: 30_000, subRequests: 1_000 },
      outbound: { policy: { appId: app.id, hosts: [] } },
    });
    const response = await worker.fetch(new Request("https://cleanup.myslop.internal/"));
    if (!response.ok) throw new Error(`file cleanup failed: ${await response.text()}`);
  } finally {
    await deleteUserWorker(env, workerName).catch((error) => recordOrphan(env, "worker", workerName, app.id, error));
  }
}

async function deleteAppAssets(env: Env, appId: string): Promise<void> {
  const prefix = `apps/${appId}/`;
  for (let page = 0; page < 1000; page++) {
    const listed = await env.ASSETS.list({ prefix, limit: 1000 });
    const keys = listed.objects.map((object) => object.key);
    if (!keys.length) return;
    await env.ASSETS.delete(keys);
  }
  throw new Error("asset cleanup limit exceeded");
}

async function removeDatabase(env: Env, app: AppRow): Promise<void> {
  if (!app.d1_id) return;
  await deleteD1(env, app.d1_id);
  await env.CONTROL_DB.prepare(
    "UPDATE apps SET d1_id=NULL,d1_name=NULL,d1_delete_after=NULL WHERE id=? AND d1_id=?",
  ).bind(app.id, app.d1_id).run();
}

async function removeFileStorage(env: Env, app: AppRow): Promise<void> {
  if (!app.r2_bucket) return;
  await emptyAppBucket(env, app);
  await deleteR2Bucket(env, app.r2_bucket);
  await env.CONTROL_DB.prepare(
    "UPDATE apps SET r2_bucket=NULL,r2_delete_after=NULL WHERE id=? AND r2_bucket=?",
  ).bind(app.id, app.r2_bucket).run();
}

async function applyMigrations(env: Env, app: AppRow, version: number, migrations: MigrationInput[]) {
  if (!app.d1_id) throw new Error("database not provisioned");
  await runD1Sql(env, app.d1_id, `CREATE TABLE IF NOT EXISTS _myslop_migrations (
    name TEXT PRIMARY KEY,
    hash TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);
  for (const migration of migrations) {
    if (!migration || !safeAssetPath(migration.name) || !migration.name.endsWith(".sql")) throw new Error("invalid migration name");
    const sql = migration.sql;
    if (typeof sql !== "string" || !sql.trim() || sql.length > 500_000) throw new Error("invalid migration SQL");
    const hash = await sha256Hex(sql);
    const [existing] = await queryD1<{ hash: string }>(
      env,
      app.d1_id,
      "SELECT hash FROM _myslop_migrations WHERE name=?",
      [migration.name],
    );
    if (existing && existing.hash !== hash) throw new Error(`migration ${migration.name} changed after it was applied`);
    const controlExisting = await env.CONTROL_DB.prepare(
      "SELECT hash,applied_at FROM app_migrations WHERE app_id=? AND name=?",
    ).bind(app.id, migration.name).first<{ hash: string; applied_at: number }>();
    if (!existing && controlExisting?.hash === hash) {
      await runD1Batch(env, app.d1_id, [{
        sql: "INSERT OR IGNORE INTO _myslop_migrations (name,hash,applied_at) VALUES (?,?,?)",
        params: [migration.name, hash, controlExisting.applied_at],
      }]);
    } else if (!existing) {
      const appliedAt = Date.now();
      await runD1Batch(env, app.d1_id, [
        { sql },
        { sql: "INSERT INTO _myslop_migrations (name,hash,applied_at) VALUES (?,?,?)", params: [migration.name, hash, appliedAt] },
      ]);
    }
    await env.CONTROL_DB.prepare(
      `INSERT INTO app_migrations (app_id,name,hash,version,applied_at) VALUES (?,?,?,?,?)
       ON CONFLICT(app_id,name) DO UPDATE SET hash=excluded.hash,version=excluded.version,applied_at=excluded.applied_at`,
    ).bind(app.id, migration.name, hash, version, Date.now()).run();
  }
}

async function withAppOperationLock(
  env: Env,
  appId: string,
  operation: () => Promise<Response>,
): Promise<Response> {
  const name = `app-operation:${appId}`;
  const holder = randomHex(12);
  if (!(await acquirePlatformLock(env, name, holder, 60 * 60_000))) {
    return json({ error: "another deployment, rollback, or secret update is in progress" }, 409, { "retry-after": "10" });
  }
  try {
    return await operation();
  } finally {
    await releasePlatformLock(env, name, holder).catch((error) => console.error("app lock release failed", error));
  }
}

async function handleDeploy(req: Request, env: Env, principal: Principal, app: AppRow): Promise<Response> {
  return withAppOperationLock(env, app.id, () => handleDeployLocked(req, env, principal, app));
}

async function handleDeployLocked(req: Request, env: Env, principal: Principal, app: AppRow): Promise<Response> {
  let body: DeployInput;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid deployment body" }, 400);
  }
  const assets = body.assets ?? [];
  const migrations = body.migrations ?? [];
  if (!Array.isArray(assets) || assets.length > 500 || !Array.isArray(migrations) || migrations.length > 100) {
    return json({ error: "deployment exceeds file or migration limits" }, 413);
  }
  const migrationNames = migrations.map((migration) => migration?.name);
  if (new Set(migrationNames).size !== migrationNames.length) return json({ error: "migration names must be unique" }, 400);
  migrations.sort((left, right) => String(left?.name).localeCompare(String(right?.name)));
  let manifest: ResolvedManifest;
  try {
    manifest = parseResolvedManifest(body.manifest);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "invalid deployment manifest" }, 400);
  }
  if (manifest.assets !== (assets.length > 0) || manifest.worker !== Boolean(body.worker)) {
    return json({ error: "deployment contents do not match the resolved manifest" }, 400);
  }
  if (manifest.capabilities.email) {
    if (!isPlatformOwner(principal)) return json({ error: "platform owner required for email capability" }, 403);
    const existing = await env.CONTROL_DB.prepare(
      `SELECT a.slug FROM apps a JOIN deployments d ON d.app_id=a.id AND d.version=a.active_version AND d.status='active'
       WHERE a.id!=? AND a.archived_at IS NULL AND json_extract(d.manifest_json,'$.capabilities.email')=1 LIMIT 1`,
    ).bind(app.id).first<{ slug: string }>();
    if (existing) return json({ error: `email capability is already owned by ${existing.slug}` }, 409);
  }
  if (migrations.length && !manifest.capabilities.database) {
    return json({ error: "migrations require the database capability" }, 400);
  }
  if (!assets.length && !body.worker) return json({ error: "deployment needs assets or a Worker" }, 400);
  if (body.worker && body.worker.length > 2_000_000) return json({ error: "worker exceeds 2 MB" }, 413);
  if (manifest.capabilities.secrets.length) {
    const { results } = await env.CONTROL_DB.prepare("SELECT name FROM app_secrets WHERE app_id=?")
      .bind(app.id).all<{ name: string }>();
    const available = new Set(results.map((row) => row.name));
    const missing = manifest.capabilities.secrets.filter((name) => !available.has(name));
    if (missing.length) return json({ error: `required secrets are missing: ${missing.join(", ")}`, requiredSecrets: missing }, 409);
  }
  await env.CONTROL_DB.prepare("UPDATE deployments SET status='failed' WHERE app_id=? AND status='pending' AND created_at<?")
    .bind(app.id, Date.now() - 15 * 60_000).run();
  const count = await env.CONTROL_DB.prepare("SELECT COUNT(*) count FROM deployments WHERE app_id=? AND status!='failed'")
    .bind(app.id).first<{ count: number }>();
  if (Number(count?.count || 0) >= 100) return json({ error: "deployment quota reached (100 successful or pending versions)" }, 429);

  let totalBytes = 0;
  const decoded: { path: string; type: string; bytes: Uint8Array }[] = [];
  try {
    for (const asset of assets) {
      if (!safeAssetPath(asset.path) || typeof asset.data !== "string") throw new Error("invalid asset path or data");
      const bytes = decodeBase64(asset.data);
      totalBytes += bytes.byteLength;
      if (totalBytes > 10_000_000) throw new Error("assets exceed 10 MB");
      decoded.push({ path: asset.path, type: asset.contentType || contentType(asset.path), bytes });
    }
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "invalid assets" }, 400);
  }

  const deploymentId = randomHex(12);
  const now = Date.now();
  try {
    await env.CONTROL_DB.prepare(
      `INSERT INTO deployments (id,app_id,version,asset_prefix,manifest_json,status,created_by,created_at)
       SELECT ?,?,COALESCE(MAX(version),0)+1,'',?,'pending',?,? FROM deployments WHERE app_id=?`,
    ).bind(deploymentId, app.id, JSON.stringify(manifest), principal.user.id, now, app.id).run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: message.includes("quota") ? "deployment quota reached" : "could not reserve deployment" }, message.includes("quota") ? 429 : 409);
  }
  const reserved = await env.CONTROL_DB.prepare("SELECT * FROM deployments WHERE id=?")
    .bind(deploymentId).first<DeploymentRow>();
  if (!reserved) return json({ error: "could not reserve deployment" }, 500);
  const version = reserved.version;
  const prefix = `apps/${app.id}/versions/${version}-${deploymentId}`;
  const workerKey = body.worker ? `${prefix}/worker.mjs` : null;
  const workerName = body.worker ? `app-${app.id}-v${version}-${deploymentId.slice(0, 8)}` : null;
  await env.CONTROL_DB.prepare(
    "UPDATE deployments SET asset_prefix=?,worker_key=?,worker_name=? WHERE id=? AND status='pending'",
  ).bind(prefix, workerKey, workerName, deploymentId).run();

  try {
    const runtimeApp = await ensureCapabilities(env, app, manifest);
    if (migrations.length) await applyMigrations(env, runtimeApp, version, migrations);
    await Promise.all(decoded.map((asset) => env.ASSETS.put(`${prefix}/${asset.path}`, asset.bytes, {
      httpMetadata: { contentType: asset.type },
    })));
    if (body.worker) {
      await env.ASSETS.put(workerKey!, body.worker, { httpMetadata: { contentType: "application/javascript" } });
      const secrets = await loadAppSecrets(env, app.id, manifest.capabilities.secrets);
      await uploadUserWorker(env, { source: body.worker, app: runtimeApp, workerName: workerName!, manifest, secrets });
    }
    const activated = await env.CONTROL_DB.batch([
      env.CONTROL_DB.prepare(
        `UPDATE deployments SET asset_prefix=?,worker_key=?,worker_name=?,worker_sha256=?,status='active'
         WHERE id=? AND status='pending'`,
      ).bind(prefix, workerKey, workerName, body.worker ? await sha256Hex(body.worker) : null, deploymentId),
      env.CONTROL_DB.prepare(
        `UPDATE apps SET
           active_version=?,
           updated_at=?,
           d1_delete_after=CASE WHEN ? THEN NULL WHEN d1_id IS NOT NULL AND d1_delete_after IS NULL THEN ? ELSE d1_delete_after END,
           r2_delete_after=CASE WHEN ? THEN NULL WHEN r2_bucket IS NOT NULL AND r2_delete_after IS NULL THEN ? ELSE r2_delete_after END
         WHERE id=? AND EXISTS (SELECT 1 FROM deployments WHERE id=? AND status='active')`,
      ).bind(
        version,
        Date.now(),
        manifest.capabilities.database ? 1 : 0,
        Date.now() + RESOURCE_GRACE_MS,
        manifest.capabilities.files ? 1 : 0,
        Date.now() + RESOURCE_GRACE_MS,
        app.id,
        deploymentId,
      ),
    ]);
    if (!activated[0].meta.changes) throw new Error("deployment reservation expired before activation");
    await reconcileAppSchedules(env, app.id, manifest.capabilities.schedules);
    await env.CONTROL_DB.prepare("DELETE FROM app_durable_objects WHERE app_id=? AND version=?").bind(app.id, version).run();
    if (manifest.capabilities.durableObjects.length) {
      await env.CONTROL_DB.batch(manifest.capabilities.durableObjects.map(({ binding, className }) =>
        env.CONTROL_DB.prepare(
          "INSERT INTO app_durable_objects (app_id,version,binding,class_name,created_at) VALUES (?,?,?,?,?)",
        ).bind(app.id, version, binding, className, Date.now()),
      ));
    }
    await audit(env, principal.user.id, "app.deployed", app.id, { version, manifest });
    return json({ deployment: { id: deploymentId, version, url: appUrl(app.slug), assets: assets.length, manifest } }, 201);
  } catch (error) {
    if (workerName) await deleteUserWorker(env, workerName).catch((cleanup) => recordOrphan(env, "worker", workerName, app.id, cleanup));
    await env.CONTROL_DB.prepare("UPDATE deployments SET status='failed' WHERE id=?").bind(deploymentId).run().catch(() => undefined);
    const current = await getAppById(env, app.id).catch(() => null);
    if (current) {
      const desired = await activeManifest(env, current).catch(() => null);
      const fallback: ResolvedManifest = desired ?? {
        version: 1,
        assets: false,
        worker: false,
        capabilities: { database: false, files: false, secrets: [], network: [], email: false, schedules: [], durableObjects: [] },
      };
      await scheduleUnusedResources(env, current, fallback).catch((cleanup) => console.error("failed resource scheduling failed", cleanup));
    }
    return json({ error: `deployment failed: ${error instanceof Error ? error.message : error}` }, 502);
  }
}

async function rebindDeploymentSecrets(env: Env, app: AppRow, deployment: DeploymentRow): Promise<void> {
  if (!deployment.worker_key || !deployment.worker_name) return;
  const manifest = parseResolvedManifest(JSON.parse(deployment.manifest_json));
  const source = await env.ASSETS.get(deployment.worker_key);
  if (!source) throw new Error("Worker source is missing");
  const secrets = await loadAppSecrets(env, app.id, manifest.capabilities.secrets);
  await uploadUserWorker(env, {
    app,
    workerName: deployment.worker_name,
    source: await source.text(),
    manifest,
    secrets,
  });
}

async function handleRollback(req: Request, env: Env, principal: Principal, app: AppRow): Promise<Response> {
  return withAppOperationLock(env, app.id, () => handleRollbackLocked(req, env, principal, app));
}

async function handleRollbackLocked(req: Request, env: Env, principal: Principal, app: AppRow): Promise<Response> {
  let version: number;
  try {
    version = Number(((await req.json()) as { version?: number }).version);
  } catch {
    return json({ error: "invalid body" }, 400);
  }
  const deployment = await env.CONTROL_DB.prepare(
    "SELECT * FROM deployments WHERE app_id=? AND version=?",
  ).bind(app.id, version).first<DeploymentRow>();
  if (!deployment || deployment.status !== "active") return json({ error: "deployment not found" }, 404);
  const manifest = parseResolvedManifest(JSON.parse(deployment.manifest_json));
  if (manifest.capabilities.database && !app.d1_id) return json({ error: "this version's database has been deleted" }, 409);
  if (manifest.capabilities.files && !app.r2_bucket) return json({ error: "this version's file storage has been deleted" }, 409);
  try {
    await rebindDeploymentSecrets(env, app, deployment);
    await env.CONTROL_DB.prepare("UPDATE apps SET active_version=?,updated_at=? WHERE id=?")
      .bind(version, Date.now(), app.id).run();
    await scheduleUnusedResources(env, app, manifest);
    await audit(env, principal.user.id, "app.rolled_back", app.id, { version });
    return json({ ok: true, version, url: appUrl(app.slug) });
  } catch (error) {
    return json({ error: `rollback failed: ${error instanceof Error ? error.message : error}` }, 502);
  }
}

async function handleSetSecret(req: Request, env: Env, principal: Principal, app: AppRow, name: string): Promise<Response> {
  return withAppOperationLock(env, app.id, () => handleSetSecretLocked(req, env, principal, app, name));
}

async function handleSetSecretLocked(req: Request, env: Env, principal: Principal, app: AppRow, name: string): Promise<Response> {
  if (!validBindingName(name)) return json({ error: "secret name must be an uppercase, non-reserved binding name" }, 400);
  let value = "";
  try {
    value = String(((await req.json()) as { value?: string }).value || "");
  } catch {
    return json({ error: "invalid body" }, 400);
  }
  if (!value || value.length > 100_000) return json({ error: "invalid secret value" }, 400);
  try {
    const encrypted = await encryptSecret(env, value);
    await env.CONTROL_DB.prepare(
      `INSERT INTO app_secrets (app_id,name,ciphertext,iv,updated_by,updated_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT(app_id,name) DO UPDATE SET ciphertext=excluded.ciphertext,iv=excluded.iv,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,
    ).bind(app.id, name, encrypted.ciphertext, encrypted.iv, principal.user.id, Date.now()).run();

    for (let attempt = 0; attempt < 3; attempt++) {
      const freshApp = await getAppById(env, app.id);
      if (!freshApp?.active_version) break;
      const deployment = await env.CONTROL_DB.prepare(
        "SELECT * FROM deployments WHERE app_id=? AND version=? AND status='active'",
      ).bind(app.id, freshApp.active_version).first<DeploymentRow>();
      if (!deployment) break;
      const manifest = parseResolvedManifest(JSON.parse(deployment.manifest_json));
      if (!manifest.capabilities.secrets.includes(name)) break;
      await rebindDeploymentSecrets(env, freshApp, deployment);
      const after = await getAppById(env, app.id);
      if (after?.active_version === freshApp.active_version) break;
    }
    await audit(env, principal.user.id, "secret.updated", app.id, { name });
    return json({ ok: true, name });
  } catch (error) {
    return json({ error: `secret update failed: ${error instanceof Error ? error.message : error}` }, 502);
  }
}

async function activeManifest(env: Env, app: AppRow): Promise<ResolvedManifest | null> {
  if (!app.active_version) return null;
  const deployment = await env.CONTROL_DB.prepare(
    "SELECT manifest_json FROM deployments WHERE app_id=? AND version=? AND status='active'",
  ).bind(app.id, app.active_version).first<{ manifest_json: string }>();
  return deployment ? parseResolvedManifest(JSON.parse(deployment.manifest_json)) : null;
}

async function handlePruneApp(req: Request, env: Env, principal: Principal, app: AppRow): Promise<Response> {
  if (!canDestroy(app, principal)) return json({ error: "only an app or platform owner can delete stored resources" }, 403);
  const body = await req.json().catch(() => ({})) as { confirm?: string };
  if (body.confirm !== app.slug) return json({ error: `confirm pruning with {\"confirm\":\"${app.slug}\"}` }, 400);
  return withAppOperationLock(env, app.id, async () => {
    const current = await getAppById(env, app.id);
    if (!current) return json({ error: "app not found" }, 404);
    const manifest = await activeManifest(env, current) ?? {
      version: 1,
      assets: false,
      worker: false,
      capabilities: { database: false, files: false, secrets: [], network: [], email: false, schedules: [], durableObjects: [] },
    } satisfies ResolvedManifest;
    const removed: string[] = [];
    if (!manifest.capabilities.files && current.r2_bucket) {
      await removeFileStorage(env, current);
      removed.push("files");
    }
    const afterFiles = (await getAppById(env, app.id)) ?? current;
    if (!manifest.capabilities.database && afterFiles.d1_id) {
      await removeDatabase(env, afterFiles);
      removed.push("database");
    }
    await audit(env, principal.user.id, "app.pruned", app.id, { removed });
    return json({ ok: true, removed });
  });
}

async function handleDestroyApp(req: Request, env: Env, principal: Principal, app: AppRow): Promise<Response> {
  if (!canDestroy(app, principal)) return json({ error: "only an app or platform owner can delete an app" }, 403);
  const body = await req.json().catch(() => ({})) as { confirm?: string };
  if (body.confirm !== app.slug) return json({ error: `confirm deletion with {\"confirm\":\"${app.slug}\"}` }, 400);
  return withAppOperationLock(env, app.id, async () => {
    const current = await getAppById(env, app.id);
    if (!current) return json({ ok: true, archived: app.slug });
    const now = Date.now();
    const recoveryUntil = now + RESOURCE_GRACE_MS;
    await env.CONTROL_DB.prepare(
      `UPDATE apps SET archived_at=?,updated_at=?,d1_delete_after=CASE WHEN d1_id IS NULL THEN NULL ELSE ? END,
       r2_delete_after=CASE WHEN r2_bucket IS NULL THEN NULL ELSE ? END WHERE id=? AND archived_at IS NULL`,
    ).bind(now, now, recoveryUntil, recoveryUntil, app.id).run();
    await audit(env, principal.user.id, "app.archived", app.id, { slug: app.slug, recoveryUntil });
    return json({ ok: true, archived: app.slug, recoveryUntil });
  });
}

async function purgeArchivedApp(env: Env, app: AppRow): Promise<void> {
  const domainHolder = `destroy-${randomHex(12)}`;
  if (!(await acquirePlatformLock(env, "domains", domainHolder, 60 * 60_000))) throw new Error("platform domain lock is busy");
  try {
    const { results: deployments } = await env.CONTROL_DB.prepare(
      "SELECT worker_name FROM deployments WHERE app_id=? AND worker_name IS NOT NULL",
    ).bind(app.id).all<{ worker_name: string }>();
    const workerNames = new Set(deployments.map((row) => row.worker_name));
    if (app.worker_name) workerNames.add(app.worker_name);
    for (const workerName of workerNames) await deleteUserWorker(env, workerName);
    if (app.r2_bucket) await removeFileStorage(env, app);
    const afterFiles = (await getAppIncludingArchived(env, app.id)) ?? app;
    if (afterFiles.d1_id) await removeDatabase(env, afterFiles);
    await deleteAppAssets(env, app.id);
    const domains = await env.CONTROL_DB.prepare("SELECT cloudflare_id FROM app_domains WHERE app_id=? AND cloudflare_id IS NOT NULL")
      .bind(app.id).all<{ cloudflare_id: string }>();
    for (const domain of domains.results) await deleteCustomDomain(env, domain.cloudflare_id);
    if (app.custom_domain_id) await deleteCustomDomain(env, app.custom_domain_id);
    await audit(env, "system", "app.deleted", app.id, { slug: app.slug });
    await env.CONTROL_DB.batch([
      env.CONTROL_DB.prepare("DELETE FROM app_members WHERE app_id=?").bind(app.id),
      env.CONTROL_DB.prepare("DELETE FROM app_secrets WHERE app_id=?").bind(app.id),
      env.CONTROL_DB.prepare("DELETE FROM app_migrations WHERE app_id=?").bind(app.id),
      env.CONTROL_DB.prepare("DELETE FROM deployments WHERE app_id=?").bind(app.id),
      env.CONTROL_DB.prepare("DELETE FROM tokens WHERE app_id=?").bind(app.id),
      env.CONTROL_DB.prepare("DELETE FROM apps WHERE id=?").bind(app.id),
    ]);
  } finally {
    await releasePlatformLock(env, "domains", domainHolder).catch((error) => console.error("domain lock release failed", error));
  }
}

async function handleAdoptResources(req: Request, env: Env, principal: Principal, app: AppRow): Promise<Response> {
  if (!isPlatformOwner(principal)) return json({ error: "platform owner required" }, 403);
  const body = await req.json().catch(() => null) as {
    database?: { id?: string; name?: string };
    files?: { bucket?: string };
    bucket?: { name?: string };
  } | null;
  const bucketName = body?.files?.bucket ?? body?.bucket?.name;
  if (!body || (!body.database && !bucketName)) return json({ error: "database or files.bucket is required" }, 400);
  if (body.database && app.d1_id) return json({ error: "app already has a database" }, 409);
  if (bucketName && app.r2_bucket) return json({ error: "app already has a bucket" }, 409);
  let database: { uuid: string; name: string } | null = null;
  let bucket: { name: string } | null = null;
  try {
    if (body.database) {
      if (!body.database.id) return json({ error: "database.id is required" }, 400);
      database = await getD1(env, body.database.id);
      if (body.database.name && body.database.name !== database.name) return json({ error: "database name does not match id" }, 409);
    }
    if (bucketName) bucket = await getR2Bucket(env, bucketName);
    await env.CONTROL_DB.prepare(
      `UPDATE apps SET
       d1_id=COALESCE(?,d1_id),d1_name=COALESCE(?,d1_name),d1_adopted=CASE WHEN ? IS NULL THEN d1_adopted ELSE 1 END,
       r2_bucket=COALESCE(?,r2_bucket),r2_adopted=CASE WHEN ? IS NULL THEN r2_adopted ELSE 1 END,updated_at=?
       WHERE id=?`,
    ).bind(database?.uuid ?? null, database?.name ?? null, database?.uuid ?? null, bucket?.name ?? null, bucket?.name ?? null, Date.now(), app.id).run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: message.includes("UNIQUE") ? "resource is already attached to another app" : `resource adoption failed: ${message}` }, 409);
  }
  await audit(env, principal.user.id, "app.resources.adopted", app.id, { database, bucket });
  return json({ app: publicApp((await getAppById(env, app.id))!) });
}

async function handleAddDomain(req: Request, env: Env, principal: Principal, app: AppRow): Promise<Response> {
  if (!isPlatformOwner(principal)) return json({ error: "platform owner required" }, 403);
  const body = await req.json().catch(() => null) as { hostname?: string } | null;
  let hostname: string;
  try {
    hostname = normalizeAppDomain(body?.hostname ?? "");
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
  const now = Date.now();
  try {
    await env.CONTROL_DB.prepare(
      "INSERT INTO app_domains (hostname,app_id,status,created_at,updated_at) VALUES (?,?,'pending',?,?)",
    ).bind(hostname, app.id, now, now).run();
  } catch {
    const existing = await env.CONTROL_DB.prepare("SELECT app_id,status FROM app_domains WHERE hostname=?").bind(hostname).first<{ app_id: string; status: string }>();
    if (existing?.app_id === app.id && existing.status === "active") return json({ hostname, status: "active" });
    return json({ error: "domain is already claimed" }, 409);
  }
  try {
    const domain = await attachCustomDomain(env, hostname);
    await env.CONTROL_DB.prepare(
      "UPDATE app_domains SET cloudflare_id=?,status='active',error=NULL,updated_at=? WHERE hostname=? AND app_id=?",
    ).bind(domain.id, Date.now(), hostname, app.id).run();
    await audit(env, principal.user.id, "app.domain.attached", app.id, { hostname });
    return json({ hostname, status: "active" }, 201);
  } catch (error) {
    await env.CONTROL_DB.prepare("UPDATE app_domains SET status='error',error=?,updated_at=? WHERE hostname=?")
      .bind(error instanceof Error ? error.message : String(error), Date.now(), hostname).run();
    return json({ error: `domain attachment failed: ${error instanceof Error ? error.message : error}` }, 502);
  }
}

async function handleDeleteDomain(env: Env, principal: Principal, app: AppRow, hostnameInput: string): Promise<Response> {
  if (!isPlatformOwner(principal)) return json({ error: "platform owner required" }, 403);
  let hostname: string;
  try {
    hostname = normalizeAppDomain(hostnameInput);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
  const row = await env.CONTROL_DB.prepare("SELECT cloudflare_id FROM app_domains WHERE hostname=? AND app_id=?")
    .bind(hostname, app.id).first<{ cloudflare_id: string | null }>();
  if (!row) return json({ error: "domain not found" }, 404);
  await env.CONTROL_DB.prepare("UPDATE app_domains SET status='deleting',updated_at=? WHERE hostname=?").bind(Date.now(), hostname).run();
  try {
    if (row.cloudflare_id) await deleteCustomDomain(env, row.cloudflare_id);
    await env.CONTROL_DB.prepare("DELETE FROM app_domains WHERE hostname=? AND app_id=?").bind(hostname, app.id).run();
    await audit(env, principal.user.id, "app.domain.detached", app.id, { hostname });
    return json({ ok: true });
  } catch (error) {
    await env.CONTROL_DB.prepare("UPDATE app_domains SET status='error',error=?,updated_at=? WHERE hostname=?")
      .bind(error instanceof Error ? error.message : String(error), Date.now(), hostname).run();
    return json({ error: `domain detachment failed: ${error instanceof Error ? error.message : error}` }, 502);
  }
}

interface ReconcileInput {
  sourceHash?: string;
  app?: { name?: string; description?: string; visibility?: AppRow["visibility"]; domains?: string[] };
  resources?: { database?: { id?: string; name?: string }; bucket?: { name?: string } };
  deployment?: DeployInput;
}

async function handleReconcileApp(
  req: Request,
  env: Env,
  principal: Principal,
  slug: string,
): Promise<Response> {
  if (!isPlatformOwner(principal)) return json({ error: "platform owner required" }, 403);
  if (!validSlug(slug)) return json({ error: "invalid app slug" }, 400);
  if (req.method === "DELETE") {
    const body = await req.json().catch(() => ({})) as { confirm?: string };
    const app = await getAppBySlug(env, slug);
    if (!app) return json({ ok: true, deleted: slug });
    if (app.managed_by !== "git") return json({ error: "refusing to delete a manually managed app" }, 409);
    if (body.confirm !== slug) return json({ error: `confirm deletion with {"confirm":"${slug}"}` }, 400);
    return handleDestroyApp(new Request(req.url, { method: "DELETE", body: JSON.stringify(body) }), env, principal, app);
  }
  if (req.method !== "PUT") return json({ error: "method not allowed" }, 405);
  const body = await req.json().catch(() => null) as ReconcileInput | null;
  if (!body?.sourceHash || !/^[a-f0-9]{64}$/.test(body.sourceHash) || !body.deployment) {
    return json({ error: "sourceHash and deployment are required" }, 400);
  }
  let app = await getAppBySlugIncludingArchived(env, slug);
  if (app?.archived_at) {
    if (Date.now() - app.archived_at >= RESOURCE_GRACE_MS) return json({ error: "app recovery window has expired" }, 410);
    await env.CONTROL_DB.prepare(
      "UPDATE apps SET archived_at=NULL,d1_delete_after=NULL,r2_delete_after=NULL,updated_at=? WHERE id=?",
    ).bind(Date.now(), app.id).run();
    await audit(env, principal.user.id, "app.restored", app.id, { source: "git reconciliation" });
    app = await getAppById(env, app.id);
  }
  if (!app) {
    const created = await handleCreateApp(
      new Request(req.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug,
          name: body.app?.name || slug,
          description: body.app?.description || "",
          visibility: body.app?.visibility || "team",
        }),
      }),
      env,
      principal,
    );
    if (!created.ok) return created;
    app = await getAppBySlug(env, slug);
    if (!app) return json({ error: "created app could not be loaded" }, 500);
    await env.CONTROL_DB.prepare("UPDATE apps SET managed_by='git' WHERE id=?").bind(app.id).run();
    app = (await getAppById(env, app.id))!;
  } else if (app.managed_by !== "git") {
    return json({ error: "slug belongs to a manually managed app" }, 409);
  }

  return withAppOperationLock(env, app.id, async () => {
    const current = await getAppById(env, app!.id);
    if (!current) return json({ error: "app not found" }, 404);
    const visibility = body.app?.visibility ?? current.visibility;
    if (!["private", "team", "public"].includes(visibility)) return json({ error: "invalid visibility" }, 400);
    await env.CONTROL_DB.prepare(
      "UPDATE apps SET name=?,description=?,visibility=?,updated_at=? WHERE id=?",
    ).bind(
      String(body.app?.name || current.name).trim().slice(0, 100),
      String(body.app?.description ?? current.description).trim().slice(0, 500),
      visibility,
      Date.now(),
      current.id,
    ).run();

    let refreshed = (await getAppById(env, current.id))!;
    if (body.resources && ((!refreshed.d1_id && body.resources.database) || (!refreshed.r2_bucket && body.resources.bucket))) {
      const adopted = await handleAdoptResources(
        new Request(req.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body.resources) }),
        env,
        principal,
        refreshed,
      );
      if (!adopted.ok) return adopted;
      refreshed = (await getAppById(env, current.id))!;
    }

    if (body.app?.domains !== undefined) {
      const desiredDomains = new Set(body.app.domains.map(normalizeAppDomain));
      const domainRows = await env.CONTROL_DB.prepare("SELECT hostname FROM app_domains WHERE app_id=?").bind(current.id).all<{ hostname: string }>();
      for (const hostname of desiredDomains) {
        if (domainRows.results.some((row) => row.hostname === hostname)) continue;
        const attached = await handleAddDomain(
          new Request(req.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hostname }) }),
          env,
          principal,
          refreshed,
        );
        if (!attached.ok) return attached;
      }
      for (const { hostname } of domainRows.results) {
        if (desiredDomains.has(hostname)) continue;
        const detached = await handleDeleteDomain(env, principal, refreshed, hostname);
        if (!detached.ok) return detached;
      }
    }

    if (refreshed.source_hash === body.sourceHash) {
      return json({ app: publicApp(refreshed), changed: false });
    }
    const deployed = await handleDeployLocked(
      new Request(req.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body.deployment),
      }),
      env,
      principal,
      refreshed,
    );
    if (!deployed.ok) return deployed;
    await env.CONTROL_DB.prepare("UPDATE apps SET source_hash=?,managed_by='git',updated_at=? WHERE id=?")
      .bind(body.sourceHash, Date.now(), refreshed.id).run();
    return json({ app: publicApp((await getAppById(env, refreshed.id))!), changed: true, deployment: await deployed.json() });
  });
}

async function handleApi(req: Request, env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
  if (url.pathname === "/api/session" && req.method === "POST") {
    const origin = req.headers.get("origin");
    if (origin !== "https://apps.myslop.app" && origin !== "http://localhost:8787") {
      return json({ error: "bad origin" }, 403);
    }
    return exchangeSession(req, env, ctx);
  }
  const principal = await authenticate(req, env);
  if (!principal) return json({ error: "unauthorized" }, 401);
  const csrf = ensureCsrf(req, principal);
  if (csrf) return csrf;

  if (principal.tokenId) {
    ctx.waitUntil(env.CONTROL_DB.prepare("UPDATE tokens SET last_used_at=? WHERE id=?").bind(Date.now(), principal.tokenId).run());
  }
  if (url.pathname === "/api/session" && req.method === "DELETE") return signOut(req, env);
  if (url.pathname === "/api/me" && req.method === "GET") return json({ user: principal.user });
  if (url.pathname === "/api/verify" && req.method === "GET") return json({ ok: true, user: principal.user, appId: principal.appId ?? null });
  const reconcileMatch = url.pathname.match(/^\/api\/reconcile\/apps\/([^/]+)$/);
  if (reconcileMatch) return handleReconcileApp(req, env, principal, decodeURIComponent(reconcileMatch[1]!));
  if (url.pathname === "/api/archived" && req.method === "GET") {
    const statement = isPlatformOwner(principal)
      ? env.CONTROL_DB.prepare("SELECT * FROM apps WHERE archived_at IS NOT NULL ORDER BY archived_at DESC")
      : env.CONTROL_DB.prepare("SELECT * FROM apps WHERE archived_at IS NOT NULL AND owner_id=? ORDER BY archived_at DESC").bind(principal.user.id);
    const archived = await statement.all<AppRow>();
    return json({ apps: archived.results.map((app) => ({ ...publicApp(app), archivedAt: app.archived_at, recoveryUntil: app.archived_at! + RESOURCE_GRACE_MS })) });
  }
  const restoreMatch = url.pathname.match(/^\/api\/archived\/([^/]+)\/restore$/);
  if (restoreMatch && req.method === "POST") {
    const app = await getAppIncludingArchived(env, decodeURIComponent(restoreMatch[1]!));
    if (!app?.archived_at || !canDestroy(app, principal)) return json({ error: "app not found" }, 404);
    const body = await req.json().catch(() => ({})) as { confirm?: string };
    if (body.confirm !== app.slug) return json({ error: `confirm recovery with {"confirm":"${app.slug}"}` }, 400);
    if (Date.now() - app.archived_at >= RESOURCE_GRACE_MS) return json({ error: "app recovery window has expired" }, 410);
    await env.CONTROL_DB.prepare(
      "UPDATE apps SET archived_at=NULL,d1_delete_after=NULL,r2_delete_after=NULL,updated_at=? WHERE id=?",
    ).bind(Date.now(), app.id).run();
    await audit(env, principal.user.id, "app.restored", app.id);
    return json({ app: publicApp((await getAppById(env, app.id))!) });
  }
  if (principal.appId) {
    const root = `/api/apps/${principal.appId}`;
    const scopedList = url.pathname === "/api/apps" && req.method === "GET";
    if (!scopedList && url.pathname !== root && !url.pathname.startsWith(`${root}/`)) {
      return json({ error: "token is scoped to one app" }, 403);
    }
  }

  if (url.pathname === "/api/apps" && req.method === "GET") {
    if (principal.appId) {
      const app = await getAppById(env, principal.appId);
      return json({ apps: app ? [await publicAppFor(env, app, principal)] : [] });
    }
    const { results } = await env.CONTROL_DB.prepare(
      `SELECT a.*,m.role AS current_role FROM apps a
       LEFT JOIN app_members m ON m.app_id=a.id AND m.user_id=?
       WHERE a.archived_at IS NULL AND (a.visibility IN ('team','public') OR a.owner_id=? OR m.user_id IS NOT NULL)
       ORDER BY a.updated_at DESC LIMIT 500`,
    ).bind(principal.user.id, principal.user.id).all<AppRow & { current_role: string | null }>();
    return json({ apps: results.map((app) => ({
      ...publicApp(app),
      permissions: {
        manage: isPlatformOwner(principal) || app.owner_id === principal.user.id || app.current_role === "editor",
        destroy: canDestroy(app, principal),
      },
    })) });
  }
  if (url.pathname === "/api/apps" && req.method === "POST") return handleCreateApp(req, env, principal);

  if (url.pathname === "/api/manage/apps" && req.method === "GET") {
    if (principal.tokenId) return json({ error: "session authentication required" }, 403);
    type ManagementRow = AppRow & {
      owner_name: string | null;
      owner_email: string | null;
      member_role: string | null;
      manifest_json: string | null;
    };
    const statement = isPlatformOwner(principal)
      ? env.CONTROL_DB.prepare(
        `SELECT a.*,u.name owner_name,u.email owner_email,NULL member_role,d.manifest_json
         FROM apps a JOIN users u ON u.id=a.owner_id
         LEFT JOIN deployments d ON d.app_id=a.id AND d.version=a.active_version
         WHERE a.archived_at IS NULL ORDER BY a.updated_at DESC LIMIT 500`,
      )
      : env.CONTROL_DB.prepare(
        `SELECT a.*,u.name owner_name,u.email owner_email,m.role member_role,d.manifest_json
         FROM apps a JOIN users u ON u.id=a.owner_id
         LEFT JOIN app_members m ON m.app_id=a.id AND m.user_id=?
         LEFT JOIN deployments d ON d.app_id=a.id AND d.version=a.active_version
         WHERE a.archived_at IS NULL AND (a.owner_id=? OR m.role='editor')
         ORDER BY a.updated_at DESC LIMIT 500`,
      ).bind(principal.user.id, principal.user.id);
    const { results } = await statement.all<ManagementRow>();
    return json({
      platformOwner: isPlatformOwner(principal),
      apps: results.map((app) => ({
        ...publicApp(app),
        owner: { name: app.owner_name, email: app.owner_email },
        components: manifestComponents(app.manifest_json),
        permissions: { manage: true, destroy: canDestroy(app, principal) },
      })),
    });
  }

  if (url.pathname === "/api/tokens" && req.method === "GET") {
    if (principal.tokenId) return json({ error: "session authentication required" }, 403);
    const { results } = await env.CONTROL_DB.prepare(
      "SELECT id,name,prefix,app_id,created_at,last_used_at,expires_at FROM tokens WHERE user_id=? AND revoked_at IS NULL ORDER BY created_at DESC",
    ).bind(principal.user.id).all();
    return json({ tokens: results });
  }
  if (url.pathname === "/api/tokens" && req.method === "POST") {
    if (principal.tokenId) return json({ error: "session authentication required" }, 403);
    const body = await req.json().catch(() => ({})) as { name?: string; appId?: string };
    if (body.appId) {
      const app = await getAppById(env, body.appId);
      if (!app || !(await canManage(env, app, principal))) return json({ error: "app not found" }, 404);
    }
    const token = await mintToken(env, principal.user.id, body.name || "agent", body.appId || null);
    return json({ token: { id: token.id, name: token.name, prefix: token.prefix, secret: token.secret, createdAt: token.createdAt } }, 201);
  }
  if (url.pathname.startsWith("/api/tokens/") && req.method === "DELETE") {
    if (principal.tokenId) return json({ error: "session authentication required" }, 403);
    const id = url.pathname.slice("/api/tokens/".length);
    const result = await env.CONTROL_DB.prepare(
      "UPDATE tokens SET revoked_at=? WHERE id=? AND user_id=? AND revoked_at IS NULL",
    ).bind(Date.now(), id, principal.user.id).run();
    return result.meta.changes ? json({ ok: true }) : json({ error: "not found" }, 404);
  }

  const match = url.pathname.match(/^\/api\/apps\/([^/]+)(?:\/(.*))?$/);
  if (!match) return json({ error: "not found" }, 404);
  const app = await getAppById(env, match[1]);
  if (!app) return json({ error: "app not found" }, 404);
  const tail = match[2] || "";

  if (!tail && req.method === "GET") {
    if (!(await canManage(env, app, principal))) return json({ error: "app not found" }, 404);
    const { results: deploymentRows } = await env.CONTROL_DB.prepare(
      `SELECT d.id,d.version,d.created_by,d.created_at,d.status,d.worker_key IS NOT NULL has_worker,
       d.manifest_json,u.name created_by_name,u.email created_by_email
       FROM deployments d LEFT JOIN users u ON u.id=d.created_by
       WHERE d.app_id=? ORDER BY d.version DESC LIMIT 50`,
    ).bind(app.id).all<Record<string, unknown>>();
    const deployments = deploymentRows.map(({ manifest_json, ...deployment }) => ({
      ...deployment,
      manifest: typeof manifest_json === "string" ? JSON.parse(manifest_json) : null,
    }));
    const { results: secrets } = await env.CONTROL_DB.prepare(
      "SELECT name,updated_at FROM app_secrets WHERE app_id=? ORDER BY name",
    ).bind(app.id).all();
    const { results: auditRows } = await env.CONTROL_DB.prepare(
      `SELECT l.id,l.action,l.detail,l.created_at,u.name user_name,u.email user_email
       FROM audit_log l LEFT JOIN users u ON u.id=l.user_id
       WHERE l.app_id=? ORDER BY l.created_at DESC LIMIT 100`,
    ).bind(app.id).all<{ id: string; action: string; detail: string | null; created_at: number; user_name: string | null; user_email: string | null }>();
    const audit = auditRows.map(({ detail, ...entry }) => ({
      ...entry,
      detail: detail ? JSON.parse(detail) : null,
    }));
    const { results: domains } = await env.CONTROL_DB.prepare(
      "SELECT hostname,status,error,created_at,updated_at FROM app_domains WHERE app_id=? ORDER BY hostname",
    ).bind(app.id).all();
    const { results: schedules } = await env.CONTROL_DB.prepare(
      "SELECT id,expression,next_run_at,last_run_at,last_status,last_error FROM app_schedules WHERE app_id=? ORDER BY expression",
    ).bind(app.id).all();
    return json({ app: await publicAppFor(env, app, principal), deployments, secrets, domains, schedules, audit });
  }
  if (!(await canManage(env, app, principal))) return json({ error: "app not found" }, 404);
  if (req.method !== "GET" && app.managed_by === "git" && !tail.startsWith("secrets/")) {
    return json({ error: "app is managed by git; update its apps/ directory and run reconciliation" }, 409);
  }
  if (tail === "adopt" && req.method === "POST") return handleAdoptResources(req, env, principal, app);
  if (tail === "domains" && req.method === "POST") return handleAddDomain(req, env, principal, app);
  if (tail.startsWith("domains/") && req.method === "DELETE") {
    return handleDeleteDomain(env, principal, app, decodeURIComponent(tail.slice("domains/".length)));
  }
  if (!tail && req.method === "DELETE") return handleDestroyApp(req, env, principal, app);
  if (tail === "prune" && req.method === "POST") return handlePruneApp(req, env, principal, app);
  if (tail === "deployments" && req.method === "POST") return handleDeploy(req, env, principal, app);
  if (tail === "rollback" && req.method === "POST") return handleRollback(req, env, principal, app);
  if (tail.startsWith("secrets/") && req.method === "PUT") {
    return handleSetSecret(req, env, principal, app, decodeURIComponent(tail.slice("secrets/".length)));
  }
  if (!tail && req.method === "PATCH") {
    const body = await req.json().catch(() => ({})) as { name?: string; description?: string; visibility?: string };
    const visibility = body.visibility ?? app.visibility;
    if (!["private", "team", "public"].includes(visibility)) return json({ error: "invalid visibility" }, 400);
    const name = String(body.name ?? app.name).trim().slice(0, 100);
    const description = String(body.description ?? app.description).trim().slice(0, 500);
    await env.CONTROL_DB.prepare("UPDATE apps SET name=?,description=?,visibility=?,updated_at=? WHERE id=?")
      .bind(name, description, visibility, Date.now(), app.id).run();
    return json({ app: await publicAppFor(env, { ...app, name, description, visibility: visibility as AppRow["visibility"] }, principal) });
  }
  return json({ error: "not found" }, 404);
}

async function sweepOrphanResources(env: Env): Promise<void> {
  const { results } = await env.CONTROL_DB.prepare(
    "SELECT type,identifier,app_id FROM orphan_resources ORDER BY created_at LIMIT 20",
  ).all<{ type: "d1" | "r2" | "worker" | "domain"; identifier: string; app_id: string | null }>();
  for (const orphan of results) {
    try {
      if (orphan.type === "d1") await deleteD1(env, orphan.identifier);
      if (orphan.type === "r2") await deleteR2Bucket(env, orphan.identifier);
      if (orphan.type === "worker") await deleteUserWorker(env, orphan.identifier);
      if (orphan.type === "domain") await deleteCustomDomain(env, orphan.identifier);
      await env.CONTROL_DB.prepare("DELETE FROM orphan_resources WHERE type=? AND identifier=?")
        .bind(orphan.type, orphan.identifier).run();
    } catch (error) {
      await env.CONTROL_DB.prepare("UPDATE orphan_resources SET error=? WHERE type=? AND identifier=?")
        .bind(error instanceof Error ? error.message : String(error), orphan.type, orphan.identifier).run();
    }
  }
}

async function sweepUnusedResources(env: Env): Promise<void> {
  const now = Date.now();
  const { results } = await env.CONTROL_DB.prepare(
    `SELECT * FROM apps WHERE archived_at IS NULL
     AND ((d1_delete_after IS NOT NULL AND d1_delete_after<=?) OR (r2_delete_after IS NOT NULL AND r2_delete_after<=?))
     ORDER BY COALESCE(d1_delete_after,r2_delete_after) LIMIT 10`,
  ).bind(now, now).all<AppRow>();
  for (const candidate of results) {
    const lockName = `app-operation:${candidate.id}`;
    const holder = `sweep-${randomHex(8)}`;
    if (!(await acquirePlatformLock(env, lockName, holder, 60 * 60_000))) continue;
    try {
      let app = await getAppById(env, candidate.id);
      if (!app) continue;
      const manifest = await activeManifest(env, app) ?? {
        version: 1,
        assets: false,
        worker: false,
        capabilities: { database: false, files: false, secrets: [], network: [], email: false, schedules: [], durableObjects: [] },
      } satisfies ResolvedManifest;
      if (!manifest.capabilities.files && app.r2_bucket && app.r2_delete_after && app.r2_delete_after <= Date.now()) {
        await removeFileStorage(env, app);
        app = (await getAppById(env, app.id)) ?? app;
      }
      if (!manifest.capabilities.database && app.d1_id && app.d1_delete_after && app.d1_delete_after <= Date.now()) {
        await removeDatabase(env, app);
      }
      await audit(env, "system", "app.resources_swept", app.id);
    } catch (error) {
      console.error("resource sweep failed", { appId: candidate.id, error });
    } finally {
      await releasePlatformLock(env, lockName, holder).catch((error) => console.error("sweep lock release failed", error));
    }
  }
}

async function sweepArchivedApps(env: Env, now = Date.now()): Promise<void> {
  const archived = await env.CONTROL_DB.prepare(
    "SELECT * FROM apps WHERE archived_at IS NOT NULL AND archived_at<=? ORDER BY archived_at LIMIT 5",
  ).bind(now - RESOURCE_GRACE_MS).all<AppRow>();
  for (const app of archived.results) {
    const lockName = `app-operation:${app.id}`;
    const holder = `destroy-${randomHex(8)}`;
    if (!(await acquirePlatformLock(env, lockName, holder, 60 * 60_000))) continue;
    try {
      const current = await getAppIncludingArchived(env, app.id);
      if (current?.archived_at && current.archived_at <= Date.now() - RESOURCE_GRACE_MS) await purgeArchivedApp(env, current);
    } catch (error) {
      console.error("archived app purge failed", { appId: app.id, error });
    } finally {
      await releasePlatformLock(env, lockName, holder).catch((error) => console.error("destroy lock release failed", error));
    }
  }
}

async function serveAsset(req: Request, env: Env, key: string): Promise<Response | null> {
  const object = await env.ASSETS.get(key);
  if (!object) return null;
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "private, no-cache");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "same-origin");
  return new Response(req.method === "HEAD" ? null : object.body, { headers });
}

async function appForHostname(env: Env, hostname: string): Promise<AppRow | null> {
  const suffix = ".apps.myslop.app";
  if (hostname.endsWith(suffix) && hostname !== `apps.myslop.app`) {
    const slug = hostname.slice(0, -suffix.length);
    return validSlug(slug) ? getAppBySlug(env, slug) : null;
  }
  return env.CONTROL_DB.prepare(
    `SELECT a.* FROM app_domains d JOIN apps a ON a.id=d.app_id
     WHERE d.hostname=? AND d.status='active' AND a.archived_at IS NULL`,
  ).bind(hostname).first<AppRow>();
}

export function appRequestHeaders(req: Request, app: AppRow, user: User | null): Headers {
  const headers = new Headers(req.headers);
  for (const name of [...headers.keys()]) {
    const lower = name.toLowerCase();
    if (lower.startsWith("x-myslop-") || (app.visibility !== "public" && (lower === "authorization" || lower === "cookie"))) {
      headers.delete(name);
    }
  }
  if (app.visibility !== "public") {
    headers.set("x-myslop-app-id", app.id);
    if (user) {
      headers.set("x-myslop-user-id", user.id);
      if (user.email) headers.set("x-myslop-user-email", user.email);
      if (user.name) headers.set("x-myslop-user-name", user.name);
    }
  }
  return headers;
}

async function handleAppRequest(req: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === "/__email" || url.pathname === "/__scheduled") return new Response("not found\n", { status: 404 });
  const app = await appForHostname(env, url.hostname);
  if (!app || !app.active_version) return new Response("app not found\n", { status: 404 });
  const user = app.visibility === "public" ? null : await getSessionUser(req, env);
  if (!(await canView(env, app, user))) {
    const wantsJson = req.headers.get("accept")?.includes("application/json") || req.headers.has("authorization");
    if (wantsJson) return json({ error: "unauthorized" }, 401);
    const returnTo = encodeURIComponent(url.toString());
    return Response.redirect(`https://apps.myslop.app/?returnTo=${returnTo}`, 302);
  }
  if (app.visibility !== "public" && user && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    const origin = req.headers.get("origin");
    if (origin !== url.origin) return new Response("bad origin\n", { status: 403 });
  }
  const deployment = await env.CONTROL_DB.prepare(
    "SELECT * FROM deployments WHERE app_id=? AND version=? AND status='active'",
  ).bind(app.id, app.active_version).first<DeploymentRow>();
  if (!deployment) return new Response("deployment missing\n", { status: 503 });

  const requestedPath = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
  if (safeAssetPath(requestedPath)) {
    const exact = await serveAsset(req, env, `${deployment.asset_prefix}/${requestedPath}`);
    if (exact) return exact;
  }

  if (deployment.worker_key && deployment.worker_name) {
    const headers = appRequestHeaders(req, app, user);
    const manifest = parseResolvedManifest(JSON.parse(deployment.manifest_json));
    const worker = env.DISPATCHER.get(deployment.worker_name, {}, {
      limits: { cpuMs: 10_000, subRequests: 1_000 },
      outbound: { policy: { appId: app.id, hosts: manifest.capabilities.network } },
    });
    const response = await worker.fetch(new Request(req, { headers }));
    if (response.status !== 404 || req.method !== "GET") return withSecurityHeaders(response, app.visibility === "public");
  }

  if (req.method === "GET" && !requestedPath.split("/").pop()?.includes(".")) {
    const fallback = await serveAsset(req, env, `${deployment.asset_prefix}/index.html`);
    if (fallback) return fallback;
  }
  return new Response("not found\n", { status: 404 });
}

function decodedBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function withSecurityHeaders(response: Response, preserveCookies = false): Response {
  const result = new Response(response.body, response);
  if (!preserveCookies) result.headers.delete("set-cookie");
  result.headers.set("x-content-type-options", "nosniff");
  result.headers.set("referrer-policy", "same-origin");
  return result;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.hostname !== "apps.myslop.app") return handleAppRequest(req, env, url);
    if (url.pathname.startsWith("/api/")) return handleApi(req, env, url, ctx);
    if (url.pathname === "/skill.md") {
      return new Response(skillMd, { headers: { "content-type": "text/markdown; charset=utf-8" } });
    }
    if (url.pathname === "/setup.sh") {
      return new Response(decodedBase64(setupShB64), {
        headers: { "content-type": "text/x-shellscript; charset=utf-8", "cache-control": "no-store" },
      });
    }
    if (url.pathname === "/cli") {
      return new Response(decodedBase64(cliB64), {
        headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" },
      });
    }
    if (url.pathname === "/schema/v1.json") {
      return json(MANIFEST_SCHEMA, 200, { "cache-control": "public, max-age=3600" });
    }
    if (url.pathname === "/" || url.pathname === "/dashboard" || url.pathname === "/setup") {
      return new Response(dashboardHtml as unknown as string, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }
    return new Response("not found\n", { status: 404 });
  },
  async email(message, env) {
    await acceptEmail(message, env);
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(Promise.all([
      dispatchDueSchedules(env),
      retryEmailDeliveries(env),
      sweepUnusedResources(env),
      sweepArchivedApps(env),
      sweepOrphanResources(env),
    ]).then(() => undefined));
  },
} satisfies ExportedHandler<Env>;
