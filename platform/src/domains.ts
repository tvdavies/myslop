export const PLATFORM_HOST = "myslop.cloud";
export const PLATFORM_ORIGIN = `https://${PLATFORM_HOST}`;
export const PLATFORM_APEX_HOST = "myslop.app";
export const LEGACY_PLATFORM_HOST = "apps.myslop.app";
export const APP_HOST_SUFFIX = ".myslop.app";
export const LEGACY_APP_HOST_SUFFIX = ".apps.myslop.app";

export const PASSTHROUGH_HOSTS = new Set([
  "events.myslop.app",
  "hello.myslop.app",
  "os.myslop.app",
  "state.myslop.app",
  "storage.myslop.app",
  "todo.myslop.app",
]);

export const RESERVED_APP_SLUGS = new Set([
  "apps",
  "events",
  "hello",
  "os",
  "state",
  "storage",
  "todo",
  "www",
]);

export function validSlugSyntax(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9-]{1,46}[a-z0-9]$/.test(value);
}

export function validSlug(value: unknown): value is string {
  return validSlugSyntax(value);
}

export function validAppSlug(value: unknown): value is string {
  return validSlugSyntax(value) && !RESERVED_APP_SLUGS.has(value);
}

export function appHostname(slug: string): string {
  return `${slug}${APP_HOST_SUFFIX}`;
}

export function appUrl(slug: string): string {
  return `https://${appHostname(slug)}`;
}

export function appSlugFromHostname(hostname: string): string | null {
  if (!hostname.endsWith(APP_HOST_SUFFIX) || hostname === PLATFORM_APEX_HOST) return null;
  const slug = hostname.slice(0, -APP_HOST_SUFFIX.length);
  return validAppSlug(slug) ? slug : null;
}

export function legacyAppSlugFromHostname(hostname: string): string | null {
  if (!hostname.endsWith(LEGACY_APP_HOST_SUFFIX) || hostname === LEGACY_PLATFORM_HOST) return null;
  const slug = hostname.slice(0, -LEGACY_APP_HOST_SUFFIX.length);
  return validAppSlug(slug) ? slug : null;
}

export function platformRedirect(url: URL): URL {
  const target = new URL(url.toString());
  target.protocol = "https:";
  target.host = PLATFORM_HOST;
  return target;
}

export function slugSuggestions(slug: string, teamSlug: string, suffix: string): string[] {
  const candidates = [`${slug}-${teamSlug}`, `${slug}-${suffix}`]
    .map((value) => value.slice(0, 48).replace(/-+$/, ""));
  return [...new Set(candidates)].filter(validAppSlug);
}
