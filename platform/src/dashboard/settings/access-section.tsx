import { Info, LoaderCircle } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { RoleBadge } from "@/components/directory/status";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { apiRequest, errorMessage } from "@/lib/api";
import { useDashboard } from "@/shell/dashboard-context";
import { SettingsSection } from "@/settings/settings-section";
import type { AppAudience, AppDetailResponse, AppRole, GroupSummary, TeamMember } from "@/types/api";

type GroupRole = "viewer" | "editor";

function assignmentNames(items: Array<{ name?: string | null; email?: string | null; slug?: string }>): string {
  return items.map((item) => item.name || item.email || item.slug).filter(Boolean).join(", ");
}

function audienceCopy(audience: AppAudience, teamName: string): string {
  switch (audience) {
    case "restricted":
      return "Only explicitly assigned people and groups can open it.";
    case "team":
      return `Every active member of ${teamName} can open it.`;
    case "public":
      return "Anyone can open it, including people outside the team.";
  }
}

function toggleAssignment<T>(current: Map<string, T>, id: string, role: T, checked: boolean): Map<string, T> {
  const next = new Map(current);
  if (checked) next.set(id, role);
  else next.delete(id);
  return next;
}

function AccessSummary({ detail }: { detail: AppDetailResponse }) {
  const dashboard = useDashboard();
  const { access } = detail;
  const users = access.users || [];
  const groups = access.groups || [];
  const viewerUsers = users.filter((user) => user.role === "viewer");
  const viewerGroups = groups.filter((group) => group.role === "viewer");
  const modifyingUsers = users.filter((user) => (user.role === "editor" || user.role === "owner") && user.id !== access.owner?.id);
  const modifyingGroups = groups.filter((group) => group.role === "editor");
  const assignmentsHidden = access.readOnly && !users.length && !groups.length;

  return (
    <div className="access-summary-grid">
      <section className="access-summary-card open">
        <h3>Who can open</h3>
        <p>{audienceCopy(access.audience, dashboard.team.name)}</p>
        <ul>
          {assignmentsHidden ? (
            <li>Individual and group grants are visible to app owners.</li>
          ) : (
            <>
              <li>{viewerUsers.length ? `Viewer people: ${assignmentNames(viewerUsers)}` : "No individual viewer-only grants."}</li>
              <li>{viewerGroups.length ? `Viewer groups: ${assignmentNames(viewerGroups)}` : "No group viewer-only grants."}</li>
              <li>Editors and owners listed under “Who can modify” can also open the app.</li>
            </>
          )}
        </ul>
      </section>
      <section className="access-summary-card modify">
        <h3>Who can modify</h3>
        <p>Editors can update the app; owners can also manage access and deletion.</p>
        <ul>
          <li>Primary owner: {access.owner?.name || access.owner?.email || "Unknown"}</li>
          {assignmentsHidden ? (
            <li>Additional editor and owner assignments are visible to app owners.</li>
          ) : (
            <>
              <li>{modifyingUsers.length ? `Additional editors or owners: ${assignmentNames(modifyingUsers)}` : "No additional people can modify it."}</li>
              <li>{modifyingGroups.length ? `Editor groups: ${assignmentNames(modifyingGroups)}` : "No groups have editor access."}</li>
            </>
          )}
        </ul>
      </section>
    </div>
  );
}

function AccessSources({ detail }: { detail: AppDetailResponse }) {
  const { access } = detail;
  return (
    <div className="access-callout">
      <div className="effective-role">
        <span>Your effective role</span>
        <strong>{access.effectiveRole || "No access"}</strong>
        <small>The highest role from the sources shown.</small>
      </div>
      <div>
        <h3>Why you have access</h3>
        <div className="source-list">
          {access.sources.length ? (
            access.sources.map((source, index) => (
              <div className="source-row" key={`${source.type}-${source.id || index}`}>
                <span>{source.label}<small>{source.type}</small></span>
                <RoleBadge role={source.role} />
              </div>
            ))
          ) : (
            <div className="source-row text-muted-foreground">No access sources</div>
          )}
        </div>
      </div>
    </div>
  );
}

