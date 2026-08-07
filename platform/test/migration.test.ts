import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

describe("control migration 008", () => {
  test("backfills the default team and legacy app members", async () => {
    const database = new Database(":memory:");
    try {
      database.exec(`
        PRAGMA foreign_keys=ON;
        CREATE TABLE users (
          id TEXT PRIMARY KEY,email TEXT,name TEXT,picture TEXT,
          platform_role TEXT NOT NULL DEFAULT 'member',created_at INTEGER NOT NULL
        );
        CREATE TABLE apps (
          id TEXT PRIMARY KEY,slug TEXT NOT NULL UNIQUE,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',
          owner_id TEXT NOT NULL REFERENCES users(id),visibility TEXT NOT NULL,worker_name TEXT NOT NULL UNIQUE,
          d1_id TEXT,d1_name TEXT,r2_bucket TEXT,custom_domain_id TEXT,d1_delete_after INTEGER,r2_delete_after INTEGER,
          active_version INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,archived_at INTEGER,
          managed_by TEXT NOT NULL DEFAULT 'manual',source_hash TEXT,d1_adopted INTEGER NOT NULL DEFAULT 0,r2_adopted INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE app_members (
          app_id TEXT NOT NULL REFERENCES apps(id),user_id TEXT NOT NULL REFERENCES users(id),role TEXT NOT NULL,created_at INTEGER NOT NULL,
          PRIMARY KEY(app_id,user_id)
        );
        CREATE TABLE audit_log (id TEXT PRIMARY KEY,app_id TEXT,user_id TEXT NOT NULL,action TEXT NOT NULL,detail TEXT,created_at INTEGER NOT NULL);
        INSERT INTO users VALUES ('owner','owner@lleverage.ai','Owner',NULL,'owner',1);
        INSERT INTO users VALUES ('editor','editor@lleverage.ai','Editor',NULL,'member',2);
        INSERT INTO apps VALUES ('public','public-app','Public','', 'owner','public','worker-public',NULL,NULL,NULL,NULL,NULL,NULL,1,1,1,NULL,'manual',NULL,0,0);
        INSERT INTO apps VALUES ('private','private-app','Private','', 'owner','private','worker-private',NULL,NULL,NULL,NULL,NULL,NULL,1,1,1,NULL,'manual',NULL,0,0);
        INSERT INTO app_members VALUES ('private','editor','editor',2);
        INSERT INTO audit_log VALUES ('audit','private','owner','app.created',NULL,1);
      `);
      database.exec(await Bun.file(new URL("../control-migrations/008_teams_folders_groups_access.sql", import.meta.url)).text());
      database.exec(`
        INSERT INTO users (id,email,name,picture,platform_role,created_at)
        VALUES ('rollback-user','rollback@lleverage.ai','Rollback User',NULL,'member',3);
        INSERT INTO apps (
          id,slug,name,description,owner_id,visibility,worker_name,created_at,updated_at,managed_by,d1_adopted,r2_adopted
        ) VALUES ('legacy','legacy-app','Legacy','', 'rollback-user','team','worker-legacy',3,3,'manual',0,0);
      `);
      expect(database.query("SELECT id,slug FROM teams").all()).toEqual([{ id: "team_default", slug: "lleverage" }]);
      expect(database.query("SELECT user_id,role,status FROM team_members ORDER BY user_id").all()).toEqual([
        { user_id: "editor", role: "member", status: "active" },
        { user_id: "owner", role: "admin", status: "active" },
        { user_id: "rollback-user", role: "member", status: "active" },
      ]);
      expect(database.query("SELECT id,team_id,folder_id FROM apps ORDER BY id").all()).toEqual([
        { id: "legacy", team_id: "team_default", folder_id: null },
        { id: "private", team_id: "team_default", folder_id: null },
        { id: "public", team_id: "team_default", folder_id: null },
      ]);
      expect(database.query("SELECT app_id,user_id,role FROM app_user_assignments ORDER BY app_id,user_id").all()).toEqual([
        { app_id: "legacy", user_id: "rollback-user", role: "owner" },
        { app_id: "private", user_id: "editor", role: "editor" },
        { app_id: "private", user_id: "owner", role: "owner" },
        { app_id: "public", user_id: "owner", role: "owner" },
      ]);
      expect(database.query("SELECT team_id FROM audit_log WHERE id='audit'").get()).toEqual({ team_id: "team_default" });
    } finally {
      database.close();
    }
  });
});

describe("control migration 009", () => {
  test("preserves existing tokens and enforces a single optional scope", async () => {
    const database = new Database(":memory:");
    try {
      database.exec(`
        PRAGMA foreign_keys=ON;
        CREATE TABLE users (id TEXT PRIMARY KEY);
        CREATE TABLE teams (id TEXT PRIMARY KEY);
        CREATE TABLE tokens (
          id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),app_id TEXT,
          hash TEXT NOT NULL UNIQUE,name TEXT NOT NULL,prefix TEXT NOT NULL,
          created_at INTEGER NOT NULL,last_used_at INTEGER,expires_at INTEGER NOT NULL,revoked_at INTEGER
        );
        INSERT INTO users VALUES ('owner');
        INSERT INTO teams VALUES ('team_myslop');
        INSERT INTO tokens VALUES ('legacy','owner',NULL,'legacy-hash','Legacy','msa_legacy',1,NULL,999,NULL);
      `);
      database.exec(await Bun.file(new URL("../control-migrations/009_team_scoped_tokens.sql", import.meta.url)).text());

      expect(database.query("SELECT id,team_id FROM tokens WHERE id='legacy'").get()).toEqual({ id: "legacy", team_id: null });
      database.exec(`
        INSERT INTO tokens (id,user_id,app_id,team_id,hash,name,prefix,created_at,expires_at)
        VALUES ('team','owner',NULL,'team_myslop','team-hash','Team','msa_team',2,999)
      `);
      expect(database.query("SELECT team_id FROM tokens WHERE id='team'").get()).toEqual({ team_id: "team_myslop" });
      expect(() => database.exec(`
        INSERT INTO tokens (id,user_id,app_id,team_id,hash,name,prefix,created_at,expires_at)
        VALUES ('invalid','owner','app','team_myslop','invalid-hash','Invalid','msa_invalid',3,999)
      `)).toThrow("token cannot be scoped to both an app and a team");
    } finally {
      database.close();
    }
  });
});
