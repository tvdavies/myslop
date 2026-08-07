import { nextCronRun } from "./cron";
import { randomHex, sha256Hex } from "./core";
import { signInternalRequest } from "./internal";
import { parseResolvedManifest } from "./manifest";
import type { AppRow, DeploymentRow, Env } from "./types";

const MAX_EMAIL_ATTEMPTS = 12;
const MAX_SCHEDULE_ATTEMPTS = 3;
const encoder = new TextEncoder();

interface ScheduledRow {
  id: string;
  app_id: string;
  expression: string;
  next_run_at: number;
  attempt?: number;
  slug: string;
  active_version: number;
  worker_name: string;
  manifest_json: string;
}

interface EmailRow {
  id: string;
  app_id: string;
  sender: string;
  recipient: string;
  spool_key: string;
  attempts: number;
  slug: string;
  active_version: number;
  worker_name: string;
  manifest_json: string;
}

async function dispatchInternal(
  env: Env,
  app: Pick<AppRow, "id" | "slug" | "worker_name" | "active_version">,
  manifestJson: string,
  path: string,
  body: ReadableStream | ArrayBuffer,
  bodyHash: string,
  headers: HeadersInit = {},
): Promise<Response> {
  if (app.active_version === null) throw new Error("app has no active deployment");
  const manifest = parseResolvedManifest(JSON.parse(manifestJson));
  const worker = env.DISPATCHER.get(app.worker_name, {}, {
    limits: { cpuMs: 30_000, subRequests: 100 },
    outbound: { policy: { appId: app.id, hosts: manifest.capabilities.network } },
  });
  const signature = await signInternalRequest(env.INTERNAL_DISPATCH_SECRET, "POST", path, bodyHash);
  return worker.fetch(`https://${app.slug}.apps.myslop.app${path}`, {
    method: "POST",
    headers: {
      ...headers,
      "x-myslop-internal-timestamp": signature.timestamp,
      "x-myslop-internal-nonce": signature.nonce,
      "x-myslop-internal-signature": signature.signature,
      "x-myslop-body-sha256": bodyHash,
    },
    body,
  });
}

export async function reconcileAppSchedules(env: Env, appId: string, schedules: string[], now = Date.now()): Promise<void> {
  const existing = await env.CONTROL_DB.prepare("SELECT id, expression FROM app_schedules WHERE app_id=?").bind(appId).all<{ id: string; expression: string }>();
  const desired = new Set(schedules);
  const batch: D1PreparedStatement[] = [];
  for (const row of existing.results) {
    if (!desired.has(row.expression)) batch.push(env.CONTROL_DB.prepare("DELETE FROM app_schedules WHERE id=?").bind(row.id));
  }
  const current = new Set(existing.results.map(({ expression }) => expression));
  for (const expression of schedules) {
    if (current.has(expression)) continue;
    batch.push(
      env.CONTROL_DB.prepare(
        "INSERT INTO app_schedules (id,app_id,expression,next_run_at,created_at,updated_at) VALUES (?,?,?,?,?,?)",
      ).bind(randomHex(12), appId, expression, nextCronRun(expression, now - 60_000), now, now),
    );
  }
  if (batch.length) await env.CONTROL_DB.batch(batch);
}

