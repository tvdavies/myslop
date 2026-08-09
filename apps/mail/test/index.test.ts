import { describe, expect, test } from "bun:test";
import worker from "../src/index";
import { sha256Hex } from "../../../platform/src/core";
import { signInternalRequest } from "../../../platform/src/internal";

function context(pending: Promise<unknown>[]) {
  return {
    waitUntil(promise: Promise<unknown>) { pending.push(promise); },
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
}

async function signedRequest(path: string, body: string, secret: string, headers: HeadersInit = {}): Promise<Request> {
  const bytes = new TextEncoder().encode(body);
  const bodyHash = await sha256Hex(bytes);
  const signature = await signInternalRequest(secret, "POST", path, bodyHash);
  return new Request(`https://mail.myslop.app${path}`, {
    method: "POST",
    headers: {
      ...headers,
      "x-myslop-body-sha256": bodyHash,
      "x-myslop-internal-timestamp": signature.timestamp,
      "x-myslop-internal-nonce": signature.nonce,
      "x-myslop-internal-signature": signature.signature,
    },
    body,
  });
}

describe("Mail platform adapters", () => {
  test("rejects unsigned internal routes", async () => {
    const response = await worker.fetch(
      new Request("https://mail.myslop.app/__scheduled", { method: "POST" }) as never,
      { MYSLOP_INTERNAL_SECRET: "secret" } as never,
      context([]),
    ) as unknown as Response;
    expect(response.status).toBe(404);
  });

  test("stores internal email idempotently under the existing R2 key layout", async () => {
    const objects = new Map<string, string>();
    const pending: Promise<unknown>[] = [];
    const env = {
      MYSLOP_INTERNAL_SECRET: "secret",
      DB: {
        prepare() {
          return { bind() { return this; }, run: async () => ({ success: true }) };
        },
      },
      FILES: {
        head: async (key: string) => objects.has(key) ? {} : null,
        put: async (key: string, value: string) => { objects.set(key, value); },
      },
      INBOX_HUB: {
        idFromName: (name: string) => name,
        get: () => ({ fetch: async () => new Response("ok") }),
      },
    };
    const raw = "From: Sender <sender@example.com>\r\nTo: demo@myslop.app\r\nSubject: Hello\r\n\r\nVisit https://example.com/verify";
    const request = await signedRequest("/__email", raw, env.MYSLOP_INTERNAL_SECRET, {
      "content-type": "message/rfc822",
      "x-myslop-delivery-id": "delivery-1",
      "x-myslop-mail-from": "sender@example.com",
      "x-myslop-rcpt-to": "demo@myslop.app",
    });
    const first = await worker.fetch(request as never, env as never, context(pending)) as unknown as Response;
    expect(first.status).toBe(201);
    await Promise.all(pending);
    expect(objects.has("inbox/demo/delivery-1.json")).toBe(true);
    expect(JSON.parse(objects.get("inbox/demo/delivery-1.json")!).links).toEqual(["https://example.com/verify"]);

    const duplicateRequest = await signedRequest("/__email", raw, env.MYSLOP_INTERNAL_SECRET, {
      "content-type": "message/rfc822",
      "x-myslop-delivery-id": "delivery-1",
      "x-myslop-mail-from": "sender@example.com",
      "x-myslop-rcpt-to": "demo@myslop.app",
    });
    const duplicate = await worker.fetch(duplicateRequest as never, env as never, context([])) as unknown as Response;
    expect(duplicate.status).toBe(200);
    expect((await duplicate.json() as { duplicate?: boolean }).duplicate).toBe(true);
  });
});

test("Mail accepts only a valid platform identity assertion for its app", async () => {
  const { Database } = await import("bun:sqlite");
  const { signIdentityAssertion } = await import("../../../platform/src/identity-assertion");
  const db = new Database(":memory:");
  try {
    db.exec(await Bun.file(new URL("../schema.sql", import.meta.url)).text());
    db.query("INSERT INTO users (id,email,name,picture,identity_id,created_at) VALUES (?,?,?,?,?,?)")
      .run("legacy-mail", "owner@example.com", "Owner", null, "mui_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 1);
    const DB = {
      prepare(sql: string) {
        let values: unknown[] = [];
        return {
          bind(...bound: unknown[]) { values = bound; return this; },
          first: async <T>() => db.query(sql).get(...values as never[]) as T | null,
          all: async <T>() => ({ results: db.query(sql).all(...values as never[]) as T[] }),
          run: async () => { const result = db.query(sql).run(...values as never[]); return { success: true, meta: { changes: result.changes } }; },
        };
      },
      batch: async (statements: Array<{ run(): Promise<unknown> }>) => Promise.all(statements.map((statement) => statement.run())),
    };
    const request = new Request("https://mail.myslop.app/api/me");
    const assertion = await signIdentityAssertion("identity-secret", request, {
      aud: "app-mail", sub: "mui_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", uid: "platform-user",
      email: "owner@example.com", email_verified: true, name: "Owner", role: "owner", sg: 1,
    });
    const response = await worker.fetch(new Request(request, { headers: { "x-myslop-identity": assertion } }) as never, {
      DB, FILES: {}, INBOX_HUB: {}, MYSLOP_INTERNAL_SECRET: "internal", MYSLOP_APP_ID: "app-mail",
      MYSLOP_IDENTITY_KEYS: JSON.stringify({ 1: "identity-secret" }), MYSLOP_IDENTITY_LINK_DEADLINE: String(Date.now() + 60_000),
    } as never, context([])) as unknown as Response;
    expect(response.status).toBe(200);
    const payload = await response.json() as { user: { id: string } };
    expect(payload.user.id).toBe("legacy-mail");
  } finally {
    db.close();
  }
});
