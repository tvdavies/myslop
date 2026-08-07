import { LoaderCircle } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RouteError, RouteLoading } from "@/components/feedback/route-state";
import { apiRequest, errorMessage } from "@/lib/api";
import { useRouteResource } from "@/hooks/use-route-resource";
import { useDashboard } from "@/shell/dashboard-context";
import type { GroupMembersResponse, GroupSummary, MembersResponse } from "@/types/api";

export function GroupMembersDialog({ open, onOpenChange, group, canAdmin, onSaved }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  group: GroupSummary | null;
  canAdmin: boolean;
  onSaved: () => void;
}) {
  const dashboard = useDashboard();
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState(false);
  const resource = useRouteResource(
    open && group ? `${dashboard.teamId}:${group.id}` : "closed",
    async (signal) => {
      if (!open || !group) return null;
      const [members, assigned] = await Promise.all([
        apiRequest<MembersResponse>(`/api/teams/${encodeURIComponent(dashboard.teamId)}/members`, { signal }),
        apiRequest<GroupMembersResponse>(`/api/teams/${encodeURIComponent(dashboard.teamId)}/groups/${encodeURIComponent(group.id)}/members`, { signal }),
      ]);
      return { members, assigned };
    },
    { trackMainBusy: false },
  );
  React.useEffect(() => {
    if (resource.status === "ready" && resource.data) setSelected(new Set(resource.data.assigned.members.map((member) => member.id)));
  }, [resource.status, resource.data]);
  if (!group) return null;

  function toggleMember(memberId: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(memberId);
      else next.delete(memberId);
      return next;
    });
  }

  async function saveMembers() {
    if (!group) return;
    setBusy(true);
    try {
      await apiRequest(`/api/teams/${encodeURIComponent(dashboard.teamId)}/groups/${encodeURIComponent(group.id)}/members`, {
        method: "PUT",
        body: { userIds: [...selected] },
      });
      toast.success("Group members saved");
      onOpenChange(false);
      onSaved();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{group.name} members</DialogTitle>
          <DialogDescription>Select active team members who should inherit this group’s app access.</DialogDescription>
        </DialogHeader>
        {resource.status === "loading" ? <RouteLoading label="Loading members…" /> : null}
        {resource.status === "error" ? <RouteError message={resource.error} retry={resource.retry} /> : null}
        {resource.status === "ready" && resource.data ? (
          <div className="check-list">
            {resource.data.members.members.map((member) => {
              const active = member.status === "active";
              const checked = selected.has(member.id);
              const status = !active && checked ? "suspended · removed if you save" : member.status;
              return (
                <label className="check-row" key={member.id}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!active || !canAdmin}
                    onChange={(event) => toggleMember(member.id, event.target.checked)}
                  />
                  <span>{member.name || member.email}<small>{member.email || ""} · {status}</small></span>
                </label>
              );
            })}
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          {canAdmin ? (
            <Button disabled={busy || resource.status !== "ready"} onClick={saveMembers}>
              {busy ? <LoaderCircle className="animate-spin" /> : null}Save members
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
