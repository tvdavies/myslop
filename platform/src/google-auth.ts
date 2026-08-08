import * as oauth from "oauth4webapi";

import { base64url, decodeBase64, json, randomHex, readCookie, SESSION_COOKIE, SESSION_TTL_MS, sessionCookie, sha256Hex } from "./core";
import { AUTH_ORIGIN, PLATFORM_ORIGIN } from "./domains";
import { decryptSecret, encryptSecret } from "./secrets";
import type { Env } from "./types";

const GOOGLE_ISSUER = new URL("https://accounts.google.com");
const GOOGLE_CALLBACK = `${AUTH_ORIGIN}/oauth/callback`;
const TRANSACTION_TTL_MS = 10 * 60_000;
const COMPLETION_TTL_MS = 60_000;
const RATE_WINDOW_MS = 10 * 60_000;
const RATE_ATTEMPTS = 30;

let discoveryCache: { value: oauth.AuthorizationServer; fetchedAt: number } | null = null;
const remoteJwksCache: oauth.JWKSCacheInput = {};

interface OAuthSecret {
  state: string;
  nonce: string;
  verifier: string;
}

interface GoogleIdentityClaims {
  iss: string;
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
  picture?: string;
}

function authHeaders(contentType = "text/html; charset=utf-8"): HeadersInit {
  return {
    "content-type": contentType,
    "cache-control": "no-store",
    pragma: "no-cache",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'; base-uri 'none'",
  };
}

