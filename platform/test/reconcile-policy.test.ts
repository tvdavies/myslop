import { afterEach, describe, expect, test } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { resolveReconcilePolicy } from "../src/index";
import type { Principal } from "../src/auth";
import type { AppRow, Env } from "../src/types";

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

async function fixture() {
  const database = new Database(":memory:");
  databases.push(database);
  database.exec(await Bun.file(new URL("../schema.sql", import.meta.url)).text());
  database.exec(`
    INSERT INTO users (id,email,name,picture,platform_role,created_at)
      VALUES ('owner','owner@lleverage.ai','Owner',NULL,'owner',1);
    INSERT OR REPLACE INTO team_members (team_id,user_id,role,status,created_at,updated_at)
      VALUES ('team_default','owner','admin','active',1,1);
  `);
  const env = {
    CONTROL_DB: { prepare: (sql: string) => new SqliteStatement(database, sql) },
  } as unknown as Env;
  const principal: Principal = {
    user: { id: "owner", email: "owner@lleverage.ai", name: "Owner", picture: null, platform_role: "owner" },
  };
  return { database, env, principal };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("reconciliation policy validation", () => {
  test("rejects an unknown folder before creating a new app", async () => {
    const { database, env, principal } = await fixture();
    const result = await resolveReconcilePolicy(env, principal, "new-app", {
      app: { folder: "missing-folder" },
    }, null);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(400);
    expect(database.query("SELECT COUNT(*) count FROM apps").get()).toEqual({ count: 0 });
  });

  test("invalid assignments leave an archived app archived", async () => {
    const { database, env, principal } = await fixture();
    database.exec(`
      INSERT INTO apps (id,slug,name,description,owner_id,visibility,worker_name,created_at,updated_at,archived_at,team_id)
      VALUES ('archived','archived-app','Archived','', 'owner','private','worker-archived',1,1,1,'team_default');
    `);
    const app = database.query("SELECT * FROM apps WHERE id='archived'").get() as AppRow;
    const result = await resolveReconcilePolicy(env, principal, app.slug, {
      access: { audience: "restricted", users: [{ email: "missing@lleverage.ai", role: "editor" }], groups: [] },
    }, app);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(400);
    expect(database.query("SELECT archived_at FROM apps WHERE id='archived'").get()).toEqual({ archived_at: 1 });
  });
});
