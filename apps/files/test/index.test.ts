import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import worker, { createShooSession, resolveShooUserId } from "../src/index";

const encoder = new TextEncoder();

function database(metadata: { user_id?: string; private?: number } | null = null) {
  return {
    prepare() {
      return {
        bind() { return this; },
        first: async () => metadata,
        run: async () => ({ success: true }),
      };
    },
  };
}

function context() {
  return { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
}

async function appToken(appId: string, secret: string): Promise<string> {
  const body = btoa(JSON.stringify({ appId, exp: Date.now() + 60_000 })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
  let binary = "";
  for (const byte of signature) binary += String.fromCharCode(byte);
  return `${body}.${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

function identityDatabase(beforeUserInsert?: (db: Database) => void) {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, name TEXT, picture TEXT, created_at INTEGER NOT NULL);
    CREATE UNIQUE INDEX users_verified_email ON users(email COLLATE NOCASE) WHERE email IS NOT NULL;
    CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
  `);
  let injected = false;
  const binding = {
    prepare(sql: string) {
      let values: unknown[] = [];
      return {
        bind(...bound: unknown[]) { values = bound; return this; },
        first: async <T>() => db.query(sql).get(...values as never[]) as T | null,
        run: async () => {
          if (!injected && sql.startsWith("INSERT INTO users") && beforeUserInsert) {
            injected = true;
            beforeUserInsert(db);
          }
          db.query(sql).run(...values as never[]);
          return { success: true };
        },
      };
    },
  };
  return { db, env: { DB: binding } };
}

describe("Files app compatibility", () => {
  test("keeps the verified account and session across Shoo origin aliases", async () => {
    const { db, env } = identityDatabase();
    db.query("INSERT INTO users VALUES (?,?,?,?,?)").run("original-user", "tom@lleverage.ai", null, null, 1);
    await createShooSession(env as never, {
      pairwise_sub: "alias-specific-user",
      email: "Tom@Lleverage.ai",
      email_verified: true,
    }, 2, "session-id");
    expect(db.query("SELECT id FROM users ORDER BY id").all()).toEqual([{ id: "original-user" }]);
    expect(db.query("SELECT user_id FROM sessions WHERE id=?").get("session-id")).toEqual({ user_id: "original-user" });
  });

  test("does not link unverified email and recovers a concurrent verified login", async () => {
    const unverified = identityDatabase();
    unverified.db.query("INSERT INTO users VALUES (?,?,?,?,?)").run("original-user", "tom@lleverage.ai", null, null, 1);
    await createShooSession(unverified.env as never, {
      pairwise_sub: "unverified-user",
      email: "tom@lleverage.ai",
      email_verified: false,
    }, 2, "unverified-session");
    expect(unverified.db.query("SELECT email FROM users WHERE id=?").get("unverified-user")).toEqual({ email: null });
    expect(await resolveShooUserId(unverified.env as never, { pairwise_sub: "no-email" })).toBe("no-email");

    const concurrent = identityDatabase((db) => {
      db.query("INSERT INTO users VALUES (?,?,?,?,?)").run("winner", "tom@lleverage.ai", null, null, 1);
    });
    await createShooSession(concurrent.env as never, {
      pairwise_sub: "racing-user",
      email: "tom@lleverage.ai",
      email_verified: true,
    }, 2, "race-session");
    expect(concurrent.db.query("SELECT user_id FROM sessions WHERE id=?").get("race-session")).toEqual({ user_id: "winner" });
  });

  test("streams public objects with immutable and sandbox headers", async () => {
    const body = new ReadableStream({ start(controller) { controller.enqueue(encoder.encode("<script>ok</script>")); controller.close(); } });
    const env = {
      DB: database(),
      EVENTS_SECRET: "secret",
      FILES: {
        get: async () => ({
          body,
          httpEtag: '"etag"',
          writeHttpMetadata(headers: Headers) { headers.set("content-type", "text/html"); },
        }),
      },
    };
    const response = await worker.fetch(new Request("https://files.myslop.app/abc/index.html") as never, env as never, context()) as unknown as Response;
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(await response.text()).toBe("<script>ok</script>");
  });

  test("preserves scoped app-upload HMAC and streams the request body", async () => {
    let uploaded: { key: string; body: ReadableStream | null } | null = null;
    const env = {
      DB: database(),
      EVENTS_SECRET: "shared-secret",
      FILES: {
        put: async (key: string, body: ReadableStream | null) => {
          uploaded = { key, body };
          return { size: 5, httpMetadata: { contentType: "text/plain" } };
        },
      },
    };
    const token = await appToken("events", env.EVENTS_SECRET);
    const response = await worker.fetch(new Request("https://files.myslop.app/app-upload/report.txt", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "text/plain", origin: "https://demo.myslop.app" },
      body: "hello",
    }) as never, env as never, context()) as unknown as Response;
    expect(response.status).toBe(201);
    const stored = uploaded as { key: string; body: ReadableStream | null } | null;
    expect(stored).not.toBeNull();
    expect(stored!.key).toMatch(/^app\/events\/[a-f0-9]{10}\/report\.txt$/);
    expect(stored!.body).toBeInstanceOf(ReadableStream);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://demo.myslop.app");
  });

  test("keeps private files hidden without the owner session", async () => {
    const env = { DB: database({ user_id: "owner", private: 1 }), EVENTS_SECRET: "secret", FILES: { get: async () => { throw new Error("must not load private object"); } } };
    const response = await worker.fetch(new Request("https://files.myslop.app/private.txt") as never, env as never, context()) as unknown as Response;
    expect(response.status).toBe(404);
  });
});

