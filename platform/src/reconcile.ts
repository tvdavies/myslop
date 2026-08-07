import type { Principal } from "./auth";

export function canReconcileApps(principal: Principal): boolean {
  return principal.user.platform_role === "owner" && !principal.appId;
}

export function reconciliationDeploymentChanged(input: {
  currentSourceHash: string | null;
  currentDeploymentHash: string | null;
  sourceHash: string;
  deploymentHash: string;
}): boolean {
  if (input.currentDeploymentHash) return input.currentDeploymentHash !== input.deploymentHash;
  return input.currentSourceHash !== input.sourceHash;
}
