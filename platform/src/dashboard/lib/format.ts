import type { AppAudience } from "@/types/api";

const AUDIENCE_LABELS: Record<AppAudience, string> = {
  restricted: "Restricted",
  team: "Team",
  public: "Public",
};

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

export function audienceLabel(audience: AppAudience): string {
  return AUDIENCE_LABELS[audience];
}

export function formatDateTime(timestamp: number | null | undefined): string {
  return timestamp ? dateTimeFormatter.format(new Date(timestamp)) : "Never";
}

export function formatDate(timestamp: number | null | undefined): string {
  return timestamp ? dateFormatter.format(new Date(timestamp)) : "Never";
}

export function relativeTime(timestamp: number | null | undefined, now = Date.now()): string {
  if (!timestamp) return "Never deployed";
  const days = Math.floor((now - timestamp) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days} days ago`;
  return formatDate(timestamp);
}

export function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function safeImageUrl(value: string | null | undefined): string {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch {
    return "";
  }
}

const ACTION_LABELS: Record<string, string> = {
  "app.created": "Created app",
  "app.deployed": "Deployed version",
  "app.rolled_back": "Rolled back",
  "app.metadata.updated": "Updated metadata",
  "app.access.updated": "Updated access",
  "app.folder.changed": "Moved app",
  "secret.updated": "Updated secret",
  "app.pruned": "Pruned resources",
  "app.archived": "Deleted app",
  "app.resources_swept": "Removed expired resources",
  "app.domain.attached": "Attached domain",
  "app.domain.detached": "Detached domain",
};

export function actionLabel(action: string): string {
  return ACTION_LABELS[action] || String(action || "Activity").replaceAll(".", " ");
}
