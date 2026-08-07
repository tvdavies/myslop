import { Info } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { RouteError, TableLoading } from "@/components/feedback/route-state";
import { PageHeader } from "@/components/page-header";
import { Panel, PanelHeader } from "@/components/panel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useRouteResource } from "@/hooks/use-route-resource";
import { apiRequest, errorMessage } from "@/lib/api";
import { formatDate, safeImageUrl } from "@/lib/format";
import { useDashboard } from "@/shell/dashboard-context";
import type { MembershipStatus, MembersResponse, TeamMember, TeamRole } from "@/types/api";

const ROLE_OPTIONS: Array<{ value: TeamRole; label: string }> = [
  { value: "member", label: "Member" },
  { value: "admin", label: "Admin" },
];

const STATUS_OPTIONS: Array<{ value: MembershipStatus; label: string }> = [
  { value: "active", label: "Active" },
  { value: "suspended", label: "Suspended" },
];

function memberLabel(member: TeamMember): string {
  return member.name || member.email || "Member";
}

function MemberIdentity({ member }: { member: TeamMember }) {
  const image = safeImageUrl(member.picture);
  const label = memberLabel(member);
  return (
    <div className="member-identity">
      {image ? <img src={image} alt="" /> : <span className="app-glyph" aria-hidden="true">{label.charAt(0).toUpperCase()}</span>}
      <span><strong>{label}</strong><small>{member.email || ""}</small></span>
    </div>
  );
}

// Read-only viewers see a badge; admins get a select. The mobile layout omits
// `ariaLabel` because its visible <label> already names the control.
function MemberControl<T extends string>({ editable, value, options, disabled, ariaLabel, onChange }: {
  editable: boolean;
  value: T;
  options: Array<{ value: T; label: string }>;
  disabled: boolean;
  ariaLabel?: string;
  onChange: (value: T) => void;
}) {
  if (!editable) return <Badge variant="outline">{value}</Badge>;
  return (
    <NativeSelect
      className="w-full"
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as T)}
    >
      {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </NativeSelect>
  );
}

export function MembersPage() {
  const dashboard = useDashboard();
  const [revision, setRevision] = React.useState(0);
  const [updating, setUpdating] = React.useState<string | null>(null);
  useDocumentTitle("Members");

  const resource = useRouteResource(`members:${dashboard.teamId}:${revision}`, (signal) =>
    apiRequest<MembersResponse>(`/api/teams/${encodeURIComponent(dashboard.teamId)}/members`, { signal }),
  );

  async function update(memberId: string, body: { role?: TeamRole; status?: MembershipStatus }, success: string) {
    setUpdating(memberId);
    try {
      await apiRequest(`/api/teams/${encodeURIComponent(dashboard.teamId)}/members/${encodeURIComponent(memberId)}`, { method: "PATCH", body });
      toast.success(success);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setUpdating(null);
      setRevision((value) => value + 1);
    }
  }

  function roleControl(member: TeamMember, canAdmin: boolean, ariaLabel?: string) {
    return (
      <MemberControl
        editable={canAdmin}
        value={member.role}
        options={ROLE_OPTIONS}
        disabled={updating === member.id}
        ariaLabel={ariaLabel}
        onChange={(role) => void update(member.id, { role }, "Member role updated")}
      />
    );
  }

  function statusControl(member: TeamMember, canAdmin: boolean, ariaLabel?: string) {
    return (
      <MemberControl
        editable={canAdmin}
        value={member.status}
        options={STATUS_OPTIONS}
        disabled={updating === member.id}
        ariaLabel={ariaLabel}
        onChange={(status) => void update(member.id, { status }, "Member status updated")}
      />
    );
  }

  return (
    <div className="content-width">
      <PageHeader
        crumbs={[dashboard.team.name, "Members"]}
        title="Members"
        description="Team membership controls who can receive app and group access."
      />
      {resource.status === "loading" ? (
        <TableLoading
          label="Loading members…"
          title="Team members"
          headers={["Member", "Team role", "Status", "Joined"]}
          hasActions={false}
        />
      ) : null}
      {resource.status === "error" ? <RouteError message={resource.error} retry={resource.retry} /> : null}
      {resource.status === "ready" ? (
        <>
          {resource.data.canAdmin ? (
            <Alert className="mb-3">
              <Info />
              <AlertDescription>Role and status changes save immediately. Suspending someone removes team-derived access without deleting assignments.</AlertDescription>
            </Alert>
          ) : null}
          <Panel>
            <PanelHeader title="Team members" meta={`${resource.data.members.length} members`} />
            <div className="desktop-directory">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Member</TableHead>
                    <TableHead>Team role</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Joined</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {resource.data.members.map((member) => (
                    <TableRow key={member.id}>
                      <TableCell><MemberIdentity member={member} /></TableCell>
                      <TableCell>{roleControl(member, resource.data.canAdmin, `Role for ${memberLabel(member)}`)}</TableCell>
                      <TableCell>{statusControl(member, resource.data.canAdmin, `Status for ${memberLabel(member)}`)}</TableCell>
                      <TableCell>{formatDate(member.created_at)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="mobile-directory">
              {resource.data.members.map((member) => (
                <article className="mobile-admin-row" key={member.id}>
                  <MemberIdentity member={member} />
                  <div className="mobile-member-controls">
                    <label>Role{roleControl(member, resource.data.canAdmin)}</label>
                    <label>Status{statusControl(member, resource.data.canAdmin)}</label>
                  </div>
                  <small>Joined {formatDate(member.created_at)}</small>
                </article>
              ))}
            </div>
          </Panel>
        </>
      ) : null}
    </div>
  );
}
