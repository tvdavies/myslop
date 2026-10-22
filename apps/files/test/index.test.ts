import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import worker, { createShooSession, resolveShooUserId } from "../src/index";

const encoder = new TextEncoder();

function database(metadata: { user_id?: string; visibility?: string } | null = null) {
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
          const result = db.query(sql).run(...values as never[]);
          return { success: true, meta: { changes: result.changes } };
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

  test("streams public objects with revalidating cache and sandbox headers", async () => {
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
    expect(response.headers.get("cache-control")).toBe("public, no-cache");
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

  function conditionalGet(contentType: string, ifNoneMatch?: string) {
    let cancelled = false;
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    const env = {
      DB: database(),
      EVENTS_SECRET: "secret",
      FILES: {
        get: async () => ({
          body,
          httpEtag: '"v2"',
          writeHttpMetadata(headers: Headers) { headers.set("content-type", contentType); },
        }),
      },
    };
    const headers: Record<string, string> = ifNoneMatch ? { "if-none-match": ifNoneMatch } : {};
    const response = worker.fetch(new Request("https://files.myslop.app/abc/index.html", { headers }) as never, env as never, context()) as unknown as Promise<Response>;
    return { response, cancelled: () => cancelled };
  }

  test("answers 304 with the sandbox when the ETag still matches", async () => {
    const etag = (await (await conditionalGet("text/html").response).headers.get("etag"))!;
    for (const header of [etag, `W/${etag}`, `"other", ${etag}`, "*"]) {
      const request = conditionalGet("text/html", header);
      const response = await request.response;
      expect(response.status).toBe(304);
      expect(response.headers.get("content-security-policy")).toContain("sandbox");
      expect(request.cancelled()).toBe(true);
    }
    expect((await conditionalGet("text/html", '"v1"').response).status).toBe(200);
  });

  test("a content-type change alone changes the ETag", async () => {
    const plain = (await conditionalGet("text/plain").response).headers.get("etag")!;
    const response = await conditionalGet("text/html", plain).response;
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
  });

  // A stored object whose body must not be sent: denial cancels it.
  function refusedObject() {
    let cancelled = false;
    return {
      cancelled: () => cancelled,
      FILES: {
        get: async () => ({
          body: new ReadableStream({ cancel() { cancelled = true; } }),
          httpEtag: '"v1"',
          writeHttpMetadata(headers: Headers) { headers.set("content-type", "text/plain"); },
        }),
      },
    };
  }

  test("keeps private files hidden without the owner session", async () => {
    const object = refusedObject();
    const env = { DB: database({ user_id: "owner", visibility: "private" }), EVENTS_SECRET: "secret", FILES: object.FILES };
    const response = await worker.fetch(new Request("https://files.myslop.app/private.txt") as never, env as never, context()) as unknown as Response;
    expect(response.status).toBe(404);
    expect(object.cancelled()).toBe(true);
  });

  test("sends anonymous browsers to sign in for protected files and 401s other clients", async () => {
    const env = { DB: database({ user_id: "owner", visibility: "protected" }), EVENTS_SECRET: "secret", FILES: refusedObject().FILES };
    const browser = await worker.fetch(new Request("https://files.myslop.app/abcdef0123/report.html", {
      headers: { accept: "text/html,application/xhtml+xml" },
    }) as never, env as never, context()) as unknown as Response;
    expect(browser.status).toBe(302);
    expect(browser.headers.get("location")).toBe(
      `https://myslop.cloud/?returnTo=${encodeURIComponent("https://files.myslop.app/abcdef0123/report.html")}`,
    );
    const image = await worker.fetch(new Request("https://files.myslop.app/abcdef0123/shot.png", {
      headers: { accept: "image/*" },
    }) as never, env as never, context()) as unknown as Response;
    expect(image.status).toBe(401);
  });
});

describe("platform identity", () => {
  function identityEnv() {
    const { db, env } = identityDatabase();
    db.exec(`CREATE TABLE files (
      key TEXT PRIMARY KEY, user_id TEXT NOT NULL, filename TEXT, size INTEGER,
      content_type TEXT, private INTEGER DEFAULT 0,
      visibility TEXT CHECK (visibility IN ('private', 'protected', 'public')),
      created_at INTEGER
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
    expect(db.query("SELECT user_id, filename, visibility, private FROM files").get()).toEqual({
      user_id: "shoo-user",
      filename: "report.txt",
      visibility: "protected",
      private: 1,
    });
  });

  test("uploads with a requested visibility and rejects unknown ones", async () => {
    const { db, env } = identityEnv();
    const upload = (query: string) => worker.fetch(new Request(`https://files.myslop.app/report.txt${query}`, {
      method: "PUT",
      headers: IDENTITY_HEADERS,
      body: "hello",
    }) as never, env as never, context()) as unknown as Promise<Response>;
    expect((await upload("?visibility=public")).status).toBe(201);
    expect((await upload("?private=1")).status).toBe(201);
    expect((await upload("?visibility=secret")).status).toBe(400);
    expect(db.query("SELECT visibility, private FROM files ORDER BY visibility").all()).toEqual([
      { visibility: "private", private: 1 },
      { visibility: "public", private: 0 },
    ]);
  });

  function replaceEnv() {
    const { db, env } = identityEnv();
    db.query("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)").run("someone-else", "bob@example.com", "Bob", 1);
    db.query("INSERT INTO files (key, user_id, filename, size, content_type, private, visibility, created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run("0123456789/report.html", "shoo-user", "report.html", 1, "text/html; charset=utf-8", 0, "public", 1);
    db.query("INSERT INTO files (key, user_id, filename, size, content_type, private, visibility, created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run("abcdefabcd/notes.txt", "someone-else", "notes.txt", 1, "text/plain; charset=utf-8", 1, "protected", 1);
    const puts: string[] = [];
    const files = {
      put: async (key: string, _body: unknown, opts: { httpMetadata?: { contentType?: string } }) => {
        puts.push(key);
        return { size: 9, httpMetadata: { contentType: opts.httpMetadata?.contentType } };
      },
    };
    return { db, puts, env: { ...env, FILES: files } };
  }

  function put(path: string, body = "version 2") {
    return new Request(`https://files.myslop.app/${path}`, { method: "PUT", headers: IDENTITY_HEADERS, body });
  }

  test("replaces the owner's file in place and keeps its URL", async () => {
    const { db, puts, env } = replaceEnv();
    const response = await worker.fetch(put("0123456789/report.html") as never, env as never, context()) as unknown as Response;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("https://files.myslop.app/0123456789/report.html\n");
    expect(puts).toEqual(["0123456789/report.html"]);
    expect(db.query("SELECT key, size, visibility FROM files WHERE user_id = ? ORDER BY key").all("shoo-user")).toEqual([
      { key: "0123456789/report.html", size: 9, visibility: "public" },
    ]);
  });

  function visibilityAtWrite(query: string, initial: string) {
    const { db, env } = replaceEnv();
    db.query("UPDATE files SET visibility = ?, private = ? WHERE key = ?")
      .run(initial, initial === "public" ? 0 : 1, "0123456789/report.html");
    let atWrite: unknown = null;
    const files = {
      ...env.FILES,
      put: async (key: string, body: unknown, opts: { httpMetadata?: { contentType?: string } }) => {
        atWrite = db.query("SELECT visibility, private FROM files WHERE key = ?").get(key);
        return env.FILES.put(key, body, opts);
      },
    };
    return worker.fetch(put(`0123456789/report.html${query}`) as never, { ...env, FILES: files } as never, context())
      .then(() => ({
        atWrite,
        after: db.query("SELECT visibility, private FROM files WHERE key = ?").get("0123456789/report.html"),
      }));
  }

  test("tightens visibility before the new bytes are written and loosens it after", async () => {
    expect(await visibilityAtWrite("?visibility=protected", "public")).toEqual({
      atWrite: { visibility: "protected", private: 1 },
      after: { visibility: "protected", private: 1 },
    });
    expect(await visibilityAtWrite("?private=1", "protected")).toEqual({
      atWrite: { visibility: "private", private: 1 },
      after: { visibility: "private", private: 1 },
    });
    expect(await visibilityAtWrite("?visibility=protected", "private")).toEqual({
      atWrite: { visibility: "private", private: 1 },
      after: { visibility: "protected", private: 1 },
    });
    expect(await visibilityAtWrite("?visibility=public", "protected")).toEqual({
      atWrite: { visibility: "protected", private: 1 },
      after: { visibility: "public", private: 0 },
    });
    expect(await visibilityAtWrite("", "private")).toEqual({
      atWrite: { visibility: "private", private: 1 },
      after: { visibility: "private", private: 1 },
    });
  });

  function getFile(env: unknown, path: string, headers: Record<string, string> = {}) {
    const files = {
      get: async () => ({
        body: new ReadableStream({ start(controller) { controller.enqueue(encoder.encode("hello")); controller.close(); } }),
        httpEtag: '"v1"',
        writeHttpMetadata(h: Headers) { h.set("content-type", "text/plain"); },
      }),
    };
    return worker.fetch(new Request(`https://files.myslop.app/${path}`, { headers }) as never, { ...(env as object), FILES: files } as never, context()) as unknown as Promise<Response>;
  }

  test("serves protected files to any signed-in user and private files only to their owner", async () => {
    const { db, env } = replaceEnv();
    db.query("INSERT INTO files (key, user_id, filename, visibility, private) VALUES (?,?,?,?,?)")
      .run("fedcba9876/secret.txt", "someone-else", "secret.txt", "private", 1);
    const bob = { "x-myslop-user-id": "plat-2", "x-myslop-user-email": "bob@example.com" };

    const protectedFile = await getFile(env, "abcdefabcd/notes.txt", IDENTITY_HEADERS);
    expect(protectedFile.status).toBe(200);
    expect(protectedFile.headers.get("cache-control")).toBe("private, no-cache");
    expect((await getFile(env, "abcdefabcd/notes.txt")).status).toBe(401);

    expect((await getFile(env, "fedcba9876/secret.txt", IDENTITY_HEADERS)).status).toBe(404);
    const owner = await getFile(env, "fedcba9876/secret.txt", bob);
    expect(owner.status).toBe(200);
    expect(owner.headers.get("cache-control")).toBe("private, no-store");
  });

  test("changes visibility from the dashboard, accepting the legacy private flag", async () => {
    const { db, env } = replaceEnv();
    db.query("INSERT INTO sessions VALUES (?,?,?,?)").run("b".repeat(64), "shoo-user", 1, Date.now() + 60_000);
    const patch = (body: unknown) => worker.fetch(new Request("https://files.myslop.app/api/files/0123456789/report.html", {
      method: "PATCH",
      headers: { cookie: `sid=${"b".repeat(64)}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as never, env as never, context()) as unknown as Promise<Response>;
    const row = () => db.query("SELECT visibility, private FROM files WHERE key = ?").get("0123456789/report.html");

    expect(await (await patch({ visibility: "protected" })).json() as unknown).toEqual({ ok: true, visibility: "protected" });
    expect(row()).toEqual({ visibility: "protected", private: 1 });
    await patch({ private: false });
    expect(row()).toEqual({ visibility: "public", private: 0 });
    expect((await patch({ visibility: "everyone" })).status).toBe(400);
    expect((await patch({ visibility: "everyone", private: true })).status).toBe(400);
    expect(row()).toEqual({ visibility: "public", private: 0 });
  });

  test("checks visibility after reading the object, so a concurrent tighten wins", async () => {
    const { db, env } = replaceEnv();
    const files = {
      get: async () => {
        // The owner's replacement tightens the file between our object read
        // and our metadata read.
        db.query("UPDATE files SET visibility = 'private', private = 1 WHERE key = ?").run("0123456789/report.html");
        return {
          body: new ReadableStream(),
          httpEtag: '"v2"',
          writeHttpMetadata(h: Headers) { h.set("content-type", "text/html"); },
        };
      },
    };
    const response = await worker.fetch(new Request("https://files.myslop.app/0123456789/report.html") as never, { ...env, FILES: files } as never, context()) as unknown as Response;
    expect(response.status).toBe(404);
  });

  test("lets the owner's dashboard session open a private file alongside another platform identity", async () => {
    const { db, env } = replaceEnv();
    db.query("UPDATE files SET visibility = 'private', private = 1 WHERE key = ?").run("abcdefabcd/notes.txt");
    db.query("INSERT INTO sessions VALUES (?,?,?,?)").run("c".repeat(64), "someone-else", 1, Date.now() + 60_000);
    const response = await getFile(env, "abcdefabcd/notes.txt", { ...IDENTITY_HEADERS, cookie: `sid=${"c".repeat(64)}` });
    expect(response.status).toBe(200);
  });

  test("lets a dashboard session open protected files", async () => {
    const { db, env } = replaceEnv();
    db.query("INSERT INTO sessions VALUES (?,?,?,?)").run("a".repeat(64), "someone-else", 1, Date.now() + 60_000);
    const response = await getFile(env, "abcdefabcd/notes.txt", { cookie: `sid=${"a".repeat(64)}` });
    expect(response.status).toBe(200);
  });

  test("does not recreate a file deleted while its replacement uploads", async () => {
    const { db, env } = replaceEnv();
    const deleted: string[] = [];
    const files = {
      put: async (key: string) => {
        db.query("DELETE FROM files WHERE key = ?").run(key);
        return { size: 9, httpMetadata: { contentType: "text/html" } };
      },
      delete: async (key: string) => { deleted.push(key); },
    };
    const response = await worker.fetch(put("0123456789/report.html") as never, { ...env, FILES: files } as never, context()) as unknown as Response;
    expect(response.status).toBe(404);
    expect(deleted).toEqual(["0123456789/report.html"]);
  });

  test("refuses to replace another user's file or an unknown key", async () => {
    const { db, puts, env } = replaceEnv();
    for (const path of ["abcdefabcd/notes.txt", "fedcba9876/report.html"]) {
      const response = await worker.fetch(put(path) as never, env as never, context()) as unknown as Response;
      expect(response.status).toBe(404);
    }
    expect(puts).toEqual([]);
    expect(db.query("SELECT COUNT(*) AS n FROM files").get()).toEqual({ n: 2 });
  });

  test("deletes the owner's file and refuses anyone else's", async () => {
    const { db, env } = replaceEnv();
    const deleted: string[] = [];
    const files = { ...env.FILES, delete: async (key: string) => { deleted.push(key); } };
    const del = (path: string, headers: Record<string, string> = IDENTITY_HEADERS) =>
      worker.fetch(new Request(`https://files.myslop.app/${path}`, { method: "DELETE", headers }) as never, { ...env, FILES: files } as never, context()) as unknown as Promise<Response>;

    expect((await del("0123456789/report.html", {})).status).toBe(401);
    expect((await del("abcdefabcd/notes.txt")).status).toBe(404);
    expect((await del("fedcba9876/missing.txt")).status).toBe(404);
    expect(deleted).toEqual([]);

    const response = await del("0123456789/report.html");
    expect(response.status).toBe(200);
    expect(deleted).toEqual(["0123456789/report.html"]);
    expect(db.query("SELECT key FROM files ORDER BY key").all()).toEqual([{ key: "abcdefabcd/notes.txt" }]);
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

describe("visibility migration", () => {
  test("backfills existing files and gives legacy writes their old meaning", async () => {
    const root = new URL("..", import.meta.url).pathname;
    // The schema as it was before migration 002: the same tables without the visibility column.
    const before = (await Bun.file(`${root}/schema.sql`).text()).replace(/^\s*visibility TEXT[^\n]*\n/m, "");
    expect(before).not.toContain("visibility TEXT");
    const db = new Database(":memory:");
    db.exec(before);
    db.exec("INSERT INTO users (id, created_at) VALUES ('u', 1)");
    const insertLegacy = db.query("INSERT INTO files (key, user_id, filename, private, created_at) VALUES (?, 'u', 'f', ?, 1)");
    insertLegacy.run("old/private", 1);
    insertLegacy.run("old/public", 0);
    db.exec(await Bun.file(`${root}/migrations/002_file_visibility.sql`).text());
    const visibility = (key: string) => (db.query("SELECT visibility FROM files WHERE key = ?").get(key) as { visibility: string }).visibility;
    expect([visibility("old/private"), visibility("old/public")]).toEqual(["private", "public"]);

    // A build that only knows `private`, e.g. after a rollback.
    insertLegacy.run("legacy/private", 1);
    insertLegacy.run("legacy/public", 0);
    expect([visibility("legacy/private"), visibility("legacy/public")]).toEqual(["private", "public"]);
    db.exec("INSERT INTO files (key, user_id, filename, private, visibility, created_at) VALUES ('new/protected', 'u', 'f', 1, 'protected', 1)");
    db.exec("UPDATE files SET private = 0 WHERE key = 'new/protected'");
    expect(visibility("new/protected")).toBe("public");
    db.exec("UPDATE files SET private = 1 WHERE key = 'old/public'");
    expect(visibility("old/public")).toBe("private");

    // Writes from this build set both columns and are left alone.
    db.exec("UPDATE files SET visibility = 'protected', private = 1 WHERE key = 'old/public'");
    db.exec("UPDATE files SET visibility = 'protected', private = 1 WHERE key = 'old/public'");
    expect(visibility("old/public")).toBe("protected");
    db.exec("UPDATE files SET visibility = 'public', private = 0 WHERE key = 'old/public'");
    expect(visibility("old/public")).toBe("public");
  });
});
