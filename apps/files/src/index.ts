import dashboardHtml from "./dashboard.html";
import skillMd from "./skill.md";
import skillHtmlTemplate from "./skill.html";
import setupShB64 from "./setup-sh.generated";
import {
  identityFromRequest,
  linkIdentityWithUser,
  resolveIdentityUser,
  type LocalIdentityUser,
} from "../../../platform/src/app-identity";

// Decoded lazily-once; stored base64 because raw shell text in the bundle
// trips the Cloudflare API WAF on deploy.
const setupSh = new TextDecoder().decode(
  Uint8Array.from(atob(setupShB64), (c) => c.charCodeAt(0)),
);

interface Env {
  FILES: R2Bucket;
  DB: D1Database;
  EVENTS_SECRET: string; // shared with events/storage: verifies per-app scoped tokens
  MYSLOP_APP_ID?: string;
  MYSLOP_IDENTITY_KEYS?: string;
  MYSLOP_IDENTITY_SECRET?: string;
  MYSLOP_IDENTITY_LINK_DEADLINE?: string;
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE = "sid";
const TOKEN_PREFIX = "msf_";

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

// --- Sessions ---

interface User extends LocalIdentityUser {
  identity_id: string | null;
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
    `SELECT u.id,u.email,u.name,u.picture,u.identity_id FROM sessions s
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

// --- Scoped-token verification (shared secret with events/storage) ---

function validAppId(id: unknown): id is string {
  return typeof id === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(id);
}

async function verifyAppToken(token: string, secret: string): Promise<string | null> {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify("HMAC", key, unb64url(sig) as BufferSource, enc.encode(body));
  if (!ok) return null;
  try {
    const payload = JSON.parse(dec.decode(unb64url(body)));
    if (typeof payload.exp === "number" && Date.now() > payload.exp) return null;
    return validAppId(payload.appId) ? payload.appId : null;
  } catch {
    return null;
  }
}

// --- Upload API tokens ---

interface TokenOwner {
  userId: string;
  tokenId: string;
}

async function verifyUploadToken(env: Env, secret: string): Promise<TokenOwner | null> {
  if (!secret.startsWith(TOKEN_PREFIX)) return null;
  const hash = await sha256Hex(secret);
  const row = await env.DB.prepare(
    "SELECT id, user_id FROM tokens WHERE hash = ? AND revoked_at IS NULL",
  )
    .bind(hash)
    .first<{ id: string; user_id: string }>();
  return row ? { userId: row.user_id, tokenId: row.id } : null;
}

// --- CORS (browser scoped-upload endpoint for myslop apps) ---

function allowedOrigin(origin: string): boolean {
  try {
    const h = new URL(origin).hostname;
    return h === "myslop.app" || h.endsWith(".myslop.app");
  } catch {
    return false;
  }
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    "access-control-allow-origin": allowedOrigin(origin) ? origin : "null",
    "access-control-allow-methods": "PUT, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, x-upload-token",
  };
}

// --- Content types ---

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  log: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  xml: "application/xml",
  pdf: "application/pdf",
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  wasm: "application/wasm",
};

function guessType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return MIME[ext] ?? "application/octet-stream";
}

function randomId(bytes: number): string {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)));
}

// --- Dashboard API ---

async function handleApi(
  req: Request,
  env: Env,
  url: URL,
  ctx: ExecutionContext,
): Promise<Response> {
  const path = url.pathname;

  // CSRF: mutating requests must come from our own origin (cookies are
  // SameSite=Lax as well; this is belt-and-braces).
  if (req.method !== "GET" && req.method !== "HEAD") {
    const origin = req.headers.get("Origin");
    if (origin !== url.origin) return json({ error: "bad origin" }, 403);
  }

  // GET /api/verify — check an upload token (used by setup.sh). Bearer-authed,
  // not session-authed.
  if (path === "/api/verify" && req.method === "GET") {
    const bearer = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    const owner = bearer.startsWith(TOKEN_PREFIX) ? await verifyUploadToken(env, bearer) : null;
    if (!owner) return json({ error: "invalid token" }, 401);
    const u = await env.DB.prepare("SELECT name, email FROM users WHERE id = ?")
      .bind(owner.userId)
      .first<{ name: string | null; email: string | null }>();
    return json({ ok: true, user: { name: u?.name ?? null, email: u?.email ?? null } });
  }

  const legacyUser = await getSessionUser(req, env);
  const identity = await identityFromRequest(req, env);
  if (identity.present && !identity.claims) return json({ error: "invalid identity assertion" }, 401);

  if (path === "/api/identity/link" && req.method === "POST") {
    if (!identity.claims) return json({ error: "platform identity required" }, 401);
    const bearer = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    const owner = bearer.startsWith(TOKEN_PREFIX) ? await verifyUploadToken(env, bearer) : null;
    if (!owner) return json({ error: "existing Files token required" }, 401);
    const linked = await linkIdentityWithUser(env, identity.claims, owner.userId);
    return linked ? json({ ok: true, user: linked }) : json({ error: "identity link rejected" }, 409);
  }

  let user: LocalIdentityUser | null = legacyUser;
  if (identity.claims) {
    const resolved = await resolveIdentityUser(env, identity.claims, legacyUser);
    if (resolved.linkRequired) return json({ error: "identity link required", code: "identity_link_required" }, 409);
    user = resolved.user;
  }
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

  // GET /api/files
  if (path === "/api/files" && req.method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT key, filename, size, content_type, private, created_at
       FROM files WHERE user_id = ? ORDER BY created_at DESC LIMIT 500`,
    )
      .bind(user.id)
      .all();
    const files = (results as Record<string, unknown>[]).map((f) => ({
      ...f,
      private: Boolean(f.private),
      url: `${url.origin}/${f.key}`,
    }));
    return json({ files });
  }

  // PATCH or DELETE /api/files/<key> (key contains a slash)
  if (path.startsWith("/api/files/")) {
    const key = decodeURIComponent(path.slice("/api/files/".length));
    const row = await env.DB.prepare("SELECT key FROM files WHERE key = ? AND user_id = ?")
      .bind(key, user.id)
      .first();
    if (!row) return json({ error: "not found" }, 404);

    if (req.method === "DELETE") {
      await env.FILES.delete(key);
      await env.DB.prepare("DELETE FROM files WHERE key = ?").bind(key).run();
      return json({ ok: true });
    }
    if (req.method === "PATCH") {
      let body: { private?: boolean };
      try {
        body = (await req.json()) as { private?: boolean };
      } catch {
        return json({ error: "invalid body" }, 400);
      }
      if (typeof body.private !== "boolean") return json({ error: "expected {private: boolean}" }, 400);
      await env.DB.prepare("UPDATE files SET private = ? WHERE key = ?")
        .bind(body.private ? 1 : 0, key)
        .run();
      return json({ ok: true, private: body.private });
    }
    return json({ error: "method not allowed" }, 405);
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
    try {
      const body = (await req.json()) as { name?: string };
      if (typeof body.name === "string" && body.name.trim()) name = body.name.trim().slice(0, 64);
    } catch {
      // default name
    }
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

  return json({ error: "not found" }, 404);
}

