import type { Principal } from "./auth";
import { listAccessibleApps } from "./access";
import { audit } from "./audit";
import { isUniqueViolation, json, randomHex, sqlPlaceholders, validSlug } from "./core";
import type { Env, FolderRow, TeamGroupRow, TeamRole } from "./types";

const TEAM_ROUTES = {
  folders: /^\/api\/teams\/([^/]+)\/folders(?:\/([^/]+))?$/,
  groups: /^\/api\/teams\/([^/]+)\/groups(?:\/([^/]+))?(\/members)?$/,
  members: /^\/api\/teams\/([^/]+)\/members(?:\/([^/]+))?$/,
};

export interface TeamContext {
  id: string;
  slug: string;
  name: string;
  role: TeamRole;
}

function segment(value: string | undefined): string | null {
  return value ? decodeURIComponent(value) : null;
}

function text(value: unknown, maxLength: number): string {
  return String(value ?? "").trim().slice(0, maxLength);
}

export async function activeTeamsFor(env: Env, principal: Principal): Promise<TeamContext[]> {
  if (principal.user.platform_role === "owner") {
    const statement = env.CONTROL_DB.prepare(
      `SELECT id,slug,name,'admin' role FROM teams
       ${principal.teamId ? "WHERE id=?" : ""} ORDER BY name`,
    );
    const rows = principal.teamId
      ? await statement.bind(principal.teamId).all<TeamContext>()
      : await statement.all<TeamContext>();
    return rows.results;
  }
  const statement = env.CONTROL_DB.prepare(
    `SELECT t.id,t.slug,t.name,m.role
     FROM team_members m JOIN teams t ON t.id=m.team_id
     WHERE m.user_id=? AND m.status='active' ${principal.teamId ? "AND t.id=?" : ""} ORDER BY t.name`,
  );
  const rows = principal.teamId
    ? await statement.bind(principal.user.id, principal.teamId).all<TeamContext>()
    : await statement.bind(principal.user.id).all<TeamContext>();
  return rows.results;
}

async function teamAccess(env: Env, principal: Principal, teamId: string, admin = false): Promise<TeamContext | null> {
  if (principal.teamId && principal.teamId !== teamId) return null;
  if (principal.user.platform_role === "owner") {
    const team = await env.CONTROL_DB.prepare("SELECT id,slug,name,'admin' role FROM teams WHERE id=?")
      .bind(teamId).first<TeamContext>();
    return team ?? null;
  }
  const team = await env.CONTROL_DB.prepare(
    `SELECT t.id,t.slug,t.name,m.role FROM team_members m JOIN teams t ON t.id=m.team_id
     WHERE m.team_id=? AND m.user_id=? AND m.status='active'`,
  ).bind(teamId, principal.user.id).first<TeamContext>();
  if (!team || (admin && team.role !== "admin")) return null;
  return team;
}

async function folderWouldCycle(env: Env, teamId: string, folderId: string, parentId: string | null): Promise<boolean> {
  let current = parentId;
  const seen = new Set<string>();
  while (current) {
    if (current === folderId || seen.has(current)) return true;
    seen.add(current);
    const parent = await env.CONTROL_DB.prepare("SELECT parent_id FROM folders WHERE id=? AND team_id=?")
      .bind(current, teamId).first<{ parent_id: string | null }>();
    if (!parent) return true;
    current = parent.parent_id;
  }
  return false;
}

