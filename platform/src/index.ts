import dashboardHtml from "./dashboard.html";
import {
  DASHBOARD_CSS,
  DASHBOARD_CSS_ETAG,
  DASHBOARD_JS,
  DASHBOARD_JS_ETAG,
} from "./dashboard-assets.generated";
import { serveDashboardAsset, type DashboardAsset } from "./dashboard-assets";
import {
  authHealth,
  authPrivacy,
  authTerms,
  beginGoogleLogin,
  completeGoogleLogin,
  consumeAuthCompletion,
} from "./google-auth";
import skillMd from "./skill.md";
import cliB64 from "./cli.generated";
import setupShB64 from "./setup-sh.generated";
import {
  authenticate,
  consumeAppSessionExchange,
  consumeGlobalSignOutExchange,
  createAppSessionExchange,
  createGlobalSignOutExchange,
  getSessionUser,
  mintToken,
  signOut,
  type Principal,
} from "./auth";
import {
  appPermissions,
  audienceToVisibility,
  effectiveAppAccess,
  effectiveAppRole,
  listAccessibleApps,
  permissionsFor,
  roleAtLeast,
  roleFromRank,
  visibilityToAudience,
  type AppAccessRow,
} from "./access";
import { audit } from "./audit";
import {
  attachCustomDomain,
  createD1,
  createR2Bucket,
  customDomainOwner,
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
  isUniqueViolation,
  json,
  randomHex,
  safeAssetPath,
  sha256Hex,
  sqlPlaceholders,
  validBindingName,
  validAppReturnUrl,
  validSlug,
  sessionCookie,
  SESSION_COOKIE,
  LEGACY_SESSION_COOKIE,
  SESSION_TTL_MS,
} from "./core";
import {
  MANIFEST_SCHEMA,
  normalizeAppDomain,
  normalizeAppManifest,
  parseResolvedManifest,
  type ResolvedAccessManifest,
  type ResolvedAppManifest,
  type ResolvedManifest,
} from "./manifest";
import { activeTeamsFor, handleOrganizationApi } from "./organization";
import { buildResourceTopology } from "./resources";
import { canReconcileApps, hasActiveDomain, reconciliationDeploymentChanged } from "./reconcile";
import { acceptEmail, dispatchDueSchedules, reconcileAppSchedules, retryEmailDeliveries } from "./runtime";
import { deriveAppIdentitySecret } from "./internal";
import { signIdentityAssertion } from "./identity-assertion";
import { encryptSecret, loadAppSecrets } from "./secrets";
import type { AppAudience, AppRole, AppRow, DeploymentRow, Env, User } from "./types";
import { isDashboardPath } from "./ui";
import {
  appSlugFromHostname,
  appUrl,
  AUTH_HOST,
  LEGACY_PLATFORM_HOST,
  legacyAppSlugFromHostname,
  PLATFORM_APEX_HOST,
  PLATFORM_HOST,
  PLATFORM_ORIGIN,
  PASSTHROUGH_HOSTS,
  platformRedirect,
  RESERVED_APP_SLUGS,
  slugSuggestions,
  validSlugSyntax,
} from "./domains";

const dashboardAssets = new Map<string, DashboardAsset>([
  [
    "/assets/dashboard.js",
    { body: DASHBOARD_JS, contentType: "text/javascript; charset=utf-8", etag: DASHBOARD_JS_ETAG },
  ],
  [
    "/assets/dashboard.css",
    { body: DASHBOARD_CSS, contentType: "text/css; charset=utf-8", etag: DASHBOARD_CSS_ETAG },
  ],
]);

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

function publicApp(app: AppRow) {
  return {
    id: app.id,
    slug: app.slug,
    name: app.name,
    description: app.description,
    visibility: app.visibility,
    audience: visibilityToAudience(app.visibility),
    teamId: app.team_id,
    folderId: app.folder_id,
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
    deploymentHash: app.deployment_hash,
    createdAt: app.created_at,
    updatedAt: app.updated_at,
  };
}

function isPlatformOwner(principal: Principal): boolean {
  return principal.user.platform_role === "owner";
}

