import PostalMime from "postal-mime";
import { ADJECTIVES, NOUNS } from "./words";
import dashboardHtml from "./dashboard.html";
import skillMd from "./skill.md";
import skillHtmlTemplate from "./skill.html";
import setupShB64 from "./setup-sh.generated";
import { internalNonceKey, verifyInternalRequest } from "../../../platform/src/internal";
import { platformIdentity, resolvePlatformUser } from "../../../platform/src/app-identity";

// Decoded once; stored base64 because raw shell text in the bundle trips the
// Cloudflare API WAF on deploy.
const setupSh = new TextDecoder().decode(
  Uint8Array.from(atob(setupShB64), (c) => c.charCodeAt(0)),
);

interface Env {
  FILES: R2Bucket;
  DB: D1Database;
  INBOX_HUB: DurableObjectNamespace;
  MYSLOP_INTERNAL_SECRET?: string;
}

const internalNonces = new Map<string, number>();

const SHOO_ISSUER = "https://shoo.dev";
const SHOO_JWKS_URL = "https://shoo.dev/.well-known/jwks.json";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE = "sid";
const TOKEN_PREFIX = "msm_";
const RETENTION_DAYS = 7;
const MAX_RAW_SIZE = 5 * 1024 * 1024;
// Leases: auto-owned (throwaway) inboxes expire after this window of inactivity
// unless extended by activity; explicit claims are permanent (no lease).
const DEFAULT_LEASE_H = 24;
const MAX_LEASE_H = 7 * 24; // matches mail retention

function leaseMsFrom(hours: number | undefined): number {
  const h = Math.min(Math.max(hours ?? DEFAULT_LEASE_H, 1), MAX_LEASE_H);
  return h * 60 * 60 * 1000;
}
// Addresses always live at @myslop.app (where MX points); the API is served
// from mail.myslop.app but that never appears in an address.
const MAIL_DOMAIN = "myslop.app";

const enc = new TextEncoder();
const dec = new TextDecoder();

// --- Small helpers ---

function unb64url(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  s += "=".repeat((4 - (s.length % 4)) % 4);
  return new Uint8Array([...atob(s)].map((c) => c.charCodeAt(0)));
}

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(input: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(input))));
}

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data, null, 2) + "\n", {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });
}

function randomId(bytes: number): string {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)));
}

// --- Shoo id_token verification (ES256 via JWKS, no SDK) ---

let jwksCache: { keys: Map<string, CryptoKey>; fetchedAt: number } | null = null;

async function loadJwks(force = false): Promise<Map<string, CryptoKey>> {
  const fresh = jwksCache && Date.now() - jwksCache.fetchedAt < 60 * 60 * 1000;
  if (jwksCache && fresh && !force) return jwksCache.keys;
  const res = await fetch(SHOO_JWKS_URL);
  if (!res.ok) throw new Error(`jwks fetch failed: ${res.status}`);
  const { keys } = (await res.json()) as { keys: JsonWebKey[] };
  const map = new Map<string, CryptoKey>();
  for (const jwk of keys) {
    if ((jwk as { kty?: string }).kty !== "EC") continue;
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    map.set((jwk as { kid?: string }).kid ?? "", key);
  }
  jwksCache = { keys: map, fetchedAt: Date.now() };
  return map;
}

interface ShooClaims {
  iss: string;
  aud: string;
  exp: number;
  pairwise_sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}

async function verifyShooIdToken(idToken: string, expectedAud: string): Promise<ShooClaims | null> {
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  let header: { alg?: string; kid?: string };
  let payload: ShooClaims;
  try {
    header = JSON.parse(dec.decode(unb64url(parts[0]!)));
    payload = JSON.parse(dec.decode(unb64url(parts[1]!)));
  } catch {
    return null;
  }
  if (header.alg !== "ES256") return null;

  let keys = await loadJwks();
  let key = keys.get(header.kid ?? "");
  if (!key) {
    keys = await loadJwks(true); // key rotation: refetch on unknown kid
    key = keys.get(header.kid ?? "");
  }
  if (!key) return null;

  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    unb64url(parts[2]!) as BufferSource,
    enc.encode(`${parts[0]!}.${parts[1]!}`),
  );
  if (!ok) return null;

  if (payload.iss !== SHOO_ISSUER) return null;
  if (payload.aud !== expectedAud) return null;
  if (typeof payload.exp !== "number" || Date.now() / 1000 > payload.exp) return null;
  if (typeof payload.pairwise_sub !== "string" || !payload.pairwise_sub) return null;
  if (payload.email !== undefined && typeof payload.email !== "string") return null;
  if (payload.email_verified !== undefined && typeof payload.email_verified !== "boolean") return null;
  return payload;
}

