import { afterEach, describe, expect, test } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { listAccessibleApps } from "../src/access";
import { authenticate } from "../src/auth";
import { sha256Hex } from "../src/core";
import type { Env } from "../src/types";

const databases: Database[] = [];

class SqliteStatement {
  private bindings: SQLQueryBindings[] = [];

  constructor(private readonly database: Database, private readonly sql: string) {}

  bind(...bindings: SQLQueryBindings[]) {
    this.bindings = bindings;
    return this;
  }

  async first<T>(): Promise<T | null> {
    return (this.database.query(this.sql).get(...this.bindings) as T | null) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.database.query(this.sql).all(...this.bindings) as T[] };
  }
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("team-scoped bearer tokens", () => {
  test("authenticate with one team and cannot list another team's apps", async () => {
    const database = new Database(":memory:");
    databases.push(database);
    database.exec(await Bun.file(new URL("../schema.sql", import.meta.url)).text());
    const secret = "msa_team-scoped-secret";
    const hash = await sha256Hex(secret);
    database.exec(`
      INSERT INTO users (id,email,name,picture,platform_role,created_at)
      VALUES ('automation','automation@myslop.app','Automation',NULL,'owner',1);
      INSERT INTO teams (id,slug,name,created_at,updated_at)
      VALUES ('team_myslop','myslop','Myslop',2,2);
      INSERT OR REPLACE INTO team_members (team_id,user_id,role,status,created_at,updated_at)
      VALUES ('team_myslop','automation','admin','active',2,2);
      INSERT INTO apps (id,slug,name,description,owner_id,visibility,worker_name,created_at,updated_at,team_id)
      VALUES
        ('myslop-app','myslop-app','Myslop app','','automation','public','worker-myslop',2,2,'team_myslop'),
        ('other-app','other-app','Other app','','automation','public','worker-other',2,2,'team_default');
    `);
    database.query(`
      INSERT INTO tokens (id,user_id,app_id,team_id,hash,name,prefix,created_at,expires_at)
      VALUES ('token','automation',NULL,'team_myslop',?,'Deploy','msa_team',2,?)
    `).run(hash, Date.now() + 60_000);
    const env = {
      CONTROL_DB: { prepare: (sql: string) => new SqliteStatement(database, sql) },
    } as unknown as Env;

    const principal = await authenticate(new Request("https://apps.myslop.app/api/me", {
      headers: { authorization: `Bearer ${secret}` },
    }), env);
    expect(principal).toMatchObject({ tokenId: "token", teamId: "team_myslop" });
    expect((await listAccessibleApps(env, principal!)).map(({ id }) => id)).toEqual(["myslop-app"]);
    expect(await listAccessibleApps(env, principal!, { teamId: "team_default" })).toEqual([]);
  });
});
