import { expect, test } from "bun:test";
import { deriveAppInternalSecret, signInternalRequest, verifyInternalRequest } from "../src/internal";
import { dispatchInternal, internalDispatchSecret } from "../src/runtime";
import type { Env } from "../src/types";

test("internal dispatch credentials are isolated per app", async () => {
  const first = await deriveAppInternalSecret("platform-master", "app-1");
  const second = await deriveAppInternalSecret("platform-master", "app-2");
  expect(first).not.toBe(second);
  expect(await internalDispatchSecret("platform-master", "app-1", 1)).toBe("platform-master");
  expect(await internalDispatchSecret("platform-master", "app-1", 2)).toBe(first);

  const signed = await signInternalRequest(first, "POST", "/__scheduled", "body-hash", 1_800_000_000_000);
  const headers = new Headers({
    "x-myslop-internal-timestamp": signed.timestamp,
    "x-myslop-internal-nonce": signed.nonce,
    "x-myslop-internal-signature": signed.signature,
  });
  expect(await verifyInternalRequest(first, "POST", "/__scheduled", "body-hash", headers, 1_800_000_000_000)).toBe(true);
  expect(await verifyInternalRequest(second, "POST", "/__scheduled", "body-hash", headers, 1_800_000_000_000)).toBe(false);
});

test("runtime dispatch derives credentials from the app id, not the delivery row id", async () => {
  const master = "platform-master";
  const appId = "app-1";
  const bodyHash = "body-hash";
  let verified = false;
  const env = {
    INTERNAL_DISPATCH_SECRET: master,
    DISPATCHER: {
      get() {
        return {
          async fetch(input: RequestInfo | URL, init?: RequestInit) {
            const url = new URL(String(input));
            verified = await verifyInternalRequest(
              await deriveAppInternalSecret(master, appId),
              "POST",
              url.pathname,
              bodyHash,
              new Headers(init?.headers),
            );
            return new Response(null, { status: verified ? 204 : 401 });
          },
        };
      },
    },
  } as unknown as Env;

  const response = await dispatchInternal(
    env,
    {
      app_id: appId,
      slug: "mail",
      worker_name: "mail-worker",
      active_version: 1,
      internal_secret_version: 2,
    },
    JSON.stringify({
      version: 1,
      assets: false,
      worker: true,
      capabilities: {
        database: false,
        files: false,
        secrets: [],
        network: [],
        email: true,
        identity: false,
        schedules: [],
        durableObjects: [],
      },
    }),
    "/__email",
    new ArrayBuffer(0),
    bodyHash,
  );

  expect(response.status).toBe(204);
  expect(verified).toBe(true);
});

test("identity assertions are audience, request, body, and time bound", async () => {
  const { signIdentityAssertion, verifyIdentityAssertion } = await import("../src/identity-assertion");
  const secret = "app-identity-secret";
  const request = new Request("https://files.myslop.app/api/tokens?view=all", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const assertion = await signIdentityAssertion(secret, request, {
    aud: "app-files",
    sub: "mui_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    uid: "legacy-files-user",
    email: "owner@example.com",
    email_verified: true,
    role: "owner",
    sg: 2,
  }, { now: 1_800_000_000_000, bodyHash: "a".repeat(64) });

  expect(await verifyIdentityAssertion(secret, assertion, request, "app-files", {
    now: 1_800_000_010_000,
    bodyHash: "a".repeat(64),
  })).toMatchObject({ sub: "mui_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", aud: "app-files", sg: 2 });
  expect(await verifyIdentityAssertion(secret, assertion, request, "app-mail", {
    now: 1_800_000_010_000,
    bodyHash: "a".repeat(64),
  })).toBeNull();
  expect(await verifyIdentityAssertion(secret, assertion, new Request("https://files.myslop.app/api/files", { method: "POST" }), "app-files", {
    now: 1_800_000_010_000,
    bodyHash: "a".repeat(64),
  })).toBeNull();
  expect(await verifyIdentityAssertion(secret, assertion, request, "app-files", {
    now: 1_800_000_040_000,
    bodyHash: "a".repeat(64),
  })).toBeNull();
});

test("identity assertion key rotation overlaps and then retires the previous key", async () => {
  const { signIdentityAssertion, verifyIdentityAssertion } = await import("../src/identity-assertion");
  const request = new Request("https://files.myslop.app/api/me");
  const claims = {
    aud: "app-files", sub: "mui_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", uid: "legacy-files-user",
    email: "owner@example.com", email_verified: true as const, role: "owner" as const, sg: 2,
  };
  const oldAssertion = await signIdentityAssertion("old-key", request, claims, { keyVersion: 4 });
  const newAssertion = await signIdentityAssertion("new-key", request, claims, { keyVersion: 5 });
  const overlap = { 4: "old-key", 5: "new-key" };
  expect(await verifyIdentityAssertion(overlap, oldAssertion, request, "app-files")).not.toBeNull();
  expect(await verifyIdentityAssertion(overlap, newAssertion, request, "app-files")).not.toBeNull();
  expect(await verifyIdentityAssertion({ 5: "new-key" }, oldAssertion, request, "app-files")).toBeNull();
});
