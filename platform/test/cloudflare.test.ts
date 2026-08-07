import { describe, expect, spyOn, test } from "bun:test";
import { attachCustomDomain, uploadUserWorker } from "../src/cloudflare";
import type { ResolvedManifest } from "../src/manifest";
import type { AppRow, Env } from "../src/types";

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

describe("dispatch Worker upload", () => {
  test("uses the single-step Durable Object migration shape", async () => {
    let metadata: Record<string, unknown> = {};
    const implementation = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const form = init?.body as FormData;
      metadata = JSON.parse(String(form.get("metadata")));
      return Response.json({ success: true, result: {} });
    }) as unknown as typeof fetch;
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(implementation);
    try {
      const manifest: ResolvedManifest = {
        version: 1,
        assets: false,
        worker: true,
        capabilities: {
          database: false,
          files: false,
          secrets: [],
          network: [],
          email: false,
          schedules: [],
          durableObjects: [{ className: "InboxHub", binding: "INBOX_HUB" }],
        },
      };
      await uploadUserWorker({
        CLOUDFLARE_ACCOUNT_ID: "account",
        CLOUDFLARE_API_TOKEN: "token",
      } as Env, {
        source: "export default {}; export class InboxHub {}",
        app: { id: "app-id", slug: "mail" } as AppRow,
        workerName: "mail-v1",
        manifest,
      });
      expect(metadata.migrations).toEqual({
        new_tag: "vmail-v1",
        new_sqlite_classes: ["InboxHub"],
      });
    } finally {
      fetchMock.mockRestore();
    }
  });
});
