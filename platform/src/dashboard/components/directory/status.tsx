import { AlertTriangle, CheckCircle2, CircleDashed, Clock3, Eye, GitBranch, LockKeyhole, Pencil, Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { audienceLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { AppAudience, AppRole, ResourceNode, ResourceStatus } from "@/types/api";

const statusIcon: Record<ResourceStatus, typeof CheckCircle2> = {
  active: CheckCircle2,
  pending: Clock3,
  unused: AlertTriangle,
  disabled: CircleDashed,
  error: AlertTriangle,
};

const roleIcon: Record<AppRole, typeof Eye> = {
  viewer: Eye,
  editor: Pencil,
  owner: LockKeyhole,
};

export function RoleBadge({ role }: { role: AppRole | null }) {
  const Icon = role ? roleIcon[role] : Eye;
  return <Badge variant="outline" className={cn("role-badge", role && `is-${role}`)}><Icon />{role || "No access"}</Badge>;
}

export function AudienceBadge({ audience }: { audience: AppAudience }) {
  const Icon = audience === "restricted" ? LockKeyhole : Users;
  return <Badge variant="outline" className={cn("audience-badge", `is-${audience}`)}><Icon />{audienceLabel(audience)}</Badge>;
}

export function GitBadge() {
  return <Badge variant="outline" className="git-badge"><GitBranch />Git managed</Badge>;
}

function normalizeStatus(status: ResourceStatus | string): ResourceStatus {
  return status in statusIcon ? status as ResourceStatus : "disabled";
}

export function StatusBadge({ status }: { status: ResourceStatus | string }) {
  const normalized = normalizeStatus(status);
  const Icon = statusIcon[normalized];
  return <Badge variant="outline" className={cn("status-badge", `is-${normalized}`)}><Icon />{status}</Badge>;
}

export function ResourceLedger({ nodes, compact = false }: { nodes: ResourceNode[]; compact?: boolean }) {
  if (!nodes.length) return <span className="text-xs text-muted-foreground">Not deployed</span>;
  return (
    <div className={cn("resource-ledger", compact && "is-compact")}>
      {nodes.map((node) => {
        const Icon = statusIcon[normalizeStatus(node.status)];
        return (
          <span key={`${node.kind}-${node.label}`} className={cn("resource-entry", `is-${node.status}`)} title={node.detail}>
            <Icon aria-hidden="true" />
            <span>{node.label}</span>
          </span>
        );
      })}
    </div>
  );
}
