import { ArrowLeft, ExternalLink, Info } from "lucide-react";
import * as React from "react";

import { AppConfirmDialog, type AppConfirmation } from "@/components/dialogs/app-confirm-dialog";
import { AudienceBadge, GitBadge, RoleBadge } from "@/components/directory/status";
import { RouteError, RouteLoading } from "@/components/feedback/route-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { DashboardLink, navigate } from "@/hooks/use-dashboard-location";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useRouteResource } from "@/hooks/use-route-resource";
import { apiRequest } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useDashboard } from "@/shell/dashboard-context";
import { AccessSection } from "@/settings/access-section";
import { ActivitySection } from "@/settings/activity-section";
import { DangerSection } from "@/settings/danger-section";
import { DeploymentsSection } from "@/settings/deployments-section";
import { OverviewSection } from "@/settings/overview-section";
import { ResourcesSection } from "@/settings/resources-section";
import { SecretsSection } from "@/settings/secrets-section";
import type { AppDetailResponse, GroupsResponse, MembersResponse } from "@/types/api";

const sections = ["Overview", "Access", "Resources", "Deployments", "Secrets", "Activity", "Danger"] as const;

export function SettingsPage({ appId, hash }: { appId: string; hash: string }) {
  const dashboard = useDashboard();
  const [revision, setRevision] = React.useState(0);
  const [confirmation, setConfirmation] = React.useState<AppConfirmation | null>(null);
  const resource = useRouteResource(`${appId}:${revision}`, async (signal) => {
    const detail = await apiRequest<AppDetailResponse>(`/api/apps/${encodeURIComponent(appId)}`, { signal });
    let members: MembersResponse = { members: [], canAdmin: false };
    let groups: GroupsResponse = { groups: [], canAdmin: false };
    if (!detail.access.readOnly) {
      [members, groups] = await Promise.all([
        apiRequest<MembersResponse>(`/api/teams/${encodeURIComponent(detail.app.teamId)}/members`, { signal }),
        apiRequest<GroupsResponse>(`/api/teams/${encodeURIComponent(detail.app.teamId)}/groups`, { signal }),
      ]);
    }
    return { detail, members: members.members || [], groups: groups.groups || [] };
  });
  const detail = resource.status === "ready" ? resource.data.detail : null;
  const refresh = () => setRevision((value) => value + 1);
  useDocumentTitle(detail ? `${detail.app.name} settings` : "App settings");

  React.useEffect(() => {
    if (!detail || detail.app.teamId === dashboard.teamId) return;
    if (dashboard.me.teams.some((team) => team.id === detail.app.teamId)) dashboard.selectTeamForCurrentRoute(detail.app.teamId);
  }, [detail, dashboard]);

  React.useEffect(() => {
    if (resource.status !== "ready") return;
    const sectionId = hash.slice(1);
    if (sections.some((section) => section.toLowerCase() === sectionId)) requestAnimationFrame(() => document.getElementById(sectionId)?.scrollIntoView());
  }, [resource.status, hash]);

  if (resource.status === "loading") return <div className="content-width"><RouteLoading label="Loading app settings…" /></div>;
  if (resource.status === "error") return <div className="content-width"><RouteError message={resource.error} retry={resource.retry} /></div>;
  const { app } = resource.data.detail;
  const activeSection = sections.some((section) => `#${section.toLowerCase()}` === hash) ? hash.slice(1) : "overview";
  const backHref = dashboard.href(app.folderId ? `/folders/${encodeURIComponent(app.folderId)}` : "/");
  async function handleConfirmComplete(deleted: boolean) {
    setConfirmation(null);
    if (!deleted) {
      refresh();
      return;
    }
    await dashboard.refetchFolders();
    navigate(dashboard.href("/dashboard"));
  }

  return (
    <div className="content-width settings-page">
      <header className="settings-header">
        <div className="settings-app-identity">
          <span className="app-glyph large" aria-hidden="true">{app.name.charAt(0).toUpperCase()}</span>
          <div>
            <p className="eyebrow">App settings</p>
            <h1>{app.name}</h1>
            <div className="settings-badges">
              <span className="font-mono">{app.slug}</span>
              <AudienceBadge audience={app.audience} />
              <RoleBadge role={app.role} />
              {app.managedBy === "git" ? <GitBadge /> : null}
            </div>
          </div>
        </div>
        <div className="settings-header-actions">
          <a className={buttonVariants({ variant: "outline", className: "text-foreground" })} href={app.url} target="_blank" rel="noopener"><ExternalLink />Open app</a>
          <DashboardLink className={buttonVariants({ variant: "outline", className: "text-foreground" })} href={backHref}><ArrowLeft />Back to library</DashboardLink>
        </div>
      </header>
      {app.managedBy === "git" ? (
        <Alert className="managed-banner">
          <Info />
          <AlertTitle>Git is the source of truth.</AlertTitle>
          <AlertDescription>Metadata, folder, access, runtime and deletion controls are read-only here. Update <code>myslop.json</code> and run reconciliation. Secret values can still be rotated when your role allows it.</AlertDescription>
        </Alert>
      ) : null}
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {sections.map((section) => {
            const id = section.toLowerCase();
            return (
              <a
                key={id}
                href={`#${id}`}
                aria-current={activeSection === id ? "location" : undefined}
                className={cn(activeSection === id && "is-active", id === "danger" && "is-danger")}
              >
                {section}
              </a>
            );
          })}
        </nav>
        <div className="settings-content">
          <OverviewSection detail={resource.data.detail} refresh={refresh} />
          <AccessSection
            detail={resource.data.detail}
            teamMembers={resource.data.members}
            teamGroups={resource.data.groups}
            refresh={refresh}
          />
          <ResourcesSection detail={resource.data.detail} />
          <DeploymentsSection detail={resource.data.detail} confirm={setConfirmation} />
          <SecretsSection detail={resource.data.detail} refresh={refresh} />
          <ActivitySection detail={resource.data.detail} />
          <DangerSection detail={resource.data.detail} confirm={setConfirmation} />
        </div>
      </div>
      <AppConfirmDialog
        app={app}
        action={confirmation}
        onOpenChange={(open) => { if (!open) setConfirmation(null); }}
        onComplete={handleConfirmComplete}
      />
    </div>
  );
}
