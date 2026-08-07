import { describe, expect, test } from "bun:test";
import { deletionConfirmations, planApps, type RemoteApp } from "./sync-apps";

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
  });
});