// --- Sessions ---

type ShooIdentity = Pick<ShooClaims, "pairwise_sub" | "email" | "email_verified" | "name" | "picture">;

export async function resolveShooUserId(env: Env, claims: ShooIdentity): Promise<string> {
  if (!claims.email || claims.email_verified !== true) return claims.pairwise_sub;
  const existing = await env.DB.prepare(
    "SELECT id FROM users WHERE email = ? COLLATE NOCASE LIMIT 1",
  )
    .bind(claims.email)
    .first<{ id: string }>();
  return existing?.id ?? claims.pairwise_sub;
}

export async function createShooSession(
  env: Env,
  claims: ShooIdentity,
  now = Date.now(),
  sid = randomId(32),
): Promise<string> {
  const verifiedEmail = claims.email_verified === true ? claims.email ?? null : null;
  let userId = await resolveShooUserId(env, claims);
  try {
    await env.DB.prepare(
      `INSERT INTO users (id, email, name, picture, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         email = COALESCE(excluded.email, email),
         name = COALESCE(excluded.name, name),
         picture = COALESCE(excluded.picture, picture)`,
    )
      .bind(userId, verifiedEmail, claims.name ?? null, claims.picture ?? null, now)
      .run();
  } catch (error) {
    if (!verifiedEmail) throw error;
    const concurrentUserId = await resolveShooUserId(env, claims);
    if (concurrentUserId === claims.pairwise_sub) throw error;
    userId = concurrentUserId;
    await env.DB.prepare(
      `UPDATE users SET name=COALESCE(?,name),picture=COALESCE(?,picture) WHERE id=?`,
    ).bind(claims.name ?? null, claims.picture ?? null, userId).run();
  }
  await env.DB.prepare(
    "INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
  )
    .bind(sid, userId, now, now + SESSION_TTL_MS)
    .run();
  return sid;
}

interface User {
  id: string;
  email: string | null;
  name: string | null;
  picture: string | null;
}

function readCookie(req: Request, name: string): string | null {
  const cookie = req.headers.get("Cookie") ?? "";
  for (const part of cookie.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq) === name) return part.slice(eq + 1);
  }
  return null;
}

