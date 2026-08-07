import { randomHex } from "./core";
import type { Env } from "./types";

export interface AuditEvent {
  actorId: string;
  action: string;
  teamId?: string | null;
  appId?: string | null;
  detail?: unknown;
}

export async function audit(env: Env, event: AuditEvent): Promise<void> {
  try {
    await env.CONTROL_DB.prepare(
      "INSERT INTO audit_log (id,app_id,user_id,action,detail,created_at,team_id) VALUES (?,?,?,?,?,?,?)",
    ).bind(
      randomHex(12),
      event.appId ?? null,
      event.actorId,
      event.action,
      event.detail === undefined ? null : JSON.stringify(event.detail),
      Date.now(),
      event.teamId ?? null,
    ).run();
  } catch (error) {
    console.error("audit write failed", { action: event.action, appId: event.appId, teamId: event.teamId, error });
  }
}
