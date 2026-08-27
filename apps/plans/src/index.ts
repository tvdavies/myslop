import dashboardHtml from "./dashboard.html";
import planHtml from "./plan.html";
import skillMd from "./skill.md";
import skillHtmlTemplate from "./skill.html";
import setupShB64 from "./setup-sh.generated";
import { diffPlan, renderPlan, type PlanBlock } from "./markdown";

// Decoded lazily-once; stored base64 because raw shell text in the bundle
// trips the Cloudflare API WAF on deploy.
const setupSh = new TextDecoder().decode(
  Uint8Array.from(atob(setupShB64), (c) => c.charCodeAt(0)),
);

interface Env {
  DB: D1Database;
}

const SHOO_ISSUER = "https://shoo.dev";
const SHOO_JWKS_URL = "https://shoo.dev/.well-known/jwks.json";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE = "sid";
const TOKEN_PREFIX = "msp_";

const MAX_TITLE = 200;
const MAX_MARKDOWN = 400_000;
const MAX_COMMENT = 10_000;
const MAX_NOTE = 500;
const MAX_VERSIONS = 200;

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
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });
}

function randomId(bytes: number): string {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function readJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

// --- Shoo id_token verification (ES256 via JWKS, no SDK) ---

let jwksCache: { keys: Map<string, CryptoKey>; fetchedAt: number } | null = null;

async function loadJwks(force = false): Promise<Map<string, CryptoKey>> {
  const fresh = jwksCache && Date.now() - jwksCache.fetchedAt < 60 * 60 * 1000;
  if (jwksCache && fresh && !force) return jwksCache.keys;
  const res = await fetch(SHOO_JWKS_URL);
  if (!res.ok) throw new Error(`jwks fetch failed: ${res.status}`);
  const { keys } = (await res.json()) as { keys: JsonWebKey[] & { kid?: string }[] };
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
    header = JSON.parse(dec.decode(unb64url(parts[0])));
    payload = JSON.parse(dec.decode(unb64url(parts[1])));
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
    unb64url(parts[2]) as BufferSource,
    enc.encode(`${parts[0]}.${parts[1]}`),
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

// --- Agent API tokens ---

interface TokenOwner {
  userId: string;
  tokenId: string;
  tokenName: string;
}

async function verifyAgentToken(env: Env, secret: string): Promise<TokenOwner | null> {
  if (!secret.startsWith(TOKEN_PREFIX)) return null;
  const hash = await sha256Hex(secret);
  const row = await env.DB.prepare(
    "SELECT id, user_id, name FROM tokens WHERE hash = ? AND revoked_at IS NULL",
  )
    .bind(hash)
    .first<{ id: string; user_id: string; name: string }>();
  return row ? { userId: row.user_id, tokenId: row.id, tokenName: row.name } : null;
}

function bearer(req: Request): string {
  return req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
}

// --- Plans ---

interface PlanRow {
  id: string;
  user_id: string;
  title: string;
  current_version: number;
  created_at: number;
  updated_at: number;
}

const PLAN_ID_RE = /^[a-f0-9]{10}$/;

async function getPlan(env: Env, id: string): Promise<PlanRow | null> {
  if (!PLAN_ID_RE.test(id)) return null;
  return env.DB.prepare("SELECT * FROM plans WHERE id = ?").bind(id).first<PlanRow>();
}

async function getVersionMarkdown(env: Env, planId: string, version: number): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT markdown FROM plan_versions WHERE plan_id = ? AND version = ?",
  )
    .bind(planId, version)
    .first<{ markdown: string }>();
  return row?.markdown ?? null;
}

type PlanStatus = "open" | "approved" | "changes_requested";

function deriveStatus(approvals: number, changes: number): PlanStatus {
  if (changes > 0) return "changes_requested";
  if (approvals > 0) return "approved";
  return "open";
}

