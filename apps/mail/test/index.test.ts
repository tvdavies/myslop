import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import worker, { createShooSession, resolveShooUserId } from "../src/index";
import { sha256Hex } from "../../../platform/src/core";
import { signInternalRequest } from "../../../platform/src/internal";

function context(pending: Promise<unknown>[]) {
  return {
    waitUntil(promise: Promise<unknown>) { pending.push(promise); },
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
}

async function signedRequest(path: string, body: string, secret: string, headers: HeadersInit = {}): Promise<Request> {
  const bytes = new TextEncoder().encode(body);
  const bodyHash = await sha256Hex(bytes);
  const signature = await signInternalRequest(secret, "POST", path, bodyHash);
  return new Request(`https://mail.myslop.app${path}`, {
    method: "POST",
    headers: {
      ...headers,
      "x-myslop-body-sha256": bodyHash,
      "x-myslop-internal-timestamp": signature.timestamp,
      "x-myslop-internal-nonce": signature.nonce,
      "x-myslop-internal-signature": signature.signature,
    },
    body,
  });
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

describe("Mail platform adapters", () => {
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

  test("rejects unsigned internal routes", async () => {
    const response = await worker.fetch(
      new Request("https://mail.myslop.app/__scheduled", { method: "POST" }) as never,
      { MYSLOP_INTERNAL_SECRET: "secret" } as never,
      context([]),
    ) as unknown as Response;
    expect(response.status).toBe(404);
  });

  test("stores internal email idempotently under the existing R2 key layout", async () => {
    const objects = new Map<string, string>();
    const pending: Promise<unknown>[] = [];
    const env = {
      MYSLOP_INTERNAL_SECRET: "secret",
      DB: {
        prepare() {
          return { bind() { return this; }, run: async () => ({ success: true }) };
        },
      },
      FILES: {
        head: async (key: string) => objects.has(key) ? {} : null,
        put: async (key: string, value: string) => { objects.set(key, value); },
      },
      INBOX_HUB: {
        idFromName: (name: string) => name,
        get: () => ({ fetch: async () => new Response("ok") }),
      },
    };
    const raw = "From: Sender <sender@example.com>\r\nTo: demo@myslop.app\r\nSubject: Hello\r\n\r\nVisit https://example.com/verify";
    const request = await signedRequest("/__email", raw, env.MYSLOP_INTERNAL_SECRET, {
      "content-type": "message/rfc822",
      "x-myslop-delivery-id": "delivery-1",
      "x-myslop-mail-from": "sender@example.com",
      "x-myslop-rcpt-to": "demo@myslop.app",
    });
    const first = await worker.fetch(request as never, env as never, context(pending)) as unknown as Response;
    expect(first.status).toBe(201);
    await Promise.all(pending);
    expect(objects.has("inbox/demo/delivery-1.json")).toBe(true);
    expect(JSON.parse(objects.get("inbox/demo/delivery-1.json")!).links).toEqual(["https://example.com/verify"]);

    const duplicateRequest = await signedRequest("/__email", raw, env.MYSLOP_INTERNAL_SECRET, {
      "content-type": "message/rfc822",
      "x-myslop-delivery-id": "delivery-1",
      "x-myslop-mail-from": "sender@example.com",
      "x-myslop-rcpt-to": "demo@myslop.app",
    });
    const duplicate = await worker.fetch(duplicateRequest as never, env as never, context([])) as unknown as Response;
    expect(duplicate.status).toBe(200);
    expect((await duplicate.json() as { duplicate?: boolean }).duplicate).toBe(true);
  });
});

describe("platform identity", () => {
  function identityEnv() {
    const { db, env } = identityDatabase();
    db.exec(`CREATE TABLE inboxes (
      name TEXT PRIMARY KEY, user_id TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
      claimed INTEGER NOT NULL DEFAULT 0, created_at INTEGER, last_read_at INTEGER, lease_expires_at INTEGER
    )`);
    return { db, env: { ...env, FILES: {} } };
  }

  const IDENTITY_HEADERS = {
    "x-myslop-user-id": "plat-1",
    "x-myslop-user-email": "ada@example.com",
    "x-myslop-user-name": "Ada",
  };

  test("claims an inbox with dispatcher-injected identity", async () => {
    const { db, env } = identityEnv();
    const response = await worker.fetch(new Request("https://mail.myslop.app/claim", {
      method: "POST",
      headers: { ...IDENTITY_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ name: "big-donkey", note: "staging" }),
    }) as never, env as never, context([])) as unknown as Response;
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ name: "big-donkey", address: "big-donkey@myslop.app" });
    expect(db.query("SELECT user_id, claimed FROM inboxes WHERE name = ?").get("big-donkey")).toEqual({
      user_id: "plat-1",
      claimed: 1,
    });
  });

  test("verifies identity at /api/verify without a bearer", async () => {
    const { env } = identityEnv();
    const response = await worker.fetch(new Request("https://mail.myslop.app/api/verify", {
      headers: IDENTITY_HEADERS,
    }) as never, env as never, context([])) as unknown as Response;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, user: { email: "ada@example.com" } });
  });

  test("agent API without identity or a valid token still 401", async () => {
    const { env } = identityEnv();
    const response = await worker.fetch(new Request("https://mail.myslop.app/claims") as never, env as never, context([])) as unknown as Response;
    expect(response.status).toBe(401);
  });
});