async function getSessionUser(req: Request, env: Env): Promise<User | null> {
  const sid = readCookie(req, SESSION_COOKIE);
  if (!sid || !/^[a-f0-9]{32,64}$/.test(sid)) return null;
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.picture FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > ?`,
  )
    .bind(sid, Date.now())
    .first<User>();
  return row ?? null;
}

function sessionCookie(sid: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

// --- Agent auth: platform identity headers or legacy msm_ tokens ---

interface TokenOwner {
  userId: string;
  tokenId: string | null;
}

// Platform identity (dispatcher-verified, injected for msa_ tokens and
// platform sessions) is preferred; legacy per-app msm_ tokens keep working.
async function agentOwner(req: Request, env: Env): Promise<TokenOwner | null> {
  const identity = platformIdentity(req);
  if (identity) return { userId: await resolvePlatformUser(env.DB, identity), tokenId: null };
  return verifyApiToken(env, bearer(req));
}

async function verifyApiToken(env: Env, secret: string): Promise<TokenOwner | null> {
  if (!secret.startsWith(TOKEN_PREFIX)) return null;
  const hash = await sha256Hex(secret);
  const row = await env.DB.prepare(
    "SELECT id, user_id FROM tokens WHERE hash = ? AND revoked_at IS NULL",
  )
    .bind(hash)
    .first<{ id: string; user_id: string }>();
  return row ? { userId: row.user_id, tokenId: row.id } : null;
}

function bearer(req: Request): string {
  return req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
}

// --- Inbox names + ownership ---

// Local parts are agent-generated; keep the keyspace boring and safe.
function validInbox(name: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(name);
}

function randomInt(n: number): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]! % n;
}

function randomName(): string {
  return `${ADJECTIVES[randomInt(ADJECTIVES.length)]}-${NOUNS[randomInt(NOUNS.length)]}`;
}

interface InboxRow {
  name: string;
  user_id: string;
  note: string;
  claimed: number;
}

type OwnResult =
  | { ok: true; created: boolean }
  | { ok: false; status: 403 | 409 };

// Establish or check ownership of a name for a user.
//   explicit: an intentional claim → permanent (lease cleared).
//   otherwise: an auto-own on read/stream → leased (sliding expiry). The lease
//   extends on every access so an actively-used throwaway stays alive; once it
//   lapses the nightly sweep releases it.
async function ownInbox(
  env: Env,
  name: string,
  userId: string,
  opts: { explicit?: boolean; note?: string; leaseHours?: number } = {},
): Promise<OwnResult> {
  const now = Date.now();
  const existing = await env.DB.prepare(
    "SELECT user_id, claimed FROM inboxes WHERE name = ?",
  )
    .bind(name)
    .first<{ user_id: string; claimed: number }>();

  if (existing) {
    if (existing.user_id !== userId) return { ok: false, status: opts.explicit ? 409 : 403 };
    if (opts.explicit) {
      // Promote to permanent.
      await env.DB.prepare(
        "UPDATE inboxes SET claimed = 1, lease_expires_at = NULL, note = COALESCE(NULLIF(?, ''), note) WHERE name = ?",
      )
        .bind(opts.note ?? "", name)
        .run();
    } else if (existing.claimed === 0) {
      // Slide the lease forward (never shorten a longer existing window).
      const lease = now + leaseMsFrom(opts.leaseHours);
      await env.DB.prepare(
        "UPDATE inboxes SET last_read_at = ?, lease_expires_at = MAX(COALESCE(lease_expires_at, 0), ?) WHERE name = ?",
      )
        .bind(now, lease, name)
        .run();
    } else {
      await env.DB.prepare("UPDATE inboxes SET last_read_at = ? WHERE name = ?").bind(now, name).run();
    }
    return { ok: true, created: false };
  }

  const lease = opts.explicit ? null : now + leaseMsFrom(opts.leaseHours);
  await env.DB.prepare(
    "INSERT INTO inboxes (name, user_id, note, claimed, created_at, last_read_at, lease_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(name, userId, opts.note ?? "", opts.explicit ? 1 : 0, now, now, lease)
    .run();
  return { ok: true, created: true };
}

// Notify an inbox's Durable Object of a new message so it fans out to any
// connected SSE clients (web + agents).
async function notifyHub(env: Env, inbox: string, record: unknown): Promise<void> {
  const stub = env.INBOX_HUB.get(env.INBOX_HUB.idFromName(inbox));
  await stub.fetch("https://hub/push", {
    method: "POST",
    body: JSON.stringify(record),
    headers: { "content-type": "application/json" },
  });
}

// Open an SSE stream for an inbox by forwarding to its Durable Object, which
// replays the R2 snapshot then streams live messages. Auth/ownership is checked
// by the caller before this runs.
function hubSubscribe(env: Env, inbox: string, req: Request): Promise<Response> {
  const stub = env.INBOX_HUB.get(env.INBOX_HUB.idFromName(inbox));
  return stub.fetch(`https://hub/subscribe?name=${encodeURIComponent(inbox)}`, {
    headers: { accept: "text/event-stream" },
    signal: req.signal,
  });
}

// --- Mail storage helpers (R2) ---

function extractLinks(text: string, html: string): string[] {
  const links = new Set<string>();
  for (const m of html.matchAll(/href="(https?:\/\/[^"]+)"/gi)) links.add(m[1]!);
  for (const m of text.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) links.add(m[0]);
  return [...links];
}

