import { describe, expect, test } from "bun:test";
import { canReconcileApps, reconciliationDeploymentChanged } from "../src/reconcile";

describe("reconciliation deployment hashes", () => {
  test("requires an unscoped platform-owner principal", () => {
    const user = { id: "owner", email: null, name: null, picture: null, platform_role: "owner" as const };
    expect(canReconcileApps({ user })).toBe(true);
    expect(canReconcileApps({ user, appId: "app-a", tokenId: "token" })).toBe(false);
    expect(canReconcileApps({ user: { ...user, platform_role: "member" } })).toBe(false);
  });

  test("bootstraps a deployment hash without redeploying when the legacy source hash matches", () => {
    expect(reconciliationDeploymentChanged({
      currentSourceHash: "same",
      currentDeploymentHash: null,
      sourceHash: "same",
      deploymentHash: "runtime",
    })).toBe(false);
  });

  test("deploys conservatively when a legacy source hash differs", () => {
    expect(reconciliationDeploymentChanged({
      currentSourceHash: "old",
      currentDeploymentHash: null,
      sourceHash: "new",
      deploymentHash: "runtime",
    })).toBe(true);
  });

  test("uses the deployment hash after bootstrap so policy-only changes do not deploy", () => {
    expect(reconciliationDeploymentChanged({
      currentSourceHash: "old-policy",
      currentDeploymentHash: "runtime",
      sourceHash: "new-policy",
      deploymentHash: "runtime",
    })).toBe(false);
  });
});
