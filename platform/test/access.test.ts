import { afterEach, describe, expect, test } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import {
  effectiveAppAccess,
  highestRole,
  listAccessibleApps,
  permissionsFor,
  roleFromRank,
  visibilityToAudience,
} from "../src/access";
import type { Principal } from "../src/auth";
import type { AppRow, Env, User } from "../src/types";

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
  const now = 1;
  database.exec(`
    INSERT INTO users (id,email,name,picture,platform_role,created_at) VALUES
      ('member','member@lleverage.ai','Member',NULL,'member',${now}),
      ('suspended','suspended@lleverage.ai','Suspended',NULL,'member',${now}),
      ('platform','platform@lleverage.ai','Platform',NULL,'owner',${now});
    INSERT OR REPLACE INTO team_members (team_id,user_id,role,status,created_at,updated_at) VALUES
      ('team_default','member','member','active',${now},${now}),
      ('team_default','suspended','member','suspended',${now},${now}),
      ('team_default','platform','admin','active',${now},${now});
    INSERT INTO apps (id,slug,name,description,owner_id,visibility,worker_name,active_version,created_at,updated_at,team_id) VALUES
      ('public','public-app','Public','', 'member','public','app-public',1,${now},${now},'team_default'),
      ('team','team-app','Team','', 'member','team','app-team',1,${now},${now},'team_default'),
      ('restricted','restricted-app','Restricted','', 'platform','private','app-restricted',1,${now},${now},'team_default');
    INSERT INTO team_groups (id,team_id,slug,name,description,created_by,created_at,updated_at)
      VALUES ('developers','team_default','developers','Developers','','platform',${now},${now});
    INSERT INTO group_members (group_id,user_id,added_by,created_at)
      VALUES ('developers','member','platform',${now}),('developers','suspended','platform',${now});
    INSERT INTO app_group_assignments (app_id,group_id,role,granted_by,created_at,updated_at)
      VALUES ('restricted','developers','editor','platform',${now},${now});
  `);
  const env = {
    CONTROL_DB: {
      prepare: (sql: string) => new SqliteStatement(database, sql),
    },
  } as unknown as Env;
  const user: User = { id: "member", email: "member@lleverage.ai", name: "Member", picture: null, platform_role: "member" };
  const principal: Principal = { user };
  return { database, env, user, principal };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("app access", () => {
  test("ranks roles and projects source-aware permissions", () => {
    expect(highestRole("viewer", "owner", "editor")).toBe("owner");
    expect(visibilityToAudience("private")).toBe("restricted");
    expect(permissionsFor({ managed_by: "manual" }, "editor")).toMatchObject({
      open: true,
      modifyMetadata: true,
      modifyRuntime: true,
      modifySecrets: true,
      modifyAccess: false,
      destroy: false,
    });
    expect(permissionsFor({ managed_by: "git" }, "owner")).toMatchObject({
      open: true,
      modifyMetadata: false,
      modifyRuntime: false,
      modifySecrets: true,
      modifyAccess: false,
      destroy: false,
    });
  });

  test("combines audience, ownership, direct and group grants without duplicate apps", async () => {
    const { env, principal } = await fixture();
    const apps = await listAccessibleApps(env, principal);
    expect(apps.map(({ id, effective_rank }) => [id, roleFromRank(effective_rank)])).toEqual([
      ["public", "owner"],
      ["team", "owner"],
      ["restricted", "editor"],
    ]);
    expect(new Set(apps.map(({ id }) => id)).size).toBe(apps.length);
  });

  test("ignores grants for suspended members but keeps public access", async () => {
    const { database, env } = await fixture();
    const user: User = { id: "suspended", email: "suspended@lleverage.ai", name: "Suspended", picture: null, platform_role: "member" };
    const principal: Principal = { user };
    const apps = await listAccessibleApps(env, principal);
    expect(apps.map(({ id }) => id)).toEqual(["public"]);
    const restricted = database.query("SELECT * FROM apps WHERE id='restricted'").get() as AppRow;
    expect((await effectiveAppAccess(env, restricted, user)).role).toBeNull();
  });

  test("platform owners can access every app across membership boundaries", async () => {
    const { env } = await fixture();
    const principal: Principal = {
      user: { id: "platform", email: "platform@lleverage.ai", name: "Platform", picture: null, platform_role: "owner" },
    };
    const apps = await listAccessibleApps(env, principal);
    expect(apps).toHaveLength(3);
    expect(apps.every(({ effective_rank }) => roleFromRank(effective_rank) === "owner")).toBe(true);
  });
});