async function handleFolderApi(
  req: Request,
  env: Env,
  principal: Principal,
  teamId: string,
  folderId: string | null,
): Promise<Response> {
  const team = await teamAccess(env, principal, teamId, req.method !== "GET");
  if (!team) return json({ error: "team not found" }, 404);

  if (!folderId && req.method === "GET") {
    const folders = await env.CONTROL_DB.prepare(
      "SELECT * FROM folders WHERE team_id=? ORDER BY name",
    ).bind(teamId).all<FolderRow>();
    const apps = await listAccessibleApps(env, principal, { teamId });
    const counts = new Map<string | null, number>();
    for (const app of apps) counts.set(app.folder_id, (counts.get(app.folder_id) ?? 0) + 1);
    return json({
      folders: folders.results.map((folder) => ({
        id: folder.id,
        slug: folder.slug,
        name: folder.name,
        parentId: folder.parent_id,
        appCount: counts.get(folder.id) ?? 0,
        createdAt: folder.created_at,
        updatedAt: folder.updated_at,
      })),
      rootAppCount: counts.get(null) ?? 0,
      canAdmin: team.role === "admin",
    });
  }

  if (!folderId && req.method === "POST") {
    const body = await req.json().catch(() => ({})) as { slug?: string; name?: string; parentId?: string | null };
    if (!validSlug(body.slug)) return json({ error: "folder slug must be 3-48 lowercase letters, numbers, and hyphens" }, 400);
    const name = text(body.name, 100);
    if (!name) return json({ error: "folder name is required" }, 400);
    const parentId = body.parentId || null;
    if (parentId) {
      const parent = await env.CONTROL_DB.prepare("SELECT 1 ok FROM folders WHERE id=? AND team_id=?")
        .bind(parentId, teamId).first();
      if (!parent) return json({ error: "parent folder not found" }, 400);
    }
    const id = randomHex(12);
    const now = Date.now();
    try {
      await env.CONTROL_DB.prepare(
        "INSERT INTO folders (id,team_id,parent_id,slug,name,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
      ).bind(id, teamId, parentId, body.slug, name, principal.user.id, now, now).run();
    } catch (error) {
      if (isUniqueViolation(error)) return json({ error: "folder slug is already in use" }, 409);
      throw error;
    }
    await audit(env, { actorId: principal.user.id, teamId, action: "folder.created", detail: { id, slug: body.slug, parentId } });
    return json({ folder: { id, slug: body.slug, name, parentId, appCount: 0, createdAt: now, updatedAt: now } }, 201);
  }

  if (folderId && (req.method === "PATCH" || req.method === "DELETE")) {
    const folder = await env.CONTROL_DB.prepare("SELECT * FROM folders WHERE id=? AND team_id=?")
      .bind(folderId, teamId).first<FolderRow>();
    if (!folder) return json({ error: "folder not found" }, 404);

    if (req.method === "PATCH") {
      const body = await req.json().catch(() => ({})) as { name?: string; parentId?: string | null };
      const name = body.name === undefined ? folder.name : text(body.name, 100);
      if (!name) return json({ error: "folder name is required" }, 400);
      const parentId = body.parentId === undefined ? folder.parent_id : body.parentId || null;
      if (await folderWouldCycle(env, teamId, folderId, parentId)) return json({ error: "folder move would create a cycle" }, 400);
      await env.CONTROL_DB.prepare("UPDATE folders SET name=?,parent_id=?,updated_at=? WHERE id=?")
        .bind(name, parentId, Date.now(), folderId).run();
      await audit(env, {
        actorId: principal.user.id,
        teamId,
        action: folder.parent_id === parentId ? "folder.updated" : "folder.moved",
        detail: { id: folderId, previousParentId: folder.parent_id, parentId, name },
      });
      return json({ folder: { id: folderId, slug: folder.slug, name, parentId } });
    }

    // Archived apps keep their folder_id, so they must block deletion too or the foreign key would.
    const counts = await env.CONTROL_DB.prepare(
      "SELECT (SELECT COUNT(*) FROM folders WHERE parent_id=?) children,(SELECT COUNT(*) FROM apps WHERE folder_id=?) apps",
    ).bind(folderId, folderId).first<{ children: number; apps: number }>();
    if (Number(counts?.children || 0) || Number(counts?.apps || 0)) {
      return json({ error: "move child folders and apps before deleting this folder" }, 409);
    }
    await env.CONTROL_DB.prepare("DELETE FROM folders WHERE id=? AND team_id=?").bind(folderId, teamId).run();
    await audit(env, { actorId: principal.user.id, teamId, action: "folder.deleted", detail: { id: folderId, slug: folder.slug } });
    return json({ ok: true });
  }

  return json({ error: "method not allowed" }, 405);
}

