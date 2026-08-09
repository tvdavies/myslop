import { expect, test } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";

import { identityFromRequest, resolveIdentityUser } from "../src/app-identity";
import { signIdentityAssertion } from "../src/identity-assertion";

class Statement {
  private values: SQLQueryBindings[] = [];
  constructor(private database: Database, private sql: string) {}
  bind(...values: SQLQueryBindings[]) { this.values = values; return this; }
  async first<T>() { return (this.database.query(this.sql).get(...this.values) as T | null) ?? null; }
  async run() { const result = this.database.query(this.sql).run(...this.values); return { success: true, meta: { changes: result.changes } }; }
}

function environment() {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,email TEXT,name TEXT,picture TEXT,identity_id TEXT,created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX users_email ON users(email COLLATE NOCASE) WHERE email IS NOT NULL;
    CREATE UNIQUE INDEX users_identity ON users(identity_id) WHERE identity_id IS NOT NULL;
    CREATE TABLE identity_links (
      identity_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,method TEXT NOT NULL,linked_at INTEGER NOT NULL,UNIQUE(user_id)
    );
  `);
  const DB = {
    prepare: (sql: string) => new Statement(database, sql),
    batch: async (statements: Statement[]) => Promise.all(statements.map((statement) => statement.run())),
  };
  return { database, env: {
    DB,
    MYSLOP_APP_ID: "app-files",
    MYSLOP_IDENTITY_SECRET: "identity-secret",
    MYSLOP_IDENTITY_LINK_DEADLINE: String(Date.now() + 60_000),
  } };
}

async function assertedRequest(secret = "identity-secret", audience = "app-files") {
  const request = new Request("https://files.myslop.app/api/me");
  const assertion = await signIdentityAssertion(secret, request, {
    aud: audience,
    sub: "mui_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    uid: "platform-user",
    email: "owner@example.com",
    email_verified: true,
    name: "Owner",
    role: "owner",
    sg: 1,
  });
  return new Request(request, { headers: { "x-myslop-identity": assertion } });
}

test("a signed identity links only with dual possession of the legacy user", async () => {
  const { database, env } = environment();
  database.query("INSERT INTO users VALUES (?,?,?,?,?,?)").run("legacy", "owner@example.com", "Old", null, null, 1);
  const identity = await identityFromRequest(await assertedRequest(), env as never);
  expect(identity.claims).not.toBeNull();

  const withoutProof = await resolveIdentityUser(env as never, identity.claims!, null);
  expect(withoutProof).toEqual({ user: null, linkRequired: true });

  const withProof = await resolveIdentityUser(env as never, identity.claims!, {
    id: "legacy", email: "owner@example.com", name: "Old", picture: null, identity_id: null,
  });
  expect(withProof.user).toMatchObject({ id: "legacy", identity_id: "mui_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
  expect(database.query("SELECT user_id,method FROM identity_links").get()).toEqual({ user_id: "legacy", method: "legacy_session" });
});

test("identity assertions fail closed for the wrong app or signature", async () => {
  const { env } = environment();
  expect((await identityFromRequest(await assertedRequest("identity-secret", "app-mail"), env as never)).claims).toBeNull();
  expect((await identityFromRequest(await assertedRequest("wrong-secret"), env as never)).claims).toBeNull();
});

test("an existing API token can link ownership after the verified email changes", async () => {
  const { database, env } = environment();
  database.query("INSERT INTO users VALUES (?,?,?,?,?,?)").run("legacy", "old@example.com", "Old", null, null, 1);
  const identity = await identityFromRequest(await assertedRequest(), env as never);
  const { linkIdentityWithUser } = await import("../src/app-identity");
  const linked = await linkIdentityWithUser(env as never, identity.claims!, "legacy");
  expect(linked).toMatchObject({ id: "legacy", email: "old@example.com", identity_id: "mui_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
  expect(database.query("SELECT method FROM identity_links").get()).toEqual({ method: "api_token" });
});
