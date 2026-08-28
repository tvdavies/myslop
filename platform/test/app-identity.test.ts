import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { platformIdentity, resolvePlatformUser } from "../src/app-identity";

// Same users-table shape every myslop app carries.
function appDatabase(beforeUserInsert?: (db: Database) => void) {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, name TEXT, picture TEXT, created_at INTEGER NOT NULL);
    CREATE UNIQUE INDEX users_verified_email ON users(email COLLATE NOCASE) WHERE email IS NOT NULL;
  `);
  let injected = false;
  const binding = {
    prepare(sql: string) {
      let values: unknown[] = [];
      const stmt = {
        bind(...bound: unknown[]) {
          values = bound;
          return stmt;
        },
        first: async <T>() => (db.query(sql).get(...(values as never[])) as T | null) ?? null,
        run: async () => {
          if (!injected && sql.startsWith("INSERT INTO users") && beforeUserInsert) {
            injected = true;
            beforeUserInsert(db);
          }
          db.query(sql).run(...(values as never[]));
          return { success: true };
        },
      };
      return stmt;
    },
  };
  return { db, binding };
}

function request(headers: Record<string, string>): Request {
  return new Request("https://app.myslop.app/api", { headers });
}

describe("platformIdentity", () => {
  test("absent without the user id header", () => {
    expect(platformIdentity(request({}))).toBeNull();
    expect(platformIdentity(request({ "x-myslop-user-email": "a@b.c" }))).toBeNull();
  });

  test("parses headers and normalizes empty values to null", () => {
    expect(
      platformIdentity(request({ "x-myslop-user-id": "u1", "x-myslop-user-email": "", "x-myslop-user-name": "Ada" })),
    ).toEqual({ id: "u1", email: null, name: "Ada" });
  });
});

describe("resolvePlatformUser", () => {
  test("creates a local user keyed by the platform id", async () => {
    const { db, binding } = appDatabase();
    const userId = await resolvePlatformUser(binding, { id: "plat-1", email: "ada@example.com", name: "Ada" }, 42);
    expect(userId).toBe("plat-1");
    expect(db.query("SELECT id, email, name, created_at FROM users").get()).toEqual({
      id: "plat-1",
      email: "ada@example.com",
      name: "Ada",
      created_at: 42,
    });
  });

  test("joins an existing Shoo account by verified email, case-insensitively", async () => {
    const { db, binding } = appDatabase();
    db.query("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)").run(
      "pairwise-shoo",
      "Ada@Example.com",
      "Ada",
      1,
    );
    const userId = await resolvePlatformUser(binding, { id: "plat-1", email: "ada@example.com", name: null });
    expect(userId).toBe("pairwise-shoo");
    expect(db.query("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 1 });
  });

  test("repeat calls are stable and fill in missing profile fields", async () => {
    const { db, binding } = appDatabase();
    const first = await resolvePlatformUser(binding, { id: "plat-1", email: null, name: null });
    const second = await resolvePlatformUser(binding, { id: "plat-1", email: "ada@example.com", name: "Ada" });
    expect(first).toBe("plat-1");
    expect(second).toBe("plat-1");
    expect(db.query("SELECT email, name FROM users WHERE id = ?").get("plat-1")).toEqual({
      email: "ada@example.com",
      name: "Ada",
    });
  });

  test("adopts the winner of a concurrent first sign-in with the same email", async () => {
    const { db, binding } = appDatabase((raw) => {
      raw.query("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)").run(
        "pairwise-shoo",
        "ada@example.com",
        null,
        1,
      );
    });
    const userId = await resolvePlatformUser(binding, { id: "plat-1", email: "ada@example.com", name: "Ada" });
    expect(userId).toBe("pairwise-shoo");
    expect(db.query("SELECT name FROM users WHERE id = ?").get("pairwise-shoo")).toEqual({ name: "Ada" });
    expect(db.query("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 1 });
  });

  test("without an email, identities never join other accounts", async () => {
    const { db, binding } = appDatabase();
    db.query("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)").run(
      "someone-else",
      "other@example.com",
      "Other",
      1,
    );
    const userId = await resolvePlatformUser(binding, { id: "plat-1", email: null, name: "Agent" });
    expect(userId).toBe("plat-1");
    expect(db.query("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 2 });
  });
});
