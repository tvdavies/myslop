import { FolderOpen, Pencil, Plus, Trash2 } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { FolderDialog } from "@/components/dialogs/folder-dialog";
import { SimpleConfirmDialog } from "@/components/dialogs/simple-confirm-dialog";
import { EmptyState, RouteError, RouteLoading } from "@/components/feedback/route-state";
import { PageHeader } from "@/components/page-header";
import { Panel, PanelHeader } from "@/components/panel";
import { Button, buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DashboardLink } from "@/hooks/use-dashboard-location";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { apiRequest, errorMessage } from "@/lib/api";
import { folderPath, nestedFolders } from "@/lib/folders";
import { useDashboard } from "@/shell/dashboard-context";
import type { FolderSummary } from "@/types/api";

export function FoldersPage() {
  const dashboard = useDashboard();
  const [dialog, setDialog] = React.useState<{ open: boolean; folder: FolderSummary | null }>({ open: false, folder: null });
  const [deleting, setDeleting] = React.useState<FolderSummary | null>(null);
  useDocumentTitle("Folders");
  const ordered = nestedFolders(dashboard.folders);

  // The desktop table shows icon buttons; the narrower mobile cards show labels only.
  function rowActions(folder: FolderSummary, icons: boolean) {
    return (
      <div className="row-actions">
        <DashboardLink
          className={buttonVariants({ variant: "outline", size: "sm", className: "text-foreground" })}
          href={dashboard.href(`/folders/${encodeURIComponent(folder.id)}`)}
        >
          {icons ? <FolderOpen /> : null}Open
        </DashboardLink>
        {dashboard.foldersCanAdmin ? (
          <>
            <Button variant="outline" size="sm" onClick={() => setDialog({ open: true, folder })}>{icons ? <Pencil /> : null}Edit</Button>
            <Button variant="outline" size="sm" onClick={() => setDeleting(folder)}>{icons ? <Trash2 /> : null}Delete</Button>
          </>
        ) : null}
      </div>
    );
  }

  async function deleteFolder() {
    if (!deleting) return;
    try {
      await apiRequest(`/api/teams/${encodeURIComponent(dashboard.teamId)}/folders/${encodeURIComponent(deleting.id)}`, { method: "DELETE" });
      await dashboard.refetchFolders();
      toast.success("Folder deleted");
    } catch (error) {
      toast.error(errorMessage(error));
      throw error;
    }
  }

  return (
    <div className="content-width">
      <PageHeader
        crumbs={[dashboard.team.name, "Folders"]}
        title="Folders"
        description="Keep the app library navigable without changing app addresses."
        action={dashboard.foldersCanAdmin ? <Button onClick={() => setDialog({ open: true, folder: null })}><Plus />New folder</Button> : undefined}
      />
      {dashboard.foldersLoading ? <RouteLoading label="Loading folders…" /> : null}
      {dashboard.foldersError ? (
        <RouteError message={dashboard.foldersError} retry={() => void dashboard.refetchFolders().catch(() => undefined)} />
      ) : null}
      {!dashboard.foldersLoading && !dashboard.foldersError ? (
        <Panel>
          <PanelHeader title="Folder structure" meta={`${dashboard.folders.length} folders`} />
          {ordered.length ? (
            <>
              <div className="desktop-directory">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Path</TableHead>
                      <TableHead>Apps</TableHead>
                      <TableHead><span className="sr-only">Actions</span></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {ordered.map(({ folder, depth }) => (
                      <TableRow key={folder.id}>
                        <TableCell>
                          <div className="name-stack">
                            <strong>{"— ".repeat(depth)}{folder.name}</strong>
                            <small className="font-mono">{folder.slug}</small>
                          </div>
                        </TableCell>
                        <TableCell>{folderPath(dashboard.folders, folder)}</TableCell>
                        <TableCell>{folder.appCount}</TableCell>
                        <TableCell>{rowActions(folder, true)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div className="mobile-directory">
                {ordered.map(({ folder, depth }) => (
                  <article className="mobile-admin-row" key={folder.id}>
                    <div className="name-stack">
                      <strong>{"— ".repeat(depth)}{folder.name}</strong>
                      <small>{folderPath(dashboard.folders, folder)} · {folder.appCount} apps</small>
                    </div>
                    {rowActions(folder, false)}
                  </article>
                ))}
              </div>
            </>
          ) : (
            <EmptyState title="No folders yet" description="Apps currently live at the root of this team library." />
          )}
        </Panel>
      ) : null}
      <FolderDialog
        open={dialog.open}
        onOpenChange={(open) => setDialog((current) => ({ ...current, open }))}
        folder={dialog.folder}
      />
      <SimpleConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => { if (!open) setDeleting(null); }}
        title="Delete folder"
        description={deleting ? `Delete the empty folder “${deleting.name}”?` : ""}
        confirmLabel="Delete folder"
        destructive
        onConfirm={deleteFolder}
      />
    </div>
  );
}
