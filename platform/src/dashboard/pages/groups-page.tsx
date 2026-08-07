import { Pencil, Plus, Trash2, Users } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { GroupDialog } from "@/components/dialogs/group-dialog";
import { GroupMembersDialog } from "@/components/dialogs/group-members-dialog";
import { SimpleConfirmDialog } from "@/components/dialogs/simple-confirm-dialog";
import { EmptyState, RouteError, TableLoading } from "@/components/feedback/route-state";
import { PageHeader } from "@/components/page-header";
import { Panel, PanelHeader } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useRouteResource } from "@/hooks/use-route-resource";
import { apiRequest, errorMessage } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { useDashboard } from "@/shell/dashboard-context";
import type { GroupSummary, GroupsResponse } from "@/types/api";

export function GroupsPage() {
  const dashboard = useDashboard();
  const [revision, setRevision] = React.useState(0);
  const [editing, setEditing] = React.useState<{ open: boolean; group: GroupSummary | null }>({ open: false, group: null });
  const [members, setMembers] = React.useState<GroupSummary | null>(null);
  const [deleting, setDeleting] = React.useState<GroupSummary | null>(null);
  useDocumentTitle("Groups");

  const resource = useRouteResource(`groups:${dashboard.teamId}:${revision}`, (signal) =>
    apiRequest<GroupsResponse>(`/api/teams/${encodeURIComponent(dashboard.teamId)}/groups`, { signal }),
  );
  const groups = resource.status === "ready" ? resource.data.groups : [];
  const canAdmin = resource.status === "ready" && resource.data.canAdmin;
  const refresh = () => setRevision((value) => value + 1);

  // The desktop table shows icon buttons; the narrower mobile cards show labels only.
  function rowActions(group: GroupSummary, icons: boolean) {
    return (
      <div className="row-actions">
        <Button variant="outline" size="sm" onClick={() => setMembers(group)}>{icons ? <Users /> : null}Members</Button>
        {canAdmin ? (
          <>
            <Button variant="outline" size="sm" onClick={() => setEditing({ open: true, group })}>{icons ? <Pencil /> : null}Edit</Button>
            <Button variant="outline" size="sm" onClick={() => setDeleting(group)}>{icons ? <Trash2 /> : null}Delete</Button>
          </>
        ) : null}
      </div>
    );
  }

  async function deleteGroup() {
    if (!deleting) return;
    try {
      await apiRequest(`/api/teams/${encodeURIComponent(dashboard.teamId)}/groups/${encodeURIComponent(deleting.id)}`, { method: "DELETE" });
      toast.success("Group deleted");
      refresh();
    } catch (error) {
      toast.error(errorMessage(error));
      throw error;
    }
  }

  return (
    <div className="content-width">
      <PageHeader
        crumbs={[dashboard.team.name, "Groups"]}
        title="Groups"
        description="Administer reusable access groups in one place."
        action={canAdmin ? <Button onClick={() => setEditing({ open: true, group: null })}><Plus />New group</Button> : undefined}
      />
      {resource.status === "loading" ? (
        <TableLoading
          label="Loading groups…"
          title="Team groups"
          headers={["Group", "Members", "Apps", "Updated", ""]}
        />
      ) : null}
      {resource.status === "error" ? <RouteError message={resource.error} retry={resource.retry} /> : null}
      {resource.status === "ready" ? (
        <Panel>
          <PanelHeader title="Team groups" meta={`${groups.length} groups`} />
          {groups.length ? (
            <>
              <div className="desktop-directory">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Group</TableHead>
                      <TableHead>Members</TableHead>
                      <TableHead>Apps</TableHead>
                      <TableHead>Updated</TableHead>
                      <TableHead><span className="sr-only">Actions</span></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {groups.map((group) => (
                      <TableRow key={group.id}>
                        <TableCell>
                          <div className="name-stack">
                            <strong>{group.name}</strong>
                            <small>{group.description || group.slug}</small>
                          </div>
                        </TableCell>
                        <TableCell>{group.memberCount}</TableCell>
                        <TableCell>{group.appCount}</TableCell>
                        <TableCell>{relativeTime(group.updatedAt)}</TableCell>
                        <TableCell>{rowActions(group, true)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div className="mobile-directory">
                {groups.map((group) => (
                  <article className="mobile-admin-row" key={group.id}>
                    <div className="name-stack">
                      <strong>{group.name}</strong>
                      <small>{group.description || group.slug} · {group.memberCount} members · {group.appCount} apps</small>
                    </div>
                    {rowActions(group, false)}
                  </article>
                ))}
              </div>
            </>
          ) : (
            <EmptyState title="No groups" description="Create a group to grant the same app role to several team members." />
          )}
        </Panel>
      ) : null}
      <GroupDialog
        open={editing.open}
        onOpenChange={(open) => setEditing((current) => ({ ...current, open }))}
        group={editing.group}
        onSaved={refresh}
      />
      <GroupMembersDialog
        open={Boolean(members)}
        onOpenChange={(open) => { if (!open) setMembers(null); }}
        group={members}
        canAdmin={canAdmin}
        onSaved={refresh}
      />
      <SimpleConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => { if (!open) setDeleting(null); }}
        title="Delete group"
        description={deleting ? `Delete the group “${deleting.name}”?` : ""}
        confirmLabel="Delete group"
        destructive
        onConfirm={deleteGroup}
      />
    </div>
  );
}