async function executeSchedule(env: Env, row: ScheduledRow, now: number): Promise<void> {
  const runId = `${row.id}:${row.next_run_at}`;
  const inserted = await env.CONTROL_DB.prepare(
    "INSERT OR IGNORE INTO schedule_runs (id,schedule_id,app_id,scheduled_at,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
  ).bind(runId, row.id, row.app_id, row.next_run_at, "running", now, now).run();
  if (!inserted.meta.changes) {
    const existing = await env.CONTROL_DB.prepare("SELECT status,attempt FROM schedule_runs WHERE id=?")
      .bind(runId).first<{ status: string; attempt: number }>();
    if (existing?.status !== "retrying") return;
    row.attempt = existing.attempt;
    await env.CONTROL_DB.prepare("UPDATE schedule_runs SET status='running',updated_at=? WHERE id=?").bind(now, runId).run();
  }
  const body = encoder.encode(JSON.stringify({ scheduleId: row.id, cron: row.expression, scheduledTime: row.next_run_at, attemptId: runId }));
  const bodyHash = await sha256Hex(body);
  try {
    const response = await dispatchInternal(
      env,
      row,
      row.manifest_json,
      "/__scheduled",
      body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
      bodyHash,
      {
      "content-type": "application/json; charset=utf-8",
    });
    if (!response.ok) throw new Error(`app returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
    await env.CONTROL_DB.batch([
      env.CONTROL_DB.prepare("UPDATE schedule_runs SET status='succeeded', updated_at=? WHERE id=?").bind(now, runId),
      env.CONTROL_DB.prepare(
        "UPDATE app_schedules SET next_run_at=?, last_run_at=?, last_status='succeeded', last_error=NULL, updated_at=? WHERE id=?",
      ).bind(nextCronRun(row.expression, Math.max(row.next_run_at, now - 60_000)), row.next_run_at, now, row.id),
    ]);
  } catch (error) {
    const attempt = (row.attempt ?? 0) + 1;
    const message = error instanceof Error ? error.message : String(error);
    const terminal = attempt >= MAX_SCHEDULE_ATTEMPTS;
    await env.CONTROL_DB.batch([
      env.CONTROL_DB.prepare("UPDATE schedule_runs SET status=?, attempt=?, error=?, updated_at=? WHERE id=?")
        .bind(terminal ? "failed" : "retrying", attempt, message, now, runId),
      env.CONTROL_DB.prepare(
        "UPDATE app_schedules SET next_run_at=?, last_run_at=?, last_status=?, last_error=?, updated_at=? WHERE id=?",
      ).bind(terminal ? nextCronRun(row.expression, Math.max(row.next_run_at, now - 60_000)) : row.next_run_at, row.next_run_at, terminal ? "failed" : "retrying", message, now, row.id),
    ]);
  }
}

export async function dispatchDueSchedules(env: Env, now = Date.now()): Promise<void> {
  const minute = Math.floor(now / 60_000) * 60_000;
  const due = await env.CONTROL_DB.prepare(
    `SELECT s.id,s.app_id,s.expression,s.next_run_at,a.slug,a.active_version,d.worker_name,d.manifest_json,
            COALESCE((SELECT attempt FROM schedule_runs WHERE schedule_id=s.id AND scheduled_at=s.next_run_at),0) attempt
     FROM app_schedules s
     JOIN apps a ON a.id=s.app_id AND a.archived_at IS NULL AND a.active_version IS NOT NULL
     JOIN deployments d ON d.app_id=a.id AND d.version=a.active_version AND d.status='active'
     WHERE s.next_run_at<=?
     ORDER BY s.next_run_at,s.id
     LIMIT 100`,
  ).bind(minute).all<ScheduledRow>();
  await Promise.all(due.results.map((row) => executeSchedule(env, row, now)));
}

function emailBackoff(attempts: number): number {
  return Math.min(6 * 60 * 60_000, 60_000 * 2 ** Math.min(attempts, 8));
}

async function deliverEmail(env: Env, row: EmailRow, now: number): Promise<"delivered" | "rejected" | "retrying" | "dead"> {
  await env.CONTROL_DB.prepare("UPDATE email_deliveries SET app_id=? WHERE id=? AND app_id IS NULL").bind(row.app_id, row.id).run();
  const object = await env.MAIL_SPOOL.get(row.spool_key);
  if (!object) throw new Error("email spool object is missing");
  const raw = await object.arrayBuffer();
  const bodyHash = await sha256Hex(new Uint8Array(raw));
  const response = await dispatchInternal(env, row, row.manifest_json, "/__email", raw, bodyHash, {
    "content-type": "message/rfc822",
    "x-myslop-delivery-id": row.id,
    "x-myslop-mail-from": row.sender,
    "x-myslop-rcpt-to": row.recipient,
  });
  const attempts = row.attempts + 1;
  const error = response.ok ? null : `app returned ${response.status}: ${(await response.text()).slice(0, 500)}`;
  if (response.ok) {
    await env.CONTROL_DB.prepare(
      "UPDATE email_deliveries SET status='delivered', attempts=?, last_error=NULL, delivered_at=?, updated_at=? WHERE id=?",
    ).bind(attempts, now, now, row.id).run();
    await env.MAIL_SPOOL.delete(row.spool_key);
    return "delivered";
  }
  if (response.status >= 400 && response.status < 500) {
    await env.CONTROL_DB.prepare(
      "UPDATE email_deliveries SET status='rejected', attempts=?, last_error=?, updated_at=? WHERE id=?",
    ).bind(attempts, error, now, row.id).run();
    await env.MAIL_SPOOL.delete(row.spool_key);
    return "rejected";
  }
  const dead = attempts >= MAX_EMAIL_ATTEMPTS;
  await env.CONTROL_DB.prepare(
    "UPDATE email_deliveries SET status=?, attempts=?, next_attempt_at=?, last_error=?, updated_at=? WHERE id=?",
  ).bind(dead ? "dead" : "retrying", attempts, now + emailBackoff(attempts), error, now, row.id).run();
  return dead ? "dead" : "retrying";
}

async function emailApp(env: Env): Promise<EmailRow | null> {
  return env.CONTROL_DB.prepare(
    `SELECT a.id app_id,a.slug,a.active_version,d.worker_name,d.manifest_json
     FROM apps a JOIN deployments d ON d.app_id=a.id AND d.version=a.active_version AND d.status='active'
     WHERE a.archived_at IS NULL AND json_extract(d.manifest_json,'$.capabilities.email')=1
     LIMIT 1`,
  ).first<EmailRow>();
}

export async function acceptEmail(message: ForwardableEmailMessage, env: Env): Promise<"delivered" | "rejected" | "spooled"> {
  const app = await emailApp(env);
  const id = crypto.randomUUID();
  const spoolKey = `pending/${id}.eml`;
  const now = Date.now();
  const messageId = message.headers.get("message-id") ?? "";
  await env.MAIL_SPOOL.put(spoolKey, message.raw, {
    customMetadata: {
      sender: message.from,
      recipient: message.to,
      messageId,
      appId: app?.app_id ?? "",
    },
  });
  try {
    await env.CONTROL_DB.prepare(
      `INSERT INTO email_deliveries
       (id,app_id,sender,recipient,spool_key,message_id,status,next_attempt_at,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).bind(id, app?.app_id ?? null, message.from, message.to, spoolKey, messageId || null, "pending", now, now, now).run();
  } catch (error) {
    console.error("email delivery indexing failed; spool recovery will retry", { id, error });
    return "spooled";
  }
  if (!app) return "spooled";
  const status = await deliverEmail(env, { ...app, id, sender: message.from, recipient: message.to, spool_key: spoolKey, attempts: 0 }, now);
  if (status === "rejected") {
    message.setReject("Recipient rejected the message");
    return "rejected";
  }
  return status === "delivered" ? "delivered" : "spooled";
}

async function recoverUnindexedEmailSpool(env: Env, now: number): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await env.MAIL_SPOOL.list({ prefix: "pending/", cursor, include: ["customMetadata"], limit: 100 });
    for (const object of listed.objects) {
      const id = object.key.slice("pending/".length).replace(/\.eml$/, "");
      const metadata = object.customMetadata;
      if (!id || !metadata?.sender || !metadata.recipient) continue;
      await env.CONTROL_DB.prepare(
        `INSERT OR IGNORE INTO email_deliveries
         (id,app_id,sender,recipient,spool_key,message_id,status,next_attempt_at,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).bind(id, metadata.appId || null, metadata.sender, metadata.recipient, object.key, metadata.messageId || null, "pending", now, object.uploaded.getTime(), now).run();
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

export async function retryEmailDeliveries(env: Env, now = Date.now()): Promise<void> {
  await recoverUnindexedEmailSpool(env, now);
  const rows = await env.CONTROL_DB.prepare(
    `SELECT e.id,e.app_id,e.sender,e.recipient,e.spool_key,e.attempts,a.slug,a.active_version,d.worker_name,d.manifest_json
     FROM email_deliveries e
     JOIN apps a ON (e.app_id IS NULL OR a.id=e.app_id) AND a.archived_at IS NULL AND a.active_version IS NOT NULL
     JOIN deployments d ON d.app_id=a.id AND d.version=a.active_version AND d.status='active'
       AND json_extract(d.manifest_json,'$.capabilities.email')=1
     WHERE e.status IN ('pending','retrying') AND e.next_attempt_at<=?
     ORDER BY e.next_attempt_at,e.id LIMIT 50`,
  ).bind(now).all<EmailRow>();
  await Promise.all(rows.results.map((row) => deliverEmail(env, row, now).catch(async (error) => {
    const attempts = row.attempts + 1;
    await env.CONTROL_DB.prepare(
      "UPDATE email_deliveries SET status=?,attempts=?,next_attempt_at=?,last_error=?,updated_at=? WHERE id=?",
    ).bind(attempts >= MAX_EMAIL_ATTEMPTS ? "dead" : "retrying", attempts, now + emailBackoff(attempts), error instanceof Error ? error.message : String(error), now, row.id).run();
  })));
}