function page(title: string, message: string, status = 200): Response {
  const escape = (value: string) => value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>body{font:15px system-ui;margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f7f7;color:#171717}.card{width:min(420px,calc(100% - 40px));padding:28px;background:#fff;border:1px solid #ddd;border-radius:14px}.mark{font-weight:700;margin-bottom:28px}h1{font-size:22px;margin:0 0 10px}p{line-height:1.55;color:#555;margin:0}a{color:inherit}</style><main class="card"><div class="mark">Myslop</div><h1>${escape(title)}</h1><p>${escape(message)}</p></main></html>`, { status, headers: authHeaders() });
}

function safeReturnTo(value: string | null): string | null {
  if (!value) return PLATFORM_ORIGIN;
  try {
    const url = new URL(value);
    if (url.origin !== PLATFORM_ORIGIN || url.username || url.password || url.port || url.hash) return null;
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/__myslop/")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function configured(env: Env): env is Env & { GOOGLE_OAUTH_CLIENT_ID: string; GOOGLE_OAUTH_CLIENT_SECRET: string } {
  return Boolean(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET);
}

async function authorizationServer(): Promise<oauth.AuthorizationServer> {
  if (discoveryCache && Date.now() - discoveryCache.fetchedAt < 3_600_000) return discoveryCache.value;
  const response = await oauth.discoveryRequest(GOOGLE_ISSUER);
  const value = await oauth.processDiscoveryResponse(GOOGLE_ISSUER, response);
  discoveryCache = { value, fetchedAt: Date.now() };
  return value;
}

async function rateKey(env: Env, req: Request, action: string): Promise<string> {
  const raw = decodeBase64(env.SECRET_ENCRYPTION_KEY);
  const material = await crypto.subtle.importKey("raw", raw as BufferSource, "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: new TextEncoder().encode("myslop-auth-rate-v1") },
    material,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
  const ip = req.headers.get("cf-connecting-ip") ?? "local";
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${action}\0${ip}`));
  return base64url(new Uint8Array(signature));
}

async function enforceRateLimit(env: Env, req: Request, action: string): Promise<boolean> {
  const now = Date.now();
  const windowStart = Math.floor(now / RATE_WINDOW_MS) * RATE_WINDOW_MS;
  const key = await rateKey(env, req, action);
  const row = await env.CONTROL_DB.prepare(
    `INSERT INTO auth_rate_limits (key,window_start,attempts,expires_at) VALUES (?,?,1,?)
     ON CONFLICT(key,window_start) DO UPDATE SET attempts=attempts+1
     RETURNING attempts`,
  ).bind(key, windowStart, windowStart + RATE_WINDOW_MS * 2).first<{ attempts: number }>();
  return Boolean(row && row.attempts <= RATE_ATTEMPTS);
}

async function audit(
  env: Env,
  action: string,
  values: { identityId?: string | null; userId?: string | null; client?: string; detail?: Record<string, unknown> } = {},
): Promise<void> {
  await env.CONTROL_DB.prepare(
    "INSERT INTO identity_audit_log (id,identity_id,user_id,action,client,detail,created_at) VALUES (?,?,?,?,?,?,?)",
  ).bind(
    `ial_${randomHex(12)}`,
    values.identityId ?? null,
    values.userId ?? null,
    action,
    values.client ?? null,
    values.detail ? JSON.stringify(values.detail) : null,
    Date.now(),
  ).run();
}

async function identityForClaims(env: Env, claims: GoogleIdentityClaims): Promise<string> {
  const now = Date.now();
  const provider = await env.CONTROL_DB.prepare(
    "SELECT identity_id FROM identity_provider_accounts WHERE issuer=? AND subject=?",
  ).bind(claims.iss, claims.sub).first<{ identity_id: string }>();
  if (provider) {
    await env.CONTROL_DB.batch([
      env.CONTROL_DB.prepare(
        `UPDATE identity_users SET email=?,email_verified=1,name=?,picture=?,updated_at=?,last_login_at=?
         WHERE id=? AND status='active'`,
      ).bind(claims.email, claims.name ?? null, claims.picture ?? null, now, now, provider.identity_id),
      env.CONTROL_DB.prepare(
        "UPDATE identity_provider_accounts SET last_login_at=? WHERE issuer=? AND subject=?",
      ).bind(now, claims.iss, claims.sub),
    ]);
    const active = await env.CONTROL_DB.prepare("SELECT 1 ok FROM identity_users WHERE id=? AND status='active'")
      .bind(provider.identity_id).first();
    if (!active) throw new Error("identity disabled");
    return provider.identity_id;
  }

  const identityId = `mui_${randomHex(16)}`;
  try {
    await env.CONTROL_DB.batch([
      env.CONTROL_DB.prepare(
        `INSERT INTO identity_users
         (id,email,email_verified,name,picture,status,session_generation,created_at,updated_at,last_login_at)
         VALUES (?,?,?,?,?,'active',1,?,?,?)`,
      ).bind(identityId, claims.email, 1, claims.name ?? null, claims.picture ?? null, now, now, now),
      env.CONTROL_DB.prepare(
        "INSERT INTO identity_provider_accounts (issuer,subject,identity_id,created_at,last_login_at) VALUES (?,?,?,?,?)",
      ).bind(claims.iss, claims.sub, identityId, now, now),
    ]);
    return identityId;
  } catch (error) {
    const concurrent = await env.CONTROL_DB.prepare(
      "SELECT identity_id FROM identity_provider_accounts WHERE issuer=? AND subject=?",
    ).bind(claims.iss, claims.sub).first<{ identity_id: string }>();
    if (!concurrent) throw error;
    return concurrent.identity_id;
  }
}

async function platformCandidate(
  env: Env,
  identityId: string,
  claims: GoogleIdentityClaims,
): Promise<{ userId: string | null; linked: boolean }> {
  const linked = await env.CONTROL_DB.prepare("SELECT id FROM users WHERE identity_id=?")
    .bind(identityId).first<{ id: string }>();
  if (linked) return { userId: linked.id, linked: true };

  const candidate = await env.CONTROL_DB.prepare("SELECT id,identity_id FROM users WHERE email=? COLLATE NOCASE LIMIT 1")
    .bind(claims.email).first<{ id: string; identity_id: string | null }>();
  if (!candidate) return { userId: null, linked: false };
  if (candidate.identity_id && candidate.identity_id !== identityId) throw new Error("identity link conflict");
  const now = Date.now();
  await env.CONTROL_DB.prepare(
    `INSERT INTO identity_link_requests
     (id,identity_id,scope,candidate_user_id,email,status,created_at,updated_at)
     VALUES (?,?, 'platform', ?,?,'pending',?,?)
     ON CONFLICT(identity_id,scope) DO UPDATE SET candidate_user_id=excluded.candidate_user_id,
       email=excluded.email,updated_at=excluded.updated_at
     WHERE identity_link_requests.status='pending'`,
  ).bind(`ilr_${randomHex(12)}`, identityId, candidate.id, claims.email, now, now).run();
  return { userId: candidate.id, linked: false };
}

export async function beginGoogleLogin(req: Request, env: Env): Promise<Response> {
  if (!configured(env)) return page("Sign-in is not ready", "Myslop authentication has not been configured yet.", 503);
  if (!(await enforceRateLimit(env, req, "login"))) return page("Try again later", "Too many sign-in attempts were received.", 429);
  const returnTo = safeReturnTo(new URL(req.url).searchParams.get("returnTo"));
  if (!returnTo) return page("Invalid return address", "Return to Myslop and start sign-in again.", 400);

  const state = oauth.generateRandomState();
  const nonce = oauth.generateRandomNonce();
  const verifier = oauth.generateRandomCodeVerifier();
  const encrypted = await encryptSecret(env, JSON.stringify({ state, nonce, verifier } satisfies OAuthSecret));
  const now = Date.now();
  await env.CONTROL_DB.prepare(
    `INSERT INTO oauth_transactions
     (state_hash,secret_ciphertext,secret_iv,return_to,expires_at,created_at) VALUES (?,?,?,?,?,?)`,
  ).bind(await sha256Hex(state), encrypted.ciphertext, encrypted.iv, returnTo, now + TRANSACTION_TTL_MS, now).run();

  const server = await authorizationServer();
  if (!server.authorization_endpoint) throw new Error("Google authorization endpoint is unavailable");
  const authorize = new URL(server.authorization_endpoint);
  authorize.search = new URLSearchParams({
    client_id: env.GOOGLE_OAUTH_CLIENT_ID,
    redirect_uri: GOOGLE_CALLBACK,
    response_type: "code",
    scope: "openid email profile",
    state,
    nonce,
    code_challenge: await oauth.calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  await audit(env, "identity.login.started", { client: "myslop.cloud" });
  return new Response(null, { status: 302, headers: { ...authHeaders(), location: authorize.toString() } });
}

export async function completeGoogleLogin(req: Request, env: Env): Promise<Response> {
  if (!configured(env)) return page("Sign-in is not ready", "Myslop authentication has not been configured yet.", 503);
  if (!(await enforceRateLimit(env, req, "callback"))) return page("Try again later", "Too many sign-in attempts were received.", 429);
  const url = new URL(req.url);
  const state = url.searchParams.get("state") ?? "";
  if (!state) return page("Sign-in could not continue", "The sign-in request is invalid or expired.", 400);
  const transaction = await env.CONTROL_DB.prepare(
    `DELETE FROM oauth_transactions WHERE state_hash=? AND expires_at>?
     RETURNING secret_ciphertext,secret_iv,return_to`,
  ).bind(await sha256Hex(state), Date.now()).first<{ secret_ciphertext: string; secret_iv: string; return_to: string }>();
  if (!transaction) return page("Sign-in expired", "Return to Myslop and start sign-in again.", 400);

  try {
    const secret = JSON.parse(await decryptSecret(env, transaction.secret_ciphertext, transaction.secret_iv)) as OAuthSecret;
    const returnTo = safeReturnTo(transaction.return_to);
    if (!returnTo || secret.state !== state) throw new Error("invalid transaction");
    const server = await authorizationServer();
    const client: oauth.Client = { client_id: env.GOOGLE_OAUTH_CLIENT_ID, id_token_signed_response_alg: "RS256" };
    const parameters = oauth.validateAuthResponse(server, client, url.searchParams, secret.state);
    const tokenResponse = await oauth.authorizationCodeGrantRequest(
      server,
      client,
      oauth.ClientSecretPost(env.GOOGLE_OAUTH_CLIENT_SECRET),
      parameters,
      GOOGLE_CALLBACK,
      secret.verifier,
    );
    const tokens = await oauth.processAuthorizationCodeResponse(server, client, tokenResponse, {
      expectedNonce: secret.nonce,
      requireIdToken: true,
    });
    await oauth.validateApplicationLevelSignature(server, tokenResponse, { [oauth.jwksCache]: remoteJwksCache });
    const rawClaims = oauth.getValidatedIdTokenClaims(tokens);
    if (
      !rawClaims || rawClaims.iss !== GOOGLE_ISSUER.origin || typeof rawClaims.sub !== "string" || !rawClaims.sub ||
      typeof rawClaims.email !== "string" || rawClaims.email_verified !== true
    ) throw new Error("invalid Google identity");
    const claims: GoogleIdentityClaims = {
      iss: rawClaims.iss,
      sub: rawClaims.sub,
      email: rawClaims.email.toLowerCase(),
      email_verified: true,
      ...(typeof rawClaims.name === "string" ? { name: rawClaims.name } : {}),
      ...(typeof rawClaims.picture === "string" ? { picture: rawClaims.picture } : {}),
    };
    const identityId = await identityForClaims(env, claims);
    const candidate = await platformCandidate(env, identityId, claims);
    const code = randomHex(32);
    const now = Date.now();
    await env.CONTROL_DB.prepare(
      `INSERT INTO auth_completion_codes
       (code_hash,identity_id,candidate_user_id,return_to,expires_at,created_at) VALUES (?,?,?,?,?,?)`,
    ).bind(await sha256Hex(code), identityId, candidate.userId, returnTo, now + COMPLETION_TTL_MS, now).run();
    await audit(env, "identity.login.google_verified", { identityId, userId: candidate.userId, client: "myslop.cloud", detail: { linked: candidate.linked } });
    const complete = new URL("/__myslop/auth-callback", PLATFORM_ORIGIN);
    complete.searchParams.set("code", code);
    return new Response(null, { status: 302, headers: { ...authHeaders(), location: complete.toString() } });
  } catch (error) {
    console.error("first-party identity callback failed", {
      name: error instanceof Error ? error.name : "Error",
      code: typeof error === "object" && error && "code" in error ? String(error.code) : undefined,
    });
    await audit(env, "identity.login.failed", { client: "myslop.cloud" }).catch(() => undefined);
    return page("Sign-in could not continue", "Return to Myslop and try again. No session was created.", 400);
  }
}

export async function consumeAuthCompletion(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code") ?? "";
  if (!/^[a-f0-9]{64}$/.test(code)) return page("Sign-in could not continue", "The sign-in request is invalid or expired.", 400);
  const completion = await env.CONTROL_DB.prepare(
    `DELETE FROM auth_completion_codes WHERE code_hash=? AND expires_at>?
     RETURNING identity_id,candidate_user_id,return_to`,
  ).bind(await sha256Hex(code), Date.now()).first<{ identity_id: string; candidate_user_id: string | null; return_to: string }>();
  if (!completion) return page("Sign-in expired", "Return to Myslop and start sign-in again.", 400);
  const returnTo = safeReturnTo(completion.return_to);
  if (!returnTo) return page("Sign-in could not continue", "The return address was rejected.", 400);

  let user = await env.CONTROL_DB.prepare("SELECT id,identity_id FROM users WHERE identity_id=?")
    .bind(completion.identity_id).first<{ id: string; identity_id: string | null }>();
  const legacySessionId = readCookie(req, SESSION_COOKIE);
  const legacy = legacySessionId
    ? await env.CONTROL_DB.prepare(
      `SELECT u.id,u.identity_id FROM sessions s JOIN users u ON u.id=s.user_id
       WHERE s.id=? AND s.expires_at>?`,
    ).bind(legacySessionId, Date.now()).first<{ id: string; identity_id: string | null }>()
    : null;

  if (!user && legacy && (!completion.candidate_user_id || completion.candidate_user_id === legacy.id)) {
    if (legacy.identity_id && legacy.identity_id !== completion.identity_id) {
      return page("Account link conflict", "This Myslop account is already linked to a different identity.", 409);
    }
    const result = await env.CONTROL_DB.prepare("UPDATE users SET identity_id=? WHERE id=? AND identity_id IS NULL")
      .bind(completion.identity_id, legacy.id).run();
    if (result.meta.changes || legacy.identity_id === completion.identity_id) {
      user = { id: legacy.id, identity_id: completion.identity_id };
      await env.CONTROL_DB.prepare(
        `UPDATE identity_link_requests SET status='approved',proof='legacy_session',reviewed_by=?,updated_at=?
         WHERE identity_id=? AND scope='platform' AND status='pending'`,
      ).bind(user.id, Date.now(), completion.identity_id).run();
      await audit(env, "identity.link.approved", {
        identityId: completion.identity_id,
        userId: user.id,
        detail: { proof: "legacy_session", emailChanged: !completion.candidate_user_id },
      });
    }
  }

  if (!user && completion.candidate_user_id) {
    await audit(env, "identity.link.required", { identityId: completion.identity_id, userId: completion.candidate_user_id });
    return page("Account link required", "This Google identity matches an existing Myslop account. Sign in from that Myslop browser session or ask a platform owner to approve the link.", 409);
  }

  if (!user) {
    const profile = await env.CONTROL_DB.prepare(
      "SELECT email,name,picture FROM identity_users WHERE id=? AND status='active'",
    ).bind(completion.identity_id).first<{ email: string; name: string | null; picture: string | null }>();
    if (!profile) return page("Account unavailable", "This Myslop identity is disabled.", 403);
    const concurrentCandidate = await env.CONTROL_DB.prepare("SELECT id FROM users WHERE email=? COLLATE NOCASE LIMIT 1")
      .bind(profile.email).first<{ id: string }>();
    if (concurrentCandidate) {
      await audit(env, "identity.link.required", { identityId: completion.identity_id, userId: concurrentCandidate.id });
      return page("Account link required", "This Google identity matches an existing Myslop account. Ask a platform owner to approve the link.", 409);
    }
    const userId = `usr_${randomHex(16)}`;
    await env.CONTROL_DB.prepare(
      `INSERT INTO users (id,email,name,picture,identity_id,platform_role,created_at)
       VALUES (?,?,?,?,?,'member',?)`,
    ).bind(userId, profile.email, profile.name, profile.picture, completion.identity_id, Date.now()).run();
    user = { id: userId, identity_id: completion.identity_id };
    await audit(env, "identity.user.created", { identityId: completion.identity_id, userId });
  }

  const identity = await env.CONTROL_DB.prepare(
    "SELECT session_generation,status FROM identity_users WHERE id=?",
  ).bind(completion.identity_id).first<{ session_generation: number; status: string }>();
  if (!identity || identity.status !== "active") return page("Account unavailable", "This Myslop identity is disabled.", 403);
  const sessionId = randomHex(32);
  const now = Date.now();
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      "INSERT INTO sessions (id,user_id,created_at,expires_at,identity_generation) VALUES (?,?,?,?,?)",
    ).bind(sessionId, user.id, now, now + SESSION_TTL_MS, identity.session_generation),
    ...(legacySessionId ? [env.CONTROL_DB.prepare("DELETE FROM sessions WHERE id=?").bind(legacySessionId)] : []),
  ]);
  await audit(env, "identity.login.succeeded", { identityId: completion.identity_id, userId: user.id, client: "myslop.cloud" });
  return new Response(null, {
    status: 302,
    headers: { ...authHeaders(), location: returnTo, "set-cookie": sessionCookie(sessionId, SESSION_TTL_MS / 1000) },
  });
}

export function authHealth(env: Env): Response {
  return json({ ok: true, configured: configured(env), issuer: AUTH_ORIGIN }, configured(env) ? 200 : 503, {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
}

export function authPrivacy(): Response {
  return page("Privacy", "Myslop uses Google profile identity only to authenticate you, preserve your account ownership, and enforce access. OAuth tokens are not stored or shared with apps.");
}

export function authTerms(): Response {
  return page("Terms", "Use Myslop authentication only for accounts you control. Access remains subject to your team and application permissions.");
}
