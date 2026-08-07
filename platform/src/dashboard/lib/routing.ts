export {
  isSafeInternalDashboardRoute,
  parseDashboardRoute,
  safeExternalAppReturn,
  type DashboardRoute,
} from "../../ui";

export interface DashboardLocation {
  pathname: string;
  search: string;
  hash: string;
}

export interface AppListState {
  q: string;
  audience: "" | "restricted" | "team" | "public";
  role: "" | "viewer" | "editor" | "owner";
  sort: "updated" | "name" | "created";
  direction: "asc" | "desc";
}

export function currentDashboardLocation(): DashboardLocation {
  return { pathname: location.pathname, search: location.search, hash: location.hash };
}

export function parseAppListState(search: string): AppListState {
  const parameters = new URLSearchParams(search);
  const audience = parameters.get("audience");
  const role = parameters.get("role");
  const sort = parameters.get("sort");
  return {
    q: parameters.get("q") || "",
    audience: audience === "restricted" || audience === "team" || audience === "public" ? audience : "",
    role: role === "viewer" || role === "editor" || role === "owner" ? role : "",
    sort: sort === "name" || sort === "created" ? sort : "updated",
    direction: parameters.get("direction") === "asc" ? "asc" : "desc",
  };
}

export function dashboardHref(pathname: string, teamId: string | null, extra: Record<string, string | null | undefined> = {}): string {
  const url = new URL(pathname, location.origin);
  if (teamId) url.searchParams.set("teamId", teamId);
  for (const [key, value] of Object.entries(extra)) {
    if (value) url.searchParams.set(key, value);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export function shouldHandleAnchorClick(event: React.MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}