export function AccessSection({ detail, teamMembers, teamGroups, refresh }: {
  detail: AppDetailResponse;
  teamMembers: TeamMember[];
  teamGroups: GroupSummary[];
  refresh: () => void;
}) {
  const { app, access } = detail;
  const [audience, setAudience] = React.useState(access.audience);
  const [users, setUsers] = React.useState<Map<string, AppRole>>(new Map());
  const [groups, setGroups] = React.useState<Map<string, GroupRole>>(new Map());
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    setAudience(access.audience);
    setUsers(new Map(access.users.map((user) => [user.id, user.role])));
    setGroups(new Map(access.groups.map((group) => [group.id, group.role])));
  }, [access]);

  const primaryOwnerId = access.owner?.id;
  const suspendedAssignments = teamMembers.filter((member) => member.status !== "active" && member.id !== primaryOwnerId && users.has(member.id));
  const blocked = suspendedAssignments.length > 0;
  const visibleMembers = teamMembers.filter((member) => member.status === "active" || member.id === primaryOwnerId || users.has(member.id));

  async function saveAccess(event: React.FormEvent) {
    event.preventDefault();
    if (blocked) return;
    setBusy(true);
    try {
      const userAssignments = [...users].map(([userId, role]) => ({ userId, role }));
      if (primaryOwnerId && !userAssignments.some((assignment) => assignment.userId === primaryOwnerId)) {
        userAssignments.unshift({ userId: primaryOwnerId, role: "owner" });
      }
      await apiRequest(`/api/apps/${encodeURIComponent(app.id)}/access`, {
        method: "PUT",
        body: { audience, users: userAssignments, groups: [...groups].map(([groupId, role]) => ({ groupId, role })) },
      });
      toast.success("Access saved");
      refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function memberSublabel(member: TeamMember, isPrimary: boolean): string {
    if (isPrimary) return "Primary owner";
    if (member.status === "active") return member.email || "Active member";
    return `${member.email || "Member"} · suspended`;
  }

  const readOnlyReason = app.managedBy === "git"
    ? "Access is managed by Git."
    : "Only an app owner can change audience and assignments.";

  return (
    <SettingsSection id="access" title="Access" description="Effective role and every source contributing to it.">
      <AccessSummary detail={detail} />
      <AccessSources detail={detail} />
      {access.readOnly ? (
        <Alert>
          <Info />
          <AlertDescription>{readOnlyReason}</AlertDescription>
        </Alert>
      ) : (
        <form onSubmit={saveAccess}>
          {blocked ? (
            <Alert className="mb-4">
              <Info />
              <AlertDescription>Reactivate {assignmentNames(suspendedAssignments)} before changing access. The API cannot rewrite assignments for suspended members without removing them.</AlertDescription>
            </Alert>
          ) : null}
          <label className="field-block">
            <span className="field-label">Base audience</span>
            <NativeSelect className="w-full" value={audience} disabled={blocked} onChange={(event) => setAudience(event.target.value as typeof audience)}>
              <option value="restricted">Restricted — only assigned people and groups</option>
              <option value="team">Team — every active team member can view</option>
              <option value="public">Public — anyone can view</option>
            </NativeSelect>
          </label>
          <div className="assignment-grid">
            <div>
              <h3>People</h3>
              <div className="assignment-list">
                {visibleMembers.length ? (
                  visibleMembers.map((member) => {
                    const isPrimary = member.id === primaryOwnerId;
                    const active = member.status === "active";
                    const checked = isPrimary || users.has(member.id);
                    const role = isPrimary ? "owner" : users.get(member.id) || "viewer";
                    const label = member.name || member.email || "Member";
                    return (
                      <div className="assignment-row" key={member.id}>
                        <input
                          type="checkbox"
                          aria-label={`Assign ${label}`}
                          checked={checked}
                          disabled={isPrimary || !active || blocked}
                          onChange={(event) => setUsers((current) => toggleAssignment(current, member.id, role, event.target.checked))}
                        />
                        <span>{label}<small>{memberSublabel(member, isPrimary)}</small></span>
                        <NativeSelect
                          className="w-full"
                          aria-label={`Role for ${label}`}
                          value={role}
                          disabled={isPrimary || !active || blocked || !checked}
                          onChange={(event) => setUsers((current) => new Map(current).set(member.id, event.target.value as AppRole))}
                        >
                          <option value="viewer">Viewer</option>
                          <option value="editor">Editor</option>
                          <option value="owner">Owner</option>
                        </NativeSelect>
                      </div>
                    );
                  })
                ) : (
                  <div className="compact-row text-muted-foreground">No team members</div>
                )}
              </div>
            </div>
            <div>
              <h3>Groups</h3>
              <div className="assignment-list">
                {teamGroups.length ? (
                  teamGroups.map((group) => {
                    const checked = groups.has(group.id);
                    const role = groups.get(group.id) || "viewer";
                    return (
                      <div className="assignment-row" key={group.id}>
                        <input
                          type="checkbox"
                          aria-label={`Assign ${group.name}`}
                          checked={checked}
                          disabled={blocked}
                          onChange={(event) => setGroups((current) => toggleAssignment(current, group.id, role, event.target.checked))}
                        />
                        <span>{group.name}<small>{group.memberCount} members</small></span>
                        <NativeSelect
                          className="w-full"
                          aria-label={`Role for ${group.name}`}
                          value={role}
                          disabled={blocked || !checked}
                          onChange={(event) => setGroups((current) => new Map(current).set(group.id, event.target.value as GroupRole))}
                        >
                          <option value="viewer">Viewer</option>
                          <option value="editor">Editor</option>
                        </NativeSelect>
                      </div>
                    );
                  })
                ) : (
                  <div className="compact-row text-muted-foreground">No groups</div>
                )}
              </div>
            </div>
          </div>
          <div className="form-actions">
            <Button type="submit" disabled={blocked || busy}>{busy ? <LoaderCircle className="animate-spin" /> : null}Save access</Button>
          </div>
        </form>
      )}
    </SettingsSection>
  );
}