async function publicAppFor(env: Env, app: AppRow, principal: Principal) {
  const permissions = await appPermissions(env, app, principal);
  return { ...publicApp(app), permissions, role: permissions.role };
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

async function canDestroy(env: Env, app: AppRow, principal: Principal): Promise<boolean> {
  return (await appPermissions(env, app, principal)).destroy;
}

function ensureCsrf(req: Request, principal: Principal): Response | null {
  if (principal.tokenId || req.method === "GET" || req.method === "HEAD") return null;
  const origin = req.headers.get("origin");
  return origin === PLATFORM_ORIGIN || origin === "http://localhost:8787"
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
  let body: { slug?: string; name?: string; description?: string; visibility?: string; audience?: AppAudience; teamId?: string; folderId?: string | null };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid body" }, 400);
  }
  if (!validSlugSyntax(body.slug)) return json({ error: "slug must be 3-48 lowercase letters, numbers, and hyphens" }, 400);
  if (RESERVED_APP_SLUGS.has(body.slug)) return json({ error: "slug is reserved", code: "slug_reserved" }, 409);
  const name = String(body.name || body.slug).trim().slice(0, 100);
  const description = String(body.description || "").trim().slice(0, 500);
  const visibility = body.audience ? audienceToVisibility(body.audience) : body.visibility || "team";
  if (!name || !["private", "team", "public"].includes(visibility)) return json({ error: "invalid app" }, 400);
  const teams = await activeTeamsFor(env, principal);
  const team = body.teamId ? teams.find(({ id }) => id === body.teamId) : teams[0];
  if (!team) return json({ error: "active team membership required" }, 403);
  const folderId = body.folderId || null;
  if (folderId) {
    const folder = await env.CONTROL_DB.prepare("SELECT 1 ok FROM folders WHERE id=? AND team_id=?")
      .bind(folderId, team.id).first();
    if (!folder) return json({ error: "folder not found" }, 400);
  }
  const owned = await env.CONTROL_DB.prepare(
    "SELECT COUNT(*) count FROM apps WHERE owner_id=? AND archived_at IS NULL",
  ).bind(principal.user.id).first<{ count: number }>();
  if (Number(owned?.count || 0) >= 25) return json({ error: "app quota reached (25)" }, 429);

  const id = randomHex(12);
  const now = Date.now();
  const workerName = `app-${id}`;
  try {
    const domainOwner = await customDomainOwner(env, `${body.slug}.myslop.app`);
    if (domainOwner) {
      return json({
        error: "slug is unavailable",
        code: "slug_unavailable",
        suggestions: slugSuggestions(body.slug, team.slug, id.slice(0, 6)),
      }, 409);
    }
  } catch (error) {
    return json({ error: `could not verify hostname availability: ${error instanceof Error ? error.message : error}` }, 502);
  }
  try {
    await env.CONTROL_DB.batch([
      env.CONTROL_DB.prepare(
        `INSERT INTO apps (id,slug,name,description,owner_id,visibility,worker_name,created_at,updated_at,team_id,folder_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(id, body.slug, name, description, principal.user.id, visibility, workerName, now, now, team.id, folderId),
      env.CONTROL_DB.prepare(
        "INSERT INTO app_user_assignments (app_id,user_id,role,granted_by,created_at,updated_at) VALUES (?,?,?,?,?,?)",
      ).bind(id, principal.user.id, "owner", principal.user.id, now, now),
    ]);
  } catch (error) {
    if (isUniqueViolation(error) || String(error).includes("hostname") || String(error).includes("slug")) {
      return json({
        error: "slug is unavailable",
        code: "slug_unavailable",
        suggestions: slugSuggestions(body.slug, team.slug, id.slice(0, 6)),
      }, 409);
    }
    return json({ error: "could not create app" }, 500);
  }

  const app = await getAppById(env, id);
  await audit(env, { actorId: principal.user.id, teamId: team.id, appId: id, action: "app.created", detail: { slug: body.slug, folderId } });
  return json({ app: await publicAppFor(env, app!, principal) }, 201);
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
    capabilities: { database: false, files: true, secrets: [], network: [], email: false, identity: false, schedules: [], durableObjects: [] },
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

export async function removeDatabase(env: Env, app: AppRow): Promise<void> {
  if (!app.d1_id) return;
  // Adopted databases predate the platform app. Detach them without deleting
  // their data so a migration can be rolled back safely.
  if (!app.d1_adopted) await deleteD1(env, app.d1_id);
  await env.CONTROL_DB.prepare(
    "UPDATE apps SET d1_id=NULL,d1_name=NULL,d1_adopted=0,d1_delete_after=NULL WHERE id=? AND d1_id=?",
  ).bind(app.id, app.d1_id).run();
}

export async function removeFileStorage(env: Env, app: AppRow): Promise<void> {
  if (!app.r2_bucket) return;
  // Never empty or delete an adopted bucket. Its objects remain available to
  // the previous Worker until the migration's rollback window closes.
  if (!app.r2_adopted) {
    await emptyAppBucket(env, app);
    await deleteR2Bucket(env, app.r2_bucket);
  }
  await env.CONTROL_DB.prepare(
    "UPDATE apps SET r2_bucket=NULL,r2_adopted=0,r2_delete_after=NULL WHERE id=? AND r2_bucket=?",
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
      `INSERT INTO deployments (id,app_id,version,asset_prefix,manifest_json,internal_secret_version,status,created_by,created_at)
       SELECT ?,?,COALESCE(MAX(version),0)+1,'',?,2,'pending',?,? FROM deployments WHERE app_id=?`,
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
    await audit(env, { actorId: principal.user.id, teamId: app.team_id, appId: app.id, action: "app.deployed", detail: { version, manifest } });
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
        capabilities: { database: false, files: false, secrets: [], network: [], email: false, identity: false, schedules: [], durableObjects: [] },
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
    internalSecretVersion: deployment.internal_secret_version === 2 ? 2 : 1,
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
    await audit(env, { actorId: principal.user.id, teamId: app.team_id, appId: app.id, action: "app.rolled_back", detail: { version } });
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
    await audit(env, { actorId: principal.user.id, teamId: app.team_id, appId: app.id, action: "secret.updated", detail: { name } });
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
  if (!(await canDestroy(env, app, principal))) return json({ error: "only an app owner can delete stored resources" }, 403);
  const body = await req.json().catch(() => ({})) as { confirm?: string };
  if (body.confirm !== app.slug) return json({ error: `confirm pruning with {\"confirm\":\"${app.slug}\"}` }, 400);
  return withAppOperationLock(env, app.id, async () => {
    const current = await getAppById(env, app.id);
    if (!current) return json({ error: "app not found" }, 404);
    const manifest = await activeManifest(env, current) ?? {
      version: 1,
      assets: false,
      worker: false,
      capabilities: { database: false, files: false, secrets: [], network: [], email: false, identity: false, schedules: [], durableObjects: [] },
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
    await audit(env, { actorId: principal.user.id, teamId: app.team_id, appId: app.id, action: "app.pruned", detail: { removed } });
    return json({ ok: true, removed });
  });
}

async function handleDestroyApp(req: Request, env: Env, principal: Principal, app: AppRow, fromReconciliation = false): Promise<Response> {
  if (!fromReconciliation && !(await canDestroy(env, app, principal))) return json({ error: "only an app owner can delete an app" }, 403);
  if (fromReconciliation && !isPlatformOwner(principal)) return json({ error: "platform owner required" }, 403);
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
    await audit(env, { actorId: principal.user.id, teamId: app.team_id, appId: app.id, action: "app.archived", detail: { slug: app.slug, recoveryUntil } });
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
    await audit(env, { actorId: "system", teamId: app.team_id, appId: app.id, action: "app.deleted", detail: { slug: app.slug } });
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
    return json({ error: isUniqueViolation(error) ? "resource is already attached to another app" : `resource adoption failed: ${message}` }, 409);
  }
  await audit(env, { actorId: principal.user.id, teamId: app.team_id, appId: app.id, action: "app.resources.adopted", detail: { database, bucket } });
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
    if (existing?.app_id !== app.id) return json({ error: "domain is already claimed" }, 409);
    await env.CONTROL_DB.prepare(
      "UPDATE app_domains SET status='pending',error=NULL,updated_at=? WHERE hostname=? AND app_id=?",
    ).bind(now, hostname, app.id).run();
  }
  try {
    const domain = await attachCustomDomain(env, hostname);
    await env.CONTROL_DB.prepare(
      "UPDATE app_domains SET cloudflare_id=?,status='active',error=NULL,updated_at=? WHERE hostname=? AND app_id=?",
    ).bind(domain.id, Date.now(), hostname, app.id).run();
    await audit(env, { actorId: principal.user.id, teamId: app.team_id, appId: app.id, action: "app.domain.attached", detail: { hostname } });
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
    await audit(env, { actorId: principal.user.id, teamId: app.team_id, appId: app.id, action: "app.domain.detached", detail: { hostname } });
    return json({ ok: true });
  } catch (error) {
    await env.CONTROL_DB.prepare("UPDATE app_domains SET status='error',error=?,updated_at=? WHERE hostname=?")
      .bind(error instanceof Error ? error.message : String(error), Date.now(), hostname).run();
    return json({ error: `domain detachment failed: ${error instanceof Error ? error.message : error}` }, 502);
  }
}

// Every list endpoint decorates its apps with the same owner, role and topology projection.
async function listedApps(env: Env, apps: AppAccessRow[]) {
  const deployments = await env.CONTROL_DB.prepare(
    `SELECT d.app_id,d.manifest_json FROM deployments d JOIN apps a ON a.id=d.app_id AND a.active_version=d.version WHERE d.status='active'`,
  ).all<{ app_id: string; manifest_json: string }>();
  const manifests = new Map(deployments.results.map((row) => [row.app_id, row.manifest_json]));
  const owners = await env.CONTROL_DB.prepare("SELECT id,name,email FROM users").all<{ id: string; name: string | null; email: string | null }>();
  const ownerMap = new Map(owners.results.map((owner) => [owner.id, owner]));
  return apps.map((app) => {
    const role = roleFromRank(app.effective_rank);
    return {
      ...publicApp(app),
      role,
      permissions: permissionsFor(app, role),
      owner: ownerMap.get(app.owner_id) ?? null,
      resources: buildResourceTopology({ app, manifestJson: manifests.get(app.id) ?? null }),
    };
  });
}

function policyManagedByGit(app: AppRow, subject: "folder" | "access"): Response {
  if (app.managed_by === "git") {
    return json({ error: `app ${subject} is managed by git; update myslop.json and run reconciliation` }, 409);
  }
  return json({ error: "app owner required" }, 403);
}

async function appAccessDetails(env: Env, app: AppRow, principal: Principal) {
  const effective = await effectiveAppAccess(env, app, principal.user);
  const permissions = permissionsFor(app, effective.role);
  const owner = await env.CONTROL_DB.prepare("SELECT id,email,name,picture FROM users WHERE id=?")
    .bind(app.owner_id).first();
  let users: unknown[] = [];
  let groups: unknown[] = [];
  if (roleAtLeast(effective.role, "owner")) {
    users = (await env.CONTROL_DB.prepare(
      `SELECT u.id,u.email,u.name,u.picture,a.role
       FROM app_user_assignments a JOIN users u ON u.id=a.user_id
       WHERE a.app_id=? ORDER BY CASE a.role WHEN 'owner' THEN 3 WHEN 'editor' THEN 2 ELSE 1 END DESC,COALESCE(u.name,u.email)`,
    ).bind(app.id).all()).results;
    groups = (await env.CONTROL_DB.prepare(
      `SELECT g.id,g.slug,g.name,g.description,a.role,COUNT(m.user_id) member_count
       FROM app_group_assignments a JOIN team_groups g ON g.id=a.group_id
       LEFT JOIN group_members m ON m.group_id=g.id
       WHERE a.app_id=? GROUP BY g.id,a.role ORDER BY g.name`,
    ).bind(app.id).all()).results;
  }
  return {
    audience: visibilityToAudience(app.visibility),
    effectiveRole: effective.role,
    sources: effective.sources,
    owner,
    users,
    groups,
    managedBy: app.managed_by,
    readOnly: !permissions.modifyAccess,
  };
}

async function handleSetAppFolder(req: Request, env: Env, principal: Principal, app: AppRow): Promise<Response> {
  const permissions = await appPermissions(env, app, principal);
  if (!permissions.moveApp) return policyManagedByGit(app, "folder");
  const body = await req.json().catch(() => ({})) as { folderId?: string | null };
  const folderId = body.folderId || null;
  if (folderId) {
    const folder = await env.CONTROL_DB.prepare("SELECT 1 ok FROM folders WHERE id=? AND team_id=?")
      .bind(folderId, app.team_id).first();
    if (!folder) return json({ error: "folder not found" }, 400);
  }
  const previousFolderId = app.folder_id;
  await env.CONTROL_DB.prepare("UPDATE apps SET folder_id=?,updated_at=? WHERE id=?")
    .bind(folderId, Date.now(), app.id).run();
  if (previousFolderId !== folderId) {
    await audit(env, { actorId: principal.user.id, teamId: app.team_id, appId: app.id, action: "app.folder.changed", detail: { previousFolderId, folderId, source: "manual" } });
  }
  return json({ app: await publicAppFor(env, (await getAppById(env, app.id))!, principal) });
}

async function handleSetAppAccess(req: Request, env: Env, principal: Principal, app: AppRow): Promise<Response> {
  const permissions = await appPermissions(env, app, principal);
  if (!permissions.modifyAccess) return policyManagedByGit(app, "access");
  const body = await req.json().catch(() => ({})) as {
    audience?: AppAudience;
    users?: { userId?: string; role?: AppRole }[];
    groups?: { groupId?: string; role?: "viewer" | "editor" }[];
  };
  if (!body.audience || !["restricted", "team", "public"].includes(body.audience)) return json({ error: "invalid audience" }, 400);
  if (!Array.isArray(body.users) || !Array.isArray(body.groups)) return json({ error: "users and groups are required" }, 400);
  const userIds = body.users.map(({ userId }) => userId || "");
  const groupIds = body.groups.map(({ groupId }) => groupId || "");
  if (userIds.some((id) => !id) || new Set(userIds).size !== userIds.length) return json({ error: "user assignments must be unique" }, 400);
  if (groupIds.some((id) => !id) || new Set(groupIds).size !== groupIds.length) return json({ error: "group assignments must be unique" }, 400);
  if (body.users.some(({ role }) => !role || !["viewer", "editor", "owner"].includes(role))) return json({ error: "invalid user role" }, 400);
  if (body.groups.some(({ role }) => !role || !["viewer", "editor"].includes(role))) return json({ error: "invalid group role" }, 400);
  const primary = body.users.find(({ userId }) => userId === app.owner_id);
  if (primary && primary.role !== "owner") return json({ error: "the primary owner cannot be downgraded" }, 400);
  if (userIds.length) {
    const members = await env.CONTROL_DB.prepare(
      `SELECT user_id FROM team_members WHERE team_id=? AND status='active' AND user_id IN (${sqlPlaceholders(userIds.length)})`,
    ).bind(app.team_id, ...userIds).all<{ user_id: string }>();
    if (members.results.length !== userIds.length) return json({ error: "every assigned user must be an active team member" }, 400);
  }
  if (groupIds.length) {
    const groups = await env.CONTROL_DB.prepare(
      `SELECT id FROM team_groups WHERE team_id=? AND id IN (${sqlPlaceholders(groupIds.length)})`,
    ).bind(app.team_id, ...groupIds).all<{ id: string }>();
    if (groups.results.length !== groupIds.length) return json({ error: "every assigned group must belong to the app team" }, 400);
  }
  const now = Date.now();
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare("UPDATE apps SET visibility=?,updated_at=? WHERE id=?")
      .bind(audienceToVisibility(body.audience), now, app.id),
    env.CONTROL_DB.prepare("DELETE FROM app_user_assignments WHERE app_id=? AND user_id<>?").bind(app.id, app.owner_id),
    env.CONTROL_DB.prepare("DELETE FROM app_group_assignments WHERE app_id=?").bind(app.id),
    ...body.users.filter(({ userId }) => userId !== app.owner_id).map(({ userId, role }) => env.CONTROL_DB.prepare(
      "INSERT INTO app_user_assignments (app_id,user_id,role,granted_by,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    ).bind(app.id, userId, role, principal.user.id, now, now)),
    ...body.groups.map(({ groupId, role }) => env.CONTROL_DB.prepare(
      "INSERT INTO app_group_assignments (app_id,group_id,role,granted_by,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    ).bind(app.id, groupId, role, principal.user.id, now, now)),
  ]);
  await audit(env, {
    actorId: principal.user.id,
    teamId: app.team_id,
    appId: app.id,
    action: "app.access.updated",
    detail: { audience: body.audience, users: body.users, groups: body.groups, source: "manual" },
  });
  const refreshed = (await getAppById(env, app.id))!;
  return json({ app: await publicAppFor(env, refreshed, principal), access: await appAccessDetails(env, refreshed, principal) });
}

interface ReconcileInput {
  teamId?: string;
  sourceHash?: string;
  deploymentHash?: string;
  app?: { name?: string; description?: string; visibility?: AppRow["visibility"]; folder?: string | null; domains?: string[] };
  access?: ResolvedAccessManifest;
  resources?: { database?: { id?: string; name?: string }; bucket?: { name?: string } };
  deployment?: DeployInput;
}

interface ReconcilePolicy {
  normalized: ResolvedAppManifest;
  teamId: string;
  ownerId: string;
  folderId: string | null;
  users: { userId: string; email: string; role: AppRole }[];
  groups: { groupId: string; slug: string; role: "viewer" | "editor" }[];
}

export async function resolveReconcilePolicy(
  env: Env,
  principal: Principal,
  slug: string,
  body: ReconcileInput,
  existing: AppRow | null,
): Promise<ReconcilePolicy | Response> {
  const teams = await activeTeamsFor(env, principal);
  if (existing && body.teamId && existing.team_id !== body.teamId) {
    return json({ error: "app belongs to a different team" }, 409);
  }
  if (existing && principal.teamId && existing.team_id !== principal.teamId) {
    return json({ error: "app not found in token team" }, 404);
  }
  const teamId = existing?.team_id ?? (
    body.teamId
      ? teams.find(({ id }) => id === body.teamId)?.id
      : teams.length === 1 ? teams[0]?.id : undefined
  );
  if (!teamId) {
    return json({
      error: body.teamId ? "target team is unavailable" : "teamId is required when more than one team is available",
    }, body.teamId ? 403 : 400);
  }
  const ownerId = existing?.owner_id ?? principal.user.id;
  let normalized: ResolvedAppManifest;
  try {
    const visibility = body.app?.visibility ?? (body.access ? undefined : existing?.visibility);
    normalized = normalizeAppManifest({
      app: {
        name: body.app?.name ?? existing?.name ?? slug,
        description: body.app?.description ?? existing?.description ?? "",
        ...(visibility ? { visibility } : {}),
        ...(body.app && Object.hasOwn(body.app, "folder") ? { folder: body.app.folder } : {}),
        domains: body.app?.domains,
      },
      access: body.access,
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }

  let folderId = existing?.folder_id ?? null;
  if (body.app && Object.hasOwn(body.app, "folder")) {
    if (normalized.folder === null) folderId = null;
    else if (normalized.folder) {
      const folder = await env.CONTROL_DB.prepare("SELECT id FROM folders WHERE team_id=? AND slug=?")
        .bind(teamId, normalized.folder).first<{ id: string }>();
      if (!folder) return json({ error: `folder not found in app team: ${normalized.folder}` }, 400);
      folderId = folder.id;
    }
  }

  const users: ReconcilePolicy["users"] = [];
  const groups: ReconcilePolicy["groups"] = [];
  if (normalized.access) {
    for (const assignment of normalized.access.users) {
      const user = await env.CONTROL_DB.prepare(
        `SELECT u.id FROM users u JOIN team_members m ON m.user_id=u.id
         WHERE m.team_id=? AND m.status='active' AND lower(u.email)=?`,
      ).bind(teamId, assignment.email).first<{ id: string }>();
      if (!user) return json({ error: `active team user not found: ${assignment.email}` }, 400);
      if (user.id === ownerId && assignment.role !== "owner") return json({ error: "the primary owner cannot be downgraded" }, 400);
      users.push({ userId: user.id, email: assignment.email, role: assignment.role });
    }
    for (const assignment of normalized.access.groups) {
      const group = await env.CONTROL_DB.prepare("SELECT id FROM team_groups WHERE team_id=? AND slug=?")
        .bind(teamId, assignment.slug).first<{ id: string }>();
      if (!group) return json({ error: `group not found in app team: ${assignment.slug}` }, 400);
      groups.push({ groupId: group.id, slug: assignment.slug, role: assignment.role });
    }
  }
  return { normalized, teamId, ownerId, folderId, users, groups };
}

async function handleReconcileApp(
  req: Request,
  env: Env,
  principal: Principal,
  slug: string,
): Promise<Response> {
  if (!canReconcileApps(principal)) {
    return json({ error: principal.appId ? "token is scoped to one app" : "platform owner required" }, 403);
  }
  if (!validSlug(slug)) return json({ error: "invalid app slug" }, 400);
  if (req.method === "DELETE") {
    const body = await req.json().catch(() => ({})) as { confirm?: string; teamId?: string };
    if (!body.teamId) return json({ error: "teamId is required for reconciliation deletion" }, 400);
    const app = await getAppBySlug(env, slug);
    if (!app) return json({ ok: true, deleted: slug });
    if (app.team_id !== body.teamId) return json({ error: "app belongs to a different team" }, 409);
    if (principal.teamId && app.team_id !== principal.teamId) return json({ error: "app not found in token team" }, 404);
    if (app.managed_by !== "git") return json({ error: "refusing to delete a manually managed app" }, 409);
    if (body.confirm !== slug) return json({ error: `confirm deletion with {"confirm":"${slug}"}` }, 400);
    return handleDestroyApp(new Request(req.url, { method: "DELETE", body: JSON.stringify(body) }), env, principal, app, true);
  }
  if (req.method !== "PUT") return json({ error: "method not allowed" }, 405);
  const body = await req.json().catch(() => null) as ReconcileInput | null;
  if (
    !body?.sourceHash || !/^[a-f0-9]{64}$/.test(body.sourceHash) ||
    !body.deploymentHash || !/^[a-f0-9]{64}$/.test(body.deploymentHash) ||
    !body.deployment
  ) {
    return json({ error: "sourceHash, deploymentHash and deployment are required" }, 400);
  }
  const sourceHash = body.sourceHash;
  const deploymentHash = body.deploymentHash;
  let app = await getAppBySlugIncludingArchived(env, slug);
  if (app && principal.teamId && app.team_id !== principal.teamId) {
    return json({ error: "app not found in token team" }, 404);
  }
  if (app?.archived_at && Date.now() - app.archived_at >= RESOURCE_GRACE_MS) {
    return json({ error: "app recovery window has expired" }, 410);
  }
  if (app && app.managed_by !== "git") return json({ error: "slug belongs to a manually managed app" }, 409);
  const policy = await resolveReconcilePolicy(env, principal, slug, body, app);
  if (policy instanceof Response) return policy;

  if (!app) {
    const created = await handleCreateApp(
      new Request(req.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug,
          teamId: policy.teamId,
          folderId: policy.folderId,
          name: policy.normalized.name || slug,
          description: policy.normalized.description,
          visibility: policy.normalized.access
            ? audienceToVisibility(policy.normalized.access.audience)
            : policy.normalized.visibility,
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
  }

  return withAppOperationLock(env, app.id, async () => {
    const archivedState = app!.archived_at ? {
      archivedAt: app!.archived_at,
      databaseDeleteAfter: app!.d1_delete_after,
      filesDeleteAfter: app!.r2_delete_after,
    } : null;
    if (archivedState) {
      await env.CONTROL_DB.prepare(
        "UPDATE apps SET archived_at=NULL,d1_delete_after=NULL,r2_delete_after=NULL,updated_at=? WHERE id=?",
      ).bind(Date.now(), app!.id).run();
    }
    const finish = async (response: Response): Promise<Response> => {
      if (!archivedState) return response;
      if (!response.ok) {
        await env.CONTROL_DB.prepare(
          "UPDATE apps SET archived_at=?,d1_delete_after=?,r2_delete_after=?,updated_at=? WHERE id=?",
        ).bind(
          archivedState.archivedAt,
          archivedState.databaseDeleteAfter,
          archivedState.filesDeleteAfter,
          Date.now(),
          app!.id,
        ).run();
        return response;
      }
      await audit(env, {
        actorId: principal.user.id,
        teamId: app!.team_id,
        appId: app!.id,
        action: "app.restored",
        detail: { source: "git reconciliation" },
      });
      return response;
    };
    const current = await getAppById(env, app!.id);
    if (!current) return finish(json({ error: "app not found" }, 404));
    try {
      const normalized = policy.normalized;
    const folderId = policy.folderId;
    const resolvedUsers = policy.users;
    const resolvedGroups = policy.groups;
    const desiredVisibility = normalized.access ? audienceToVisibility(normalized.access.audience) : normalized.visibility;
    const currentUsers = normalized.access ? (await env.CONTROL_DB.prepare(
      "SELECT user_id,role FROM app_user_assignments WHERE app_id=? AND user_id<>? ORDER BY user_id",
    ).bind(current.id, current.owner_id).all<{ user_id: string; role: AppRole }>()).results : [];
    const currentGroups = normalized.access ? (await env.CONTROL_DB.prepare(
      "SELECT group_id,role FROM app_group_assignments WHERE app_id=? ORDER BY group_id",
    ).bind(current.id).all<{ group_id: string; role: "viewer" | "editor" }>()).results : [];
    const desiredUsers = resolvedUsers.filter(({ userId }) => userId !== current.owner_id)
      .map(({ userId, role }) => ({ user_id: userId, role })).sort((left, right) => left.user_id.localeCompare(right.user_id));
    const desiredGroups = resolvedGroups.map(({ groupId, role }) => ({ group_id: groupId, role }))
      .sort((left, right) => left.group_id.localeCompare(right.group_id));
    const policyChanged =
      current.name !== normalized.name || current.description !== normalized.description ||
      current.visibility !== desiredVisibility || current.folder_id !== folderId ||
      (normalized.access !== undefined && (
        JSON.stringify(currentUsers) !== JSON.stringify(desiredUsers) ||
        JSON.stringify(currentGroups) !== JSON.stringify(desiredGroups)
      ));

    const applyPolicy = async () => {
      if (!policyChanged) return;
      const now = Date.now();
      const statements = [
        env.CONTROL_DB.prepare("UPDATE apps SET name=?,description=?,visibility=?,folder_id=?,updated_at=? WHERE id=?")
          .bind(normalized.name || current.name, normalized.description, desiredVisibility, folderId, now, current.id),
      ];
      if (normalized.access) {
        statements.push(
          env.CONTROL_DB.prepare("DELETE FROM app_user_assignments WHERE app_id=? AND user_id<>?").bind(current.id, current.owner_id),
          env.CONTROL_DB.prepare("DELETE FROM app_group_assignments WHERE app_id=?").bind(current.id),
          ...desiredUsers.map(({ user_id, role }) => env.CONTROL_DB.prepare(
            "INSERT INTO app_user_assignments (app_id,user_id,role,granted_by,created_at,updated_at) VALUES (?,?,?,?,?,?)",
          ).bind(current.id, user_id, role, principal.user.id, now, now)),
          ...desiredGroups.map(({ group_id, role }) => env.CONTROL_DB.prepare(
            "INSERT INTO app_group_assignments (app_id,group_id,role,granted_by,created_at,updated_at) VALUES (?,?,?,?,?,?)",
          ).bind(current.id, group_id, role, principal.user.id, now, now)),
        );
      }
      await env.CONTROL_DB.batch(statements);
      await audit(env, {
        actorId: principal.user.id,
        teamId: current.team_id,
        appId: current.id,
        action: "app.policy.reconciled",
        detail: { folder: normalized.folder, access: normalized.access, source: "git" },
      });
    };

    let refreshed = (await getAppById(env, current.id))!;
    let resourcesChanged = false;
    if (body.resources && ((!refreshed.d1_id && body.resources.database) || (!refreshed.r2_bucket && body.resources.bucket))) {
      const adopted = await handleAdoptResources(
        new Request(req.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body.resources) }),
        env,
        principal,
        refreshed,
      );
      if (!adopted.ok) return finish(adopted);
      resourcesChanged = true;
      refreshed = (await getAppById(env, current.id))!;
    }

    let domainsChanged = false;
    if (body.app?.domains !== undefined) {
      const desiredDomains = new Set(body.app.domains.map(normalizeAppDomain));
      const domainRows = await env.CONTROL_DB.prepare("SELECT hostname,status FROM app_domains WHERE app_id=?")
        .bind(current.id).all<{ hostname: string; status: string }>();
      for (const hostname of desiredDomains) {
        if (hasActiveDomain(domainRows.results, hostname)) continue;
        const attached = await handleAddDomain(
          new Request(req.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hostname }) }),
          env,
          principal,
          refreshed,
        );
        if (!attached.ok) return finish(attached);
        domainsChanged = true;
      }
      for (const { hostname } of domainRows.results) {
        if (desiredDomains.has(hostname)) continue;
        const detached = await handleDeleteDomain(env, principal, refreshed, hostname);
        if (!detached.ok) return finish(detached);
        domainsChanged = true;
      }
    }

    const deploymentChanged = reconciliationDeploymentChanged({
      currentSourceHash: current.source_hash,
      currentDeploymentHash: current.deployment_hash,
      sourceHash,
      deploymentHash,
    });
    let deployment: unknown;
    if (deploymentChanged) {
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
      if (!deployed.ok) return finish(deployed);
      deployment = await deployed.json();
    }
    await applyPolicy();
    const sourceChanged = current.source_hash !== sourceHash;
    await env.CONTROL_DB.prepare(
      "UPDATE apps SET source_hash=?,deployment_hash=?,managed_by='git',updated_at=? WHERE id=?",
    ).bind(sourceHash, deploymentHash, Date.now(), refreshed.id).run();
    const result = (await getAppById(env, refreshed.id))!;
      return finish(json({
        app: publicApp(result),
        changed: sourceChanged || policyChanged || resourcesChanged || domainsChanged || deploymentChanged,
        policyChanged: policyChanged || resourcesChanged || domainsChanged,
        deploymentChanged,
        ...(deployment ? { deployment } : {}),
      }));
    } catch (error) {
      return finish(json({ error: `reconciliation failed: ${error instanceof Error ? error.message : error}` }, 500));
    }
  });
}

async function handleApi(req: Request, env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
  const principal = await authenticate(req, env);
  if (!principal) return json({ error: "unauthorized" }, 401);
  const csrf = ensureCsrf(req, principal);
  if (csrf) return csrf;

  if (principal.tokenId) {
    ctx.waitUntil(env.CONTROL_DB.prepare("UPDATE tokens SET last_used_at=? WHERE id=?").bind(Date.now(), principal.tokenId).run());
  }
  if (url.pathname === "/api/session" && req.method === "DELETE") return signOut(req, env);
  if (url.pathname === "/api/identity-links" && req.method === "GET") {
    if (!isPlatformOwner(principal)) return json({ error: "platform owner required" }, 403);
    const { results } = await env.CONTROL_DB.prepare(
      `SELECT id,identity_id,scope,candidate_user_id,email,status,proof,created_at,updated_at
       FROM identity_link_requests WHERE status='pending' ORDER BY created_at`,
    ).all();
    return json({ links: results });
  }
  const identityLinkMatch = url.pathname.match(/^\/api\/identity-links\/([^/]+)\/approve$/);
  if (identityLinkMatch && req.method === "POST") {
    if (!isPlatformOwner(principal)) return json({ error: "platform owner required" }, 403);
    const body = await req.json().catch(() => ({})) as { confirm?: string };
    const link = await env.CONTROL_DB.prepare(
      `SELECT id,identity_id,candidate_user_id FROM identity_link_requests
       WHERE id=? AND scope='platform' AND status='pending'`,
    ).bind(decodeURIComponent(identityLinkMatch[1]!)).first<{ id: string; identity_id: string; candidate_user_id: string | null }>();
    if (!link?.candidate_user_id || body.confirm !== link.candidate_user_id) {
      return json({ error: "confirm the candidate user id" }, 400);
    }
    const updated = await env.CONTROL_DB.prepare(
      "UPDATE users SET identity_id=? WHERE id=? AND identity_id IS NULL",
    ).bind(link.identity_id, link.candidate_user_id).run();
    if (!updated.meta.changes) return json({ error: "identity link conflict" }, 409);
    await env.CONTROL_DB.prepare(
      `UPDATE identity_link_requests SET status='approved',proof='operator',reviewed_by=?,updated_at=? WHERE id=?`,
    ).bind(principal.user.id, Date.now(), link.id).run();
    await audit(env, { actorId: principal.user.id, action: "identity.link.approved", detail: { linkId: link.id, userId: link.candidate_user_id } });
    return json({ ok: true });
  }
  if (url.pathname === "/api/me" && req.method === "GET") {
    const teams = await activeTeamsFor(env, principal);
    return json({
      user: principal.user,
      teams,
      defaultTeamId: teams[0]?.id ?? null,
      platformOwner: isPlatformOwner(principal),
    });
  }
  if (url.pathname === "/api/verify" && req.method === "GET") {
    return json({
      ok: true,
      user: principal.user,
      appId: principal.appId ?? null,
      teamId: principal.teamId ?? null,
      features: { teamReconciliation: 1, reviewedResourceAdoption: 1 },
    });
  }
  if (url.pathname === "/api/app-session-exchange" && req.method === "POST") {
    if (principal.tokenId) return json({ error: "session authentication required" }, 403);
    const body = await req.json().catch(() => null) as { returnTo?: string } | null;
    const callback = body?.returnTo ? await createAppSessionExchange(req, env, body.returnTo) : null;
    return callback ? json({ callback }) : json({ error: "invalid or expired app return" }, 400);
  }
  const organizationResponse = await handleOrganizationApi(req, env, principal, url);
  if (organizationResponse) return organizationResponse;
  const reconcileMatch = url.pathname.match(/^\/api\/reconcile\/apps\/([^/]+)$/);
  if (reconcileMatch) return handleReconcileApp(req, env, principal, decodeURIComponent(reconcileMatch[1]!));
  if (url.pathname === "/api/archived" && req.method === "GET") {
    const archived = (await listAccessibleApps(env, principal, { includeArchived: true }))
      .filter((app) => app.archived_at !== null)
      .sort((left, right) => right.archived_at! - left.archived_at!);
    return json({
      apps: archived.map((app) => {
        const role = roleFromRank(app.effective_rank);
        return {
          ...publicApp(app),
          role,
          permissions: permissionsFor(app, role),
          archivedAt: app.archived_at,
          recoveryUntil: app.archived_at! + RESOURCE_GRACE_MS,
        };
      }),
    });
  }
  const restoreMatch = url.pathname.match(/^\/api\/archived\/([^/]+)\/restore$/);
  if (restoreMatch && req.method === "POST") {
    const app = await getAppIncludingArchived(env, decodeURIComponent(restoreMatch[1]!));
    if (!app?.archived_at || !(await canDestroy(env, app, principal))) return json({ error: "app not found" }, 404);
    const body = await req.json().catch(() => ({})) as { confirm?: string };
    if (body.confirm !== app.slug) return json({ error: `confirm recovery with {"confirm":"${app.slug}"}` }, 400);
    if (Date.now() - app.archived_at >= RESOURCE_GRACE_MS) return json({ error: "app recovery window has expired" }, 410);
    await env.CONTROL_DB.prepare(
      "UPDATE apps SET archived_at=NULL,d1_delete_after=NULL,r2_delete_after=NULL,updated_at=? WHERE id=?",
    ).bind(Date.now(), app.id).run();
    await audit(env, { actorId: principal.user.id, teamId: app.team_id, appId: app.id, action: "app.restored" });
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
    const teamId = url.searchParams.get("teamId") || undefined;
    let apps = await listAccessibleApps(env, principal, { teamId });
    const folderId = url.searchParams.get("folderId");
    if (folderId === "root") apps = apps.filter((app) => app.folder_id === null);
    else if (folderId) apps = apps.filter((app) => app.folder_id === folderId);
    const query = (url.searchParams.get("q") || "").trim().toLowerCase();
    if (query) apps = apps.filter((app) => `${app.name}\n${app.slug}\n${app.description}`.toLowerCase().includes(query));
    const audience = url.searchParams.get("audience");
    if (audience && ["restricted", "team", "public"].includes(audience)) {
      apps = apps.filter((app) => visibilityToAudience(app.visibility) === audience);
    }
    const roleFilter = url.searchParams.get("role");
    if (roleFilter === "viewer" || roleFilter === "editor" || roleFilter === "owner") {
      apps = apps.filter((app) => roleFromRank(app.effective_rank) === roleFilter);
    }
    const sort = url.searchParams.get("sort") || "updated";
    const direction = url.searchParams.get("direction") === "asc" ? 1 : -1;
    apps.sort((left, right) => {
      if (sort === "name") return direction * left.name.localeCompare(right.name);
      if (sort === "created") return direction * (left.created_at - right.created_at);
      return direction * (left.updated_at - right.updated_at);
    });
    return json({ apps: await listedApps(env, apps) });
  }
  if (url.pathname === "/api/apps" && req.method === "POST") return handleCreateApp(req, env, principal);

  if (url.pathname === "/api/manage/apps" && req.method === "GET") {
    if (principal.tokenId) return json({ error: "session authentication required" }, 403);
    const apps = (await listAccessibleApps(env, principal)).filter((app) => app.effective_rank >= 2);
    return json({ platformOwner: isPlatformOwner(principal), apps: await listedApps(env, apps) });
  }

  if (url.pathname === "/api/tokens" && req.method === "GET") {
    if (principal.tokenId) return json({ error: "session authentication required" }, 403);
    const { results } = await env.CONTROL_DB.prepare(
      "SELECT id,name,prefix,app_id,team_id,created_at,last_used_at,expires_at FROM tokens WHERE user_id=? AND revoked_at IS NULL ORDER BY created_at DESC",
    ).bind(principal.user.id).all();
    return json({ tokens: results });
  }
  if (url.pathname === "/api/tokens" && req.method === "POST") {
    if (principal.tokenId) return json({ error: "session authentication required" }, 403);
    const body = await req.json().catch(() => ({})) as { name?: string; appId?: string; teamId?: string };
    if (body.appId && body.teamId) return json({ error: "choose either an app or team scope" }, 400);
    if (body.appId) {
      const app = await getAppById(env, body.appId);
      if (!app || !(await appPermissions(env, app, principal)).modifySecrets) return json({ error: "app not found" }, 404);
    }
    if (body.teamId) {
      const team = (await activeTeamsFor(env, principal)).find(({ id }) => id === body.teamId);
      if (!team || team.role !== "admin") return json({ error: "team admin access required" }, 403);
    }
    const token = await mintToken(env, principal.user.id, body.name || "agent", body.appId || null, body.teamId || null);
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
  const effective = await effectiveAppAccess(env, app, principal.user);
  if (
    !effective.role ||
    (principal.appId && principal.appId !== app.id) ||
    (principal.teamId && principal.teamId !== app.team_id)
  ) return json({ error: "app not found" }, 404);
  const permissions = permissionsFor(app, effective.role);

  if (!tail && req.method === "GET") {
    // Viewers may open an app and read its topology, but deployment internals and the
    // audit trail stay with the people who can change the app.
    const editor = roleAtLeast(effective.role, "editor");
    const { results: deploymentRows } = await env.CONTROL_DB.prepare(
      `SELECT d.id,d.version,d.created_by,d.created_at,d.status,d.worker_key IS NOT NULL has_worker,
       d.manifest_json,u.name created_by_name,u.email created_by_email
       FROM deployments d LEFT JOIN users u ON u.id=d.created_by
       WHERE d.app_id=? ORDER BY d.version DESC LIMIT 50`,
    ).bind(app.id).all<Record<string, unknown>>();
    const activeManifestJson = deploymentRows.find((row) => Number(row.version) === app.active_version)?.manifest_json;
    const deployments = editor
      ? deploymentRows.map(({ manifest_json, ...deployment }) => ({
        ...deployment,
        manifest: typeof manifest_json === "string" ? JSON.parse(manifest_json) : null,
      }))
      : deploymentRows.map(({ version, status, created_at }) => ({ version, status, created_at }));
    const { results: secretRows } = await env.CONTROL_DB.prepare(
      "SELECT name,updated_at FROM app_secrets WHERE app_id=? ORDER BY name",
    ).bind(app.id).all<{ name: string; updated_at: number }>();
    let activity: unknown[] = [];
    if (editor) {
      const { results: auditRows } = await env.CONTROL_DB.prepare(
        `SELECT l.id,l.action,l.detail,l.created_at,u.name user_name,u.email user_email
         FROM audit_log l LEFT JOIN users u ON u.id=l.user_id
         WHERE l.app_id=? ORDER BY l.created_at DESC LIMIT 100`,
      ).bind(app.id).all<{ id: string; action: string; detail: string | null; created_at: number; user_name: string | null; user_email: string | null }>();
      activity = auditRows.map(({ detail, ...entry }) => ({ ...entry, detail: detail ? JSON.parse(detail) : null }));
    }
    const { results: domains } = await env.CONTROL_DB.prepare(
      "SELECT hostname,status,error,created_at,updated_at FROM app_domains WHERE app_id=? ORDER BY hostname",
    ).bind(app.id).all<{ hostname: string; status: string; error: string | null; created_at: number; updated_at: number }>();
    const { results: schedules } = await env.CONTROL_DB.prepare(
      "SELECT id,expression,next_run_at,last_run_at,last_status,last_error FROM app_schedules WHERE app_id=? ORDER BY expression",
    ).bind(app.id).all<{ id: string; expression: string; next_run_at: number; last_run_at: number | null; last_status: string | null; last_error: string | null }>();
    const visibleDomains = editor ? domains : domains.map(({ error: _error, ...domain }) => domain);
    const visibleSchedules = editor ? schedules : schedules.map(({ last_error: _error, ...schedule }) => schedule);
    return json({
      app: { ...publicApp(app), role: effective.role, permissions },
      access: await appAccessDetails(env, app, principal),
      deployments,
      secrets: permissions.modifySecrets ? secretRows : secretRows.map(({ name }) => ({ name })),
      domains: visibleDomains,
      schedules: visibleSchedules,
      activity,
      resources: buildResourceTopology({
        app,
        manifestJson: typeof activeManifestJson === "string" ? activeManifestJson : null,
        domains,
        schedules,
        configuredSecrets: secretRows.map(({ name }) => name),
      }),
    });
  }
  if (tail === "access" && req.method === "GET") return json({ access: await appAccessDetails(env, app, principal) });
  if (tail === "access" && req.method === "PUT") return handleSetAppAccess(req, env, principal, app);
  if (tail === "folder" && req.method === "PATCH") return handleSetAppFolder(req, env, principal, app);
  if (tail.startsWith("secrets/") && req.method === "PUT") {
    if (!permissions.modifySecrets) return json({ error: "editor access required" }, 403);
    return handleSetSecret(req, env, principal, app, decodeURIComponent(tail.slice("secrets/".length)));
  }
  const reviewedGitRollback = tail === "rollback" && req.method === "POST" && isPlatformOwner(principal);
  if (app.managed_by === "git" && req.method !== "GET" && !reviewedGitRollback) {
    return json({ error: "app is managed by git; update its myslop.json and run reconciliation" }, 409);
  }
  if (tail === "adopt" && req.method === "POST") return handleAdoptResources(req, env, principal, app);
  if (tail === "domains" && req.method === "POST") {
    if (!permissions.modifyRuntime) return json({ error: "editor access required" }, 403);
    return json({ error: "custom domains are not yet supported; the default hostname is allocated from the app slug" }, 400);
  }
  if (tail.startsWith("domains/") && req.method === "DELETE") {
    if (!permissions.modifyRuntime) return json({ error: "editor access required" }, 403);
    return handleDeleteDomain(env, principal, app, decodeURIComponent(tail.slice("domains/".length)));
  }
  if (!tail && req.method === "DELETE") return handleDestroyApp(req, env, principal, app);
  if (tail === "prune" && req.method === "POST") return handlePruneApp(req, env, principal, app);
  if (tail === "deployments" && req.method === "POST") {
    if (!permissions.modifyRuntime) return json({ error: "editor access required" }, 403);
    return handleDeploy(req, env, principal, app);
  }
  if (tail === "rollback" && req.method === "POST") {
    if (!permissions.modifyRuntime) return json({ error: "editor access required" }, 403);
    return handleRollback(req, env, principal, app);
  }
  if (!tail && req.method === "PATCH") {
    if (!permissions.modifyMetadata) return json({ error: "editor access required" }, 403);
    const body = await req.json().catch(() => ({})) as { name?: string; description?: string };
    const name = String(body.name ?? app.name).trim().slice(0, 100);
    const description = String(body.description ?? app.description).trim().slice(0, 500);
    if (!name) return json({ error: "app name is required" }, 400);
    await env.CONTROL_DB.prepare("UPDATE apps SET name=?,description=?,updated_at=? WHERE id=?")
      .bind(name, description, Date.now(), app.id).run();
    await audit(env, { actorId: principal.user.id, teamId: app.team_id, appId: app.id, action: "app.metadata.updated", detail: { name, description } });
    return json({ app: await publicAppFor(env, { ...app, name, description }, principal) });
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
        capabilities: { database: false, files: false, secrets: [], network: [], email: false, identity: false, schedules: [], durableObjects: [] },
      } satisfies ResolvedManifest;
      if (!manifest.capabilities.files && app.r2_bucket && app.r2_delete_after && app.r2_delete_after <= Date.now()) {
        await removeFileStorage(env, app);
        app = (await getAppById(env, app.id)) ?? app;
      }
      if (!manifest.capabilities.database && app.d1_id && app.d1_delete_after && app.d1_delete_after <= Date.now()) {
        await removeDatabase(env, app);
      }
      await audit(env, { actorId: "system", teamId: app.team_id, appId: app.id, action: "app.resources_swept" });
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
  const slug = appSlugFromHostname(hostname);
  if (slug) return getAppBySlug(env, slug);
  return env.CONTROL_DB.prepare(
    `SELECT a.* FROM app_domains d JOIN apps a ON a.id=d.app_id
     WHERE d.hostname=? AND d.status='active' AND a.archived_at IS NULL`,
  ).bind(hostname).first<AppRow>();
}

export function appRequestHeaders(req: Request, app: AppRow, user: User | null, role: AppRole | null = null): Headers {
  const headers = new Headers(req.headers);
  for (const name of [...headers.keys()]) {
    const lower = name.toLowerCase();
    if (lower.startsWith("x-myslop-") || (app.visibility !== "public" && (lower === "authorization" || lower === "cookie"))) {
      headers.delete(name);
    }
  }
  if (/^Bearer\s+msa_/i.test(headers.get("authorization") ?? "")) headers.delete("authorization");
  if (app.visibility === "public") {
    const cookies = (headers.get("cookie") ?? "").split(/;\s*/)
      .filter((cookie) => cookie && !cookie.startsWith(`${SESSION_COOKIE}=`) && !cookie.startsWith(`${LEGACY_SESSION_COOKIE}=`));
    if (cookies.length) headers.set("cookie", cookies.join("; "));
    else headers.delete("cookie");
  }
  if (app.visibility !== "public") {
    headers.set("x-myslop-app-id", app.id);
    if (user) {
      headers.set("x-myslop-user-id", user.id);
      if (user.email) headers.set("x-myslop-user-email", user.email);
      if (user.name) headers.set("x-myslop-user-name", user.name);
      if (role) headers.set("x-myslop-app-role", role);
    }
  }
  return headers;
}

async function appDispatchHeaders(
  req: Request,
  env: Env,
  app: AppRow,
  manifest: ResolvedManifest,
  user: User | null,
  role: AppRole | null,
): Promise<Headers> {
  const headers = appRequestHeaders(req, app, user, role);
  if (!manifest.capabilities.identity || !user?.identity_id || !role) return headers;
  const identity = await env.CONTROL_DB.prepare(
    "SELECT email,email_verified,name,picture,session_generation FROM identity_users WHERE id=? AND status='active'",
  ).bind(user.identity_id).first<{
    email: string; email_verified: number; name: string | null; picture: string | null; session_generation: number;
  }>();
  if (!identity || identity.email_verified !== 1) return headers;
  let bodyHash: string | undefined;
  if (req.body && req.method !== "GET" && req.method !== "HEAD") {
    const rawLength = req.headers.get("content-length");
    const length = rawLength === null ? Number.NaN : Number(rawLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > 1024 * 1024) return headers;
    const body = new Uint8Array(await req.clone().arrayBuffer());
    if (body.byteLength !== length) return headers;
    bodyHash = await sha256Hex(body);
  }
  headers.set("x-myslop-identity", await signIdentityAssertion(
    await deriveAppIdentitySecret(env.INTERNAL_DISPATCH_SECRET, app.id),
    req,
    {
      aud: app.id,
      sub: user.identity_id,
      uid: user.id,
      email: identity.email,
      email_verified: true,
      ...(identity.name ? { name: identity.name } : {}),
      ...(identity.picture ? { picture: identity.picture } : {}),
      role,
      sg: identity.session_generation,
    },
    { bodyHash, keyVersion: Math.max(1, Number(env.IDENTITY_ASSERTION_KEY_VERSION) || 1) },
  ));
  return headers;
}

async function handleAppRequest(req: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === "/__email" || url.pathname === "/__scheduled") return new Response("not found\n", { status: 404 });
  const app = await appForHostname(env, url.hostname);
  if (!app || !app.active_version) return new Response("app not found\n", { status: 404 });
  if (url.pathname === "/__myslop/signout" && req.method === "GET") {
    const returnTo = url.searchParams.get("returnTo") ?? "";
    const callback = await createGlobalSignOutExchange(req, env, app.id, url.hostname, returnTo);
    if (!callback) return new Response("sign-out request expired or invalid\n", { status: 400 });
    return new Response(null, {
      status: 302,
      headers: { location: callback, "set-cookie": sessionCookie("", 0), "cache-control": "no-store" },
    });
  }
  if (url.pathname === "/__myslop/session" && req.method === "GET") {
    const exchange = await consumeAppSessionExchange(env, url.searchParams.get("code") ?? "", url.hostname);
    if (!exchange) return new Response("session exchange expired or invalid\n", { status: 400 });
    return new Response(null, {
      status: 302,
      headers: {
        location: exchange.returnTo,
        "set-cookie": sessionCookie(exchange.sessionHandle, SESSION_TTL_MS / 1000),
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  }
  if (url.pathname.startsWith("/__myslop/")) return new Response("not found\n", { status: 404 });
  const user = await getSessionUser(req, env);
  const role = await effectiveAppRole(env, app, user);
  if (!role) {
    const wantsJson = req.headers.get("accept")?.includes("application/json") || req.headers.has("authorization");
    if (wantsJson) return json({ error: "unauthorized" }, 401);
    const returnTo = encodeURIComponent(url.toString());
    return Response.redirect(`${PLATFORM_ORIGIN}/?returnTo=${returnTo}`, 302);
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
    const manifest = parseResolvedManifest(JSON.parse(deployment.manifest_json));
    if (user && (app.visibility !== "public" || manifest.capabilities.identity) && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      if (req.headers.get("origin") !== url.origin) return new Response("bad origin\n", { status: 403 });
    }
    const headers = await appDispatchHeaders(req, env, app, manifest, user, role);
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
    const localPlatform = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.hostname === AUTH_HOST) {
      if (url.pathname === "/health" && (req.method === "GET" || req.method === "HEAD")) return authHealth(env);
      if (url.pathname === "/login" && req.method === "GET") return beginGoogleLogin(req, env);
      if (url.pathname === "/oauth/callback" && req.method === "GET") return completeGoogleLogin(req, env);
      if (url.pathname === "/privacy" && req.method === "GET") return authPrivacy();
      if (url.pathname === "/terms" && req.method === "GET") return authTerms();
      return new Response("not found\n", { status: 404, headers: { "cache-control": "no-store" } });
    }
    if (url.hostname === PLATFORM_HOST && url.pathname === "/__myslop/auth-callback" && req.method === "GET") {
      return consumeAuthCompletion(req, env);
    }
    if (url.hostname === PLATFORM_HOST && url.pathname === "/__myslop/signout" && req.method === "GET") {
      const returnTo = await consumeGlobalSignOutExchange(env, url.searchParams.get("code") ?? "");
      if (!returnTo) return new Response("sign-out request expired or invalid\n", { status: 400 });
      return new Response(null, {
        status: 302,
        headers: { location: returnTo, "set-cookie": sessionCookie("", 0), "cache-control": "no-store" },
      });
    }
    if (PASSTHROUGH_HOSTS.has(url.hostname)) return fetch(req);
    if (url.hostname === PLATFORM_APEX_HOST || url.hostname === "www.myslop.app") {
      return Response.redirect(platformRedirect(url).toString(), 308);
    }
    if (url.hostname === LEGACY_PLATFORM_HOST) {
      if (url.pathname.startsWith("/api/") && (req.method === "GET" || req.method === "HEAD")) {
        return handleApi(req, env, url, ctx);
      }
      if (url.pathname.startsWith("/api/")) {
        return json({ error: `platform API moved to ${PLATFORM_ORIGIN}`, code: "platform_origin_moved" }, 409);
      }
      return Response.redirect(platformRedirect(url).toString(), 308);
    }
    const legacySlug = legacyAppSlugFromHostname(url.hostname);
    if (legacySlug) {
      const target = new URL(url.pathname, appUrl(legacySlug));
      target.search = url.search;
      return Response.redirect(target.toString(), 308);
    }
    if (url.pathname === "/__myslop/session" && req.method === "DELETE") {
      if (req.headers.get("origin") !== url.origin) return new Response("bad origin\n", { status: 403 });
      return signOut(req, env);
    }
    if (url.hostname !== PLATFORM_HOST && !localPlatform) return handleAppRequest(req, env, url);
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
    const dashboardAsset = dashboardAssets.get(url.pathname);
    if (dashboardAsset) return serveDashboardAsset(req, dashboardAsset);
    if (isDashboardPath(url.pathname)) {
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