async function listInbox(env: Env, inbox: string) {
  const listed = await env.FILES.list({
    prefix: `inbox/${inbox}/`,
    include: ["customMetadata"],
  });
  return listed.objects
    .map((o) => ({
      id: o.key.split("/").pop()!.replace(/\.json$/, ""),
      from: o.customMetadata?.from ?? "",
      subject: o.customMetadata?.subject ?? "",
      receivedAt: o.customMetadata?.receivedAt ?? "",
    }))
    .sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- Dashboard API (session-authed) ---

async function handleApi(req: Request, env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
  const path = url.pathname;

  if (req.method !== "GET" && req.method !== "HEAD") {
    const origin = req.headers.get("Origin");
    if (origin && origin !== url.origin) return json({ error: "bad origin" }, 403);
  }

  // POST /api/session — exchange a verified shoo id_token for our own session.
  if (path === "/api/session" && req.method === "POST") {
    let idToken: string;
    try {
      idToken = ((await req.json()) as { id_token?: string }).id_token ?? "";
    } catch {
      return json({ error: "invalid body" }, 400);
    }
    const claims = await verifyShooIdToken(idToken, `origin:${url.origin}`);
    if (!claims) return json({ error: "invalid token" }, 401);

    const now = Date.now();
    const sid = await createShooSession(env, claims, now);
    ctx.waitUntil(env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now).run());

    return json({ ok: true }, 200, { "set-cookie": sessionCookie(sid, SESSION_TTL_MS / 1000) });
  }

  // GET /api/verify — check agent credentials (used by setup.sh). Accepts
  // platform identity or a legacy msm_ bearer, not sessions.
  if (path === "/api/verify" && req.method === "GET") {
    const owner = await agentOwner(req, env);
    if (!owner) return json({ error: "invalid token" }, 401);
    const u = await env.DB.prepare("SELECT name, email FROM users WHERE id = ?")
      .bind(owner.userId)
      .first<{ name: string | null; email: string | null }>();
    return json({ ok: true, user: { name: u?.name ?? null, email: u?.email ?? null } });
  }

  const user = await getSessionUser(req, env);
  if (!user) return json({ error: "unauthorized" }, 401);

  if (path === "/api/session" && req.method === "DELETE") {
    const sid = readCookie(req, SESSION_COOKIE);
    if (sid) await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sid).run();
    return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });
  }

  if (path === "/api/me" && req.method === "GET") {
    return json({ user, domain: MAIL_DOMAIN });
  }

  // GET /api/tokens
  if (path === "/api/tokens" && req.method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT id, name, prefix, created_at, last_used_at FROM tokens
       WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`,
    )
      .bind(user.id)
      .all();
    return json({ tokens: results });
  }

  // POST /api/tokens {name}
  if (path === "/api/tokens" && req.method === "POST") {
    let name = "unnamed";
    try {
      const body = (await req.json()) as { name?: string };
      if (typeof body.name === "string" && body.name.trim()) name = body.name.trim().slice(0, 64);
    } catch {
      // default name
    }
    const secret = TOKEN_PREFIX + b64url(crypto.getRandomValues(new Uint8Array(32)));
    const id = randomId(8);
    await env.DB.prepare(
      "INSERT INTO tokens (id, user_id, hash, name, prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(id, user.id, await sha256Hex(secret), name, secret.slice(0, 12), Date.now())
      .run();
    return json({ token: { id, name, prefix: secret.slice(0, 12), secret } }, 201);
  }

  // DELETE /api/tokens/<id>
  if (path.startsWith("/api/tokens/") && req.method === "DELETE") {
    const res = await env.DB.prepare(
      "UPDATE tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
    )
      .bind(Date.now(), path.slice("/api/tokens/".length), user.id)
      .run();
    if (!res.meta.changes) return json({ error: "not found" }, 404);
    return json({ ok: true });
  }

  // GET /api/addresses — the user's owned inbox names, with message counts.
  if (path === "/api/addresses" && req.method === "GET") {
    type Row = { name: string; note: string; claimed: number; created_at: number; lease_expires_at: number | null };
    const { results } = await env.DB.prepare(
      `SELECT name, note, claimed, created_at, lease_expires_at FROM inboxes
       WHERE user_id = ? ORDER BY created_at DESC LIMIT 500`,
    )
      .bind(user.id)
      .all<Row>();
    const addresses = await Promise.all(
      (results as Row[]).map(async (r) => {
        const msgs = await listInbox(env, r.name);
        return {
          name: r.name,
          address: `${r.name}@${MAIL_DOMAIN}`,
          note: r.note,
          claimed: Boolean(r.claimed),
          leaseExpiresAt: r.lease_expires_at,
          created_at: r.created_at,
          count: msgs.length,
          latest: msgs[0]?.receivedAt ?? null,
        };
      }),
    );
    return json({ addresses });
  }

  // GET /api/addresses/<name>/stream — SSE for the dashboard (session-authed).
  if (path.startsWith("/api/addresses/") && path.endsWith("/stream") && req.method === "GET") {
    const name = decodeURIComponent(path.slice("/api/addresses/".length, -"/stream".length)).toLowerCase();
    if (!validInbox(name)) return json({ error: "invalid name" }, 400);
    const own = await ownInbox(env, name, user.id);
    if (!own.ok) return json({ error: "not found" }, 404);
    return hubSubscribe(env, name, req);
  }

  // POST /api/addresses {name?, note?} — claim a name from the dashboard.
  if (path === "/api/addresses" && req.method === "POST") {
    let body: { name?: string; note?: string } = {};
    try {
      body = (await req.json()) as { name?: string; note?: string };
    } catch {
      // empty body = generate
    }
    const note = typeof body.note === "string" ? body.note : "";
    if (body.name) {
      const name = body.name.toLowerCase();
      if (!validInbox(name)) return json({ error: "invalid name" }, 400);
      const r = await ownInbox(env, name, user.id, { explicit: true, note });
      if (!r.ok) return json({ error: "already in use", name }, 409);
      return json({ name, address: `${name}@${MAIL_DOMAIN}` }, r.created ? 201 : 200);
    }
    for (let i = 0; i < 12; i++) {
      const name = randomName();
      const r = await ownInbox(env, name, user.id, { explicit: true, note });
      if (r.ok && r.created) return json({ name, address: `${name}@${MAIL_DOMAIN}` }, 201);
    }
    return json({ error: "could not find a free name, try again" }, 503);
  }

  // GET /api/addresses/<name> — messages in one owned inbox.
  if (path.startsWith("/api/addresses/") && req.method === "GET") {
    const name = decodeURIComponent(path.slice("/api/addresses/".length)).toLowerCase();
    if (!validInbox(name)) return json({ error: "invalid name" }, 400);
    const owned = await env.DB.prepare("SELECT 1 FROM inboxes WHERE name = ? AND user_id = ?")
      .bind(name, user.id)
      .first();
    if (!owned) return json({ error: "not found" }, 404);
    return json({ address: `${name}@${MAIL_DOMAIN}`, messages: await listInbox(env, name) });
  }

  // GET /api/message/<name>/<id> — one full message from an owned inbox.
  if (path.startsWith("/api/message/") && req.method === "GET") {
    const rest = path.slice("/api/message/".length).split("/");
    const name = decodeURIComponent(rest[0] ?? "").toLowerCase();
    const id = rest[1] ?? "";
    if (!validInbox(name) || !id) return json({ error: "invalid" }, 400);
    const owned = await env.DB.prepare("SELECT 1 FROM inboxes WHERE name = ? AND user_id = ?")
      .bind(name, user.id)
      .first();
    if (!owned) return json({ error: "not found" }, 404);
    const obj = await env.FILES.get(`inbox/${name}/${id}.json`);
    if (!obj) return json({ error: "not found" }, 404);
    return new Response(obj.body, { headers: { "content-type": "application/json; charset=utf-8" } });
  }

  // DELETE /api/addresses/<name> — release ownership + purge stored mail.
  if (path.startsWith("/api/addresses/") && req.method === "DELETE") {
    const name = decodeURIComponent(path.slice("/api/addresses/".length)).toLowerCase();
    if (!validInbox(name)) return json({ error: "invalid name" }, 400);
    const res = await env.DB.prepare("DELETE FROM inboxes WHERE name = ? AND user_id = ?")
      .bind(name, user.id)
      .run();
    if (!res.meta.changes) return json({ error: "not found" }, 404);
    const listed = await env.FILES.list({ prefix: `inbox/${name}/` });
    await Promise.all(listed.objects.map((o) => env.FILES.delete(o.key)));
    return json({ released: name, deleted: listed.objects.length });
  }

  return json({ error: "not found" }, 404);
}

// --- Agent API (platform identity or Bearer msm_): claims + inbox access, per-user ownership ---

async function handleAgentApi(req: Request, env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
  const owner = await agentOwner(req, env);
  if (!owner) return json({ error: "unauthorized" }, 401);
  if (owner.tokenId) {
    ctx.waitUntil(
      env.DB.prepare("UPDATE tokens SET last_used_at = ? WHERE id = ?").bind(Date.now(), owner.tokenId).run(),
    );
  }
  const uid = owner.userId;
  const parts = url.pathname.split("/").filter(Boolean);

  // POST /claim { name?, note? } — reserve a name (generate one if omitted).
  if (parts[0]! === "claim" && !parts[1]! && req.method === "POST") {
    let body: { name?: string; note?: string } = {};
    try {
      const raw = await req.text();
      if (raw) body = JSON.parse(raw);
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    const note = typeof body.note === "string" ? body.note : "";

    if (body.name) {
      const name = body.name.toLowerCase();
      if (!validInbox(name)) return json({ error: "invalid name" }, 400);
      const r = await ownInbox(env, name, uid, { explicit: true, note });
      if (!r.ok) return json({ error: "already in use", name }, 409);
      return json({ name, address: `${name}@${MAIL_DOMAIN}`, note }, r.created ? 201 : 200);
    }

    for (let i = 0; i < 12; i++) {
      const name = randomName();
      const r = await ownInbox(env, name, uid, { explicit: true, note });
      if (r.ok && r.created) return json({ name, address: `${name}@${MAIL_DOMAIN}`, note }, 201);
    }
    return json({ error: "could not find a free name, try again" }, 503);
  }

  // GET /claims — this user's owned names.
  if (parts[0]! === "claims" && !parts[1]! && req.method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT name, note, claimed, created_at, lease_expires_at FROM inboxes WHERE user_id = ? ORDER BY created_at DESC`,
    )
      .bind(uid)
      .all();
    const claims = (
      results as { name: string; note: string; claimed: number; created_at: number; lease_expires_at: number | null }[]
    ).map((r) => ({
      name: r.name,
      address: `${r.name}@${MAIL_DOMAIN}`,
      note: r.note,
      permanent: Boolean(r.claimed),
      leaseExpiresAt: r.lease_expires_at ? new Date(r.lease_expires_at).toISOString() : null,
      claimedAt: new Date(r.created_at).toISOString(),
    }));
    return json({ claims });
  }

  // DELETE /claim/<name> — release a name you own AND purge its stored mail,
  // matching the dashboard's release. Giving up the name wipes the mailbox.
  if (parts[0]! === "claim" && parts[1]! && req.method === "DELETE") {
    const name = parts[1]!.toLowerCase();
    if (!validInbox(name)) return json({ error: "invalid name" }, 400);
    const res = await env.DB.prepare("DELETE FROM inboxes WHERE name = ? AND user_id = ?")
      .bind(name, uid)
      .run();
    if (!res.meta.changes) return json({ error: "not found", name }, 404);
    const listed = await env.FILES.list({ prefix: `inbox/${name}/` });
    await Promise.all(listed.objects.map((o) => env.FILES.delete(o.key)));
    return json({ released: name, deleted: listed.objects.length });
  }

  // Inbox access. Ownership is auto-established on first touch.
  if (parts[0]! !== "inbox" || !parts[1]! || !validInbox(parts[1]!)) {
    return json({ error: "not found" }, 404);
  }
  const inbox = parts[1]!;
  const leaseHours = Number(url.searchParams.get("lease")) || undefined;
  const own = await ownInbox(env, inbox, uid, { leaseHours });
  if (!own.ok) return json({ error: "inbox owned by another account", inbox }, own.status);

  // GET /inbox/<name>/stream — Server-Sent Events: R2 snapshot then live push.
  if (req.method === "GET" && parts[2]! === "stream") {
    return hubSubscribe(env, inbox, req);
  }

  // GET /inbox/<name>/<id> — full message
  if (req.method === "GET" && parts[2]!) {
    const obj = await env.FILES.get(`inbox/${inbox}/${parts[2]!}.json`);
    if (!obj) return json({ error: "not found" }, 404);
    return new Response(obj.body, { headers: { "content-type": "application/json; charset=utf-8" } });
  }

  // GET /inbox/<name>?wait=<seconds> — list, long-polling until non-empty
  if (req.method === "GET") {
    const wait = Math.min(Number(url.searchParams.get("wait")) || 0, 50);
    const deadline = Date.now() + wait * 1000;
    let messages = await listInbox(env, inbox);
    while (messages.length === 0 && Date.now() < deadline) {
      await sleep(2500);
      messages = await listInbox(env, inbox);
    }
    return json({ inbox: `${inbox}@${MAIL_DOMAIN}`, messages });
  }

  // DELETE /inbox/<name> — purge stored mail (keeps the ownership row).
  if (req.method === "DELETE" && !parts[2]!) {
    const listed = await env.FILES.list({ prefix: `inbox/${inbox}/` });
    await Promise.all(listed.objects.map((o) => env.FILES.delete(o.key)));
    return json({ deleted: listed.objects.length });
  }

  return json({ error: "method not allowed" }, 405);
}

