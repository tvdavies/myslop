import { expect, test } from "bun:test";
import { deriveAppInternalSecret, signInternalRequest, verifyInternalRequest } from "../src/internal";
import { internalDispatchSecret } from "../src/runtime";

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