async function handleGroupApi(
  req: Request,
  env: Env,
  principal: Principal,
  teamId: string,
  groupId: string | null,
  membersPath: boolean,
): Promise<Response> {
  const team = await teamAccess(env, principal, teamId, req.method !== "GET");
  if (!team) return json({ error: "team not found" }, 404);

  if (!groupId && req.method === "GET") {
    const rows = await env.CONTROL_DB.prepare(
      `SELECT g.*,COUNT(DISTINCT gm.user_id) member_count,COUNT(DISTINCT a.app_id) app_count
       FROM team_groups g
       LEFT JOIN group_members gm ON gm.group_id=g.id
       LEFT JOIN app_group_assignments a ON a.group_id=g.id
       WHERE g.team_id=? GROUP BY g.id ORDER BY g.name`,
    ).bind(teamId).all<TeamGroupRow & { member_count: number; app_count: number }>();
    return json({
      groups: rows.results.map((group) => ({
        id: group.id,
        slug: group.slug,
        name: group.name,
        description: group.description,
        memberCount: group.member_count,
        appCount: group.app_count,
        createdAt: group.created_at,
        updatedAt: group.updated_at,
      })),
      canAdmin: team.role === "admin",
    });
  }

  if (!groupId && req.method === "POST") {
    const body = await req.json().catch(() => ({})) as { slug?: string; name?: string; description?: string };
    if (!validSlug(body.slug)) return json({ error: "group slug must be 3-48 lowercase letters, numbers, and hyphens" }, 400);
    const name = text(body.name, 100);
    if (!name) return json({ error: "group name is required" }, 400);
    const description = text(body.description, 500);
    const id = randomHex(12);
    const now = Date.now();
    try {
      await env.CONTROL_DB.prepare(
        "INSERT INTO team_groups (id,team_id,slug,name,description,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
      ).bind(id, teamId, body.slug, name, description, principal.user.id, now, now).run();
    } catch (error) {
      if (isUniqueViolation(error)) return json({ error: "group slug is already in use" }, 409);
      throw error;
    }
    await audit(env, { actorId: principal.user.id, teamId, action: "group.created", detail: { id, slug: body.slug } });
    return json({ group: { id, slug: body.slug, name, description, memberCount: 0, appCount: 0 } }, 201);
  }

  const group = groupId
    ? await env.CONTROL_DB.prepare("SELECT * FROM team_groups WHERE id=? AND team_id=?")
      .bind(groupId, teamId).first<TeamGroupRow>()
    : null;
  if (!group) return json({ error: "group not found" }, 404);

  if (membersPath && req.method === "GET") {
    const members = await env.CONTROL_DB.prepare(
      `SELECT u.id,u.email,u.name,u.picture,m.created_at
       FROM group_members m JOIN users u ON u.id=m.user_id
       WHERE m.group_id=? ORDER BY COALESCE(u.name,u.email)`,
    ).bind(group.id).all();
    return json({ group: { id: group.id, slug: group.slug, name: group.name }, members: members.results, canAdmin: team.role === "admin" });
  }

  if (membersPath && req.method === "PUT") {
    const body = await req.json().catch(() => ({})) as { userIds?: string[] };
    if (!Array.isArray(body.userIds) || !body.userIds.every((id) => typeof id === "string") || new Set(body.userIds).size !== body.userIds.length) {
      return json({ error: "userIds must be a unique list" }, 400);
    }
    if (body.userIds.length) {
      const active = await env.CONTROL_DB.prepare(
        `SELECT user_id FROM team_members WHERE team_id=? AND status='active' AND user_id IN (${sqlPlaceholders(body.userIds.length)})`,
      ).bind(teamId, ...body.userIds).all<{ user_id: string }>();
      if (active.results.length !== body.userIds.length) return json({ error: "every group member must be an active team member" }, 400);
    }
    const now = Date.now();
    await env.CONTROL_DB.batch([
      env.CONTROL_DB.prepare("DELETE FROM group_members WHERE group_id=?").bind(group.id),
      ...body.userIds.map((userId) => env.CONTROL_DB.prepare(
        "INSERT INTO group_members (group_id,user_id,added_by,created_at) VALUES (?,?,?,?)",
      ).bind(group.id, userId, principal.user.id, now)),
    ]);
    await audit(env, { actorId: principal.user.id, teamId, action: "group.members.updated", detail: { groupId: group.id, userIds: body.userIds } });
    return json({ ok: true });
  }

  if (!membersPath && req.method === "PATCH") {
    const body = await req.json().catch(() => ({})) as { name?: string; description?: string };
    const name = body.name === undefined ? group.name : text(body.name, 100);
    if (!name) return json({ error: "group name is required" }, 400);
    const description = body.description === undefined ? group.description : text(body.description, 500);
    await env.CONTROL_DB.prepare("UPDATE team_groups SET name=?,description=?,updated_at=? WHERE id=?")
      .bind(name, description, Date.now(), group.id).run();
    await audit(env, { actorId: principal.user.id, teamId, action: "group.updated", detail: { id: group.id, name } });
    return json({ group: { id: group.id, slug: group.slug, name, description } });
  }

  if (!membersPath && req.method === "DELETE") {
    const usage = await env.CONTROL_DB.prepare("SELECT COUNT(*) count FROM app_group_assignments WHERE group_id=?")
      .bind(group.id).first<{ count: number }>();
    if (Number(usage?.count || 0)) return json({ error: "remove this group from its apps before deleting it", appCount: usage?.count }, 409);
    await env.CONTROL_DB.prepare("DELETE FROM team_groups WHERE id=?").bind(group.id).run();
    await audit(env, { actorId: principal.user.id, teamId, action: "group.deleted", detail: { id: group.id, slug: group.slug } });
    return json({ ok: true });
  }

  return json({ error: "method not allowed" }, 405);
}

