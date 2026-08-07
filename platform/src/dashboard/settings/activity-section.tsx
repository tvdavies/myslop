import { EmptyState } from "@/components/feedback/route-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { actionLabel, formatDateTime } from "@/lib/format";
import { SettingsSection } from "@/settings/settings-section";
import type { ActivityEntry, AppDetailResponse } from "@/types/api";

function ActivityIdentity({ entry }: { entry: ActivityEntry }) {
  return (
    <div className="name-stack">
      <strong>{actionLabel(entry.action)}</strong>
      {entry.detail ? <small className="activity-detail">{JSON.stringify(entry.detail)}</small> : null}
    </div>
  );
}

function actorName(entry: ActivityEntry): string {
  return entry.user_name || entry.user_email || "System";
}

export function ActivitySection({ detail }: { detail: AppDetailResponse }) {
  return (
    <SettingsSection id="activity" title="Activity" description="Recent administrative and deployment events.">
      {detail.activity.length ? (
        <>
          <div className="desktop-directory">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Event</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Time</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.activity.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell><ActivityIdentity entry={entry} /></TableCell>
                    <TableCell>{actorName(entry)}</TableCell>
                    <TableCell>{formatDateTime(entry.created_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="mobile-directory">
            {detail.activity.map((entry) => (
              <article className="mobile-admin-row" key={entry.id}>
                <ActivityIdentity entry={entry} />
                <small>{actorName(entry)} · {formatDateTime(entry.created_at)}</small>
              </article>
            ))}
          </div>
        </>
      ) : (
        <EmptyState title="No activity" description="Audit events will appear here." />
      )}
    </SettingsSection>
  );
}
