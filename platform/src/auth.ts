import {
  base64url,
  json,
  randomHex,
  readCookie,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  sessionCookie,
  sha256Hex,
  TOKEN_PREFIX,
  TOKEN_TTL_MS,
  validAppReturnUrl,
} from "./core";
import { appSlugFromHostname, PLATFORM_HOST, PLATFORM_ORIGIN } from "./domains";
import type { Env, User } from "./types";

export async function createAppSessionExchange(
  req: Request,
  env: Env,
  returnTo: string,
): Promise<string | null> {
  if (!validAppReturnUrl(returnTo)) return null;
  const sessionId = readCookie(req, SESSION_COOKIE);
  if (!sessionId || !(await getSessionUser(req, env))) return null;
  const target = new URL(returnTo);
  const slug = appSlugFromHostname(target.hostname);
  if (!slug) return null;
  const app = await env.CONTROL_DB.prepare(
    "SELECT id FROM apps WHERE slug=? AND archived_at IS NULL AND active_version IS NOT NULL",
  ).bind(slug).first<{ id: string }>();
  if (!app) return null;
  const code = randomHex(32);
  const codeHash = await sha256Hex(code);
  const now = Date.now();
  await env.CONTROL_DB.prepare(
    `INSERT INTO app_session_exchanges (code_hash,session_id,app_id,hostname,return_to,expires_at,created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(codeHash, sessionId, app.id, target.hostname, target.toString(), now + 60_000, now).run();
  await env.CONTROL_DB.prepare("DELETE FROM app_session_exchanges WHERE expires_at<?").bind(now).run();
  const callback = new URL("/__myslop/session", target.origin);
  callback.searchParams.set("code", code);
  return callback.toString();
}

export async function createGlobalSignOutExchange(
  req: Request,
  env: Env,
  appId: string,
  hostname: string,
  returnTo: string,
): Promise<string | null> {
  if (!validAppReturnUrl(returnTo)) return null;
  const target = new URL(returnTo);
  if (target.hostname !== hostname) return null;
  const handle = readCookie(req, SESSION_COOKIE);
  if (!handle) return null;
  const appSession = await env.CONTROL_DB.prepare(
    `SELECT session_id FROM app_sessions
     WHERE handle_hash=? AND app_id=? AND hostname=? AND expires_at>?`,
  ).bind(await sha256Hex(handle), appId, hostname, Date.now()).first<{ session_id: string }>();
  if (!appSession) return null;
  const code = randomHex(32);
  const now = Date.now();
  await env.CONTROL_DB.prepare(
    `INSERT INTO app_session_exchanges (code_hash,session_id,app_id,hostname,return_to,expires_at,created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(await sha256Hex(code), appSession.session_id, appId, "__signout__", target.toString(), now + 60_000, now).run();
  const callback = new URL("/__myslop/signout", PLATFORM_ORIGIN);
  callback.searchParams.set("code", code);
  return callback.toString();
}

export async function consumeGlobalSignOutExchange(
  env: Env,
  code: string,
): Promise<string | null> {
  if (!/^[a-f0-9]{64}$/.test(code)) return null;
  const exchange = await env.CONTROL_DB.prepare(
    `DELETE FROM app_session_exchanges
     WHERE code_hash=? AND hostname='__signout__' AND expires_at>?
     RETURNING session_id,return_to`,
  ).bind(await sha256Hex(code), Date.now()).first<{ session_id: string; return_to: string }>();
  if (!exchange || !validAppReturnUrl(exchange.return_to)) return null;
  await env.CONTROL_DB.prepare("DELETE FROM sessions WHERE id=?").bind(exchange.session_id).run();
  return exchange.return_to;
}

export async function consumeAppSessionExchange(
  env: Env,
  code: string,
  hostname: string,
): Promise<{ sessionHandle: string; returnTo: string } | null> {
  if (!/^[a-f0-9]{64}$/.test(code)) return null;
  const codeHash = await sha256Hex(code);
  const now = Date.now();
  const exchange = await env.CONTROL_DB.prepare(
    `DELETE FROM app_session_exchanges
     WHERE code_hash=? AND hostname=? AND expires_at>?
     RETURNING session_id,app_id,return_to`,
  ).bind(codeHash, hostname, now).first<{ session_id: string; app_id: string; return_to: string }>();
  if (!exchange || !validAppReturnUrl(exchange.return_to)) return null;
  const target = new URL(exchange.return_to);
  if (target.hostname !== hostname) return null;
  const session = await env.CONTROL_DB.prepare(
    `SELECT s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id
     LEFT JOIN identity_users i ON i.id=u.identity_id
     WHERE s.id=? AND s.expires_at>?
       AND (u.identity_id IS NULL OR (i.status='active' AND (s.identity_generation IS NULL OR s.identity_generation=i.session_generation)))`,
  ).bind(exchange.session_id, now).first<{ expires_at: number }>();
  if (!session) return null;
  const handle = randomHex(32);
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare("DELETE FROM app_sessions WHERE session_id=? AND app_id=? AND hostname=?")
      .bind(exchange.session_id, exchange.app_id, hostname),
    env.CONTROL_DB.prepare(
      `INSERT INTO app_sessions (handle_hash,session_id,app_id,hostname,expires_at,created_at)
       VALUES (?,?,?,?,?,?)`,
    ).bind(await sha256Hex(handle), exchange.session_id, exchange.app_id, hostname, session.expires_at, now),
  ]);
  return { sessionHandle: handle, returnTo: target.toString() };
}