async function handleMemberApi(
  req: Request,
  env: Env,
  principal: Principal,
  teamId: string,
  userId: string | null,
): Promise<Response> {
  const team = await teamAccess(env, principal, teamId, req.method !== "GET");
  if (!team) return json({ error: "team not found" }, 404);

  if (!userId && req.method === "GET") {
    const members = await env.CONTROL_DB.prepare(
      `SELECT u.id,u.email,u.name,u.picture,m.role,m.status,m.created_at,m.updated_at
       FROM team_members m JOIN users u ON u.id=m.user_id
       WHERE m.team_id=? ORDER BY COALESCE(u.name,u.email)`,
    ).bind(teamId).all();
    return json({ members: members.results, canAdmin: team.role === "admin" });
  }

  if (userId && req.method === "PATCH") {
    const body = await req.json().catch(() => ({})) as { role?: TeamRole; status?: "active" | "suspended" };
    if (body.role !== undefined && !["member", "admin"].includes(body.role)) return json({ error: "invalid team role" }, 400);
    if (body.status !== undefined && !["active", "suspended"].includes(body.status)) return json({ error: "invalid membership status" }, 400);
    if (body.role === undefined && body.status === undefined) return json({ error: "role or status is required" }, 400);
    if (userId === principal.user.id && body.status === "suspended") return json({ error: "you cannot suspend your own membership" }, 400);
    const member = await env.CONTROL_DB.prepare("SELECT role,status FROM team_members WHERE team_id=? AND user_id=?")
      .bind(teamId, userId).first<{ role: TeamRole; status: "active" | "suspended" }>();
    if (!member) return json({ error: "team member not found" }, 404);
    const role = body.role ?? member.role;
    const status = body.status ?? member.status;
    if (member.role === "admin" && member.status === "active" && (role !== "admin" || status !== "active")) {
      const others = await env.CONTROL_DB.prepare(
        "SELECT COUNT(*) count FROM team_members WHERE team_id=? AND role='admin' AND status='active' AND user_id<>?",
      ).bind(teamId, userId).first<{ count: number }>();
      if (!Number(others?.count || 0)) return json({ error: "a team must retain at least one active admin" }, 409);
    }
    const update = body.role !== undefined && body.status !== undefined
      ? env.CONTROL_DB.prepare("UPDATE team_members SET role=?,status=?,updated_at=? WHERE team_id=? AND user_id=?")
        .bind(body.role, body.status, Date.now(), teamId, userId)
      : body.role !== undefined
        ? env.CONTROL_DB.prepare("UPDATE team_members SET role=?,updated_at=? WHERE team_id=? AND user_id=?")
          .bind(body.role, Date.now(), teamId, userId)
        : env.CONTROL_DB.prepare("UPDATE team_members SET status=?,updated_at=? WHERE team_id=? AND user_id=?")
          .bind(body.status, Date.now(), teamId, userId);
    try {
      await update.run();
    } catch (error) {
      if (String(error).includes("team must retain an active admin")) {
        return json({ error: "a team must retain at least one active admin" }, 409);
      }
      throw error;
    }
    const updated = (await env.CONTROL_DB.prepare("SELECT role,status FROM team_members WHERE team_id=? AND user_id=?")
      .bind(teamId, userId).first<{ role: TeamRole; status: "active" | "suspended" }>())!;
    await audit(env, {
      actorId: principal.user.id,
      teamId,
      action: memberChangeAction(member.status, updated.status),
      detail: { userId, previousRole: member.role, role: updated.role, previousStatus: member.status, status: updated.status },
    });
    return json({ member: { userId, role: updated.role, status: updated.status } });
  }

  return json({ error: "method not allowed" }, 405);
}

