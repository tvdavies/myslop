import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import worker from "../src/index";
import { AUTHOR_PERMISSIONS } from "../src/permissions";
import { d1 } from "./d1";

const migration = () => Bun.file(new URL("../migrations/002_agent_review_permissions.sql", import.meta.url)).text();

describe("agent review migration", () => {
  test("preserves an existing secret, ownership, revocation and human reviews", async () => {
    const db = new Database(":memory:");
    try {
      db.exec("PRAGMA foreign_keys=ON");
      db.exec(await Bun.file(new URL("../migrations/001_init.sql", import.meta.url)).text());
      const secret = "msp_existing-migration-test-secret";
      const hash = new Bun.CryptoHasher("sha256").update(secret).digest("hex");
      db.query("INSERT INTO users (id,name,created_at) VALUES ('owner','Owner',1)").run();
      db.query("INSERT INTO tokens (id,user_id,hash,name,prefix,created_at,last_used_at,revoked_at) VALUES ('existing','owner',?,'Existing key','msp_existing',1,2,NULL)").run(hash);
      db.query("INSERT INTO tokens (id,user_id,hash,name,prefix,created_at,revoked_at) VALUES ('revoked','owner','revoked-hash','Revoked','msp_revoked',1,3)").run();
      db.query("INSERT INTO plans (id,user_id,title,current_version,created_at,updated_at) VALUES ('0123456789','owner','Existing plan',1,1,1)").run();
      db.query("INSERT INTO reviews (plan_id,version,user_id,verdict,note,created_at) VALUES ('0123456789',1,'owner','approved','Keep me',2)").run();
      const oldToken = db.query("SELECT * FROM tokens WHERE id='existing'").get()!;
      const oldReview = db.query("SELECT * FROM reviews").get();
      db.exec(await migration());
      // Re-prepare after ALTER TABLE; Bun caches SELECT * column metadata.
      expect(db.prepare("SELECT * FROM tokens WHERE id='existing'").get()).toEqual({ ...oldToken, permissions: JSON.stringify(AUTHOR_PERMISSIONS) });
      expect(db.query("SELECT revoked_at FROM tokens WHERE id='revoked'").get()).toEqual({ revoked_at: 3 });
      expect(db.query("SELECT * FROM reviews").get()).toEqual(oldReview);
      const response = await worker.fetch(new Request("https://plans.myslop.app/api/verify", {
        headers: { authorization: `Bearer ${secret}` },
      }) as never, { DB: d1(db) } as never, { waitUntil() {} } as never) as unknown as Response;
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ token: { id: "existing" }, permissions: AUTHOR_PERMISSIONS });
    } finally {
      db.close();
    }
  });

  test("forward migrations match a fresh schema bootstrap", async () => {
    const migrated = new Database(":memory:");
    const fresh = new Database(":memory:");
    try {
      migrated.exec(await Bun.file(new URL("../migrations/001_init.sql", import.meta.url)).text());
      migrated.exec(await migration());
      fresh.exec(await Bun.file(new URL("../schema.sql", import.meta.url)).text());
      const tables = fresh.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
      expect(migrated.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()).toEqual(tables);
      for (const { name } of tables) {
        for (const pragma of ["table_info", "foreign_key_list", "index_list"]) {
          expect(migrated.query(`PRAGMA ${pragma}(${name})`).all()).toEqual(fresh.query(`PRAGMA ${pragma}(${name})`).all());
        }
      }
    } finally {
      migrated.close();
      fresh.close();
    }
  });
});
