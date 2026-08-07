import { describe, expect, spyOn, test } from "bun:test";
import { attachCustomDomain } from "../src/cloudflare";
import type { Env } from "../src/types";

describe("custom domain cutover", () => {
  test("explicitly overrides the standalone Worker origin", async () => {
    let requestBody: Record<string, unknown> = {};
    const implementation = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({ success: true, result: { id: "domain-id" } });
    }) as unknown as typeof fetch;
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(implementation);
    try {
      const result = await attachCustomDomain({
        CLOUDFLARE_ACCOUNT_ID: "account",
        CLOUDFLARE_API_TOKEN: "token",
      } as Env, "files.myslop.app");
      expect(result).toEqual({ id: "domain-id" });
      expect(requestBody).toEqual({
        hostname: "files.myslop.app",
        service: "myslop-apps",
        zone_name: "myslop.app",
        override_existing_origin: true,
      });
    } finally {
      fetchMock.mockRestore();
    }
  });
});
