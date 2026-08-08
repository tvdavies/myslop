import { expect, test } from "bun:test";
import { acceptEmail } from "../src/runtime";

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
