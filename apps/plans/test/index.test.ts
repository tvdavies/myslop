import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import worker from "../src/index";
import { renderPlan } from "../src/markdown";

import { d1 } from "./d1";
import { AUTHOR_PERMISSIONS, PERMISSION_PRESETS } from "../src/permissions";

afterEach(() => db?.close());

function context() {
  return { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
}

const BASE = "https://plans.myslop.app";
const encoder = new TextEncoder();

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

let db: Database;
let env: { DB: ReturnType<typeof d1> };

const OWNER_TOKEN = "msp_owner-secret";
const STRANGER_TOKEN = "msp_stranger-secret";
const OWNER_SID = "a".repeat(32);
const REVIEWER_SID = "b".repeat(32);
const REVIEWER2_SID = "c".repeat(32);

beforeEach(async () => {
  db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(await Bun.file(new URL("../schema.sql", import.meta.url)).text());
  env = { DB: d1(db) };

  const now = Date.now();
  const insertUser = db.query("INSERT INTO users (id, email, name, picture, created_at) VALUES (?, ?, ?, ?, ?)");
  insertUser.run("owner-user", "owner@example.com", "Owner", null, now);
  insertUser.run("reviewer-user", "reviewer@example.com", "Reviewer", null, now);
  insertUser.run("reviewer-two", "second@example.com", "Second", null, now);
  insertUser.run("stranger-user", "stranger@example.com", "Stranger", null, now);

  const insertSession = db.query("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)");
  insertSession.run(OWNER_SID, "owner-user", now, now + 86_400_000);
  insertSession.run(REVIEWER_SID, "reviewer-user", now, now + 86_400_000);
  insertSession.run(REVIEWER2_SID, "reviewer-two", now, now + 86_400_000);

  const insertToken = db.query(
    "INSERT INTO tokens (id, user_id, hash, name, prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  insertToken.run("tok1", "owner-user", await sha256Hex(OWNER_TOKEN), "claude", OWNER_TOKEN.slice(0, 12), now);
  insertToken.run("tok2", "stranger-user", await sha256Hex(STRANGER_TOKEN), "other", STRANGER_TOKEN.slice(0, 12), now);
});

async function call(
  method: string,
  path: string,
  opts: {
    token?: string;
    sid?: string;
    body?: unknown;
    identity?: { id: string; email?: string; name?: string };
    origin?: string;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
  if (opts.origin) headers.origin = opts.origin;
  if (opts.identity) {
    headers["x-myslop-user-id"] = opts.identity.id;
    if (opts.identity.email) headers["x-myslop-user-email"] = opts.identity.email;
    if (opts.identity.name) headers["x-myslop-user-name"] = opts.identity.name;
  }
  if (opts.sid) headers.cookie = `sid=${opts.sid}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return (await worker.fetch(
    new Request(`${BASE}${path}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }) as never,
    env as never,
    context(),
  )) as unknown as Response;
}

const PLAN_MD = "# Rollout\n\nWe ship in two phases.\n\n- phase one\n- phase two";

async function createPlan(): Promise<{ id: string; url: string; version: number }> {
  const res = await call("POST", "/api/agent/plans", {
    token: OWNER_TOKEN,
    body: { title: "Service rollout plan", markdown: PLAN_MD },
  });
  expect(res.status).toBe(201);
  return res.json() as Promise<{ id: string; url: string; version: number }>;
}

describe("platform identity", () => {
  const OWNER_IDENTITY = { id: "plat-owner", email: "owner@example.com", name: "Owner" };

  test("authenticates the agent API and joins the token owner's account by email", async () => {
    const created = await call("POST", "/api/agent/plans", {
      identity: OWNER_IDENTITY,
      body: { title: "Identity plan", markdown: PLAN_MD },
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    // Same verified email as the msp_ token owner → same account, both credentials see it.
    const viaToken = await call("GET", `/api/agent/plans/${id}`, { token: OWNER_TOKEN });
    expect(viaToken.status).toBe(200);
    const viaIdentity = await call("GET", `/api/agent/plans/${id}`, { identity: OWNER_IDENTITY });
    expect(viaIdentity.status).toBe(200);
  });

  test("labels identity comments with the platform user's name", async () => {
    const plan = await createPlan();
    const res = await call("POST", `/api/agent/plans/${plan.id}/comments`, {
      identity: OWNER_IDENTITY,
      body: { body: "Shipped the first phase." },
    });
    expect(res.status).toBe(201);
    expect(db.query("SELECT author_type, agent_name FROM comments WHERE plan_id = ?").get(plan.id)).toEqual({
      author_type: "agent",
      agent_name: "Owner",
    });
  });

  test("unknown identities get fresh accounts and cannot see other plans", async () => {
    const plan = await createPlan();
    const res = await call("GET", `/api/agent/plans/${plan.id}`, {
      identity: { id: "plat-stranger", email: "someone-new@example.com" },
    });
    expect(res.status).toBe(404);
    expect(db.query("SELECT id FROM users WHERE id = ?").get("plat-stranger")).toEqual({ id: "plat-stranger" });
  });

  test("identity verifies at /api/verify without a bearer", async () => {
    const res = await call("GET", "/api/verify", { identity: OWNER_IDENTITY });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, user: { email: "owner@example.com" } });
  });
});

