import { RotateCcw } from "lucide-react";

import { StatusBadge } from "@/components/directory/status";
import { EmptyState } from "@/components/feedback/route-state";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime } from "@/lib/format";
import { SettingsSection } from "@/settings/settings-section";
import type { AppConfirmation } from "@/components/dialogs/app-confirm-dialog";
import type { AppDetailResponse, DeploymentSummary, ListedApp } from "@/types/api";

function runtimeLabel(hasWorker: DeploymentSummary["has_worker"]): string {
  if (hasWorker === true || hasWorker === 1) return "App / runtime";
  if (hasWorker === false || hasWorker === 0) return "Static app";
  return "";
}

function isActiveVersion(deployment: DeploymentSummary, app: ListedApp): boolean {
  return Number(deployment.version) === Number(app.activeVersion);
}

function canRollback(deployment: DeploymentSummary, app: ListedApp): boolean {
  return deployment.status === "active" && !isActiveVersion(deployment, app) && app.permissions.modifyRuntime;
}

function VersionLabel({ deployment, app }: { deployment: DeploymentSummary; app: ListedApp }) {
  return (
    <strong>
      Version {deployment.version}
      {isActiveVersion(deployment, app) ? <span className="current-label">Current</span> : null}
    </strong>
  );
}

export function DeploymentsSection({ detail, confirm }: { detail: AppDetailResponse; confirm: (action: AppConfirmation) => void }) {
  const { app, deployments } = detail;

  // The desktop table shows an icon button; the narrower mobile cards show a label only.
  function rollbackButton(deployment: DeploymentSummary, icons: boolean) {
    if (!canRollback(deployment, app)) return null;
    return (
      <Button variant="outline" size="sm" onClick={() => confirm({ type: "rollback", version: deployment.version })}>
        {icons ? <RotateCcw /> : null}Rollback
      </Button>
    );
  }

  return (
    <SettingsSection id="deployments" title="Deployments" description="Immutable versions and rollback controls.">
      {deployments.length ? (
        <>
          <div className="desktop-directory">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Deployment</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>By</TableHead>
                  <TableHead><span className="sr-only">Actions</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {deployments.map((deployment) => {
                  const runtime = runtimeLabel(deployment.has_worker);
                  const creator = deployment.created_by_name || deployment.created_by_email || "";
                  return (
                    <TableRow key={deployment.version}>
                      <TableCell>
                        <div className="name-stack">
                          <VersionLabel deployment={deployment} app={app} />
                          {runtime ? <small>{runtime}</small> : null}
                        </div>
                      </TableCell>
                      <TableCell><StatusBadge status={deployment.status} /></TableCell>
                      <TableCell>{formatDateTime(deployment.created_at)}</TableCell>
                      <TableCell>{creator || <span className="text-muted-foreground">—</span>}</TableCell>
                      <TableCell>{rollbackButton(deployment, true)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <div className="mobile-directory">
            {deployments.map((deployment) => (
              <article className="mobile-admin-row" key={deployment.version}>
                <div className="name-stack">
                  <VersionLabel deployment={deployment} app={app} />
                  <small>{formatDateTime(deployment.created_at)}</small>
                </div>
                <StatusBadge status={deployment.status} />
                {rollbackButton(deployment, false)}
              </article>
            ))}
          </div>
        </>
      ) : (
        <EmptyState title="No deployments" description="Deploy this app from an agent or local machine to create version 1." />
      )}
    </SettingsSection>
  );
}
