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