describe("agent API", () => {
  test("creates a plan and reports it via status and list endpoints", async () => {
    const created = await createPlan();
    expect(created.url).toBe(`${BASE}/p/${created.id}`);
    expect(created.version).toBe(1);

    const status = await (await call("GET", `/api/agent/plans/${created.id}`, { token: OWNER_TOKEN })).json() as Record<string, unknown>;
    expect(status.title).toBe("Service rollout plan");
    expect(status.status).toBe("open");
    expect(status.current_version).toBe(1);
    expect((status.versions as unknown[]).length).toBe(1);

    expect(status.raw_url).toBe(`${BASE}/p/${created.id}/md`);

    const list = await (await call("GET", "/api/agent/plans", { token: OWNER_TOKEN })).json() as { plans: { id: string; raw_url: string }[] };
    expect(list.plans.map((p) => p.id)).toEqual([created.id]);
    expect(list.plans[0]!.raw_url).toBe(`${BASE}/p/${created.id}/md`);
  });

  test("rejects missing/invalid auth and hides plans from other tokens", async () => {
    const created = await createPlan();
    expect((await call("POST", "/api/agent/plans", { body: { title: "x", markdown: "y" } })).status).toBe(401);
    expect((await call("GET", `/api/agent/plans/${created.id}`, { token: "msp_wrong" })).status).toBe(401);
    // Another user's valid token cannot see or update the plan.
    expect((await call("GET", `/api/agent/plans/${created.id}`, { token: STRANGER_TOKEN })).status).toBe(404);
    expect(
      (await call("PUT", `/api/agent/plans/${created.id}`, { token: STRANGER_TOKEN, body: { markdown: "hijack" } })).status,
    ).toBe(404);
  });

  test("requires a meaningful title", async () => {
    const res = await call("POST", "/api/agent/plans", { token: OWNER_TOKEN, body: { markdown: "hello" } });
    expect(res.status).toBe(400);
  });

  test("PUT publishes an immutable new version and resets approvals", async () => {
    const created = await createPlan();
    // Reviewer approves v1.
    const approve = await call("POST", `/api/plans/${created.id}/review`, {
      sid: REVIEWER_SID,
      body: { verdict: "approved", version: 1 },
    });
    expect(approve.status).toBe(200);
    let status = await (await call("GET", `/api/agent/plans/${created.id}`, { token: OWNER_TOKEN })).json() as Record<string, unknown>;
    expect(status.status).toBe("approved");

    const updated = await call("PUT", `/api/agent/plans/${created.id}`, {
      token: OWNER_TOKEN,
      body: { markdown: `${PLAN_MD}\n\n- phase three`, note: "v2: added phase three" },
    });
    expect(updated.status).toBe(200);
    expect(((await updated.json()) as { version: number }).version).toBe(2);

    status = await (await call("GET", `/api/agent/plans/${created.id}`, { token: OWNER_TOKEN })).json() as Record<string, unknown>;
    expect(status.status).toBe("open"); // approval was for v1
    expect(status.current_version).toBe(2);
    // v1 markdown unchanged
    const v1 = db.query("SELECT markdown FROM plan_versions WHERE plan_id=? AND version=1").get(created.id) as { markdown: string };
    expect(v1.markdown).toBe(PLAN_MD);
  });
});

async function mintKey(permissions: string[], name = "Oracle") {
  const response = await call("POST", "/api/tokens", { sid: OWNER_SID, body: { name, permissions } });
  expect(response.status).toBe(201);
  return ((await response.json()) as { token: { id: string; secret: string; permissions: string[] } }).token;
}

async function grantExistingReview() {
  const response = await call("PATCH", "/api/tokens/tok1", {
    sid: OWNER_SID, body: { permissions: [...AUTHOR_PERMISSIONS, "plans:review"] },
  });
  expect(response.status).toBe(200);
}

