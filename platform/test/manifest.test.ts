import { describe, expect, test } from "bun:test";
import { normalizeAppManifest, parseResolvedManifest, resolveManifest } from "../src/manifest";

describe("capability manifest", () => {
  test("a static page needs no runtime resources", () => {
    expect(resolveManifest({}, { assets: true, worker: false, migrations: false })).toEqual({
      version: 1,
      assets: true,
      worker: false,
      capabilities: { database: false, files: false, secrets: [], network: [], email: false, schedules: [], durableObjects: [] },
    });
  });

  test("infers Worker and database from source layout", () => {
    expect(resolveManifest({}, { assets: true, worker: true, migrations: true }).capabilities.database).toBe(true);
  });

  test("adds only explicitly requested non-obvious capabilities", () => {
    const manifest = resolveManifest({
      capabilities: {
        files: true,
        secrets: ["HUBSPOT_TOKEN"],
        network: ["API.HUBAPI.COM"],
      },
    }, { assets: true, worker: true, migrations: false });
    expect(manifest.capabilities).toEqual({
      database: false,
      files: true,
      secrets: ["HUBSPOT_TOKEN"],
      network: ["api.hubapi.com"],
      email: false,
      schedules: [],
      durableObjects: [],
    });
  });

  test("normalizes app metadata, schedules, email, and durable objects", () => {
    const manifest = resolveManifest({
      app: { visibility: "public", domains: ["FILES.MYSLOP.APP"] },
      capabilities: {
        email: true,
        schedules: ["17 3 * * *"],
        durableObjects: [{ class: "InboxHub" }],
      },
    }, { assets: false, worker: true, migrations: false });
    expect(manifest.capabilities).toEqual({
      database: false,
      files: false,
      secrets: [],
      network: [],
      email: true,
      schedules: ["17 3 * * *"],
      durableObjects: [{ className: "InboxHub", binding: "INBOX_HUB" }],
    });
  });

  test("rejects invalid app domains and schedules", () => {
    expect(() => resolveManifest({ app: { domains: ["example.com"] } }, { assets: false, worker: false, migrations: false }))
      .toThrow("myslop.app zone");
    expect(() => resolveManifest({ capabilities: { schedules: ["every minute"] } }, { assets: false, worker: true, migrations: false }))
      .toThrow("five-field");
  });

  test("rejects server capabilities without a Worker", () => {
    expect(() => resolveManifest({ capabilities: { files: true } }, { assets: true, worker: false, migrations: false }))
      .toThrow("require worker.ts");
  });

  test("rejects unknown fields instead of silently under-provisioning", () => {
    expect(() => resolveManifest({ capabilities: { file: true } }, { assets: false, worker: true, migrations: false }))
      .toThrow("unknown capability");
  });

  test("rejects duplicate capabilities", () => {
    expect(() => resolveManifest({ capabilities: { secrets: ["TOKEN", "TOKEN"] } }, { assets: false, worker: true, migrations: false }))
      .toThrow("duplicates");
  });

  test("rejects reserved secret bindings and URL-shaped network entries", () => {
    expect(() => resolveManifest({ capabilities: { secrets: ["DB"] } }, { assets: false, worker: true, migrations: false }))
      .toThrow("non-reserved");
    expect(() => resolveManifest({ capabilities: { network: ["https://api.example.com"] } }, { assets: false, worker: true, migrations: false }))
      .toThrow("hostnames");
  });

  test("rejects incomplete or unknown resolved deployment fields", () => {
    expect(() => parseResolvedManifest({
      version: 1,
      assets: false,
      worker: true,
      typo: true,
      capabilities: { database: false, files: false, secrets: [], network: [], email: false, schedules: [], durableObjects: [] },
    })).toThrow("unknown deployment manifest field");
    expect(() => parseResolvedManifest({
      version: 1,
      assets: false,
      worker: true,
      capabilities: { database: false, files: false },
    })).toThrow("must be complete");
  });

  test("validates the resolved deployment representation", () => {
    const manifest = parseResolvedManifest({
      version: 1,
      assets: false,
      worker: true,
      capabilities: { database: true, files: false, secrets: [], network: [], email: false, schedules: [], durableObjects: [] },
    });
    expect(manifest.capabilities.database).toBe(true);
  });

  test("normalizes folder and access policy deterministically", () => {
    expect(normalizeAppManifest({
      app: { visibility: "private", folder: "business-apps" },
      access: {
        audience: "restricted",
        users: [
          { email: " ZED@LLEVERAGE.AI ", role: "viewer" },
          { email: "amy@lleverage.ai", role: "owner" },
        ],
        groups: [
          { slug: "sales-team", role: "viewer" },
          { slug: "developers", role: "editor" },
        ],
      },
    })).toMatchObject({
      folder: "business-apps",
      access: {
        audience: "restricted",
        users: [
          { email: "amy@lleverage.ai", role: "owner" },
          { email: "zed@lleverage.ai", role: "viewer" },
        ],
        groups: [
          { slug: "developers", role: "editor" },
          { slug: "sales-team", role: "viewer" },
        ],
      },
    });
  });

  test("derives visibility from the access audience when the legacy field is omitted", () => {
    expect(normalizeAppManifest({ access: { audience: "restricted" } }).visibility).toBe("private");
    expect(normalizeAppManifest({ access: { audience: "public" } }).visibility).toBe("public");
    expect(normalizeAppManifest({ app: { name: "Demo" } }).visibility).toBe("team");
  });

  test("keeps legacy manifests free of implicit folder and access fields", () => {
    const app = normalizeAppManifest({ app: { visibility: "public" } });
    expect(Object.hasOwn(app, "folder")).toBe(false);
    expect(Object.hasOwn(app, "access")).toBe(false);
  });

  test("rejects conflicting or invalid access declarations", () => {
    expect(() => normalizeAppManifest({
      app: { visibility: "public" },
      access: { audience: "restricted" },
    })).toThrow("must agree");
    expect(() => normalizeAppManifest({
      access: { audience: "team", groups: [{ slug: "developers", role: "owner" as "editor" }] },
    })).toThrow("group role");
    expect(() => normalizeAppManifest({
      access: {
        audience: "team",
        users: [
          { email: "same@lleverage.ai", role: "viewer" },
          { email: "SAME@LLEVERAGE.AI", role: "editor" },
        ],
      },
    })).toThrow("duplicates");
  });
});
