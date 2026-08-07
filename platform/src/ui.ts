export function isDashboardPath(pathname: string): boolean {
  return pathname === "/" ||
    pathname === "/dashboard" ||
    pathname === "/setup" ||
    pathname === "/team/groups" ||
    pathname === "/team/folders" ||
    pathname === "/team/members" ||
    pathname === "/account/tokens" ||
    /^\/folders\/[^/]+$/.test(pathname) ||
    /^\/apps\/[^/]+\/settings$/.test(pathname);
}
