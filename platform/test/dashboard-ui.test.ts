import { describe, expect, test } from "bun:test";
import {
  isDashboardPath,
  isSafeInternalDashboardRoute,
  parseDashboardRoute,
  safeExternalAppReturn,
} from "../src/ui";
import {
  availableFolderOptions,
  descendantFolderIds,
  folderPath,
  nestedFolders,
} from "../src/dashboard/lib/folders";
import { selectActiveTeamId, shouldFocusMainRoute } from "../src/dashboard/lib/dashboard-state";
import { relativeTime, slugify } from "../src/dashboard/lib/format";
import { resolveTheme } from "../src/dashboard/theme/theme-provider";
import type { FolderSummary } from "../src/dashboard/types/api";

const folders: FolderSummary[] = [
  { id: "b", slug: "child", name: "Child", parentId: "a", appCount: 1, createdAt: 1, updatedAt: 1 },
  { id: "c", slug: "other", name: "Other", parentId: null, appCount: 0, createdAt: 1, updatedAt: 1 },
  { id: "a", slug: "parent", name: "Parent", parentId: null, appCount: 2, createdAt: 1, updatedAt: 1 },
];

describe("dashboard routes", () => {
  test("parses every refreshable route", () => {
    expect(parseDashboardRoute("/")).toEqual({ name: "apps", scope: "root" });
    expect(parseDashboardRoute("/dashboard")).toEqual({ name: "apps", scope: "all" });
    expect(parseDashboardRoute("/folders/folder%201")).toEqual({ name: "apps", scope: "folder", folderId: "folder 1" });
    expect(parseDashboardRoute("/apps/app%201/settings")).toEqual({ name: "settings", appId: "app 1" });
    expect(parseDashboardRoute("/team/groups")).toEqual({ name: "groups" });
    expect(parseDashboardRoute("/team/folders")).toEqual({ name: "folders" });
    expect(parseDashboardRoute("/team/members")).toEqual({ name: "members" });
    expect(parseDashboardRoute("/account/tokens")).toEqual({ name: "tokens" });
    expect(parseDashboardRoute("/setup")).toEqual({ name: "setup" });
    expect(parseDashboardRoute("/folders/%")).toEqual({ name: "not-found" });
    expect(parseDashboardRoute("/apps/%/settings")).toEqual({ name: "not-found" });
    expect(parseDashboardRoute("/missing")).toEqual({ name: "not-found" });
  });

  test("keeps the router and the path allowlist in agreement", () => {
    const routable = [
      "/",
      "/dashboard",
      "/setup",
      "/team/folders",
      "/team/groups",
      "/team/members",
      "/account/tokens",
      "/folders/a",
      "/apps/a/settings",
    ];
    for (const pathname of routable) {
      expect(isDashboardPath(pathname)).toBe(true);
      expect(parseDashboardRoute(pathname).name).not.toBe("not-found");
    }
    for (const pathname of ["/missing", "/api/me", "/folders/a/b", "/apps/a/settings/extra"]) {
      expect(isDashboardPath(pathname)).toBe(false);
      expect(parseDashboardRoute(pathname).name).toBe("not-found");
    }
  });

  test("accepts only dashboard-owned internal returns", () => {
    expect(isSafeInternalDashboardRoute("/apps/a/settings?teamId=t#access")).toBe(true);
    expect(isSafeInternalDashboardRoute("/folders/a?q=test")).toBe(true);
    expect(isSafeInternalDashboardRoute("//evil.example/dashboard")).toBe(false);
    expect(isSafeInternalDashboardRoute("https://evil.example/dashboard")).toBe(false);
    expect(isSafeInternalDashboardRoute("/api/me")).toBe(false);
    expect(isDashboardPath("/dashboard")).toBe(true);
  });

  test("validates external app return URLs", () => {
    expect(safeExternalAppReturn("https://valid-app.apps.myslop.app/path?q=1")).toBe("https://valid-app.apps.myslop.app/path?q=1");
    expect(safeExternalAppReturn("http://valid-app.apps.myslop.app/")).toBeNull();
    expect(safeExternalAppReturn("https://apps.myslop.app/")).toBeNull();
    expect(safeExternalAppReturn("https://valid-app.apps.myslop.app:444/")).toBeNull();
    expect(safeExternalAppReturn("https://user@valid-app.apps.myslop.app/")).toBeNull();
    expect(safeExternalAppReturn("https://invalid_.apps.myslop.app/")).toBeNull();
  });
});

describe("dashboard shell state", () => {
  const teams = [
    { id: "team-a", slug: "a", name: "Team A", role: "member" as const },
    { id: "team-b", slug: "b", name: "Team B", role: "admin" as const },
  ];

  test("represents an account with no active team without inventing an id", () => {
    expect(selectActiveTeamId([], null, null)).toBeNull();
    expect(selectActiveTeamId(teams, "missing", "team-b")).toBe("team-b");
    expect(selectActiveTeamId(teams, "team-a", "team-b")).toBe("team-a");
  });

  test("moves route focus only for pathname changes outside main", () => {
    expect(shouldFocusMainRoute("/dashboard", "/dashboard", false)).toBe(false);
    expect(shouldFocusMainRoute("/dashboard", "/dashboard", true)).toBe(false);
    expect(shouldFocusMainRoute("/dashboard", "/team/groups", true)).toBe(false);
    expect(shouldFocusMainRoute("/dashboard", "/team/groups", false)).toBe(true);
  });
});

describe("dashboard pure helpers", () => {
  test("orders folders, formats paths, and excludes descendants", () => {
    expect(nestedFolders(folders).map(({ folder, depth }) => [folder.name, depth])).toEqual([
      ["Other", 0],
      ["Parent", 0],
      ["Child", 1],
    ]);
    expect(folderPath(folders, folders[0]!)).toBe("Parent / Child");
    expect(descendantFolderIds(folders, "a")).toEqual(new Set(["a", "b"]));
    expect(availableFolderOptions(folders, "a").map(({ folder }) => folder.id)).toEqual(["c"]);
  });

  test("survives a parent cycle without looping forever", () => {
    const cyclic: FolderSummary[] = [
      { id: "x", slug: "x", name: "X", parentId: "y", appCount: 0, createdAt: 1, updatedAt: 1 },
      { id: "y", slug: "y", name: "Y", parentId: "x", appCount: 0, createdAt: 1, updatedAt: 1 },
    ];
    expect(folderPath(cyclic, cyclic[0]!)).toBe("Y / X");
    expect(nestedFolders(cyclic)).toEqual([]);
  });

  test("resolves system themes and formats stable labels", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(slugify(" Commercial & Ops ")).toBe("commercial-ops");
    const now = Date.UTC(2026, 7, 7, 12);
    expect(relativeTime(now, now)).toBe("Today");
    expect(relativeTime(now - 86_400_000, now)).toBe("Yesterday");
    expect(relativeTime(now - 5 * 86_400_000, now)).toBe("5 days ago");
  });
});