describe("platform identity", () => {
  function identityEnv() {
    const { db, env } = identityDatabase();
    db.exec(`CREATE TABLE files (
      key TEXT PRIMARY KEY, user_id TEXT NOT NULL, filename TEXT, size INTEGER,
      content_type TEXT, private INTEGER DEFAULT 0, created_at INTEGER
    )`);
    db.query("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)").run(
      "shoo-user",
      "ada@example.com",
      "Ada",
      1,
    );
    return {
      db,
      env: {
        ...env,
        EVENTS_SECRET: "secret",
        FILES: {
          put: async (_key: string, _body: unknown, opts: { httpMetadata?: { contentType?: string } }) => ({
            size: 5,
            httpMetadata: { contentType: opts.httpMetadata?.contentType },
          }),
        },
      },
    };
  }

  const IDENTITY_HEADERS = {
    "x-myslop-user-id": "plat-1",
    "x-myslop-user-email": "ada@example.com",
    "x-myslop-user-name": "Ada",
  };

  test("uploads with dispatcher-injected identity, joined to the Shoo account by email", async () => {
    const { db, env } = identityEnv();
    const response = await worker.fetch(new Request("https://files.myslop.app/report.txt", {
      method: "PUT",
      headers: IDENTITY_HEADERS,
      body: "hello",
    }) as never, env as never, context()) as unknown as Response;
    expect(response.status).toBe(201);
    expect(await response.text()).toMatch(/^https:\/\/files\.myslop\.app\/[a-f0-9]{10}\/report\.txt\n$/);
    expect(db.query("SELECT user_id, filename FROM files").get()).toEqual({
      user_id: "shoo-user",
      filename: "report.txt",
    });
  });

  test("verifies identity at /api/verify without a bearer", async () => {
    const { env } = identityEnv();
    const response = await worker.fetch(new Request("https://files.myslop.app/api/verify", {
      headers: IDENTITY_HEADERS,
    }) as never, env as never, context()) as unknown as Response;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, user: { email: "ada@example.com" } });
  });

  test("uploads without identity or a valid token still 401", async () => {
    const { env } = identityEnv();
    const response = await worker.fetch(new Request("https://files.myslop.app/report.txt", {
      method: "PUT",
      body: "hello",
    }) as never, env as never, context()) as unknown as Response;
    expect(response.status).toBe(401);
  });
});