async function ingestEmail(
  env: Env,
  ctx: ExecutionContext,
  input: { id: string; sender: string; recipient: string; raw: ReadableStream | ArrayBuffer; rawSize?: number },
): Promise<Response> {
  const inbox = input.recipient.toLowerCase().split("@")[0] ?? "";
  if (!validInbox(inbox) || (input.rawSize ?? 0) > MAX_RAW_SIZE) return json({ error: "mailbox unavailable" }, 422);
  const objectKey = `inbox/${inbox}/${input.id}.json`;
  if (await env.FILES.head(objectKey)) return json({ ok: true, duplicate: true });
  const parsed = await PostalMime.parse(input.raw);
  const receivedAt = new Date().toISOString();
  const record = {
    id: input.id,
    inbox,
    from: parsed.from?.address ?? input.sender,
    fromName: parsed.from?.name ?? "",
    to: input.recipient,
    subject: parsed.subject ?? "",
    receivedAt,
    text: parsed.text ?? "",
    html: parsed.html ?? "",
    links: extractLinks(parsed.text ?? "", parsed.html ?? ""),
  };
  await env.FILES.put(objectKey, JSON.stringify(record), {
    customMetadata: { from: record.from, subject: record.subject.slice(0, 256), receivedAt },
  });
  ctx.waitUntil((async () => {
    await env.DB.prepare(
      "UPDATE inboxes SET lease_expires_at = MAX(COALESCE(lease_expires_at, 0), ?) WHERE name = ? AND claimed = 0",
    ).bind(Date.now() + DEFAULT_LEASE_H * 60 * 60 * 1000, inbox).run();
    await notifyHub(env, inbox, record);
  })());
  return json({ ok: true, id: input.id }, 201);
}