async function planStatus(env: Env, plan: PlanRow): Promise<PlanStatus> {
  const row = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN verdict='approved' THEN 1 ELSE 0 END) AS approvals,
       SUM(CASE WHEN verdict='changes_requested' THEN 1 ELSE 0 END) AS changes
     FROM reviews WHERE plan_id = ? AND version = ?`,
  )
    .bind(plan.id, plan.current_version)
    .first<{ approvals: number | null; changes: number | null }>();
  return deriveStatus(row?.approvals ?? 0, row?.changes ?? 0);
}

interface CommentRow {
  id: string;
  version: number;
  block_id: string | null;
  parent_id: string | null;
  author_type: "user" | "agent";
  user_id: string | null;
  agent_name: string | null;
  body: string;
  created_at: number;
  resolved_at: number | null;
  user_name: string | null;
  user_email: string | null;
  user_picture: string | null;
}

async function loadComments(env: Env, planId: string, since?: number): Promise<CommentRow[]> {
  const base = `SELECT c.id, c.version, c.block_id, c.parent_id, c.author_type, c.user_id, c.agent_name,
       c.body, c.created_at, c.resolved_at,
       u.name AS user_name, u.email AS user_email, u.picture AS user_picture
     FROM comments c LEFT JOIN users u ON u.id = c.user_id
     WHERE c.plan_id = ?`;
  const stmt = since
    ? env.DB.prepare(`${base} AND c.created_at > ? ORDER BY c.created_at`).bind(planId, since)
    : env.DB.prepare(`${base} ORDER BY c.created_at`).bind(planId);
  const { results } = await stmt.all<CommentRow>();
  return results;
}

function commentAuthor(row: CommentRow): { type: "user" | "agent"; name: string; picture: string | null } {
  if (row.author_type === "agent") {
    return { type: "agent", name: row.agent_name ? `Agent · ${row.agent_name}` : "Agent", picture: null };
  }
  return {
    type: "user",
    name: row.user_name || row.user_email || (row.user_id ?? "user").slice(0, 12),
    picture: row.user_picture,
  };
}

async function loadReviews(env: Env, planId: string) {
  const { results } = await env.DB.prepare(
    `SELECT r.version, r.verdict, r.note, r.created_at, r.user_id,
       u.name AS user_name, u.email AS user_email
     FROM reviews r JOIN users u ON u.id = r.user_id
     WHERE r.plan_id = ? ORDER BY r.created_at`,
  )
    .bind(planId)
    .all<{
      version: number;
      verdict: string;
      note: string | null;
      created_at: number;
      user_id: string;
      user_name: string | null;
      user_email: string | null;
    }>();
  return results.map((r) => ({
    version: r.version,
    verdict: r.verdict,
    note: r.note,
    created_at: r.created_at,
    user_id: r.user_id,
    user_name: r.user_name || r.user_email || r.user_id.slice(0, 12),
  }));
}

// Re-attach a comment's block anchor in the viewed version: exact id match
// first, then content-hash match (block moved), else null (orphaned).
function attachBlockId(comment: CommentRow, viewedVersion: number, blocks: PlanBlock[]): string | null {
  if (!comment.block_id) return null;
  if (comment.version === viewedVersion && blocks.some((b) => b.id === comment.block_id)) {
    return comment.block_id;
  }
  const hash = comment.block_id.split("-")[1];
  if (!hash) return null;
  const match = blocks.find((b) => b.id.split("-")[1] === hash);
  return match?.id ?? null;
}

function validBlockId(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,4}-[a-f0-9]{8}$/.test(value);
}

// --- Annotated raw markdown ---
//
// The unauthenticated /p/:id/md endpoint serves the plan markdown with review
// feedback embedded as HTML comment markers, placed directly under the block
// each thread refers to, so a model reading the file sees exactly which part
// of its plan a comment targets. `?plain=1` skips all of this.

function hcEsc(text: string): string {
  // "-->" inside an HTML comment would terminate it early.
  return text.replace(/-->/g, "-- >");
}

async function annotatedMarkdown(
  env: Env,
  plan: PlanRow,
  version: number,
  markdown: string,
  origin: string,
): Promise<string> {
  const [comments, reviews] = await Promise.all([loadComments(env, plan.id), loadReviews(env, plan.id)]);
  const blocks = renderPlan(markdown).blocks;
  const roots = comments.filter((c) => !c.parent_id);
  const openRoots = roots.filter((c) => !c.resolved_at);
  const resolvedCount = roots.length - openRoots.length;
  const replies = (id: string) => comments.filter((c) => c.parent_id === id);

  // Anchor open threads to blocks of the served version (content-hash
  // re-attach across versions); unanchored threads are general comments.
  const byBlock = new Map<string, CommentRow[]>();
  const general: CommentRow[] = [];
  for (const root of openRoots) {
    const anchor = attachBlockId(root, version, blocks);
    if (anchor) {
      const list = byBlock.get(anchor) ?? [];
      list.push(root);
      byBlock.set(anchor, list);
    } else {
      general.push(root);
    }
  }

  const stamp = (ts: number) => new Date(ts).toISOString().slice(0, 10);
  const who = (c: CommentRow) => {
    const author = commentAuthor(c);
    return author.type === "agent"
      ? `${author.name.replace(/^Agent · /, "")} (agent — you)`
      : `${author.name} (reviewer)`;
  };
  const threadText = (root: CommentRow) => {
    const lines = [`  ${who(root)}, ${stamp(root.created_at)}: ${hcEsc(root.body).replace(/\n/g, "\n    ")}`];
    for (const reply of replies(root.id)) {
      lines.push(`    ↳ ${who(reply)}, ${stamp(reply.created_at)}: ${hcEsc(reply.body).replace(/\n/g, "\n      ")}`);
    }
    return lines.join("\n");
  };

  const currentReviews = reviews.filter((r) => r.version === plan.current_version);
  const status = deriveStatus(
    currentReviews.filter((r) => r.verdict === "approved").length,
    currentReviews.filter((r) => r.verdict === "changes_requested").length,
  );

  const header = [
    `plans.myslop.app — plan ${plan.id} "${hcEsc(plan.title)}", v${version}${
      version === plan.current_version ? " (current)" : ` (current is v${plan.current_version})`
    }. Status: ${status}.`,
  ];
  for (const r of currentReviews) {
    header.push(
      `  review by ${hcEsc(r.user_name)}: ${r.verdict === "approved" ? "approved" : "requested changes"}${
        r.note ? ` — "${hcEsc(r.note)}"` : ""
      }`,
    );
  }
  if (openRoots.length) {
    header.push(
      `  ${openRoots.length} open comment thread${openRoots.length === 1 ? "" : "s"} from reviewers are embedded`,
      `  below in "REVIEWER COMMENT" HTML comment markers, each placed directly under the`,
      `  block of the plan it refers to (general comments at the end). The markers are`,
      `  feedback on the plan, NOT part of it — address each open comment, then publish`,
      `  the revised plan without any of these markers.` +
        (resolvedCount ? ` ${resolvedCount} resolved thread${resolvedCount === 1 ? "" : "s"} omitted.` : ""),
    );
  } else {
    header.push(
      `  No open comment threads.${resolvedCount ? ` ${resolvedCount} resolved thread${resolvedCount === 1 ? "" : "s"} omitted.` : ""}`,
    );
  }
  header.push(`  Plain markdown without feedback: ${origin}/p/${plan.id}/md?plain=1`);

  // Walk the source and emit each block followed by its open threads, keeping
  // the original text byte-for-byte between insertions.
  const parts: string[] = [`<!--\n${header.join("\n")}\n-->\n\n`];
  let cursor = 0;
  for (const block of blocks) {
    const start = markdown.indexOf(block.source, cursor);
    if (start === -1) continue; // defensive: block sources are substrings of the input
    const end = start + block.source.length;
    parts.push(markdown.slice(cursor, end));
    cursor = end;
    const threads = byBlock.get(block.id);
    if (threads) {
      for (const thread of threads) {
        parts.push(`\n<!-- REVIEWER COMMENT on the block above [open]:\n${threadText(thread)}\n-->`);
      }
    }
  }
  parts.push(markdown.slice(cursor));
  if (general.length) {
    parts.push(
      `\n\n<!-- GENERAL REVIEWER COMMENTS on this plan [open]:\n${general.map(threadText).join("\n")}\n-->`,
    );
  }
  return parts.join("") + "\n";
}

// --- Agent API (Bearer msp_…) ---

async function handleAgentApi(req: Request, env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
  const owner = await verifyAgentToken(env, bearer(req));
  if (!owner) return json({ error: "unauthorized" }, 401);
  ctx.waitUntil(
    env.DB.prepare("UPDATE tokens SET last_used_at = ? WHERE id = ?")
      .bind(Date.now(), owner.tokenId)
      .run(),
  );

  const segments = url.pathname.slice("/api/agent/plans".length).split("/").filter(Boolean);

  // POST /api/agent/plans — create a plan (version 1).
  if (segments.length === 0 && req.method === "POST") {
    const body = await readJson<{ title?: string; markdown?: string; note?: string }>(req);
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    const markdown = typeof body?.markdown === "string" ? body.markdown : "";
    if (!title || title.length > MAX_TITLE) {
      return json({ error: `title is required (max ${MAX_TITLE} chars)` }, 400);
    }
    if (!markdown.trim() || markdown.length > MAX_MARKDOWN) {
      return json({ error: `markdown is required (max ${MAX_MARKDOWN} chars)` }, 400);
    }
    const note = typeof body?.note === "string" ? body.note.trim().slice(0, MAX_NOTE) || null : null;
    const now = Date.now();
    const id = randomId(5);
    await env.DB.prepare(
      "INSERT INTO plans (id, user_id, title, current_version, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
    )
      .bind(id, owner.userId, title, now, now)
      .run();
    await env.DB.prepare(
      "INSERT INTO plan_versions (plan_id, version, title, markdown, note, created_at) VALUES (?, 1, ?, ?, ?, ?)",
    )
      .bind(id, title, markdown, note, now)
      .run();
    return json({ id, url: `${url.origin}/p/${id}`, raw_url: `${url.origin}/p/${id}/md`, version: 1, title, status: "open" }, 201);
  }

  // GET /api/agent/plans — list plans owned by this token's user.
  if (segments.length === 0 && req.method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT p.id, p.title, p.current_version, p.created_at, p.updated_at,
         (SELECT COUNT(*) FROM reviews r WHERE r.plan_id=p.id AND r.version=p.current_version AND r.verdict='approved') AS approvals,
         (SELECT COUNT(*) FROM reviews r WHERE r.plan_id=p.id AND r.version=p.current_version AND r.verdict='changes_requested') AS changes,
         (SELECT COUNT(*) FROM comments c WHERE c.plan_id=p.id AND c.parent_id IS NULL AND c.resolved_at IS NULL) AS unresolved
       FROM plans p WHERE p.user_id = ? ORDER BY p.updated_at DESC LIMIT 200`,
    )
      .bind(owner.userId)
      .all<{ id: string; title: string; current_version: number; created_at: number; updated_at: number; approvals: number; changes: number; unresolved: number }>();
    return json({
      plans: results.map((p) => ({
        id: p.id,
        url: `${url.origin}/p/${p.id}`,
        raw_url: `${url.origin}/p/${p.id}/md`,
        title: p.title,
        status: deriveStatus(p.approvals, p.changes),
        current_version: p.current_version,
        unresolved_comments: p.unresolved,
        created_at: p.created_at,
        updated_at: p.updated_at,
      })),
    });
  }

  const plan = segments.length > 0 ? await getPlan(env, segments[0]!) : null;
  if (!plan || plan.user_id !== owner.userId) return json({ error: "not found" }, 404);

  // GET /api/agent/plans/:id — status summary.
  if (segments.length === 1 && req.method === "GET") {
    const [status, reviews, versionsRes, unresolvedRow] = await Promise.all([
      planStatus(env, plan),
      loadReviews(env, plan.id),
      env.DB.prepare(
        "SELECT version, title, note, created_at FROM plan_versions WHERE plan_id = ? ORDER BY version",
      )
        .bind(plan.id)
        .all<{ version: number; title: string; note: string | null; created_at: number }>(),
      env.DB.prepare(
        "SELECT COUNT(*) AS n FROM comments WHERE plan_id = ? AND parent_id IS NULL AND resolved_at IS NULL",
      )
        .bind(plan.id)
        .first<{ n: number }>(),
    ]);
    return json({
      id: plan.id,
      url: `${url.origin}/p/${plan.id}`,
      raw_url: `${url.origin}/p/${plan.id}/md`,
      title: plan.title,
      status,
      current_version: plan.current_version,
      versions: versionsRes.results,
      reviews: reviews.map((r) => ({
        version: r.version,
        verdict: r.verdict,
        note: r.note,
        by: r.user_name,
        created_at: r.created_at,
      })),
      unresolved_comment_count: unresolvedRow?.n ?? 0,
      created_at: plan.created_at,
      updated_at: plan.updated_at,
    });
  }

  // PUT /api/agent/plans/:id — publish a new version.
  if (segments.length === 1 && req.method === "PUT") {
    const body = await readJson<{ title?: string; markdown?: string; note?: string }>(req);
    const markdown = typeof body?.markdown === "string" ? body.markdown : "";
    if (!markdown.trim() || markdown.length > MAX_MARKDOWN) {
      return json({ error: `markdown is required (max ${MAX_MARKDOWN} chars)` }, 400);
    }
    let title = plan.title;
    if (typeof body?.title === "string" && body.title.trim()) {
      title = body.title.trim();
      if (title.length > MAX_TITLE) return json({ error: `title too long (max ${MAX_TITLE})` }, 400);
    }
    if (plan.current_version >= MAX_VERSIONS) return json({ error: "version limit reached" }, 409);
    const note = typeof body?.note === "string" ? body.note.trim().slice(0, MAX_NOTE) || null : null;
    const now = Date.now();
    const version = plan.current_version + 1;
    await env.DB.prepare(
      "INSERT INTO plan_versions (plan_id, version, title, markdown, note, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(plan.id, version, title, markdown, note, now)
      .run();
    await env.DB.prepare(
      "UPDATE plans SET title = ?, current_version = ?, updated_at = ? WHERE id = ?",
    )
      .bind(title, version, now, plan.id)
      .run();
    return json({ id: plan.id, url: `${url.origin}/p/${plan.id}`, raw_url: `${url.origin}/p/${plan.id}/md`, version, title, status: "open" });
  }

  // GET /api/agent/plans/:id/comments[?since=ts]
  if (segments.length === 2 && segments[1] === "comments" && req.method === "GET") {
    const since = Number(url.searchParams.get("since")) || undefined;
    const comments = await loadComments(env, plan.id, since);
    // Block excerpts per referenced version so the agent sees what text a
    // block comment points at.
    const excerpts = new Map<string, string>();
    const versions = [...new Set(comments.filter((c) => c.block_id).map((c) => c.version))];
    for (const version of versions) {
      const markdown = await getVersionMarkdown(env, plan.id, version);
      if (!markdown) continue;
      for (const block of renderPlan(markdown).blocks) {
        excerpts.set(`${version}:${block.id}`, block.text);
      }
    }
    return json({
      plan: { id: plan.id, title: plan.title, current_version: plan.current_version },
      comments: comments.map((c) => ({
        id: c.id,
        version: c.version,
        block_id: c.block_id,
        block_excerpt: c.block_id ? excerpts.get(`${c.version}:${c.block_id}`) ?? null : null,
        parent_id: c.parent_id,
        author: commentAuthor(c),
        body: c.body,
        created_at: c.created_at,
        resolved: Boolean(c.resolved_at),
      })),
    });
  }

  // POST /api/agent/plans/:id/comments — agent comment or reply.
  if (segments.length === 2 && segments[1] === "comments" && req.method === "POST") {
    const body = await readJson<{ body?: string; reply_to?: string; block_id?: string }>(req);
    const text = typeof body?.body === "string" ? body.body.trim() : "";
    if (!text || text.length > MAX_COMMENT) {
      return json({ error: `body is required (max ${MAX_COMMENT} chars)` }, 400);
    }
    let parentId: string | null = null;
    let version = plan.current_version;
    let blockId: string | null = null;
    if (body?.reply_to) {
      const parent = await env.DB.prepare(
        "SELECT id, parent_id, version, block_id FROM comments WHERE id = ? AND plan_id = ?",
      )
        .bind(String(body.reply_to), plan.id)
        .first<{ id: string; parent_id: string | null; version: number; block_id: string | null }>();
      if (!parent) return json({ error: "reply_to comment not found" }, 404);
      parentId = parent.parent_id ?? parent.id; // single-level threads
      version = parent.version;
      blockId = parent.block_id;
    } else if (body?.block_id !== undefined) {
      if (!validBlockId(body.block_id)) return json({ error: "invalid block_id" }, 400);
      blockId = body.block_id;
    }
    const id = randomId(8);
    await env.DB.prepare(
      `INSERT INTO comments (id, plan_id, version, block_id, parent_id, author_type, user_id, agent_name, body, created_at)
       VALUES (?, ?, ?, ?, ?, 'agent', NULL, ?, ?, ?)`,
    )
      .bind(id, plan.id, version, blockId, parentId, owner.tokenName, text, Date.now())
      .run();
    return json({ id, ok: true }, 201);
  }

  // POST /api/agent/plans/:id/comments/:cid/resolve
  if (segments.length === 4 && segments[1] === "comments" && segments[3] === "resolve" && req.method === "POST") {
    const body = await readJson<{ resolved?: boolean }>(req);
    const resolved = body?.resolved !== false;
    const res = await env.DB.prepare(
      "UPDATE comments SET resolved_at = ? WHERE id = ? AND plan_id = ? AND parent_id IS NULL",
    )
      .bind(resolved ? Date.now() : null, segments[2], plan.id)
      .run();
    if (!res.meta.changes) return json({ error: "not found" }, 404);
    return json({ ok: true, resolved });
  }

  return json({ error: "not found" }, 404);
}

