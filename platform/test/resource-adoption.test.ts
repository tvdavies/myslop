import { afterEach, describe, expect, test } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { removeDatabase, removeFileStorage } from "../src/index";
import type { AppRow, Env } from "../src/types";

const databases: Database[] = [];

class SqliteStatement {
  private bindings: SQLQueryBindings[] = [];

  constructor(private readonly database: Database, private readonly sql: string) {}

  bind(...bindings: SQLQueryBindings[]) {
    this.bindings = bindings;
    return this;
  }

  async run(): Promise<{ meta: { changes: number } }> {
    const result = this.database.query(this.sql).run(...this.bindings);
    return { meta: { changes: Number(result.changes) } };
  }
}

async function fixture() {
  const database = new Database(":memory:");
  databases.push(database);
  database.exec(await Bun.file(new URL("../schema.sql", import.meta.url)).text());
  database.exec(`
    INSERT INTO users (id,email,name,picture,platform_role,created_at)
    VALUES ('owner','owner@myslop.app','Owner',NULL,'owner',1);
    INSERT INTO apps (
      id,slug,name,description,owner_id,visibility,worker_name,d1_id,d1_name,r2_bucket,
      d1_adopted,r2_adopted,created_at,updated_at,team_id
    ) VALUES (
      'app','adopted-app','Adopted','', 'owner','public','worker',
      'existing-d1','existing-db','existing-bucket',1,1,1,1,'team_default'
    );
  `);
  const env = {
    CONTROL_DB: { prepare: (sql: string) => new SqliteStatement(database, sql) },
  } as unknown as Env;
  const app = database.query("SELECT * FROM apps WHERE id='app'").get() as AppRow;
  return { database, env, app };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("adopted resource lifecycle", () => {
  test("detaches adopted D1 and R2 resources without deleting their data", async () => {
    const { database, env, app } = await fixture();
    await removeDatabase(env, app);
    await removeFileStorage(env, app);

    expect(database.query(`
      SELECT d1_id,d1_name,d1_adopted,d1_delete_after,
             r2_bucket,r2_adopted,r2_delete_after
      FROM apps WHERE id='app'
    `).get()).toEqual({
      d1_id: null,
      d1_name: null,
      d1_adopted: 0,
      d1_delete_after: null,
      r2_bucket: null,
      r2_adopted: 0,
      r2_delete_after: null,
    });
  });
});