async function runMaintenance(env: Env): Promise<void> {
  const now = Date.now();
  const { results: expired } = await env.DB.prepare(
    "SELECT name FROM inboxes WHERE lease_expires_at IS NOT NULL AND lease_expires_at < ?",
  ).bind(now).all<{ name: string }>();
  for (const { name } of expired as { name: string }[]) {
    const listed = await env.FILES.list({ prefix: `inbox/${name}/` });
    await Promise.all(listed.objects.map((object) => env.FILES.delete(object.key)));
    await env.DB.prepare("DELETE FROM inboxes WHERE name = ?").bind(name).run();
  }
  const cutoff = now - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let cursor: string | undefined;
  do {
    const listed = await env.FILES.list({ prefix: "inbox/", cursor });
    const stale = listed.objects.filter((object) => object.uploaded.getTime() < cutoff);
    await Promise.all(stale.map((object) => env.FILES.delete(object.key)));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

async function internalRequest(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!env.MYSLOP_INTERNAL_SECRET) return json({ error: "internal routing is unavailable" }, 503);
  const url = new URL(req.url);
  const expectedHash = req.headers.get("x-myslop-body-sha256") ?? "";
  if (!expectedHash || !req.body) return json({ error: "not found" }, 404);
  const raw = await req.arrayBuffer();
  const actualHash = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", raw)));
  if (actualHash !== expectedHash || !(await verifyInternalRequest(env.MYSLOP_INTERNAL_SECRET, req.method, url.pathname, expectedHash, req.headers))) {
    return json({ error: "not found" }, 404);
  }
  const nonce = internalNonceKey(req.headers);
  if (!nonce) return json({ error: "not found" }, 404);
  const now = Date.now();
  for (const [key, expiresAt] of internalNonces) if (expiresAt <= now) internalNonces.delete(key);
  if (internalNonces.has(nonce)) return json({ error: "duplicate internal request" }, 409);
  internalNonces.set(nonce, now + 5 * 60_000);
  if (url.pathname === "/__email" && req.method === "POST") {
    const id = req.headers.get("x-myslop-delivery-id") ?? "";
    const sender = req.headers.get("x-myslop-mail-from") ?? "";
    const recipient = req.headers.get("x-myslop-rcpt-to") ?? "";
    if (!id || !sender || !recipient) return json({ error: "invalid delivery envelope" }, 400);
    return ingestEmail(env, ctx, { id, sender, recipient, raw, rawSize: raw.byteLength });
  }
  if (url.pathname === "/__scheduled" && req.method === "POST") {
    await runMaintenance(env);
    return json({ ok: true });
  }
  return json({ error: "not found" }, 404);
}

export default {
  async email(message, env, ctx) {
    const id = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const response = await ingestEmail(env, ctx, {
      id,
      sender: message.from,
      recipient: message.to,
      raw: message.raw,
      rawSize: message.rawSize,
    });
    if (!response.ok) message.setReject("mailbox unavailable");
  },

  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/__email" || url.pathname === "/__scheduled") return internalRequest(req, env, ctx);
    if (url.pathname === "/dashboard" || url.pathname === "/dashboard/" || url.pathname === "/setup") {
      return new Response(dashboardHtml as unknown as string, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }
    if (url.pathname === "/setup.sh") return new Response(setupSh, { headers: { "content-type": "text/x-shellscript; charset=utf-8", "cache-control": "public, max-age=300" } });
    if (url.pathname === "/skill.md") return new Response(skillMd, { headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "public, max-age=300" } });
    if (url.pathname === "/skill") {
      const escaped = skillMd.replace(/[&<>]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[character]!));
      return new Response((skillHtmlTemplate as unknown as string).replace("__SKILL_MD__", escaped), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" } });
    }
    if (url.pathname.startsWith("/api/")) return handleApi(req, env, url, ctx);
    if (url.pathname === "/" && req.method === "GET") return Response.redirect(`${url.origin}/dashboard`, 302);
    return handleAgentApi(req, env, url, ctx);
  },

  async scheduled(_event, env) {
    await runMaintenance(env);
  },
} satisfies ExportedHandler<Env>;