// --- Dashboard / viewer API (session cookie) ---

async function handleApi(req: Request, env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
  const path = url.pathname;

  // CSRF: mutating requests must come from our own origin (cookies are
  // SameSite=Lax as well; this is belt-and-braces).
  if (req.method !== "GET" && req.method !== "HEAD") {
    const origin = req.headers.get("Origin");
    if (origin && origin !== url.origin) return json({ error: "bad origin" }, 403);
  }

  // POST /api/session — exchange a verified shoo id_token for our own session.
  if (path === "/api/session" && req.method === "POST") {
    const body = await readJson<{ id_token?: string }>(req);
    if (!body) return json({ error: "invalid body" }, 400);
    const claims = await verifyShooIdToken(body.id_token ?? "", `origin:${url.origin}`);
    if (!claims) return json({ error: "invalid token" }, 401);

    const now = Date.now();
    const sid = await createShooSession(env, claims, now);

    // Opportunistic cleanup of expired sessions.
    ctx.waitUntil(
      env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now).run(),
    );

    return json({ ok: true }, 200, { "set-cookie": sessionCookie(sid, SESSION_TTL_MS / 1000) });
  }

  // GET /api/verify — check an agent token (used by setup.sh). Bearer-authed.
  if (path === "/api/verify" && req.method === "GET") {
    const owner = await verifyAgentToken(env, bearer(req));
    if (!owner) return json({ error: "invalid token" }, 401);
    const u = await env.DB.prepare("SELECT name, email FROM users WHERE id = ?")
      .bind(owner.userId)
      .first<{ name: string | null; email: string | null }>();
    return json({ ok: true, user: { name: u?.name ?? null, email: u?.email ?? null } });
  }

  // Agent API is Bearer-authed, not session-authed.
  if (path.startsWith("/api/agent/plans")) {
    return handleAgentApi(req, env, url, ctx);
  }

  // Everything below requires a session.
  const user = await getSessionUser(req, env);
  if (!user) return json({ error: "unauthorized" }, 401);

  // DELETE /api/session — sign out.
  if (path === "/api/session" && req.method === "DELETE") {
    const sid = readCookie(req, SESSION_COOKIE);
    if (sid) await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sid).run();
    return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });
  }

  // GET /api/me
  if (path === "/api/me" && req.method === "GET") {
    return json({ user });
  }

  // GET /api/tokens
  if (path === "/api/tokens" && req.method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT id, name, prefix, created_at, last_used_at
       FROM tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`,
    )
      .bind(user.id)
      .all();
    return json({ tokens: results });
  }

  // POST /api/tokens {name} — mint; full secret returned exactly once.
  if (path === "/api/tokens" && req.method === "POST") {
    let name = "unnamed";
    const body = await readJson<{ name?: string }>(req);
    if (typeof body?.name === "string" && body.name.trim()) name = body.name.trim().slice(0, 64);
    const secret = TOKEN_PREFIX + b64url(crypto.getRandomValues(new Uint8Array(32)));
    const token = {
      id: randomId(8),
      hash: await sha256Hex(secret),
      prefix: secret.slice(0, 12),
      created_at: Date.now(),
    };
    await env.DB.prepare(
      "INSERT INTO tokens (id, user_id, hash, name, prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(token.id, user.id, token.hash, name, token.prefix, token.created_at)
      .run();
    return json({ token: { id: token.id, name, prefix: token.prefix, created_at: token.created_at, secret } }, 201);
  }

  // DELETE /api/tokens/<id> — revoke.
  if (path.startsWith("/api/tokens/") && req.method === "DELETE") {
    const id = path.slice("/api/tokens/".length);
    const res = await env.DB.prepare(
      "UPDATE tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
    )
      .bind(Date.now(), id, user.id)
      .run();
    if (!res.meta.changes) return json({ error: "not found" }, 404);
    return json({ ok: true });
  }

  // GET /api/plans — the signed-in user's own plans (dashboard).
  if (path === "/api/plans" && req.method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT p.id, p.title, p.current_version, p.created_at, p.updated_at,
         (SELECT COUNT(*) FROM reviews r WHERE r.plan_id=p.id AND r.version=p.current_version AND r.verdict='approved') AS approvals,
         (SELECT COUNT(*) FROM reviews r WHERE r.plan_id=p.id AND r.version=p.current_version AND r.verdict='changes_requested') AS changes,
         (SELECT COUNT(*) FROM comments c WHERE c.plan_id=p.id AND c.parent_id IS NULL) AS comment_count,
         (SELECT COUNT(*) FROM comments c WHERE c.plan_id=p.id AND c.parent_id IS NULL AND c.resolved_at IS NULL) AS unresolved
       FROM plans p WHERE p.user_id = ? ORDER BY p.updated_at DESC LIMIT 200`,
    )
      .bind(user.id)
      .all<{ id: string; title: string; current_version: number; created_at: number; updated_at: number; approvals: number; changes: number; comment_count: number; unresolved: number }>();
    return json({
      plans: results.map((p) => ({
        id: p.id,
        url: `${url.origin}/p/${p.id}`,
        title: p.title,
        status: deriveStatus(p.approvals, p.changes),
        current_version: p.current_version,
        comment_count: p.comment_count,
        unresolved_count: p.unresolved,
        created_at: p.created_at,
        updated_at: p.updated_at,
      })),
    });
  }

  // /api/plans/:id[...]
  if (path.startsWith("/api/plans/")) {
    const segments = path.slice("/api/plans/".length).split("/").filter(Boolean);
    const plan = await getPlan(env, segments[0] ?? "");
    if (!plan) return json({ error: "not found" }, 404);

    // GET /api/plans/:id?version=N — full viewer payload.
    if (segments.length === 1 && req.method === "GET") {
      const requested = Number(url.searchParams.get("version")) || plan.current_version;
      if (requested < 1 || requested > plan.current_version) return json({ error: "unknown version" }, 404);
      const markdown = await getVersionMarkdown(env, plan.id, requested);
      if (markdown === null) return json({ error: "unknown version" }, 404);
      const rendered = renderPlan(markdown);
      const [comments, reviews, versionsRes, owner] = await Promise.all([
        loadComments(env, plan.id),
        loadReviews(env, plan.id),
        env.DB.prepare(
          "SELECT version, title, note, created_at FROM plan_versions WHERE plan_id = ? ORDER BY version",
        )
          .bind(plan.id)
          .all<{ version: number; title: string; note: string | null; created_at: number }>(),
        env.DB.prepare("SELECT name, email FROM users WHERE id = ?")
          .bind(plan.user_id)
          .first<{ name: string | null; email: string | null }>(),
      ]);
      const currentReviews = reviews.filter((r) => r.version === plan.current_version);
      const status = deriveStatus(
        currentReviews.filter((r) => r.verdict === "approved").length,
        currentReviews.filter((r) => r.verdict === "changes_requested").length,
      );
      const myReview = currentReviews.find((r) => r.user_id === user.id) ?? null;
      return json({
        plan: {
          id: plan.id,
          title: plan.title,
          status,
          current_version: plan.current_version,
          version: requested,
          owner: owner?.name || owner?.email || "unknown",
          is_owner: plan.user_id === user.id,
          created_at: plan.created_at,
          updated_at: plan.updated_at,
        },
        versions: versionsRes.results,
        reviews: reviews.map((r) => ({
          version: r.version,
          verdict: r.verdict,
          note: r.note,
          by: r.user_name,
          mine: r.user_id === user.id,
          created_at: r.created_at,
        })),
        my_review: myReview ? { verdict: myReview.verdict, note: myReview.note } : null,
        html: rendered.html,
        blocks: rendered.blocks.map((b) => ({ id: b.id, kind: b.kind, text: b.text })),
        comments: comments.map((c) => ({
          id: c.id,
          version: c.version,
          block_id: c.block_id,
          display_block_id: attachBlockId(c, requested, rendered.blocks),
          parent_id: c.parent_id,
          author: commentAuthor(c),
          mine: c.author_type === "user" && c.user_id === user.id,
          body: c.body,
          created_at: c.created_at,
          resolved: Boolean(c.resolved_at),
        })),
      });
    }

    // GET /api/plans/:id/diff?from=N&to=M
    if (segments.length === 2 && segments[1] === "diff" && req.method === "GET") {
      const from = Number(url.searchParams.get("from"));
      const to = Number(url.searchParams.get("to"));
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < 1 ||
        from > plan.current_version || to > plan.current_version) {
        return json({ error: "invalid versions" }, 400);
      }
      const [oldMd, newMd] = await Promise.all([
        getVersionMarkdown(env, plan.id, from),
        getVersionMarkdown(env, plan.id, to),
      ]);
      if (oldMd === null || newMd === null) return json({ error: "unknown version" }, 404);
      return json({ from, to, parts: diffPlan(oldMd, newMd) });
    }

    // POST /api/plans/:id/comments — user comment or reply.
    if (segments.length === 2 && segments[1] === "comments" && req.method === "POST") {
      const body = await readJson<{ body?: string; version?: number; block_id?: string; parent_id?: string }>(req);
      const text = typeof body?.body === "string" ? body.body.trim() : "";
      if (!text || text.length > MAX_COMMENT) {
        return json({ error: `body is required (max ${MAX_COMMENT} chars)` }, 400);
      }
      let parentId: string | null = null;
      let version = Number(body?.version) || plan.current_version;
      let blockId: string | null = null;
      if (body?.parent_id) {
        const parent = await env.DB.prepare(
          "SELECT id, parent_id, version, block_id FROM comments WHERE id = ? AND plan_id = ?",
        )
          .bind(String(body.parent_id), plan.id)
          .first<{ id: string; parent_id: string | null; version: number; block_id: string | null }>();
        if (!parent) return json({ error: "parent comment not found" }, 404);
        parentId = parent.parent_id ?? parent.id;
        version = parent.version;
        blockId = parent.block_id;
      } else {
        if (version < 1 || version > plan.current_version) return json({ error: "unknown version" }, 400);
        if (body?.block_id !== undefined && body.block_id !== null) {
          if (!validBlockId(body.block_id)) return json({ error: "invalid block_id" }, 400);
          const markdown = await getVersionMarkdown(env, plan.id, version);
          const blocks = markdown === null ? [] : renderPlan(markdown).blocks;
          if (!blocks.some((b) => b.id === body.block_id)) return json({ error: "unknown block" }, 400);
          blockId = body.block_id;
        }
      }
      const id = randomId(8);
      await env.DB.prepare(
        `INSERT INTO comments (id, plan_id, version, block_id, parent_id, author_type, user_id, agent_name, body, created_at)
         VALUES (?, ?, ?, ?, ?, 'user', ?, NULL, ?, ?)`,
      )
        .bind(id, plan.id, version, blockId, parentId, user.id, text, Date.now())
        .run();
      return json({ id, ok: true }, 201);
    }

    // DELETE /api/plans/:id/comments/:cid — author or plan owner.
    if (segments.length === 3 && segments[1] === "comments" && req.method === "DELETE") {
      const comment = await env.DB.prepare(
        "SELECT id, user_id, author_type FROM comments WHERE id = ? AND plan_id = ?",
      )
        .bind(segments[2], plan.id)
        .first<{ id: string; user_id: string | null; author_type: string }>();
      if (!comment) return json({ error: "not found" }, 404);
      const canDelete = plan.user_id === user.id ||
        (comment.author_type === "user" && comment.user_id === user.id);
      if (!canDelete) return json({ error: "forbidden" }, 403);
      await env.DB.prepare("DELETE FROM comments WHERE id = ? OR parent_id = ?")
        .bind(comment.id, comment.id)
        .run();
      return json({ ok: true });
    }

    // POST /api/plans/:id/comments/:cid/resolve
    if (segments.length === 4 && segments[1] === "comments" && segments[3] === "resolve" && req.method === "POST") {
      const body = await readJson<{ resolved?: boolean }>(req);
      const resolved = body?.resolved !== false;
      const res = await env.DB.prepare(
        "UPDATE comments SET resolved_at = ? WHERE id = ? AND plan_id = ? AND parent_id IS NULL",
      )
        .bind(resolved ? Date.now() : null, segments[2], plan.id)
        .run();
      if (!res.meta.changes) return json({ error: "not found" }, 404);
      return json({ ok: true, resolved });
    }

    // POST /api/plans/:id/review {verdict, note?, version} — current version only.
    if (segments.length === 2 && segments[1] === "review" && req.method === "POST") {
      const body = await readJson<{ verdict?: string; note?: string; version?: number }>(req);
      const verdict = body?.verdict;
      if (verdict !== "approved" && verdict !== "changes_requested") {
        return json({ error: "verdict must be approved or changes_requested" }, 400);
      }
      const version = Number(body?.version);
      if (version !== plan.current_version) {
        return json({ error: "stale version: reviews apply to the current version only", current_version: plan.current_version }, 409);
      }
      const note = typeof body?.note === "string" ? body.note.trim().slice(0, MAX_NOTE) || null : null;
      await env.DB.prepare(
        `INSERT INTO reviews (plan_id, version, user_id, verdict, note, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(plan_id, version, user_id) DO UPDATE SET
           verdict = excluded.verdict, note = excluded.note, created_at = excluded.created_at`,
      )
        .bind(plan.id, version, user.id, verdict, note, Date.now())
        .run();
      return json({ ok: true, status: await planStatus(env, plan) });
    }

    // DELETE /api/plans/:id — owner only; removes everything.
    if (segments.length === 1 && req.method === "DELETE") {
      if (plan.user_id !== user.id) return json({ error: "forbidden" }, 403);
      await env.DB.prepare("DELETE FROM comments WHERE plan_id = ?").bind(plan.id).run();
      await env.DB.prepare("DELETE FROM reviews WHERE plan_id = ?").bind(plan.id).run();
      await env.DB.prepare("DELETE FROM plan_versions WHERE plan_id = ?").bind(plan.id).run();
      await env.DB.prepare("DELETE FROM plans WHERE id = ?").bind(plan.id).run();
      return json({ ok: true });
    }

    return json({ error: "not found" }, 404);
  }

  return json({ error: "not found" }, 404);
}