describe("key permissions", () => {
  test("existing credentials keep author access and can be upgraded in place without rotation", async () => {
    const plan = await createPlan();
    const original = db.query("SELECT id, hash, prefix, created_at FROM tokens WHERE id='tok1'").get();
    const initial = await call("GET", "/api/verify", { token: OWNER_TOKEN });
    expect(await initial.json()).toMatchObject({ token: { id: "tok1", name: "claude" }, permissions: AUTHOR_PERMISSIONS });
    expect((await call("POST", `/api/agent/plans/${plan.id}/review`, {
      token: OWNER_TOKEN, body: { version: 1, verdict: "approved" },
    })).status).toBe(403);
    await grantExistingReview();
    expect(db.query("SELECT id, hash, prefix, created_at FROM tokens WHERE id='tok1'").get()).toEqual(original);
    expect((await call("POST", `/api/agent/plans/${plan.id}/review`, {
      token: OWNER_TOKEN, body: { version: 1, verdict: "approved" },
    })).status).toBe(200);
    expect((await call("PUT", `/api/agent/plans/${plan.id}`, {
      token: OWNER_TOKEN, body: { markdown: "# Still an author" },
    })).status).toBe(200);
    const list = await (await call("GET", "/api/tokens", { sid: OWNER_SID })).json() as {
      tokens: { id: string; permissions: string[] }[]; permission_presets: unknown;
    };
    expect(list.tokens.find((t) => t.id === "tok1")!.permissions).toContain("plans:review");
    expect(list.permission_presets).toEqual(PERMISSION_PRESETS);
    expect(JSON.stringify(list)).not.toContain(OWNER_TOKEN);
    expect(JSON.stringify(list)).not.toContain("hash");
  });

  test("omitted permissions keep setup and old token-creation clients author-only", async () => {
    const response = await call("POST", "/api/tokens", { sid: OWNER_SID, body: { name: "cli" } });
    expect(response.status).toBe(201);
    const { token } = await response.json() as { token: { permissions: string[]; secret: string } };
    expect(token.permissions).toEqual(AUTHOR_PERMISSIONS);
    const verify = await call("GET", "/api/verify", { token: token.secret });
    expect(await verify.json()).toMatchObject({ permissions: AUTHOR_PERMISSIONS });
  });

  test("validates creation and updates without silently granting defaults", async () => {
    for (const permissions of [null, "plans:review", {}, ["*"], ["plans:delete"], ["plans:read", 1]]) {
      expect((await call("POST", "/api/tokens", { sid: OWNER_SID, body: { permissions } })).status).toBe(400);
      expect((await call("PATCH", "/api/tokens/tok1", { sid: OWNER_SID, body: { permissions } })).status).toBe(400);
    }
    expect((await call("PATCH", "/api/tokens/tok1", { sid: OWNER_SID, body: {} })).status).toBe(400);
    const key = await mintKey([]);
    expect((await call("GET", "/api/agent/plans", { token: key.secret })).status).toBe(403);
    expect(await (await call("GET", "/api/verify", { token: key.secret })).json()).toMatchObject({ permissions: [] });
    const duplicate = await mintKey(["plans:review", "plans:read", "plans:read"]);
    expect(duplicate.permissions).toEqual(["plans:read", "plans:review"]);
    db.query("UPDATE tokens SET permissions='invalid JSON' WHERE id=?").run(duplicate.id);
    expect((await call("GET", "/api/agent/plans", { token: duplicate.secret })).status).toBe(403);
  });

  for (const granted of ["plans:read", "plans:write", "plans:comment", "plans:resolve", "plans:review"]) {
    test(`enforces ${granted} independently on every agent action`, async () => {
      const plan = await createPlan();
      const comment = await (await call("POST", `/api/plans/${plan.id}/comments`, {
        sid: OWNER_SID, body: { body: "A thread", version: 1 },
      })).json() as { id: string };
      const key = await mintKey([granted]);
      const base = `/api/agent/plans/${plan.id}`;
      const routes = [
        { method: "GET", path: "/api/agent/plans", permission: "plans:read", status: 200 },
        { method: "POST", path: "/api/agent/plans", permission: "plans:write", body: { title: "New", markdown: "# New" }, status: 201 },
        { method: "GET", path: base, permission: "plans:read", status: 200 },
        { method: "PUT", path: base, permission: "plans:write", body: { markdown: "# Revision" }, status: 200 },
        { method: "GET", path: `${base}/comments`, permission: "plans:read", status: 200 },
        { method: "POST", path: `${base}/comments`, permission: "plans:comment", body: { body: "Feedback" }, status: 201 },
        { method: "POST", path: `${base}/comments/${comment.id}/resolve`, permission: "plans:resolve", body: {}, status: 200 },
        { method: "POST", path: `${base}/review`, permission: "plans:review", body: { version: 1, verdict: "approved" }, status: 200 },
      ];
      for (const route of routes) {
        const res = await call(route.method, route.path, { token: key.secret, body: route.body });
        expect(res.status).toBe(route.permission === granted ? route.status : 403);
        if (route.permission !== granted) expect(await res.json()).toMatchObject({ required_permission: route.permission });
      }
      expect((await call("DELETE", base, { token: key.secret })).status).toBe(404);
      expect((await call("POST", `${base}/review/extra`, { token: key.secret })).status).toBe(404);
      expect((await call("GET", "/api/agent/plans-suffix", { token: key.secret })).status).toBe(401);
    });
  }

  test("keys cannot mint, grant, revoke or use a session to bypass their permissions", async () => {
    const plan = await createPlan();
    for (const sid of [undefined, OWNER_SID]) {
      for (const [method, path] of [["GET", "/api/tokens"], ["POST", "/api/tokens"], ["PATCH", "/api/tokens/tok1"], ["DELETE", "/api/tokens/tok1"], ["POST", `/api/plans/${plan.id}/review`]]) {
        expect((await call(method!, path!, {
          token: OWNER_TOKEN, sid, body: method === "GET" ? undefined : { permissions: ["plans:review"], verdict: "approved", version: 1 },
        })).status).toBe(401);
      }
    }
    expect((await call("PATCH", "/api/tokens/tok1", {
      sid: REVIEWER_SID, body: { permissions: ["plans:review"] },
    })).status).toBe(404);
    expect((await call("PATCH", "/api/tokens/tok1", {
      sid: OWNER_SID, origin: "https://other.example", body: { permissions: ["plans:review"] },
    })).status).toBe(403);
    expect((await call("POST", "/api/tokens", {
      sid: OWNER_SID, origin: "https://other.example", body: { permissions: ["plans:review"] },
    })).status).toBe(403);
  });

  test("app bearers win over platform identities; identity alone never grants review", async () => {
    const plan = await createPlan();
    const key = await mintKey(["plans:read"]);
    const identity = { id: "plat-owner", email: "owner@example.com", name: "Owner" };
    expect((await call("POST", "/api/agent/plans", {
      token: key.secret, identity, body: { title: "No escalation", markdown: "# No" },
    })).status).toBe(403);
    for (const token of ["msp_invalid", "wrong-format", "", STRANGER_TOKEN]) {
      expect((await call("GET", `/api/agent/plans/${plan.id}`, { token, identity })).status).toBe(token === STRANGER_TOKEN ? 404 : 401);
    }
    await grantExistingReview();
    expect((await call("POST", `/api/agent/plans/${plan.id}/review`, {
      identity, body: { version: 1, verdict: "approved" },
    })).status).toBe(403); // Not upgraded just because another key of the user was.
    expect((await call("POST", `/api/agent/plans/${plan.id}/review`, {
      token: OWNER_TOKEN, identity, body: { version: 1, verdict: "approved" },
    })).status).toBe(200);
  });

  test("downgrades and revocation affect the next request without rotating secrets", async () => {
    const plan = await createPlan();
    const key = await mintKey(PERMISSION_PRESETS.oracle!);
    const review = () => call("POST", `/api/agent/plans/${plan.id}/review`, {
      token: key.secret, body: { version: 1, verdict: "approved" },
    });
    expect((await review()).status).toBe(200);
    await call("PATCH", `/api/tokens/${key.id}`, { sid: OWNER_SID, body: { permissions: ["plans:read"] } });
    expect((await review()).status).toBe(403);
    await call("DELETE", `/api/tokens/${key.id}`, { sid: OWNER_SID });
    expect((await review()).status).toBe(401);
    expect((await call("GET", "/api/agent/plans", {
      token: key.secret, identity: { id: "owner-user" },
    })).status).toBe(401);
    expect((await call("PATCH", `/api/tokens/${key.id}`, {
      sid: OWNER_SID, body: { permissions: ["plans:review"] },
    })).status).toBe(404);
    expect(db.query("SELECT verdict FROM agent_reviews WHERE token_id=?").get(key.id)).toEqual({ verdict: "approved" });
  });
});