// --- InboxHub Durable Object: per-inbox real-time fan-out over SSE ---
//
// One instance per inbox name. On subscribe it replays the R2 snapshot then
// holds the connection open; email() calls /push and it fans the message out to
// every connected client. Purely a relay — mail lives in R2, nothing persisted
// here. Writes to each client are serialized through a promise chain and
// deduped by message id so snapshot + live pushes never interleave or double up.

interface HubClient {
  sentIds: Set<string>;
  closed: boolean;
  chain: Promise<void>;
  write: (s: string) => void;
}

export class InboxHub {
  private env: Env;
  private clients = new Set<HubClient>();

  constructor(_state: DurableObjectState, env: Env) {
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/push") {
      const record = (await request.json()) as { id?: string };
      this.broadcast(record);
      return new Response("ok");
    }

    if (url.pathname === "/subscribe") {
      return this.subscribe(request, url.searchParams.get("name") ?? "");
    }

    return new Response("not found", { status: 404 });
  }

  private makeClient(writer: WritableStreamDefaultWriter<Uint8Array>): HubClient {
    const encoder = new TextEncoder();
    const client: HubClient = {
      sentIds: new Set(),
      closed: false,
      chain: Promise.resolve(),
      write(s: string) {
        this.chain = this.chain
          .then(() => (this.closed ? undefined : writer.write(encoder.encode(s))))
          .catch(() => {
            this.closed = true;
          });
      },
    };
    return client;
  }

  private async subscribe(request: Request, name: string): Promise<Response> {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const client = this.makeClient(writer);
    this.clients.add(client);
    client.write(": connected\n\n");

    // Snapshot: replay stored mail oldest→newest (id timestamp-prefix sorts).
    try {
      const listed = await this.env.FILES.list({ prefix: `inbox/${name}/` });
      for (const key of listed.objects.map((o) => o.key).sort()) {
        const obj = await this.env.FILES.get(key);
        if (!obj) continue;
        const text = await obj.text();
        let id = key.split("/").pop()!.replace(/\.json$/, "");
        try {
          id = (JSON.parse(text) as { id?: string }).id ?? id;
        } catch {
          /* keep key-derived id */
        }
        if (client.sentIds.has(id)) continue;
        client.sentIds.add(id);
        client.write(`event: message\nid: ${id}\ndata: ${text}\n\n`);
      }
    } catch {
      /* snapshot best-effort */
    }

    const ping = setInterval(() => client.write(": ping\n\n"), 25000);
    const cleanup = () => {
      if (client.closed) return;
      client.closed = true;
      clearInterval(ping);
      this.clients.delete(client);
      writer.close().catch(() => {});
    };
    request.signal.addEventListener("abort", cleanup);

    return new Response(readable, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    });
  }

  private broadcast(record: { id?: string }): void {
    const data = JSON.stringify(record);
    const id = record.id ?? "";
    for (const client of this.clients) {
      if (client.closed) {
        this.clients.delete(client);
        continue;
      }
      if (id && client.sentIds.has(id)) continue;
      if (id) client.sentIds.add(id);
      client.write(`event: message\nid: ${id}\ndata: ${data}\n\n`);
    }
  }
}