export async function getSessionUser(req: Request, env: Env): Promise<User | null> {
  const id = readCookie(req, SESSION_COOKIE);
  if (!id || !/^[a-f0-9]{64}$/.test(id)) return null;
  const hostname = new URL(req.url).hostname;
  const fields = "u.id,u.email,u.name,u.picture,u.identity_id,u.platform_role";
  const identityGuard = `(u.identity_id IS NULL OR (
    i.status='active' AND (s.identity_generation IS NULL OR s.identity_generation=i.session_generation)
  ))`;
  if (hostname === PLATFORM_HOST || hostname === "localhost" || hostname === "127.0.0.1") {
    return (await env.CONTROL_DB.prepare(
      `SELECT ${fields} FROM sessions s JOIN users u ON u.id=s.user_id
       LEFT JOIN identity_users i ON i.id=u.identity_id
       WHERE s.id=? AND s.expires_at>? AND ${identityGuard}`,
    ).bind(id, Date.now()).first<User>()) ?? null;
  }
  const appSession = await env.CONTROL_DB.prepare(
    `SELECT ${fields} FROM app_sessions a JOIN sessions s ON s.id=a.session_id
     JOIN users u ON u.id=s.user_id LEFT JOIN identity_users i ON i.id=u.identity_id
     WHERE a.handle_hash=? AND a.hostname=? AND a.expires_at>? AND s.expires_at>? AND ${identityGuard}`,
  ).bind(await sha256Hex(id), hostname, Date.now(), Date.now()).first<User>();
  if (appSession) return appSession;
  // Compatibility for host-only app cookies issued before distinct app handles existed.
  return (await env.CONTROL_DB.prepare(
    `SELECT ${fields} FROM sessions s JOIN users u ON u.id=s.user_id
     LEFT JOIN identity_users i ON i.id=u.identity_id
     WHERE s.id=? AND s.expires_at>? AND ${identityGuard}`,
  ).bind(id, Date.now()).first<User>()) ?? null;
}

export interface Principal {
  user: User;
  tokenId?: string;
  appId?: string | null;
  teamId?: string | null;
}

export async function authenticate(req: Request, env: Env): Promise<Principal | null> {
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (bearer.startsWith(TOKEN_PREFIX)) {
    const hash = await sha256Hex(bearer);
    const row = await env.CONTROL_DB.prepare(
      `SELECT t.id token_id,t.user_id,t.app_id,t.team_id,u.email,u.name,u.picture,u.identity_id,u.platform_role
       FROM tokens t JOIN users u ON u.id=t.user_id
       WHERE t.hash=? AND t.revoked_at IS NULL AND t.expires_at>?`,
    ).bind(hash, Date.now()).first<{ token_id: string; user_id: string; app_id: string | null; team_id: string | null; email: string | null; name: string | null; picture: string | null; identity_id: string | null; platform_role: "member" | "owner" }>();
    if (!row) return null;
    return {
      user: { id: row.user_id, email: row.email, name: row.name, picture: row.picture, identity_id: row.identity_id, platform_role: row.platform_role },
      tokenId: row.token_id,
      appId: row.app_id,
      teamId: row.team_id,
    };
  }
  const user = await getSessionUser(req, env);
  return user ? { user } : null;
}

export async function mintToken(
  env: Env,
  userId: string,
  name: string,
  appId: string | null = null,
  teamId: string | null = null,
) {
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
  if (appId && teamId) throw new Error("a token cannot be scoped to both an app and a team");
  await env.CONTROL_DB.prepare(
    "INSERT INTO tokens (id,user_id,app_id,team_id,hash,name,prefix,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ).bind(token.id, userId, appId, teamId, token.hash, token.name, token.prefix, token.createdAt, token.expiresAt).run();
  return token;
}

export async function signOut(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (user) await env.CONTROL_DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(user.id).run();
  return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });
}
