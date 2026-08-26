import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import worker from "../src/index";
import { renderPlan } from "../src/markdown";

// --- D1 shim over bun:sqlite ---

function d1(db: Database) {
  return {
    prepare(sql: string) {
      let values: unknown[] = [];
      const stmt = {
        bind(...bound: unknown[]) {
          values = bound;
          return stmt;
        },
        first: async <T>() => (db.query(sql).get(...(values as never[])) as T | null) ?? null,
        all: async <T>() => ({ results: db.query(sql).all(...(values as never[])) as T[] }),
        run: async () => {
          const result = db.query(sql).run(...(values as never[]));
          return { success: true, meta: { changes: result.changes } };
        },
      };
      return stmt;
    },
  };
}

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
  opts: { token?: string; sid?: string; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
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

    const list = await (await call("GET", "/api/agent/plans", { token: OWNER_TOKEN })).json() as { plans: { id: string }[] };
    expect(list.plans.map((p) => p.id)).toEqual([created.id]);
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
