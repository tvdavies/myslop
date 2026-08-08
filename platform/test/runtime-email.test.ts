import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { acceptEmail, RETRYABLE_EMAILS_SQL } from "../src/runtime";

const encoder = new TextEncoder();

function database() {
  return {
    prepare() {
      return {
        bind() { return this; },
        first: async () => null,
        run: async () => ({ success: true }),
      };
    },
  };
}

test("inbound email spooling gives R2 a known-length body", async () => {
  let stored: ArrayBuffer | null = null;
  let metadata: Record<string, string> | undefined;
  const env = {
    CONTROL_DB: database(),
    MAIL_SPOOL: {
      put: async (_key: string, value: ArrayBuffer, options: { customMetadata?: Record<string, string> }) => {
        stored = value;
        metadata = options.customMetadata;
      },
    },
  };
  const message = {
    from: "sender@example.com",
    to: "inbox@myslop.app",
    headers: new Headers({ "message-id": "message-1" }),
    raw: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("Subject: Test\r\n\r\nHello"));
        controller.close();
      },
    }),
    rawSize: 22,
    setReject() {},
    forward: async () => {},
    reply: async () => {},
  };

  expect(await acceptEmail(message as never, env as never)).toBe("spooled");
  expect(stored).toBeInstanceOf(ArrayBuffer);
  expect(new TextDecoder().decode(stored!)).toBe("Subject: Test\r\n\r\nHello");
  expect(metadata).toEqual({
    sender: "sender@example.com",
    recipient: "inbox@myslop.app",
    messageId: "message-1",
    appId: "",
  });
});

test("email retries bind an unassigned delivery to the selected email app", () => {
  const database = new Database(":memory:");
  try {
    database.exec(`
      CREATE TABLE apps (
        id TEXT PRIMARY KEY, slug TEXT NOT NULL, active_version INTEGER,
        archived_at INTEGER
      );
      CREATE TABLE deployments (
        app_id TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL,
        worker_name TEXT NOT NULL, manifest_json TEXT NOT NULL,
        internal_secret_version INTEGER NOT NULL
      );
      CREATE TABLE email_deliveries (
        id TEXT PRIMARY KEY, app_id TEXT, sender TEXT NOT NULL, recipient TEXT NOT NULL,
        spool_key TEXT NOT NULL, attempts INTEGER NOT NULL, status TEXT NOT NULL,
        next_attempt_at INTEGER NOT NULL
      );
      INSERT INTO apps VALUES ('app-mail','mail',4,NULL);
      INSERT INTO deployments VALUES (
        'app-mail',4,'active','mail-worker',
        '{"capabilities":{"email":true}}',2
      );
      INSERT INTO email_deliveries VALUES (
        'delivery-1',NULL,'sender@example.com','inbox@myslop.app',
        'pending/delivery-1.eml',0,'pending',1
      );
    `);
    expect(database.query(RETRYABLE_EMAILS_SQL).get(2)).toMatchObject({
      id: "delivery-1",
      app_id: "app-mail",
      internal_secret_version: 2,
    });
  } finally {
    database.close();
  }
});
