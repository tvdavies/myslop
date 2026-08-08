import { CalendarClock, Globe2 } from "lucide-react";

import { StatusBadge } from "@/components/directory/status";
import { formatDateTime } from "@/lib/format";
import { SettingsSection } from "@/settings/settings-section";
import type { AppDetailResponse, ScheduleSummary } from "@/types/api";

function scheduleDetail(schedule: ScheduleSummary): string {
  if (schedule.last_error) return schedule.last_error;
  return schedule.next_run_at ? `Next ${formatDateTime(schedule.next_run_at)}` : "No run scheduled";
}

export function ResourcesSection({ detail }: { detail: AppDetailResponse }) {
  return (
    <SettingsSection id="resources" title="Resources" description="The deployed app and the services attached to it.">
      <div className="topology" aria-label="Resource topology">
        {detail.resources.nodes.length ? (
          detail.resources.nodes.map((node) => (
            <div className={`topology-node is-${node.status}`} key={`${node.kind}-${node.label}`}>
              <div>
                <strong>{node.label}</strong>
                <StatusBadge status={node.status} />
              </div>
              <p>{node.detail}{node.secondary ? <small>{node.secondary}</small> : null}</p>
            </div>
          ))
        ) : (
          <p className="text-muted-foreground">No resource topology is available.</p>
        )}
      </div>
      <div className="resource-detail-grid">
        <section>
          <h3><Globe2 />Domains</h3>
          <div className="compact-list">
            {detail.domains.length ? (
              detail.domains.map((domain) => (
                <div className="compact-row" key={domain.hostname}>
                  <span>
                    <strong>{domain.hostname}</strong>
                    <small>{domain.error || formatDateTime(domain.updated_at)}</small>
                  </span>
                  <StatusBadge status={domain.status} />
                </div>
              ))
            ) : (
              <div className="compact-row">
                <span className="font-mono">{detail.app.slug}.myslop.app</span>
                <StatusBadge status="active" />
              </div>
            )}
          </div>
        </section>
        <section>
          <h3><CalendarClock />Schedules</h3>
          <div className="compact-list">
            {detail.schedules.length ? (
              detail.schedules.map((schedule) => (
                <div className="compact-row" key={schedule.id}>
                  <span>
                    <strong className="font-mono">{schedule.expression}</strong>
                    <small>{scheduleDetail(schedule)}</small>
                  </span>
                  <StatusBadge status={schedule.last_status || "pending"} />
                </div>
              ))
            ) : (
              <div className="compact-row text-muted-foreground">No schedules</div>
            )}
          </div>
        </section>
      </div>
    </SettingsSection>
  );
}
