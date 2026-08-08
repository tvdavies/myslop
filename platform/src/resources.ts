import { parseResolvedManifest } from "./manifest";
import type { AppRow } from "./types";

export type ResourceKind = "runtime" | "database" | "storage" | "schedules" | "domain" | "email" | "secrets";

export interface ResourceNode {
  kind: ResourceKind;
  label: "App / runtime" | "Database" | "Storage" | "Schedules" | "Domain" | "Email" | "Secrets";
  status: "active" | "pending" | "unused" | "disabled" | "error";
  detail: string;
  secondary?: string;
}

export interface ResourceTopology {
  nodes: ResourceNode[];
  summary: string[];
}

interface DomainStatus {
  hostname: string;
  status: string;
}

interface ScheduleStatus {
  expression: string;
  last_status?: string | null;
}

function activeManifest(manifestJson: string | null) {
  if (!manifestJson) return null;
  try {
    return parseResolvedManifest(JSON.parse(manifestJson));
  } catch {
    return null;
  }
}

function plural(count: number, singular: string, many = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : many}`;
}

function attachedResourceNode(
  kind: Extract<ResourceKind, "database" | "storage">,
  label: ResourceNode["label"],
  attached: boolean,
  pendingRemoval: boolean,
): ResourceNode {
  if (pendingRemoval) return { kind, label, status: "unused", detail: "Pending removal" };
  if (attached) return { kind, label, status: "active", detail: "Attached" };
  return { kind, label, status: "pending", detail: "Declared" };
}

export function buildResourceTopology(input: {
  app: Pick<AppRow, "slug" | "active_version" | "d1_id" | "r2_bucket" | "d1_delete_after" | "r2_delete_after">;
  manifestJson?: string | null;
  domains?: DomainStatus[];
  schedules?: ScheduleStatus[];
  configuredSecrets?: string[];
}): ResourceTopology {
  const manifest = activeManifest(input.manifestJson ?? null);
  const runtime = manifest?.capabilities;
  const nodes: ResourceNode[] = [];
  const runtimeDetails: string[] = [];
  if (manifest?.assets) runtimeDetails.push("static content");
  if (manifest?.worker) runtimeDetails.push("server runtime");
  if (runtime?.network.length) runtimeDetails.push(plural(runtime.network.length, "approved host"));
  if (runtime?.durableObjects.length) runtimeDetails.push(plural(runtime.durableObjects.length, "durable runtime object"));
  nodes.push({
    kind: "runtime",
    label: "App / runtime",
    status: input.app.active_version ? "active" : "pending",
    detail: input.app.active_version ? `Version ${input.app.active_version} active` : "Not deployed",
    secondary: runtimeDetails.join(" · ") || undefined,
  });

  if (input.app.d1_id || runtime?.database) {
    nodes.push(attachedResourceNode("database", "Database", Boolean(input.app.d1_id), Boolean(input.app.d1_delete_after)));
  }
  if (input.app.r2_bucket || runtime?.files) {
    nodes.push(attachedResourceNode("storage", "Storage", Boolean(input.app.r2_bucket), Boolean(input.app.r2_delete_after)));
  }

  const schedules: ScheduleStatus[] = input.schedules ?? (runtime?.schedules ?? []).map((expression) => ({ expression }));
  if (schedules.length) {
    const failed = schedules.some(({ last_status }) => last_status === "failed");
    nodes.push({
      kind: "schedules",
      label: "Schedules",
      status: failed ? "error" : "active",
      detail: plural(schedules.length, "schedule"),
      secondary: failed ? "A recent run failed" : schedules.map(({ expression }) => expression).join(" · "),
    });
  }

  const domains = input.domains ?? [];
  const activeAliases = domains.filter(({ status }) => status === "active");
  const domainError = domains.some(({ status }) => status === "error");
  nodes.push({
    kind: "domain",
    label: "Domain",
    status: domainError ? "error" : "active",
    detail: `${input.app.slug}.myslop.app`,
    secondary: activeAliases.length ? plural(activeAliases.length, "active alias", "active aliases") : undefined,
  });

  if (runtime?.email) {
    nodes.push({ kind: "email", label: "Email", status: "active", detail: "Inbound delivery enabled" });
  }

  const requiredSecrets = runtime?.secrets ?? [];
  const configured = new Set(input.configuredSecrets ?? []);
  if (requiredSecrets.length || configured.size) {
    const ready = requiredSecrets.filter((name) => configured.has(name)).length;
    nodes.push({
      kind: "secrets",
      label: "Secrets",
      status: ready === requiredSecrets.length ? "active" : "pending",
      detail: requiredSecrets.length ? `${ready} of ${requiredSecrets.length} configured` : plural(configured.size, "configured secret"),
    });
  }

  return {
    nodes,
    summary: nodes.filter(({ kind }) => kind !== "runtime").map(({ label }) => label),
  };
}