// --- Main handler ---

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const key = decodeURIComponent(url.pathname.slice(1));
    const origin = req.headers.get("Origin") ?? "";

    // CORS preflight for the browser scoped-upload endpoint.
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // /setup is the same SPA in token-setup mode: it signs the user in and
    // auto-mints a token named from ?name=, shown on a clean copy page.
    if (url.pathname === "/dashboard" || url.pathname === "/dashboard/" || url.pathname === "/setup") {
      return new Response(dashboardHtml as unknown as string, {
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

    // Scoped upload: apps upload with their per-app token (no upload secret in
    // the browser). Files land under app/<appId>/ and get a public URL.
    if (req.method === "PUT" && url.pathname.startsWith("/app-upload/")) {
      const auth = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
      const appId = await verifyAppToken(auth, env.EVENTS_SECRET);
      if (!appId) {
        return new Response("unauthorized\n", { status: 401, headers: corsHeaders(origin) });
      }
      const filename = decodeURIComponent(url.pathname.slice("/app-upload/".length))
        .split("/")
        .pop() ?? "";
      if (!filename) {
        return new Response("missing filename\n", { status: 400, headers: corsHeaders(origin) });
      }
      const id = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
      const objectKey = `app/${appId}/${id}/${filename}`;
      const clientType = req.headers.get("Content-Type");
      await env.FILES.put(objectKey, req.body, {
        httpMetadata: {
          contentType:
            clientType && clientType !== "application/octet-stream"
              ? clientType
              : guessType(filename),
        },
      });
      return new Response(`https://${url.hostname}/${objectKey}\n`, {
        status: 201,
        headers: corsHeaders(origin),
      });
    }

    // Direct upload: per-user API token minted at /dashboard, via
    // Authorization: Bearer or X-Upload-Token.
    if (req.method === "PUT") {
      const bearer = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
      const candidate = bearer || req.headers.get("X-Upload-Token") || "";

      const owner = await verifyUploadToken(env, candidate);
      if (!owner) return new Response("unauthorized\n", { status: 401 });

      const filename = key.split("/").pop() ?? "";
      if (!filename) return new Response("missing filename\n", { status: 400 });

      // Random prefix: no collisions between uploads, URLs not enumerable.
      const id = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
      const objectKey = `${id}/${filename}`;

      const clientType = req.headers.get("Content-Type");
      const obj = await env.FILES.put(objectKey, req.body, {
        httpMetadata: {
          contentType:
            clientType && clientType !== "application/octet-stream"
              ? clientType
              : guessType(filename),
        },
      });

      if (owner) {
        const isPrivate = url.searchParams.get("private") === "1";
        await env.DB.prepare(
          `INSERT INTO files (key, user_id, filename, size, content_type, private, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
          .bind(
            objectKey,
            owner.userId,
            filename,
            obj?.size ?? null,
            obj?.httpMetadata?.contentType ?? guessType(filename),
            isPrivate ? 1 : 0,
            Date.now(),
          )
          .run();
        ctx.waitUntil(
          env.DB.prepare("UPDATE tokens SET last_used_at = ? WHERE id = ?")
            .bind(Date.now(), owner.tokenId)
            .run(),
        );
      }

      return new Response(`https://${url.hostname}/${objectKey}\n`, {
        status: 201,
      });
    }

    if (req.method === "GET" || req.method === "HEAD") {
      if (!key) return Response.redirect(`${url.origin}/dashboard`, 302);

      // Private files are only served to their owner's dashboard session.
      const meta = await env.DB.prepare("SELECT user_id, private FROM files WHERE key = ?")
        .bind(key)
        .first<{ user_id: string; private: number }>();
      const isPrivate = Boolean(meta?.private);
      if (isPrivate) {
        let user = await getSessionUser(req, env);
        const asserted = await identityFromRequest(req, env);
        if (asserted.present) {
          if (!asserted.claims) return new Response("not found\n", { status: 404 });
          const resolved = await resolveIdentityUser(env, asserted.claims, user);
          user = resolved.user;
        }
        if (!user || user.id !== meta!.user_id) {
          return new Response("not found\n", { status: 404 });
        }
      }

      const obj = await env.FILES.get(key);
      if (!obj) return new Response("not found\n", { status: 404 });

      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set("etag", obj.httpEtag);
      // Keys are content-unique (random prefix): public files cache forever;
      // private files must never land in a shared cache.
      headers.set(
        "cache-control",
        isPrivate ? "private, no-store" : "public, max-age=31536000, immutable",
      );
      if (!headers.get("content-type")) {
        headers.set("content-type", guessType(key));
      }
      headers.set("x-content-type-options", "nosniff");
      // User content is served from the same origin as the authenticated
      // dashboard, so scriptable documents (HTML/SVG/XML) must run in an
      // opaque origin: CSP sandbox WITHOUT allow-same-origin. Scripts still
      // work, but the document gets no cookies and cannot call /api/*.
      const ct = (headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      const scriptable = [
        "text/html",
        "application/xhtml+xml",
        "image/svg+xml",
        "application/xml",
        "text/xml",
      ];
      if (scriptable.includes(ct)) {
        headers.set(
          "content-security-policy",
          "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads",
        );
      }
      return new Response(req.method === "HEAD" ? null : obj.body, { headers });
    }

    return new Response("method not allowed\n", {
      status: 405,
      headers: { allow: "GET, HEAD, PUT, PATCH, DELETE, OPTIONS" },
    });
  },
} satisfies ExportedHandler<Env>;