function memberChangeAction(previousStatus: "active" | "suspended", status: "active" | "suspended"): string {
  if (status === previousStatus) return "team.member.updated";
  return status === "suspended" ? "team.member.suspended" : "team.member.reactivated";
}

export async function handleOrganizationApi(
  req: Request,
  env: Env,
  principal: Principal,
  url: URL,
): Promise<Response | null> {
  if (url.pathname === "/api/teams" && req.method === "POST") {
    if (principal.user.platform_role !== "owner" || principal.appId || principal.teamId) {
      return json({ error: "unscoped platform owner required" }, 403);
    }
    const body = await req.json().catch(() => ({})) as { slug?: string; name?: string; allowedEmailDomain?: string | null };
    if (!validSlug(body.slug)) return json({ error: "team slug must be 3-48 lowercase letters, numbers, and hyphens" }, 400);
    const name = text(body.name, 100);
    if (!name) return json({ error: "team name is required" }, 400);
    const allowedEmailDomain = body.allowedEmailDomain ? text(body.allowedEmailDomain, 253).toLowerCase() : null;
    if (allowedEmailDomain && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(allowedEmailDomain)) {
      return json({ error: "allowed email domain is invalid" }, 400);
    }
    const id = randomHex(12);
    const now = Date.now();
    try {
      await env.CONTROL_DB.batch([
        env.CONTROL_DB.prepare(
          "INSERT INTO teams (id,slug,name,allowed_email_domain,created_at,updated_at) VALUES (?,?,?,?,?,?)",
        ).bind(id, body.slug, name, allowedEmailDomain, now, now),
        env.CONTROL_DB.prepare(
          "INSERT INTO team_members (team_id,user_id,role,status,created_at,updated_at) VALUES (?,?,'admin','active',?,?)",
        ).bind(id, principal.user.id, now, now),
      ]);
    } catch (error) {
      if (isUniqueViolation(error)) return json({ error: "team slug is already in use" }, 409);
      throw error;
    }
    await audit(env, { actorId: principal.user.id, teamId: id, action: "team.created", detail: { slug: body.slug, name } });
    return json({ team: { id, slug: body.slug, name, role: "admin" } }, 201);
  }
  if (!url.pathname.startsWith("/api/teams/")) return null;
  // Organization management is never in scope for a token bound to a single app.
  if (principal.appId) return json({ error: "token is scoped to one app" }, 403);

  const folders = TEAM_ROUTES.folders.exec(url.pathname);
  if (folders) return handleFolderApi(req, env, principal, decodeURIComponent(folders[1]!), segment(folders[2]));

  const groups = TEAM_ROUTES.groups.exec(url.pathname);
  if (groups) return handleGroupApi(req, env, principal, decodeURIComponent(groups[1]!), segment(groups[2]), Boolean(groups[3]));

  const members = TEAM_ROUTES.members.exec(url.pathname);
  if (members) return handleMemberApi(req, env, principal, decodeURIComponent(members[1]!), segment(members[2]));

  return null;
}
