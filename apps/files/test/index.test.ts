import { describe, expect, test } from "bun:test";
import worker from "../src/index";

const encoder = new TextEncoder();

function database(metadata: { user_id?: string; private?: number } | null = null) {
  return {
    prepare() {
      return {
        bind() { return this; },
        first: async () => metadata,
        run: async () => ({ success: true }),
      };
    },
  };
}

function context() {
  return { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
}

async function appToken(appId: string, secret: string): Promise<string> {
  const body = btoa(JSON.stringify({ appId, exp: Date.now() + 60_000 })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
  let binary = "";
  for (const byte of signature) binary += String.fromCharCode(byte);
  return `${body}.${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

describe("Files app compatibility", () => {
  test("streams public objects with immutable and sandbox headers", async () => {
    const body = new ReadableStream({ start(controller) { controller.enqueue(encoder.encode("<script>ok</script>")); controller.close(); } });
    const env = {
      DB: database(),
      EVENTS_SECRET: "secret",
      FILES: {
        get: async () => ({
          body,
          httpEtag: '"etag"',
          writeHttpMetadata(headers: Headers) { headers.set("content-type", "text/html"); },
        }),
      },
    };
    const response = await worker.fetch(new Request("https://files.myslop.app/abc/index.html") as never, env as never, context()) as unknown as Response;
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(await response.text()).toBe("<script>ok</script>");
  });

  test("preserves scoped app-upload HMAC and streams the request body", async () => {
    let uploaded: { key: string; body: ReadableStream | null } | null = null;
    const env = {
      DB: database(),
      EVENTS_SECRET: "shared-secret",
      FILES: {
        put: async (key: string, body: ReadableStream | null) => {
          uploaded = { key, body };
          return { size: 5, httpMetadata: { contentType: "text/plain" } };
        },
      },
    };
    const token = await appToken("events", env.EVENTS_SECRET);
    const response = await worker.fetch(new Request("https://files.myslop.app/app-upload/report.txt", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "text/plain", origin: "https://demo.myslop.app" },
      body: "hello",
    }) as never, env as never, context()) as unknown as Response;
    expect(response.status).toBe(201);
    const stored = uploaded as { key: string; body: ReadableStream | null } | null;
    expect(stored).not.toBeNull();
    expect(stored!.key).toMatch(/^app\/events\/[a-f0-9]{10}\/report\.txt$/);
    expect(stored!.body).toBeInstanceOf(ReadableStream);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://demo.myslop.app");
  });

  test("keeps private files hidden without the owner session", async () => {
    const env = { DB: database({ user_id: "owner", private: 1 }), EVENTS_SECRET: "secret", FILES: { get: async () => { throw new Error("must not load private object"); } } };
    const response = await worker.fetch(new Request("https://files.myslop.app/private.txt") as never, env as never, context()) as unknown as Response;
    expect(response.status).toBe(404);
  });
});