describe("agent review flow", () => {
  test("Oracle reviews another key's plan, requests changes, then approves the revised version", async () => {
    const plan = await createPlan();
    const key = await mintKey(PERMISSION_PRESETS.oracle!);
    const feedback = await call("POST", `/api/agent/plans/${plan.id}/comments`, {
      token: key.secret, body: { body: "Add a rollback section." },
    });
    expect(feedback.status).toBe(201);
    const { id: commentId } = await feedback.json() as { id: string };
    let response = await call("POST", `/api/agent/plans/${plan.id}/review`, {
      token: key.secret, body: { version: 1, verdict: "changes_requested", note: "  Needs rollback  " },
    });
    expect(await response.json()).toMatchObject({ ok: true, version: 1, current_version: 1, status: "changes_requested" });
    await call("POST", `/api/agent/plans/${plan.id}/comments/${commentId}/resolve`, { token: OWNER_TOKEN, body: {} });
    let status = await (await call("GET", `/api/agent/plans/${plan.id}`, { token: OWNER_TOKEN })).json() as { status: string };
    expect(status.status).toBe("changes_requested"); // Resolving is not approval.
    response = await call("PUT", `/api/agent/plans/${plan.id}`, {
      token: OWNER_TOKEN, body: { markdown: "# Rollout\n\n## Rollback\n\nRestore the previous release." },
    });
    expect(await response.json()).toMatchObject({ version: 2, status: "open" });
    response = await call("POST", `/api/agent/plans/${plan.id}/review`, {
      token: key.secret, body: { version: 2, verdict: "approved", note: "Ready" },
    });
    expect(await response.json()).toMatchObject({ status: "approved", version: 2 });
    expect(db.query("SELECT version, verdict, note FROM agent_reviews ORDER BY version").all()).toEqual([
      { version: 1, verdict: "changes_requested", note: "Needs rollback" },
      { version: 2, verdict: "approved", note: "Ready" },
    ]);
    for (const [path, opts] of [["/api/agent/plans", { token: OWNER_TOKEN }], ["/api/plans", { sid: OWNER_SID }]] as const) {
      const list = await (await call("GET", path, opts)).json() as { plans: { status: string }[] };
      expect(list.plans[0]!.status).toBe("approved");
    }
    const raw = await (await call("GET", `/p/${plan.id}/md`)).text();
    expect(raw).toContain("status: approved");
    expect(raw).toContain("Agent · Oracle: approved — Ready");
    const viewer = await (await call("GET", `/api/plans/${plan.id}`, { sid: OWNER_SID })).json() as {
      plan: { status: string }; reviews: { author: { type: string; id: string }; mine: boolean }[]; my_review: unknown;
    };
    expect(viewer.plan.status).toBe("approved");
    expect(viewer.reviews[1]).toMatchObject({ author: { type: "agent", id: key.id }, mine: false });
    expect(viewer.my_review).toBeNull();
  });

  test("two agent keys and their human owner keep independent verdicts", async () => {
    const plan = await createPlan();
    await grantExistingReview();
    const second = await mintKey(PERMISSION_PRESETS.oracle!, "Second oracle");
    await call("POST", `/api/plans/${plan.id}/review`, { sid: OWNER_SID, body: { version: 1, verdict: "changes_requested" } });
    for (const token of [OWNER_TOKEN, second.secret, OWNER_TOKEN]) {
      const res = await call("POST", `/api/agent/plans/${plan.id}/review`, { token, body: { version: 1, verdict: "approved" } });
      expect(await res.json()).toMatchObject({ status: "changes_requested" });
    }
    const viewer = await (await call("GET", `/api/plans/${plan.id}`, { sid: OWNER_SID })).json() as {
      reviews: { author: { type: string }; mine: boolean }[]; my_review: { verdict: string };
    };
    expect(viewer.reviews).toHaveLength(3);
    expect(viewer.reviews.filter((r) => r.mine)).toHaveLength(1);
    expect(viewer.my_review.verdict).toBe("changes_requested");
    expect(viewer.reviews.filter((r) => r.author.type === "agent")).toHaveLength(2);
    await call("POST", `/api/plans/${plan.id}/review`, { sid: OWNER_SID, body: { version: 1, verdict: "approved" } });
    const changed = await call("POST", `/api/agent/plans/${plan.id}/review`, {
      token: second.secret, body: { version: 1, verdict: "changes_requested" },
    });
    expect(await changed.json()).toMatchObject({ status: "changes_requested" });
    expect(db.query("SELECT COUNT(*) n FROM agent_reviews").get()).toEqual({ n: 2 });
    expect((await call("DELETE", `/api/plans/${plan.id}`, { sid: OWNER_SID })).status).toBe(200);
    expect(db.query("SELECT COUNT(*) n FROM agent_reviews").get()).toEqual({ n: 0 });
  });

  test("review authority does not grant access to another account's plans or comments", async () => {
    const plan = await createPlan();
    db.query("UPDATE tokens SET permissions=? WHERE id='tok2'").run(JSON.stringify([...AUTHOR_PERMISSIONS, "plans:review"]));
    for (const [method, path, body] of [
      ["GET", `/api/agent/plans/${plan.id}`, undefined],
      ["GET", `/api/agent/plans/${plan.id}/comments`, undefined],
      ["POST", `/api/agent/plans/${plan.id}/comments`, { body: "No" }],
      ["POST", `/api/agent/plans/${plan.id}/review`, { version: 1, verdict: "approved" }],
      ["PUT", `/api/agent/plans/${plan.id}`, { markdown: "# No" }],
    ] as const) {
      expect((await call(method, path, { token: STRANGER_TOKEN, body })).status).toBe(404);
    }
    const list = await call("GET", "/api/agent/plans", { token: STRANGER_TOKEN });
    expect(await list.json() as { plans: unknown[] }).toEqual({ plans: [] });
  });

  test("requires a valid verdict and explicit integer version, and rejects stale/future versions", async () => {
    const plan = await createPlan();
    await grantExistingReview();
    for (const version of [undefined, null, "1", true, 1.5, 0, -1, {}, []]) {
      expect((await call("POST", `/api/agent/plans/${plan.id}/review`, {
        token: OWNER_TOKEN, body: { version, verdict: "approved" },
      })).status).toBe(400);
    }
    expect((await call("POST", `/api/agent/plans/${plan.id}/review`, {
      token: OWNER_TOKEN, body: { version: 1, verdict: "approve" },
    })).status).toBe(400);
    expect((await call("POST", `/api/agent/plans/${plan.id}/review`, {
      token: OWNER_TOKEN, body: { version: 2, verdict: "approved" },
    })).status).toBe(409);
    await call("PUT", `/api/agent/plans/${plan.id}`, { token: OWNER_TOKEN, body: { markdown: "# v2" } });
    const stale = await call("POST", `/api/agent/plans/${plan.id}/review`, {
      token: OWNER_TOKEN, body: { version: 1, verdict: "approved" },
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ current_version: 2 });
    expect(db.query("SELECT COUNT(*) n FROM agent_reviews").get()).toEqual({ n: 0 });
  });

  for (const type of ["user", "agent"] as const) {
    for (const timing of ["beforeRun", "afterRun"] as const) {
      test(`${type} review handles a concurrent revision ${timing}`, async () => {
        const plan = await createPlan();
        await grantExistingReview();
        const table = type === "agent" ? "agent_reviews" : "reviews";
        let armed = true;
        env.DB = d1(db, { [timing]: (sql: string) => {
          if (!armed || !sql.includes(`INSERT INTO ${table} (`)) return;
          armed = false;
          db.query("INSERT INTO plan_versions (plan_id,version,title,markdown,created_at) VALUES (?,2,'New','# New',?)").run(plan.id, Date.now());
          db.query("UPDATE plans SET current_version=2 WHERE id=?").run(plan.id);
        } });
        const response = await call("POST", `/api/${type === "agent" ? "agent/" : ""}plans/${plan.id}/review`, {
          ...(type === "agent" ? { token: OWNER_TOKEN } : { sid: OWNER_SID }),
          body: { version: 1, verdict: "approved" },
        });
        expect(response.status).toBe(timing === "beforeRun" ? 409 : 200);
        expect(await response.json()).toMatchObject({ current_version: 2, ...(timing === "afterRun" ? { version: 1, status: "open" } : {}) });
        expect(db.query(`SELECT COUNT(*) n FROM ${table}`).get()).toEqual({ n: timing === "beforeRun" ? 0 : 1 });
        const status = await (await call("GET", `/api/agent/plans/${plan.id}`, { token: OWNER_TOKEN })).json() as { status: string };
        expect(status.status).toBe("open");
      });
    }
  }
});

