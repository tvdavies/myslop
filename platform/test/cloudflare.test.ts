import { describe, expect, spyOn, test } from "bun:test";
import { attachCustomDomain, customDomainOwner, uploadUserWorker } from "../src/cloudflare";
import type { ResolvedManifest } from "../src/manifest";
import type { AppRow, Env } from "../src/types";

describe("custom domain allocation", () => {
  test("fails closed on an existing origin by default", async () => {
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
        override_existing_origin: false,
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  test("requires an explicit override for reviewed cutovers and selects the cloud zone", async () => {
    let requestBody: Record<string, unknown> = {};
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation((async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({ success: true, result: { id: "cloud-domain" } });
    }) as typeof fetch);
    try {
      await attachCustomDomain({
        CLOUDFLARE_ACCOUNT_ID: "account",
        CLOUDFLARE_API_TOKEN: "token",
      } as Env, "myslop.cloud", { overrideExistingOrigin: true });
      expect(requestBody).toMatchObject({
        hostname: "myslop.cloud",
        zone_name: "myslop.cloud",
        override_existing_origin: true,
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  test("detects exact Worker domain collisions before allocation", async () => {
    const implementation = (async () => Response.json({
      success: true,
      result: [{ hostname: "events.myslop.app", service: "myslop-events" }],
    })) as unknown as typeof fetch;
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(implementation);
    try {
      expect(await customDomainOwner({
        CLOUDFLARE_ACCOUNT_ID: "account",
        CLOUDFLARE_API_TOKEN: "token",
      } as Env, "events.myslop.app")).toBe("myslop-events");
      expect(await customDomainOwner({
        CLOUDFLARE_ACCOUNT_ID: "account",
        CLOUDFLARE_API_TOKEN: "token",
      } as Env, "available.myslop.app")).toBeNull();
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
          identity: false,
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

describe("identity Worker binding", () => {
  test("provisions a domain-separated per-app identity secret", async () => {
    let bindings: Array<Record<string, unknown>> = [];
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation((async (_input, init) => {
      const metadata = JSON.parse(String((init?.body as FormData).get("metadata"))) as { bindings: Array<Record<string, unknown>> };
      bindings = metadata.bindings;
      return Response.json({ success: true, result: {} });
    }) as typeof fetch);
    try {
      await uploadUserWorker({
        CLOUDFLARE_ACCOUNT_ID: "account",
        CLOUDFLARE_API_TOKEN: "token",
        INTERNAL_DISPATCH_SECRET: "master-secret",
        IDENTITY_LINKING_DEADLINE: "1788825600000",
        IDENTITY_ASSERTION_KEY_VERSION: "4",
        IDENTITY_DISPATCH_SECRET_PREVIOUS: "previous-master",
        IDENTITY_DISPATCH_SECRET_NEXT: "next-master",
      } as Env, {
        source: "export default {}",
        app: { id: "app-files", slug: "files" } as AppRow,
        workerName: "files-v1",
        manifest: {
          version: 1,
          assets: false,
          worker: true,
          capabilities: {
            database: false,
            files: false,
            secrets: [],
            network: [],
            email: false,
            identity: true,
            schedules: [],
            durableObjects: [],
          },
        },
      });
      const identity = bindings.find(({ name }) => name === "MYSLOP_IDENTITY_KEYS");
      const internal = bindings.find(({ name }) => name === "MYSLOP_INTERNAL_SECRET");
      expect(identity?.type).toBe("secret_text");
      expect(Object.keys(JSON.parse(String(identity?.text)))).toEqual(["3", "4", "5"]);
      expect(internal).toBeUndefined();
      expect(bindings.find(({ name }) => name === "MYSLOP_IDENTITY_LINK_DEADLINE")?.text).toBe("1788825600000");
    } finally {
      fetchMock.mockRestore();
    }
  });
});
