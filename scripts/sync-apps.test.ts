import { describe, expect, test } from "bun:test";
import type { AppArtifact } from "../platform/src/artifact";
import { addedDeletionConfirmations, deletionConfirmations, planApps, reconciliationBody, type RemoteApp } from "./sync-apps";

const remote = (slug: string, managedBy: RemoteApp["managedBy"] = "git"): RemoteApp => ({
  id: slug,
  slug,
  managedBy,
  sourceHash: null,
});

describe("apps reconciliation plan", () => {
  test("creates new apps and updates existing apps in deterministic order", () => {
    expect(planApps(["mail", "files"], [remote("files")], new Set())).toEqual([
      { slug: "files", action: "update" },
      { slug: "mail", action: "create" },
    ]);
  });

  test("requires an exact deletion confirmation", () => {
    expect(() => planApps([], [remote("mail")], new Set())).toThrow("DELETE mail");
    expect(planApps([], [remote("mail")], new Set(["mail"]))).toEqual([{ slug: "mail", action: "delete" }]);
  });

  test("does not delete manually managed apps", () => {
    expect(planApps([], [remote("demo", "manual")], new Set())).toEqual([]);
  });

  test("parses only active exact confirmation lines", () => {
    const confirmations = deletionConfirmations("# DELETE old\nDELETE mail\n- DELETE files\nDELETE invalid slug\n");
    expect([...confirmations]).toEqual(["mail"]);
    expect([...addedDeletionConfirmations("+DELETE mail\n DELETE files\n+++ b/apps/DELETIONS.md")]).toEqual(["mail"]);
  });

  test("omitted access and visibility preserve the remote audience", () => {
    const source = {
      app: { name: "Demo", description: "", visibility: "team", domains: [], resources: {} },
      deployment: { manifest: {}, assets: [], migrations: [] },
      sourceHash: "source",
      deploymentHash: "deployment",
    } as unknown as AppArtifact;
    const body = reconciliationBody(source, { app: { name: "Demo" } }, "demo", "team-myslop", false, undefined);
    expect(body.teamId).toBe("team-myslop");
    expect(Object.hasOwn(body, "resources")).toBe(false);
    expect(Object.hasOwn(body.app, "visibility")).toBe(false);
    expect(Object.hasOwn(body, "access")).toBe(false);
  });

  test("submits only the resource selected for reviewed adoption", () => {
    const source = {
      app: {
        name: "Demo",
        description: "",
        visibility: "public",
        domains: [],
        resources: {
          database: { id: "database-id", name: "database-name" },
          bucket: { name: "bucket-name" },
        },
      },
      deployment: { manifest: {}, assets: [], migrations: [] },
      sourceHash: "source",
      deploymentHash: "deployment",
    } as unknown as AppArtifact;
    const body = reconciliationBody(source, {}, "demo", "team-myslop", false, {
      bucket: source.app.resources.bucket,
    });
    expect(body.resources).toEqual({ bucket: { name: "bucket-name" } });
  });

  test("explicit access controls audience without a synthesized legacy visibility", () => {
    const source = {
      app: {
        name: "Demo",
        description: "",
        visibility: "private",
        domains: [],
        resources: {},
        access: { audience: "restricted", users: [], groups: [] },
      },
      deployment: { manifest: {}, assets: [], migrations: [] },
      sourceHash: "source",
      deploymentHash: "deployment",
    } as unknown as AppArtifact;
    const body = reconciliationBody(source, { access: { audience: "restricted" } }, "demo", "team-myslop", false, undefined);
    expect(Object.hasOwn(body.app, "visibility")).toBe(false);
    expect(body.access?.audience).toBe("restricted");
  });
});