describe("review flow", () => {
  test("changes_requested wins over approvals; verdicts upsert per user", async () => {
    const created = await createPlan();
    await call("POST", `/api/plans/${created.id}/review`, { sid: REVIEWER_SID, body: { verdict: "approved", version: 1 } });
    await call("POST", `/api/plans/${created.id}/review`, {
      sid: REVIEWER2_SID,
      body: { verdict: "changes_requested", note: "phase two is vague", version: 1 },
    });
    let status = await (await call("GET", `/api/agent/plans/${created.id}`, { token: OWNER_TOKEN })).json() as { status: string; reviews: { verdict: string; by: string }[] };
    expect(status.status).toBe("changes_requested");
    expect(status.reviews.length).toBe(2);

    // Second reviewer changes their mind: upsert, not a second row.
    await call("POST", `/api/plans/${created.id}/review`, { sid: REVIEWER2_SID, body: { verdict: "approved", version: 1 } });
    status = await (await call("GET", `/api/agent/plans/${created.id}`, { token: OWNER_TOKEN })).json() as typeof status;
    expect(status.status).toBe("approved");
    expect(status.reviews.length).toBe(2);
  });

  test("rejects stale-version reviews", async () => {
    const created = await createPlan();
    await call("PUT", `/api/agent/plans/${created.id}`, { token: OWNER_TOKEN, body: { markdown: "# v2" } });
    const res = await call("POST", `/api/plans/${created.id}/review`, {
      sid: REVIEWER_SID,
      body: { verdict: "approved", version: 1 },
    });
    expect(res.status).toBe(409);
  });
});

