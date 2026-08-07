import { afterEach, describe, expect, test } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { handleOrganizationApi } from "../src/organization";
import type { Principal } from "../src/auth";
import type { Env, User } from "../src/types";

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

  async run(): Promise<{ meta: { changes: number } }> {
    const result = this.database.query(this.sql).run(...this.bindings);
    return { meta: { changes: Number(result.changes) } };
  }
}

const admin: User = { id: "admin", email: "admin@lleverage.ai", name: "Admin", picture: null, platform_role: "member" };

async function fixture() {
  const database = new Database(":memory:");
  databases.push(database);
  database.exec(await Bun.file(new URL("../schema.sql", import.meta.url)).text());
  database.exec(`
    INSERT INTO users (id,email,name,picture,platform_role,created_at) VALUES
      ('admin','admin@lleverage.ai','Admin',NULL,'member',1),
      ('member','member@lleverage.ai','Member',NULL,'member',1);
    INSERT OR REPLACE INTO team_members (team_id,user_id,role,status,created_at,updated_at) VALUES
      ('team_default','admin','admin','active',1,1),
      ('team_default','member','member','active',1,1);
    INSERT INTO folders (id,team_id,parent_id,slug,name,created_by,created_at,updated_at)
      VALUES ('retired','team_default',NULL,'retired','Retired','admin',1,1),('empty','team_default',NULL,'empty','Empty','admin',1,1);
    INSERT INTO apps (id,slug,name,description,owner_id,visibility,worker_name,created_at,updated_at,archived_at,team_id,folder_id)
      VALUES ('archived','archived-app','Archived','','admin','team','app-archived',1,1,1,'team_default','retired');
  `);
  const env = {
    CONTROL_DB: {
      prepare: (sql: string) => new SqliteStatement(database, sql),
      batch: (statements: SqliteStatement[]) => Promise.all(statements.map((statement) => statement.run())),
    },
  } as unknown as Env;
  return { database, env, principal: { user: admin } satisfies Principal };
}

async function organizationRequest(
  env: Env,
  principal: Principal,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<Response | null> {
  const url = new URL(`https://apps.myslop.app${path}`);
  return handleOrganizationApi(new Request(url, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  }), env, principal, url);
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("organization api", () => {
  test("app-scoped tokens cannot reach team management", async () => {
    const scoped: Principal = { user: admin, tokenId: "token", appId: "app-id" };
    const response = await organizationRequest({} as Env, scoped, "/api/teams/team_default/folders");
    expect(response?.status).toBe(403);
    expect(await organizationRequest({} as Env, scoped, "/api/apps")).toBeNull();
  });

  test("sessions and platform tokens still reach team management", async () => {
    const { env, principal } = await fixture();
    const response = await organizationRequest(env, { ...principal, tokenId: "token" }, "/api/teams/team_default/folders");
    expect(response?.status).toBe(200);
  });

  test("platform owners can create a team with themselves as an admin", async () => {
    const { database, env, principal } = await fixture();
    database.exec("UPDATE users SET platform_role='owner' WHERE id='admin'");
    const owner: Principal = { ...principal, user: { ...principal.user, platform_role: "owner" } };
    const response = await organizationRequest(env, owner, "/api/teams", "POST", { slug: "myslop", name: "Myslop" });
    expect(response?.status).toBe(201);
    const created = await response!.json() as { team: { id: string } };
    expect(database.query("SELECT slug,name FROM teams WHERE id=?").get(created.team.id)).toEqual({ slug: "myslop", name: "Myslop" });
    expect(database.query("SELECT role,status FROM team_members WHERE team_id=? AND user_id='admin'").get(created.team.id))
      .toEqual({ role: "admin", status: "active" });
  });

  test("team-scoped tokens cannot reach another team", async () => {
    const { database, env, principal } = await fixture();
    database.exec(`INSERT INTO teams (id,slug,name,created_at,updated_at) VALUES ('other','other','Other',2,2)`);
    const scoped: Principal = { ...principal, tokenId: "token", teamId: "team_default" };
    expect((await organizationRequest(env, scoped, "/api/teams/team_default/folders"))?.status).toBe(200);
    expect((await organizationRequest(env, scoped, "/api/teams/other/folders"))?.status).toBe(404);
  });

  test("archived apps still block folder deletion", async () => {
    const { env, principal } = await fixture();
    const blocked = await organizationRequest(env, principal, "/api/teams/team_default/folders/retired", "DELETE");
    expect(blocked?.status).toBe(409);
    expect(await blocked!.json()).toMatchObject({ error: "move child folders and apps before deleting this folder" });
    const removed = await organizationRequest(env, principal, "/api/teams/team_default/folders/empty", "DELETE");
    expect(removed?.status).toBe(200);
  });

  test("the last active team admin cannot be demoted", async () => {
    const { env, principal } = await fixture();
    const response = await organizationRequest(
      env,
      principal,
      "/api/teams/team_default/members/admin",
      "PATCH",
      { role: "member" },
    );
    expect(response?.status).toBe(409);
  });

  test("overlapping partial member updates preserve both fields", async () => {
    const { database, env, principal } = await fixture();
    const [roleResponse, statusResponse] = await Promise.all([
      organizationRequest(env, principal, "/api/teams/team_default/members/member", "PATCH", { role: "admin" }),
      organizationRequest(env, principal, "/api/teams/team_default/members/member", "PATCH", { status: "suspended" }),
    ]);
    expect(roleResponse?.status).toBe(200);
    expect(statusResponse?.status).toBe(200);
    expect(database.query("SELECT role,status FROM team_members WHERE team_id='team_default' AND user_id='member'").get())
      .toEqual({ role: "admin", status: "suspended" });
  });
});
