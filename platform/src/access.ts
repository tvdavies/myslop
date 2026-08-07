import type { Principal } from "./auth";
import type { AppAudience, AppRole, AppRow, Env, User } from "./types";

const ROLE_RANK: Record<AppRole, number> = { viewer: 1, editor: 2, owner: 3 };
const RANK_ROLE: Record<number, AppRole> = { 1: "viewer", 2: "editor", 3: "owner" };

export interface AppPermissions {
  role: AppRole | null;
  open: boolean;
  viewSettings: boolean;
  modifyMetadata: boolean;
  modifyRuntime: boolean;
  modifySecrets: boolean;
  modifyAccess: boolean;
  moveApp: boolean;
  destroy: boolean;
}

export interface AccessSource {
  type: "platform" | "owner" | "user" | "group" | "team" | "public";
  role: AppRole;
  label: string;
  id?: string;
}

export interface EffectiveAccess {
  role: AppRole | null;
  sources: AccessSource[];
  membershipActive: boolean;
}

export type AppAccessRow = AppRow & { effective_rank: number };

export function visibilityToAudience(visibility: AppRow["visibility"]): AppAudience {
  return visibility === "private" ? "restricted" : visibility;
}

export function audienceToVisibility(audience: AppAudience): AppRow["visibility"] {
  return audience === "restricted" ? "private" : audience;
}

export function highestRole(...roles: Array<AppRole | null | undefined>): AppRole | null {
  let rank = 0;
  for (const role of roles) rank = Math.max(rank, role ? ROLE_RANK[role] : 0);
  return RANK_ROLE[rank] ?? null;
}

export function roleAtLeast(role: AppRole | null, required: AppRole): boolean {
  return (role ? ROLE_RANK[role] : 0) >= ROLE_RANK[required];
}

export function permissionsFor(app: Pick<AppRow, "managed_by">, role: AppRole | null): AppPermissions {
  const viewer = roleAtLeast(role, "viewer");
  const editor = roleAtLeast(role, "editor");
  const owner = roleAtLeast(role, "owner");
  const gitManaged = app.managed_by === "git";
  return {
    role,
    open: viewer,
    viewSettings: viewer,
    modifyMetadata: editor && !gitManaged,
    modifyRuntime: editor && !gitManaged,
    modifySecrets: editor,
    modifyAccess: owner && !gitManaged,
    moveApp: owner && !gitManaged,
    destroy: owner && !gitManaged,
  };
}

export async function effectiveAppAccess(env: Env, app: AppRow, user: User | null): Promise<EffectiveAccess> {
  if (user?.platform_role === "owner") {
    return {
      role: "owner",
      membershipActive: true,
      sources: [{ type: "platform", role: "owner", label: "Platform owner" }],
    };
  }

  const sources: AccessSource[] = [];
  if (app.visibility === "public") sources.push({ type: "public", role: "viewer", label: "Public access" });

  let membershipActive = false;
  if (user) {
    const membership = await env.CONTROL_DB.prepare(
      "SELECT status FROM team_members WHERE team_id=? AND user_id=?",
    ).bind(app.team_id, user.id).first<{ status: "active" | "suspended" }>();
    membershipActive = membership?.status === "active";

    if (membershipActive) {
      if (app.visibility === "team") sources.push({ type: "team", role: "viewer", label: "Team access" });
      if (app.owner_id === user.id) sources.push({ type: "owner", role: "owner", label: "Primary owner", id: user.id });

      const direct = await env.CONTROL_DB.prepare(
        "SELECT role FROM app_user_assignments WHERE app_id=? AND user_id=?",
      ).bind(app.id, user.id).first<{ role: AppRole }>();
      if (direct) sources.push({ type: "user", role: direct.role, label: "Individual assignment", id: user.id });

      const groups = await env.CONTROL_DB.prepare(
        `SELECT g.id,g.name,a.role
         FROM app_group_assignments a
         JOIN team_groups g ON g.id=a.group_id AND g.team_id=?
         JOIN group_members m ON m.group_id=g.id AND m.user_id=?
         WHERE a.app_id=?
         ORDER BY g.name`,
      ).bind(app.team_id, user.id, app.id).all<{ id: string; name: string; role: "viewer" | "editor" }>();
      for (const group of groups.results) {
        sources.push({ type: "group", role: group.role, label: group.name, id: group.id });
      }
    }
  }

  return { role: highestRole(...sources.map(({ role }) => role)), membershipActive, sources };
}

export async function effectiveAppRole(env: Env, app: AppRow, user: User | null): Promise<AppRole | null> {
  return (await effectiveAppAccess(env, app, user)).role;
}

export async function appPermissions(env: Env, app: AppRow, principal: Principal): Promise<AppPermissions> {
  if (principal.appId && principal.appId !== app.id) return permissionsFor(app, null);
  return permissionsFor(app, await effectiveAppRole(env, app, principal.user));
}

// Binds, in order: 1 when the viewer is a platform owner, then the viewer id three times.
const ROLE_RANK_SQL = `MAX(
    CASE WHEN ?=1 THEN 3 ELSE 0 END,
    CASE WHEN tm.status='active' AND a.owner_id=? THEN 3 ELSE 0 END,
    CASE WHEN tm.status='active' THEN COALESCE((
      SELECT MAX(CASE ua.role WHEN 'owner' THEN 3 WHEN 'editor' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END)
      FROM app_user_assignments ua WHERE ua.app_id=a.id AND ua.user_id=?
    ),0) ELSE 0 END,
    CASE WHEN tm.status='active' THEN COALESCE((
      SELECT MAX(CASE ga.role WHEN 'editor' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END)
      FROM app_group_assignments ga
      JOIN group_members gm ON gm.group_id=ga.group_id AND gm.user_id=?
      JOIN team_groups g ON g.id=ga.group_id AND g.team_id=a.team_id
      WHERE ga.app_id=a.id
    ),0) ELSE 0 END,
    CASE WHEN a.visibility='public' THEN 1 WHEN a.visibility='team' AND tm.status='active' THEN 1 ELSE 0 END
  )`;

export async function listAccessibleApps(
  env: Env,
  principal: Principal,
  options: { teamId?: string; includeArchived?: boolean; appId?: string } = {},
): Promise<AppAccessRow[]> {
  const conditions = [options.includeArchived ? "1=1" : "a.archived_at IS NULL"];
  const trailing: unknown[] = [];
  if (options.teamId) {
    conditions.push("a.team_id=?");
    trailing.push(options.teamId);
  }
  const appId = options.appId ?? principal.appId ?? undefined;
  if (appId) {
    conditions.push("a.id=?");
    trailing.push(appId);
  }
  const userId = principal.user.id;
  const rankBindings = [principal.user.platform_role === "owner" ? 1 : 0, userId, userId, userId];
  const membershipBinding = userId;
  const sql = `SELECT * FROM (
      SELECT a.*,${ROLE_RANK_SQL} effective_rank
      FROM apps a
      LEFT JOIN team_members tm ON tm.team_id=a.team_id AND tm.user_id=?
      WHERE ${conditions.join(" AND ")}
    )
    WHERE effective_rank>0
    ORDER BY updated_at DESC
    LIMIT 500`;
  return (await env.CONTROL_DB.prepare(sql)
    .bind(...rankBindings, membershipBinding, ...trailing)
    .all<AppAccessRow>()).results;
}

export function roleFromRank(rank: number): AppRole | null {
  return RANK_ROLE[rank] ?? null;
}