describe("comments", () => {
  test("block comment → agent reply → resolve round-trip", async () => {
    const created = await createPlan();
    const blocks = renderPlan(PLAN_MD).blocks;
    const liBlock = blocks.find((b) => b.kind === "li")!;

    // Reviewer comments on a list item.
    const commented = await call("POST", `/api/plans/${created.id}/comments`, {
      sid: REVIEWER_SID,
      body: { body: "What happens between the phases?", block_id: liBlock.id, version: 1 },
    });
    expect(commented.status).toBe(201);
    const { id: commentId } = (await commented.json()) as { id: string };

    // Agent pulls comments and sees the block excerpt + author identity.
    const pulled = await (await call("GET", `/api/agent/plans/${created.id}/comments`, { token: OWNER_TOKEN })).json() as {
      comments: { id: string; author: { type: string; name: string }; block_id: string; block_excerpt: string; resolved: boolean }[];
    };
    expect(pulled.comments.length).toBe(1);
    expect(pulled.comments[0]!.author.type).toBe("user");
    expect(pulled.comments[0]!.block_id).toBe(liBlock.id);
    expect(pulled.comments[0]!.block_excerpt).toBe(liBlock.text);

    // Agent replies; reply is attributed to the agent and threaded.
    const replied = await call("POST", `/api/agent/plans/${created.id}/comments`, {
      token: OWNER_TOKEN,
      body: { body: "A one-week bake period.", reply_to: commentId },
    });
    expect(replied.status).toBe(201);

    // Agent resolves the thread.
    const resolved = await call("POST", `/api/agent/plans/${created.id}/comments/${commentId}/resolve`, {
      token: OWNER_TOKEN,
      body: {},
    });
    expect(resolved.status).toBe(200);

    // Viewer payload shows the thread attached to the block, agent reply included.
    const view = await (await call("GET", `/api/plans/${created.id}`, { sid: REVIEWER_SID })).json() as {
      comments: { id: string; parent_id: string | null; author: { type: string; name: string }; display_block_id: string | null; resolved: boolean }[];
    };
    expect(view.comments.length).toBe(2);
    const root = view.comments.find((c) => !c.parent_id)!;
    const reply = view.comments.find((c) => c.parent_id)!;
    expect(root.display_block_id).toBe(liBlock.id);
    expect(root.resolved).toBe(true);
    expect(reply.parent_id).toBe(root.id);
    expect(reply.author.type).toBe("agent");
    expect(reply.author.name).toBe("Agent · claude");
  });

  test("re-attaches block comments across versions by content hash", async () => {
    const created = await createPlan();
    const v1Blocks = renderPlan(PLAN_MD).blocks;
    const target = v1Blocks.find((b) => b.text === "phase two")!;
    await call("POST", `/api/plans/${created.id}/comments`, {
      sid: REVIEWER_SID,
      body: { body: "needs detail", block_id: target.id, version: 1 },
    });

    // v2 inserts a block before the list, shifting indexes.
    const v2md = "# Rollout\n\nNew intro paragraph.\n\nWe ship in two phases.\n\n- phase one\n- phase two";
    await call("PUT", `/api/agent/plans/${created.id}`, { token: OWNER_TOKEN, body: { markdown: v2md } });

    const view = await (await call("GET", `/api/plans/${created.id}`, { sid: REVIEWER_SID })).json() as {
      blocks: { id: string; text: string }[];
      comments: { display_block_id: string | null; version: number }[];
    };
    const moved = view.blocks.find((b) => b.text === "phase two")!;
    expect(view.comments[0]!.version).toBe(1);
    expect(view.comments[0]!.display_block_id).toBe(moved.id);
    expect(moved.id).not.toBe(target.id); // index moved, hash matched

    // A comment on a block that disappeared becomes general (null anchor).
    const gone = renderPlan(v2md).blocks.find((b) => b.text === "New intro paragraph.")!;
    await call("POST", `/api/plans/${created.id}/comments`, {
      sid: REVIEWER_SID,
      body: { body: "drop this", block_id: gone.id, version: 2 },
    });
    await call("PUT", `/api/agent/plans/${created.id}`, { token: OWNER_TOKEN, body: { markdown: PLAN_MD } });
    const after = await (await call("GET", `/api/plans/${created.id}`, { sid: REVIEWER_SID })).json() as {
      comments: { body?: string; display_block_id: string | null }[];
    };
    const orphan = after.comments.find((c) => (c as { body: string }).body === "drop this")!;
    expect(orphan.display_block_id).toBeNull();
  });

  test("validates block ids and rejects unknown blocks", async () => {
    const created = await createPlan();
    expect(
      (await call("POST", `/api/plans/${created.id}/comments`, {
        sid: REVIEWER_SID,
        body: { body: "x", block_id: "nonsense", version: 1 },
      })).status,
    ).toBe(400);
    expect(
      (await call("POST", `/api/plans/${created.id}/comments`, {
        sid: REVIEWER_SID,
        body: { body: "x", block_id: "99-deadbeef", version: 1 },
      })).status,
    ).toBe(400);
  });

  test("comment deletion is limited to the author or plan owner", async () => {
    const created = await createPlan();
    const { id: commentId } = await (await call("POST", `/api/plans/${created.id}/comments`, {
      sid: REVIEWER_SID,
      body: { body: "mine", version: 1 },
    })).json() as { id: string };
    // Another reviewer cannot delete it.
    expect((await call("DELETE", `/api/plans/${created.id}/comments/${commentId}`, { sid: REVIEWER2_SID })).status).toBe(403);
    // The plan owner can.
    expect((await call("DELETE", `/api/plans/${created.id}/comments/${commentId}`, { sid: OWNER_SID })).status).toBe(200);
  });
});

