// Platform-injected identity for myslop apps.
//
// The dispatcher strips client-supplied x-myslop-* headers on every app
// request and injects verified values when the caller holds a platform
// session or a platform token (msa_), so apps can trust these headers as
// authoritative. Anonymous requests to public apps carry none of them.
//
// Apps that predate platform identity keep their own users table populated
// from Shoo sign-ins. resolvePlatformUser maps a platform identity onto that
// table: platform emails are verified, so a local account with the same email
// is the same person — the users_verified_email unique index guarantees one
// account per verified email across both sign-in paths.

export interface PlatformIdentity {
  id: string;
  email: string | null;
  name: string | null;
}

interface BoundStatement {
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<unknown>;
}

// Structural subset of D1Database so both the real binding and test shims fit.
export interface IdentityDatabase {
  prepare(sql: string): { bind(...values: (string | number | null)[]): BoundStatement };
}

export function platformIdentity(req: Request): PlatformIdentity | null {
  const id = req.headers.get("x-myslop-user-id");
  if (!id) return null;
  return {
    id,
    email: req.headers.get("x-myslop-user-email") || null,
    name: req.headers.get("x-myslop-user-name") || null,
  };
}

async function userIdByEmail(db: IdentityDatabase, email: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT id FROM users WHERE email = ? COLLATE NOCASE LIMIT 1")
    .bind(email)
    .first<{ id: string }>();
  return row?.id ?? null;
}

// Find-or-create the local user for a platform identity; returns the local
// user id. New identities are keyed by the platform user id, existing accounts
// (Shoo or platform) are matched by verified email.
export async function resolvePlatformUser(
  db: IdentityDatabase,
  identity: PlatformIdentity,
  now = Date.now(),
): Promise<string> {
  let userId = (identity.email && (await userIdByEmail(db, identity.email))) || identity.id;
  try {
    await db
      .prepare(
        `INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           email = COALESCE(excluded.email, email),
           name = COALESCE(excluded.name, name)`,
      )
      .bind(userId, identity.email, identity.name, now)
      .run();
  } catch (error) {
    // Unique-email collision: a concurrent sign-in created the account first.
    if (!identity.email) throw error;
    const winner = await userIdByEmail(db, identity.email);
    if (!winner || winner === userId) throw error;
    userId = winner;
    await db
      .prepare("UPDATE users SET name = COALESCE(?, name) WHERE id = ?")
      .bind(identity.name, userId)
      .run();
  }
  return userId;
}
