import { afterEach, describe, expect, test } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import worker from "../src/index";
import {
  consumeAppSessionExchange,
  createAppSessionExchange,
  getSessionUser,
  resolveShooPlatformUserId,
  signOut,
} from "../src/auth";
import type { Env } from "../src/types";

const databases: Database[] = [];

class SqliteStatement {
  private bindings: SQLQueryBindings[] = [];
  constructor(private readonly database: Database, private readonly sql: string) {}
  bind(...bindings: SQLQueryBindings[]) { this.bindings = bindings; return this; }
  async first<T>(): Promise<T | null> {
    return (this.database.query(this.sql).get(...this.bindings) as T | null) ?? null;
  }
  async run() {
    const result = this.database.query(this.sql).run(...this.bindings);
    return { success: true, meta: { changes: result.changes } };
  }
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function environment() {
  const database = new Database(":memory:");
  databases.push(database);
  database.exec(awaitableSchema);
  database.exec(`
    INSERT INTO users (id,email,name,picture,platform_role,created_at)
    VALUES ('original','tom@example.com','Tom',NULL,'owner',1);
    INSERT INTO sessions (id,user_id,created_at,expires_at)
    VALUES ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','original',1,9999999999999);
    INSERT INTO apps (id,slug,name,description,owner_id,visibility,worker_name,active_version,created_at,updated_at,team_id)
    VALUES ('demo','demo','Demo','','original','team','worker-demo',1,1,1,'team_default');
  `);
  return {
    database,
    env: { CONTROL_DB: { prepare: (sql: string) => new SqliteStatement(database, sql) } } as unknown as Env,
  };
}

const awaitableSchema = await Bun.file(new URL("../schema.sql", import.meta.url)).text();

describe("cross-domain platform sessions", () => {
  test("links only verified Shoo identities by case-insensitive email", async () => {
    const { env } = environment();
    expect(await resolveShooPlatformUserId(env, {
      pairwise_sub: "cloud-subject",
      email: "TOM@example.com",
      email_verified: true,
    })).toBe("original");
    expect(await resolveShooPlatformUserId(env, {
      pairwise_sub: "unverified-subject",
      email: "tom@example.com",
      email_verified: false,
    })).toBe("unverified-subject");
  });

  test("uses a one-time code bound to one app hostname", async () => {
    const { env } = environment();
    const request = new Request("https://myslop.cloud/auth/app", {
      headers: { cookie: "__Host-msa_sid=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    });
    const callback = await createAppSessionExchange(request, env, "https://demo.myslop.app/deep?q=1");
    expect(callback).not.toBeNull();
    const code = new URL(callback!).searchParams.get("code")!;

    expect(await consumeAppSessionExchange(env, code, "other.myslop.app")).toBeNull();
    expect(await consumeAppSessionExchange(env, code, "demo.myslop.app")).toEqual({
      sessionId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      returnTo: "https://demo.myslop.app/deep?q=1",
    });
    expect(await consumeAppSessionExchange(env, code, "demo.myslop.app")).toBeNull();
  });

  test("issues a host-only cookie at the reserved callback and rejects cross-site exchange POSTs", async () => {
    const { env } = environment();
    const platformRequest = new Request("https://myslop.cloud/", {
      headers: { cookie: "__Host-msa_sid=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    });
    const callback = await createAppSessionExchange(platformRequest, env, "https://demo.myslop.app/deep");
    const response = await worker.fetch(
      new Request(callback!) as never,
      env as never,
      {} as never,
    ) as unknown as Response;
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://demo.myslop.app/deep");
    expect(response.headers.get("set-cookie")).toStartWith("__Host-msa_sid=");
    expect(response.headers.get("set-cookie")).not.toContain("Domain=");

    const csrf = await worker.fetch(
      new Request("https://myslop.cloud/api/app-session-exchange", {
        method: "POST",
        headers: {
          cookie: "__Host-msa_sid=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          origin: "https://attacker.example",
          "content-type": "application/json",
        },
        body: JSON.stringify({ returnTo: "https://demo.myslop.app/" }),
      }) as never,
      env as never,
      {} as never,
    ) as unknown as Response;
    expect(csrf.status).toBe(403);
  });

  test("rejects expired exchange codes", async () => {
    const { database, env } = environment();
    const request = new Request("https://myslop.cloud/", {
      headers: { cookie: "__Host-msa_sid=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    });
    const callback = await createAppSessionExchange(request, env, "https://demo.myslop.app/");
    database.exec("UPDATE app_session_exchanges SET expires_at=0");
    expect(await consumeAppSessionExchange(env, new URL(callback!).searchParams.get("code")!, "demo.myslop.app")).toBeNull();
  });


  test("legacy domain cookies cannot authenticate platform APIs after cutover", async () => {
    const { env } = environment();
    const user = await getSessionUser(new Request("https://apps.myslop.app/api/me", {
      headers: { cookie: "msa_sid=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    }), env);
    expect(user).toBeNull();
  });

  test("canonical sign-out invalidates legacy and app-host sessions for the user", async () => {
    const { database, env } = environment();
    database.exec(`
      INSERT INTO sessions (id,user_id,created_at,expires_at)
      VALUES ('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','original',2,9999999999999)
    `);
    const response = await signOut(new Request("https://myslop.cloud/api/session", {
      method: "DELETE",
      headers: { cookie: "__Host-msa_sid=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    }), env);
    expect(response.status).toBe(200);
    expect(database.query("SELECT COUNT(*) count FROM sessions WHERE user_id='original'").get()).toEqual({ count: 0 });
  });

});
