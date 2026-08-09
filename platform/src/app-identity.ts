import { verifyIdentityAssertion, type IdentityAssertionClaims } from "./identity-assertion";

const nonceCache = new Map<string, number>();

export interface IdentityAppEnv {
  DB: D1Database;
  MYSLOP_APP_ID?: string;
  MYSLOP_IDENTITY_KEYS?: string;
  MYSLOP_IDENTITY_SECRET?: string;
  MYSLOP_IDENTITY_LINK_DEADLINE?: string;
}

export interface LocalIdentityUser {
  id: string;
  email: string | null;
  name: string | null;
  picture: string | null;
  identity_id: string | null;
}

export interface IdentityRequestResult {
  present: boolean;
  claims: IdentityAssertionClaims | null;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function bodyHash(req: Request): Promise<string | undefined | null> {
  if (!req.body || req.method === "GET" || req.method === "HEAD") return undefined;
  const rawLength = req.headers.get("content-length");
  const length = rawLength === null ? Number.NaN : Number(rawLength);
  if (!Number.isSafeInteger(length) || length < 0 || length > 1024 * 1024) return null;
  const body = await req.clone().arrayBuffer();
  if (body.byteLength !== length) return null;
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", body)));
}

export async function identityFromRequest(req: Request, env: IdentityAppEnv): Promise<IdentityRequestResult> {
  const assertion = req.headers.get("x-myslop-identity");
  if (!assertion) return { present: false, claims: null };
  if (!env.MYSLOP_APP_ID) return { present: true, claims: null };
  let keys: string | Record<string, string> | null = env.MYSLOP_IDENTITY_SECRET ?? null;
  if (env.MYSLOP_IDENTITY_KEYS) {
    try {
      const parsed = JSON.parse(env.MYSLOP_IDENTITY_KEYS) as Record<string, unknown>;
      if (!Object.values(parsed).every((value) => typeof value === "string")) return { present: true, claims: null };
      keys = parsed as Record<string, string>;
    } catch {
      return { present: true, claims: null };
    }
  }
  if (!keys) return { present: true, claims: null };
  const requestBodyHash = await bodyHash(req);
  if (requestBodyHash === null) return { present: true, claims: null };
  const claims = await verifyIdentityAssertion(
    keys,
    assertion,
    req,
    env.MYSLOP_APP_ID,
    { bodyHash: requestBodyHash },
  );
  if (!claims) return { present: true, claims: null };
  const now = Date.now();
  for (const [nonce, expiry] of nonceCache) if (expiry <= now) nonceCache.delete(nonce);
  if (nonceCache.has(claims.jti)) return { present: true, claims: null };
  nonceCache.set(claims.jti, claims.exp * 1000);
  return { present: true, claims };
}

function linkWindowOpen(env: IdentityAppEnv): boolean {
  const deadline = Number(env.MYSLOP_IDENTITY_LINK_DEADLINE ?? "0");
  return Number.isSafeInteger(deadline) && Date.now() <= deadline;
}

async function byIdentity(env: IdentityAppEnv, identityId: string): Promise<LocalIdentityUser | null> {
  return (await env.DB.prepare(
    "SELECT id,email,name,picture,identity_id FROM users WHERE identity_id=?",
  ).bind(identityId).first<LocalIdentityUser>()) ?? null;
}

async function linkUser(
  env: IdentityAppEnv,
  claims: IdentityAssertionClaims,
  userId: string,
  method: "legacy_session" | "api_token" | "operator",
): Promise<LocalIdentityUser | null> {
  if (!linkWindowOpen(env)) return null;
  const existing = await env.DB.prepare("SELECT id,email,identity_id FROM users WHERE id=?")
    .bind(userId).first<{ id: string; email: string | null; identity_id: string | null }>();
  if (!existing || (existing.identity_id && existing.identity_id !== claims.sub)) return null;
  if (existing.identity_id === claims.sub) return byIdentity(env, claims.sub);
  try {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE users SET identity_id=?,name=COALESCE(?,name),picture=COALESCE(?,picture) WHERE id=? AND identity_id IS NULL",
      ).bind(claims.sub, claims.name ?? null, claims.picture ?? null, userId),
      env.DB.prepare(
        `INSERT INTO identity_links (identity_id,user_id,method,linked_at)
         SELECT ?,id,?,? FROM users WHERE id=? AND identity_id=?`,
      ).bind(claims.sub, method, Date.now(), userId, claims.sub),
    ]);
  } catch {
    return byIdentity(env, claims.sub);
  }
  return byIdentity(env, claims.sub);
}

export async function resolveIdentityUser(
  env: IdentityAppEnv,
  claims: IdentityAssertionClaims,
  legacyUser: LocalIdentityUser | null,
): Promise<{ user: LocalIdentityUser | null; linkRequired: boolean }> {
  const linked = await byIdentity(env, claims.sub);
  if (linked) return { user: linked, linkRequired: false };
  if (legacyUser) {
    const linkedLegacy = await linkUser(env, claims, legacyUser.id, "legacy_session");
    if (linkedLegacy) return { user: linkedLegacy, linkRequired: false };
  }
  const candidate = await env.DB.prepare("SELECT id FROM users WHERE email=? COLLATE NOCASE LIMIT 1")
    .bind(claims.email).first<{ id: string }>();
  if (candidate) return { user: null, linkRequired: true };
  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO users (id,email,name,picture,identity_id,created_at) VALUES (?,?,?,?,?,?)",
      ).bind(claims.sub, claims.email, claims.name ?? null, claims.picture ?? null, claims.sub, Date.now()),
      env.DB.prepare(
        "INSERT INTO identity_links (identity_id,user_id,method,linked_at) VALUES (?,?,'new',?)",
      ).bind(claims.sub, claims.sub, Date.now()),
    ]);
  } catch {
    const concurrent = await byIdentity(env, claims.sub);
    return { user: concurrent, linkRequired: !concurrent };
  }
  return { user: await byIdentity(env, claims.sub), linkRequired: false };
}

export async function linkIdentityWithUser(
  env: IdentityAppEnv,
  claims: IdentityAssertionClaims,
  userId: string,
): Promise<LocalIdentityUser | null> {
  return linkUser(env, claims, userId, "api_token");
}
