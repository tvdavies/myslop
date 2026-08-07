import { ExternalLink, Plus, Search, Settings2 } from "lucide-react";
import * as React from "react";

import { AppDialog } from "@/components/dialogs/app-dialog";
import { AudienceBadge, ResourceLedger, RoleBadge } from "@/components/directory/status";
import { EmptyState, RouteError, RouteLoading } from "@/components/feedback/route-state";
import { PageHeader } from "@/components/page-header";
import { Panel } from "@/components/panel";
import { Button, buttonVariants } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DashboardLink, navigate } from "@/hooks/use-dashboard-location";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useRouteResource } from "@/hooks/use-route-resource";
import { apiRequest } from "@/lib/api";
import { folderById, folderPath } from "@/lib/folders";
import { relativeTime, formatDateTime } from "@/lib/format";
import { parseAppListState, type DashboardLocation, type DashboardRoute } from "@/lib/routing";
import { useDashboard } from "@/shell/dashboard-context";
import type { AppsResponse, FolderSummary, ListedApp } from "@/types/api";

type AppsRoute = Extract<DashboardRoute, { name: "apps" }>;

const SEARCH_DEBOUNCE_MS = 280;

function routeTitle(route: AppsRoute, folder: FolderSummary | null): string {
  switch (route.scope) {
    case "all":
      return "All apps";
    case "root":
      return "Root";
    case "folder":
      return folder?.name || "Folder";
  }
}

function routeDescription(route: AppsRoute, folders: FolderSummary[], folder: FolderSummary | null): string {
  switch (route.scope) {
    case "all":
      return "Every app you can open in this team.";
    case "root":
      return "Apps that are not filed in a folder.";
    case "folder":
      return folder ? `Apps filed in ${folderPath(folders, folder)}.` : "This folder is unavailable.";
  }
}

function AppIdentity({ app }: { app: ListedApp }) {
  return (
    <div className="app-identity">
      <span className="app-glyph" aria-hidden="true">{app.name.charAt(0).toUpperCase()}</span>
      <span><strong>{app.name}</strong><small>{app.description || app.slug}</small></span>
    </div>
  );
}

function AppRowActions({ app, settingsHref }: { app: ListedApp; settingsHref: string }) {
  return (
    <div className="row-actions">
      <a className={buttonVariants({ variant: "outline", size: "sm", className: "text-foreground" })} href={app.url} target="_blank" rel="noopener"><ExternalLink />Open</a>
      {app.permissions.viewSettings ? (
        <DashboardLink className={buttonVariants({ variant: "outline", size: "sm", className: "text-foreground" })} href={settingsHref}><Settings2 />Settings</DashboardLink>
      ) : null}
    </div>
  );
}