describe("viewer API and pages", () => {
  test("requires a session and serves any signed-in user", async () => {
    const created = await createPlan();
    expect((await call("GET", `/api/plans/${created.id}`)).status).toBe(401);
    const view = await (await call("GET", `/api/plans/${created.id}`, { sid: REVIEWER_SID })).json() as {
      plan: { title: string; is_owner: boolean; owner: string };
      html: string;
      blocks: unknown[];
    };
    expect(view.plan.title).toBe("Service rollout plan");
    expect(view.plan.is_owner).toBe(false);
    expect(view.plan.owner).toBe("Owner");
    expect(view.html).toContain("data-block-id=");
    expect(view.blocks.length).toBe(renderPlan(PLAN_MD).blocks.length);
  });

  test("serves version diffs", async () => {
    const created = await createPlan();
    await call("PUT", `/api/agent/plans/${created.id}`, {
      token: OWNER_TOKEN,
      body: { markdown: PLAN_MD.replace("two phases", "three phases") + "\n\n- phase three" },
    });
    const diff = await (await call("GET", `/api/plans/${created.id}/diff?from=1&to=2`, { sid: REVIEWER_SID })).json() as {
      parts: { type: string }[];
    };
    expect(diff.parts.some((p) => p.type === "changed")).toBe(true);
    expect(diff.parts.some((p) => p.type === "added")).toBe(true);
    expect((await call("GET", `/api/plans/${created.id}/diff?from=1&to=9`, { sid: REVIEWER_SID })).status).toBe(400);
  });

  test("owner-only deletion removes the plan and its data", async () => {
    const created = await createPlan();
    await call("POST", `/api/plans/${created.id}/comments`, { sid: REVIEWER_SID, body: { body: "hi", version: 1 } });
    expect((await call("DELETE", `/api/plans/${created.id}`, { sid: REVIEWER_SID })).status).toBe(403);
    expect((await call("DELETE", `/api/plans/${created.id}`, { sid: OWNER_SID })).status).toBe(200);
    expect((await call("GET", `/api/plans/${created.id}`, { sid: REVIEWER_SID })).status).toBe(404);
    expect(db.query("SELECT COUNT(*) AS n FROM comments").get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM plan_versions").get()).toEqual({ n: 0 });
  });

  test("serves the viewer shell, dashboard, skill and setup script", async () => {
    const created = await createPlan();
    const page = await call("GET", `/p/${created.id}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("plans.myslop.app");
    expect((await call("GET", "/dashboard")).status).toBe(200);
    expect((await call("GET", "/skill.md")).status).toBe(200);
    const setup = await call("GET", "/setup.sh");
    expect(setup.status).toBe(200);
    expect(await setup.text()).toContain("MYSLOP_PLANS_TOKEN");
    const skill = await (await call("GET", "/skill")).text();
    expect(skill).toContain("plan-review");
  });

  test("serves raw markdown at /md unauthenticated; .md redirects", async () => {
    const created = await createPlan();

    // Legacy .md form redirects to the canonical /md, preserving the query.
    const legacy = await call("GET", `/p/${created.id}.md?v=1`);
    expect(legacy.status).toBe(301);
    expect(legacy.headers.get("location")).toBe(`${BASE}/p/${created.id}/md?v=1`);

    // Plain mode returns the stored markdown untouched.
    const plain = await call("GET", `/p/${created.id}/md?plain=1`);
    expect(plain.status).toBe(200);
    expect(plain.headers.get("content-type")).toContain("text/markdown");
    expect(await plain.text()).toBe(PLAN_MD);

    // Default mode prefixes YAML frontmatter, then the full plan.
    const bare = await (await call("GET", `/p/${created.id}/md`)).text();
    expect(bare.startsWith("---\n")).toBe(true);
    // Blank line separates the closing --- from the document.
    expect(bare).toContain(`\n---\n\n${PLAN_MD}`);
    expect(bare).toContain(`id: ${created.id}`);
    expect(bare).toContain("status: open");
    expect(bare).toContain("open_comment_threads: 0");

    // After publishing v2, the bare URL serves the current version and ?v pins one.
    await call("PUT", `/api/agent/plans/${created.id}`, { token: OWNER_TOKEN, body: { markdown: "# v2" } });
    const current = await call("GET", `/p/${created.id}/md?plain=1`);
    expect(await current.text()).toBe("# v2");
    expect(current.headers.get("x-plan-version")).toBe("2");
    const pinned = await call("GET", `/p/${created.id}/md?v=1&plain=1`);
    expect(await pinned.text()).toBe(PLAN_MD);
    expect(pinned.headers.get("x-plan-version")).toBe("1");

    expect((await call("GET", `/p/${created.id}/md?v=9`)).status).toBe(404);
    expect((await call("GET", `/p/${created.id}/md?v=abc`)).status).toBe(404);
    expect((await call("GET", "/p/0123456789/md")).status).toBe(404);
    expect((await call("POST", `/p/${created.id}/md`)).status).toBe(405);
  });

  test("raw markdown carries metadata frontmatter, not comment bodies", async () => {
    const created = await createPlan();
    const blocks = renderPlan(PLAN_MD).blocks;
    const li = blocks.find((b) => b.text === "phase two")!;

    const commented = await call("POST", `/api/plans/${created.id}/comments`, {
      sid: REVIEWER_SID,
      body: { body: "What happens between the phases?", block_id: li.id, version: 1 },
    });
    const { id: commentId } = (await commented.json()) as { id: string };
    await call("POST", `/api/plans/${created.id}/comments`, {
      sid: REVIEWER_SID,
      body: { body: "Please add a rollback section.", version: 1 },
    });
    await call("POST", `/api/plans/${created.id}/review`, {
      sid: REVIEWER_SID,
      body: { verdict: "changes_requested", note: "phases need detail", version: 1 },
    });

    const raw = await (await call("GET", `/p/${created.id}/md`)).text();
    expect(raw.startsWith("---\n")).toBe(true);
    expect(raw).toContain('title: "Service rollout plan"');
    expect(raw).toContain('author: "Owner"');
    expect(raw).toContain("status: changes_requested");
    expect(raw).toContain("version: 1");
    expect(raw).toContain("open_comment_threads: 2");
    expect(raw).toContain('- "Reviewer: requested changes — phases need detail"');
    expect(raw).toContain(PLAN_MD);
    // Comment bodies live behind the comments API, not in the document.
    expect(raw).not.toContain("What happens between the phases?");
    expect(raw).not.toContain("Please add a rollback section.");
    // Plain mode: no frontmatter at all.
    expect(await (await call("GET", `/p/${created.id}/md?plain=1`)).text()).toBe(PLAN_MD);

    // Resolving a thread updates the counts.
    await call("POST", `/api/agent/plans/${created.id}/comments/${commentId}/resolve`, {
      token: OWNER_TOKEN,
      body: {},
    });
    const afterResolve = await (await call("GET", `/p/${created.id}/md`)).text();
    expect(afterResolve).toContain("open_comment_threads: 1");
    expect(afterResolve).toContain("resolved_comment_threads: 1");
  });

  test("cross-origin mutations are rejected", async () => {
    const created = await createPlan();
    const res = (await worker.fetch(
      new Request(`${BASE}/api/plans/${created.id}/comments`, {
        method: "POST",
        headers: { cookie: `sid=${REVIEWER_SID}`, origin: "https://evil.example", "content-type": "application/json" },
        body: JSON.stringify({ body: "x", version: 1 }),
      }) as never,
      env as never,
      context(),
    )) as unknown as Response;
    expect(res.status).toBe(403);
  });
});
