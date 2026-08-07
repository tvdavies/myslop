import {
  base64url,
  decodeBase64url,
  json,
  randomHex,
  readCookie,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  sessionCookie,
  sha256Hex,
  TOKEN_PREFIX,
  TOKEN_TTL_MS,
} from "./core";
import type { Env, User } from "./types";

const SHOO_ISSUER = "https://shoo.dev";
const SHOO_JWKS_URL = "https://shoo.dev/.well-known/jwks.json";
const enc = new TextEncoder();
const dec = new TextDecoder();

let jwksCache: { keys: Map<string, CryptoKey>; fetchedAt: number } | null = null;

async function loadJwks(force = false): Promise<Map<string, CryptoKey>> {
  if (!force && jwksCache && Date.now() - jwksCache.fetchedAt < 3_600_000) return jwksCache.keys;
  const response = await fetch(SHOO_JWKS_URL);
  if (!response.ok) throw new Error(`Shoo JWKS request failed: ${response.status}`);
  const body = (await response.json()) as { keys: (JsonWebKey & { kid?: string })[] };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys) {
    if (jwk.kty !== "EC") continue;
    keys.set(
      jwk.kid ?? "",
      await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]),
    );
  }
  jwksCache = { keys, fetchedAt: Date.now() };
  return keys;
}

interface ShooClaims {
  iss: string;
  aud: string;
  exp: number;
  pairwise_sub: string;
  email?: string;
  name?: string;
  picture?: string;
}

async function verifyShooToken(token: string): Promise<ShooClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header: { alg?: string; kid?: string };
  let claims: ShooClaims;
  try {
    header = JSON.parse(dec.decode(decodeBase64url(parts[0])));
    claims = JSON.parse(dec.decode(decodeBase64url(parts[1])));
  } catch {
    return null;
  }
  if (header.alg !== "ES256") return null;
  let keys = await loadJwks();
  let key = keys.get(header.kid ?? "");
  if (!key) {
    keys = await loadJwks(true);
    key = keys.get(header.kid ?? "");
  }
  if (!key) return null;
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    decodeBase64url(parts[2]) as BufferSource,
    enc.encode(`${parts[0]}.${parts[1]}`) as BufferSource,
  );
  if (!valid || claims.iss !== SHOO_ISSUER || claims.aud !== "origin:https://apps.myslop.app") return null;
  if (!claims.pairwise_sub || claims.exp < Date.now() / 1000) return null;
  return claims;
}

export async function exchangeSession(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  let idToken = "";
  try {
    idToken = ((await req.json()) as { id_token?: string }).id_token ?? "";
  } catch {
    return json({ error: "invalid body" }, 400);
  }
  const claims = await verifyShooToken(idToken);
  if (!claims) return json({ error: "invalid identity token" }, 401);
  const domain = (env.ALLOWED_EMAIL_DOMAIN || "lleverage.ai").toLowerCase();
  if (!claims.email || !claims.email.toLowerCase().endsWith(`@${domain}`)) {
    return json({ error: `sign in with your @${domain} account` }, 403);
  }
  const now = Date.now();
  await env.CONTROL_DB.prepare(
    `INSERT INTO users (id, email, name, picture, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET email=excluded.email, name=excluded.name, picture=excluded.picture`,
  ).bind(claims.pairwise_sub, claims.email ?? null, claims.name ?? null, claims.picture ?? null, now).run();
  const id = randomHex(32);
  await env.CONTROL_DB.prepare(
    "INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
  ).bind(id, claims.pairwise_sub, now, now + SESSION_TTL_MS).run();
  ctx.waitUntil(env.CONTROL_DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now).run());
  return json({ ok: true }, 200, { "set-cookie": sessionCookie(id, SESSION_TTL_MS / 1000) });
}

export async function getSessionUser(req: Request, env: Env): Promise<User | null> {
  const id = readCookie(req, SESSION_COOKIE);
  if (!id || !/^[a-f0-9]{64}$/.test(id)) return null;
  return (await env.CONTROL_DB.prepare(
    `SELECT u.id, u.email, u.name, u.picture, u.platform_role FROM sessions s JOIN users u ON u.id=s.user_id
     WHERE s.id=? AND s.expires_at>?`,
  ).bind(id, Date.now()).first<User>()) ?? null;
}

export interface Principal {
  user: User;
  tokenId?: string;
  appId?: string | null;
}

export async function authenticate(req: Request, env: Env): Promise<Principal | null> {
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (bearer.startsWith(TOKEN_PREFIX)) {
    const hash = await sha256Hex(bearer);
    const row = await env.CONTROL_DB.prepare(
      `SELECT t.id token_id, t.user_id, t.app_id, u.email, u.name, u.picture, u.platform_role
       FROM tokens t JOIN users u ON u.id=t.user_id
       WHERE t.hash=? AND t.revoked_at IS NULL AND t.expires_at>?`,
    ).bind(hash, Date.now()).first<{ token_id: string; user_id: string; app_id: string | null; email: string | null; name: string | null; picture: string | null; platform_role: "member" | "owner" }>();
    if (!row) return null;
    return {
      user: { id: row.user_id, email: row.email, name: row.name, picture: row.picture, platform_role: row.platform_role },
      tokenId: row.token_id,
      appId: row.app_id,
    };
  }
  const user = await getSessionUser(req, env);
  return user ? { user } : null;
}

export async function mintToken(env: Env, userId: string, name: string, appId: string | null = null) {
  const secret = TOKEN_PREFIX + base64url(crypto.getRandomValues(new Uint8Array(32)));
  const token = {
    id: randomHex(8),
    secret,
    hash: await sha256Hex(secret),
    name: name.trim().slice(0, 64) || "agent",
    prefix: secret.slice(0, 12),
    createdAt: Date.now(),
    expiresAt: Date.now() + TOKEN_TTL_MS,
  };
  await env.CONTROL_DB.prepare(
    "INSERT INTO tokens (id,user_id,app_id,hash,name,prefix,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?)",
  ).bind(token.id, userId, appId, token.hash, token.name, token.prefix, token.createdAt, token.expiresAt).run();
  return token;
}

export async function signOut(req: Request, env: Env): Promise<Response> {
  const id = readCookie(req, SESSION_COOKIE);
  if (id) await env.CONTROL_DB.prepare("DELETE FROM sessions WHERE id=?").bind(id).run();
  return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });
}