export function AppsPage({ route, current }: { route: AppsRoute; current: DashboardLocation }) {
  const dashboard = useDashboard();
  const filters = parseAppListState(current.search);
  const [search, setSearch] = React.useState(filters.q);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const searchTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const [revision, setRevision] = React.useState(0);
  React.useEffect(() => setSearch(filters.q), [filters.q]);
  React.useEffect(() => () => { if (searchTimer.current) clearTimeout(searchTimer.current); }, []);

  const folder = route.scope === "folder" ? folderById(dashboard.folders, route.folderId) : null;
  const title = routeTitle(route, folder);
  const description = routeDescription(route, dashboard.folders, folder);
  useDocumentTitle(title);

  const resource = useRouteResource(`${dashboard.teamId}:${current.pathname}:${current.search}:${revision}`, async (signal) => {
    const parameters = new URLSearchParams({ teamId: dashboard.teamId, sort: filters.sort, direction: filters.direction });
    if (route.scope === "root") parameters.set("folderId", "root");
    if (route.scope === "folder") parameters.set("folderId", route.folderId);
    if (filters.q) parameters.set("q", filters.q);
    if (filters.audience) parameters.set("audience", filters.audience);
    if (filters.role) parameters.set("role", filters.role);
    return apiRequest<AppsResponse>(`/api/apps?${parameters}`, { signal });
  });

  function updateQuery(changes: Record<string, string>) {
    const url = new URL(location.href);
    for (const [key, value] of Object.entries(changes)) {
      if (value) url.searchParams.set(key, value);
      else url.searchParams.delete(key);
    }
    url.searchParams.set("teamId", dashboard.teamId);
    navigate(`${url.pathname}${url.search}`, true);
  }

  function handleSearchChange(value: string) {
    setSearch(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => updateQuery({ q: value.trim() }), SEARCH_DEBOUNCE_MS);
  }

  function handleSortChange(value: string) {
    const [sort, direction] = value.split("-");
    updateQuery({ sort: sort!, direction: direction! });
  }

  const defaultFolderId = route.scope === "folder" ? route.folderId : "";
  const hasFilters = Boolean(filters.q || filters.audience || filters.role);
  const settingsHref = (app: ListedApp) => dashboard.href(`/apps/${encodeURIComponent(app.id)}/settings`);

  return (
    <div className="content-width">
      <PageHeader
        crumbs={[dashboard.team.name, title]}
        title={title}
        description={description}
        action={<Button onClick={() => setDialogOpen(true)}><Plus />New app</Button>}
      />
      <form className="directory-toolbar" role="search" aria-label="Filter apps" onSubmit={(event) => event.preventDefault()}>
        <label className="search-field">
          <span className="sr-only">Search apps</span>
          <InputGroup>
            <InputGroupAddon><Search aria-hidden="true" /></InputGroupAddon>
            <InputGroupInput
              type="search"
              value={search}
              placeholder="Search name, slug or description"
              onChange={(event) => handleSearchChange(event.target.value)}
            />
          </InputGroup>
        </label>
        <NativeSelect className="w-full" aria-label="Audience" value={filters.audience} onChange={(event) => updateQuery({ audience: event.target.value })}>
          <option value="">Any audience</option>
          <option value="restricted">Restricted</option>
          <option value="team">Team</option>
          <option value="public">Public</option>
        </NativeSelect>
        <NativeSelect className="w-full" aria-label="Role" value={filters.role} onChange={(event) => updateQuery({ role: event.target.value })}>
          <option value="">Any role</option>
          <option value="owner">Owner</option>
          <option value="editor">Editor</option>
          <option value="viewer">Viewer</option>
        </NativeSelect>
        <NativeSelect
          className="w-full"
          aria-label="Sort apps"
          value={`${filters.sort}-${filters.direction}`}
          onChange={(event) => handleSortChange(event.target.value)}
        >
          <option value="updated-desc">Recently updated</option>
          <option value="updated-asc">Least recently updated</option>
          <option value="name-asc">Name A–Z</option>
          <option value="name-desc">Name Z–A</option>
          <option value="created-desc">Newest created</option>
          <option value="created-asc">Oldest created</option>
        </NativeSelect>
      </form>
      {resource.status === "loading" ? <RouteLoading label="Loading apps…" /> : null}
      {resource.status === "error" ? <RouteError message={resource.error} retry={resource.retry} /> : null}
      {resource.status === "ready" && resource.data.apps.length ? (
        <Panel aria-label="Apps" className="directory-panel">
          <div className="desktop-directory">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>App</TableHead>
                  <TableHead>Resources</TableHead>
                  <TableHead>Audience</TableHead>
                  <TableHead>Your role</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead><span className="sr-only">Actions</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {resource.data.apps.map((app) => (
                  <TableRow key={app.id}>
                    <TableCell><AppIdentity app={app} /></TableCell>
                    <TableCell><ResourceLedger nodes={app.resources?.nodes || []} compact /></TableCell>
                    <TableCell><AudienceBadge audience={app.audience} /></TableCell>
                    <TableCell><RoleBadge role={app.role} /></TableCell>
                    <TableCell><span title={formatDateTime(app.updatedAt)}>{relativeTime(app.updatedAt)}</span></TableCell>
                    <TableCell><AppRowActions app={app} settingsHref={settingsHref(app)} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="mobile-directory">
            {resource.data.apps.map((app) => (
              <article className="mobile-app-row" key={app.id}>
                <AppIdentity app={app} />
                <ResourceLedger nodes={app.resources?.nodes || []} compact />
                <div className="mobile-app-meta">
                  <AudienceBadge audience={app.audience} />
                  <RoleBadge role={app.role} />
                  <span>{relativeTime(app.updatedAt)}</span>
                </div>
                <AppRowActions app={app} settingsHref={settingsHref(app)} />
              </article>
            ))}
          </div>
        </Panel>
      ) : null}
      {resource.status === "ready" && !resource.data.apps.length ? (
        <EmptyState
          title="No apps here"
          description={hasFilters ? "Clear the filters to see more apps." : "Create an app in this location, then deploy it from an agent or your local machine."}
          action={<Button onClick={() => setDialogOpen(true)}><Plus />Create app</Button>}
        />
      ) : null}
      <AppDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        defaultFolderId={defaultFolderId}
        onCreated={() => setRevision((value) => value + 1)}
      />
    </div>
  );
}
