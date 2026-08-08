import { APP_HOST_SUFFIX, PLATFORM_ORIGIN, RESERVED_APP_SLUGS, validSlugSyntax } from "./domains";

export type DashboardRoute =
  | { name: "apps"; scope: "all" | "root" }
  | { name: "apps"; scope: "folder"; folderId: string }
  | { name: "settings"; appId: string }
  | { name: "folders" | "groups" | "members" | "tokens" | "setup" }
  | { name: "not-found" };

// Single source of truth for the fixed dashboard paths: both the router and the
// path allowlist read from it, so the two can never drift apart.
const STATIC_ROUTES = new Map<string, DashboardRoute>([
  ["/", { name: "apps", scope: "root" }],
  ["/dashboard", { name: "apps", scope: "all" }],
  ["/setup", { name: "setup" }],
  ["/team/folders", { name: "folders" }],
  ["/team/groups", { name: "groups" }],
  ["/team/members", { name: "members" }],
  ["/account/tokens", { name: "tokens" }],
]);

const DASHBOARD_PATH_PATTERNS = [/^\/folders\/[^/]+$/, /^\/apps\/[^/]+\/settings$/];

export function isDashboardPath(pathname: string): boolean {
  return STATIC_ROUTES.has(pathname) || DASHBOARD_PATH_PATTERNS.some((pattern) => pattern.test(pathname));
}

function decodeRouteSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function parseDashboardRoute(pathname: string): DashboardRoute {
  const staticRoute = STATIC_ROUTES.get(pathname);
  if (staticRoute) return staticRoute;
  const folder = pathname.match(/^\/folders\/([^/]+)$/);
  if (folder) {
    const folderId = decodeRouteSegment(folder[1]!);
    return folderId === null ? { name: "not-found" } : { name: "apps", scope: "folder", folderId };
  }
  const settings = pathname.match(/^\/apps\/([^/]+)\/settings$/);
  if (settings) {
    const appId = decodeRouteSegment(settings[1]!);
    return appId === null ? { name: "not-found" } : { name: "settings", appId };
  }
  return { name: "not-found" };
}

export function isSafeInternalDashboardRoute(value: string | null | undefined, origin = PLATFORM_ORIGIN): boolean {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return false;
  try {
    return isDashboardPath(new URL(value, origin).pathname);
  } catch {
    return false;
  }
}

export function safeExternalAppReturn(value: string | null | undefined): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.port || url.username || url.password) return null;
  if (!url.hostname.endsWith(APP_HOST_SUFFIX)) return null;
  const slug = url.hostname.slice(0, -APP_HOST_SUFFIX.length);
  return validSlugSyntax(slug) && !RESERVED_APP_SLUGS.has(slug) ? url.href : null;
}