// --- Main handler ---

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    if (url.pathname === "/dashboard" || url.pathname === "/dashboard/" || url.pathname === "/setup") {
      return new Response(dashboardHtml as unknown as string, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }

    // Raw markdown for a plan — deliberately unauthenticated so agents and
    // tools can fetch the plan text with just the link (ids are unguessable).
    // Canonical form is /p/:id/md; the earlier /p/:id.md form redirects.
    const rawMatch = url.pathname.match(/^\/p\/([a-f0-9]{10})(\.md|\/md)$/);
    if (rawMatch) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        return new Response("method not allowed\n", { status: 405, headers: { allow: "GET, HEAD" } });
      }
      if (rawMatch[2] === ".md") {
        return Response.redirect(`${url.origin}/p/${rawMatch[1]}/md${url.search}`, 301);
      }
      const plan = await getPlan(env, rawMatch[1]!);
      if (!plan) return new Response("not found\n", { status: 404 });
      const version = url.searchParams.has("v") ? Number(url.searchParams.get("v")) : plan.current_version;
      if (!Number.isInteger(version) || version < 1 || version > plan.current_version) {
        return new Response("unknown version\n", { status: 404 });
      }
      const markdown = await getVersionMarkdown(env, plan.id, version);
      if (markdown === null) return new Response("unknown version\n", { status: 404 });
      const body = url.searchParams.get("plain") === "1"
        ? markdown
        : await annotatedMarkdown(env, plan, version, markdown, url.origin);
      return new Response(body, {
        headers: {
          "content-type": "text/markdown; charset=utf-8",
          "cache-control": "no-store",
          "x-plan-version": String(version),
        },
      });
    }

    // Plan viewer shell; the page authenticates and loads via /api/plans/:id.
    if (/^\/p\/[a-f0-9]{10}$/.test(url.pathname)) {
      return new Response(planHtml as unknown as string, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }

    if (url.pathname === "/setup.sh") {
      return new Response(setupSh, {
        headers: { "content-type": "text/x-shellscript; charset=utf-8", "cache-control": "public, max-age=300" },
      });
    }

    // Raw markdown: what agents fetch and install.
    if (url.pathname === "/skill.md") {
      return new Response(skillMd, {
        headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "public, max-age=300" },
      });
    }

    // Human-readable page rendering the same skill verbatim, plus install steps.
    if (url.pathname === "/skill") {
      const escaped = skillMd.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
      return new Response((skillHtmlTemplate as unknown as string).replace("__SKILL_MD__", escaped), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" },
      });
    }

    if (url.pathname.startsWith("/api/")) {
      return handleApi(req, env, url, ctx);
    }

    if (req.method === "GET" || req.method === "HEAD") {
      return Response.redirect(`${url.origin}/dashboard`, 302);
    }

    return new Response("method not allowed\n", {
      status: 405,
      headers: { allow: "GET, HEAD, POST, PUT, DELETE" },
    });
  },
} satisfies ExportedHandler<Env>;
