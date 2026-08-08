import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const team = { id: "team_default", slug: "lleverage", name: "Lleverage", role: "admin" as const };
const folders = [
  { id: "folder-commercial", slug: "commercial", name: "Commercial", parentId: null, appCount: 1, createdAt: 1, updatedAt: 1 },
  { id: "folder-reports", slug: "reports", name: "Reports", parentId: "folder-commercial", appCount: 0, createdAt: 1, updatedAt: 1 },
];
const members = [
  { id: "user-1", email: "tom@example.com", name: "Tom Davies", picture: null, role: "admin" as const, status: "active" as const, created_at: Date.UTC(2026, 0, 5), updated_at: 1 },
  { id: "user-2", email: "alex@example.com", name: "Alex Morgan", picture: null, role: "member" as const, status: "suspended" as const, created_at: Date.UTC(2026, 1, 6), updated_at: 1 },
];
const groups = [
  { id: "group-sales", slug: "sales", name: "Sales", description: "Commercial team", memberCount: 4, appCount: 1, createdAt: 1, updatedAt: Date.UTC(2026, 7, 7) },
];
const tokens = [
  { id: "tok-1", name: "Laptop", prefix: "msa_abc", app_id: null, team_id: null, created_at: Date.UTC(2026, 6, 1), last_used_at: null, expires_at: null },
  { id: "tok-2", name: "Agent", prefix: "msa_xyz", app_id: "app-1", team_id: null, created_at: Date.UTC(2026, 6, 2), last_used_at: Date.UTC(2026, 7, 1), expires_at: null },
  { id: "tok-3", name: "Team deploy", prefix: "msa_team", app_id: null, team_id: team.id, created_at: Date.UTC(2026, 6, 3), last_used_at: null, expires_at: null },
];
const app = {
  id: "app-1", slug: "commercial-dashboard", name: "Commercial Dashboard", description: "Pipeline",
  visibility: "private" as const, audience: "restricted" as const, teamId: team.id, folderId: folders[0]!.id,
  url: "https://commercial-dashboard.myslop.app", activeVersion: 4, hasDatabase: true, hasFiles: false,
  databaseDeleteAfter: null, filesDeleteAfter: null, databaseAdopted: false, filesAdopted: false,
  managedBy: "manual" as const, sourceHash: null, deploymentHash: null,
  createdAt: 1, updatedAt: Date.UTC(2026, 7, 7), role: "owner" as const,
  permissions: { role: "owner" as const, open: true, viewSettings: true, modifyMetadata: true, modifyRuntime: true, modifySecrets: true, modifyAccess: true, moveApp: true, destroy: true },
  owner: { id: "user-1", name: "Tom Davies", email: "tom@example.com" },
  resources: { summary: [], nodes: [] },
};

function json(route: Route, value: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
}

async function mock(page: Page, options: {
  onRequest?: (path: string) => void;
  delayPath?: string;
  delayMs?: number;
} = {}) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    options.onRequest?.(path);
    if (path === options.delayPath) await new Promise((resolve) => setTimeout(resolve, options.delayMs || 0));
    if (path === "/api/me") {
      return json(route, {
        user: { id: "user-1", email: "tom@example.com", name: "Tom Davies", picture: null, platform_role: "owner" },
        teams: [team], defaultTeamId: team.id, platformOwner: true,
      });
    }
    if (path === `/api/teams/${team.id}/folders`) return json(route, { folders, rootAppCount: 2, canAdmin: true });
    if (path === `/api/teams/${team.id}/members`) return json(route, { members, canAdmin: true });
    if (path === `/api/teams/${team.id}/groups`) return json(route, { groups, canAdmin: true });
    if (path === "/api/tokens") return json(route, { tokens });
    if (path === "/api/apps") return json(route, { apps: [app] });
    return json(route, { error: `unmocked ${path}` }, 404);
  });
}

async function axeClean(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
  expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
}

test("members page renders identity, role and status controls in both layouts", async ({ page }) => {
  await mock(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/team/members?teamId=${team.id}`);

  await expect(page.getByRole("heading", { level: 1, name: "Members" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Role for Tom Davies" })).toHaveValue("admin");
  await expect(page.getByRole("combobox", { name: "Status for Alex Morgan" })).toHaveValue("suspended");
  await expect(page.locator(".desktop-directory .member-identity")).toHaveCount(2);
  await axeClean(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".mobile-directory .mobile-admin-row")).toHaveCount(2);
  await expect(page.locator(".mobile-member-controls").first()).toContainText("Role");
  await expect(page.locator(".mobile-member-controls").first()).toContainText("Status");
  await axeClean(page);
});

test("folders page renders nested rows and admin actions", async ({ page }) => {
  await mock(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/team/folders?teamId=${team.id}`);

  await expect(page.getByRole("heading", { level: 1, name: "Folders" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Commercial / Reports" })).toBeVisible();
  await expect(page.locator(".desktop-directory").getByRole("button", { name: "Delete" })).toHaveCount(2);
  await expect(page.locator(".desktop-directory").getByRole("link", { name: "Open" })).toHaveCount(2);
  await axeClean(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".mobile-directory .mobile-admin-row")).toHaveCount(2);
  await axeClean(page);
});

test("groups page renders group rows and member actions", async ({ page }) => {
  await mock(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/team/groups?teamId=${team.id}`);

  await expect(page.getByRole("heading", { level: 1, name: "Groups" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Sales Commercial team" })).toBeVisible();
  await expect(page.locator(".desktop-directory").getByRole("button", { name: "Members" })).toHaveCount(1);
  await axeClean(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".mobile-directory .mobile-admin-row")).toHaveCount(1);
  await axeClean(page);
});

test("shows a table-shaped loading state for slower directory requests", async ({ page }) => {
  const groupsPath = `/api/teams/${team.id}/groups`;
  await mock(page, { delayPath: groupsPath, delayMs: 500 });
  await page.goto(`/team/groups?teamId=${team.id}`);

  const loading = page.locator(".table-loading");
  await expect(loading).toBeVisible();
  await expect(loading.locator("th")).toHaveText(["Group", "Members", "Apps", "Updated", "Actions"]);
  await expect(loading.locator('.desktop-directory [data-slot="skeleton"]')).toHaveCount(35);
  await expect(page.getByRole("cell", { name: "Sales Commercial team" })).toBeVisible();
  await expect(loading).toHaveCount(0);
});

test("reuses recent table data when navigating back to a page", async ({ page }) => {
  const requests = new Map<string, number>();
  await mock(page, { onRequest: (path) => requests.set(path, (requests.get(path) || 0) + 1) });
  await page.goto(`/team/groups?teamId=${team.id}`);

  await expect(page.getByRole("cell", { name: "Sales Commercial team" })).toBeVisible();
  await page.getByRole("link", { name: "Members" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Members" })).toBeVisible();
  await page.getByRole("link", { name: "Groups" }).click();
  await expect(page.getByRole("cell", { name: "Sales Commercial team" })).toBeVisible();

  expect(requests.get(`/api/teams/${team.id}/groups`)).toBe(1);
  await expect(page.locator(".table-loading")).toHaveCount(0);
});

test("tokens page renders scope labels for global, team and app-scoped tokens", async ({ page }) => {
  await mock(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/account/tokens");

  await expect(page.getByRole("heading", { level: 1, name: "Agent API tokens" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "All manageable apps" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Commercial Dashboard" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Lleverage", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Never" }).first()).toBeVisible();

  const tokenName = page.getByLabel("Token name");
  const tokenScope = page.getByLabel("Scope");
  const [nameBox, scopeBox] = await Promise.all([tokenName.boundingBox(), tokenScope.boundingBox()]);
  expect(nameBox).not.toBeNull();
  expect(scopeBox).not.toBeNull();
  expect(nameBox!.y).toBeCloseTo(scopeBox!.y, 0);
  expect(nameBox!.height).toBe(36);
  expect(scopeBox!.height).toBe(36);
  await axeClean(page);

  await page.setViewportSize({ width: 390, height: 844 });
  const [mobileNameBox, mobileScopeBox] = await Promise.all([tokenName.boundingBox(), tokenScope.boundingBox()]);
  expect(mobileNameBox).not.toBeNull();
  expect(mobileScopeBox).not.toBeNull();
  expect(mobileScopeBox!.y).toBeGreaterThan(mobileNameBox!.y + mobileNameBox!.height);
  await expect(page.locator(".mobile-directory .mobile-admin-row")).toHaveCount(3);
  await expect(page.locator(".mobile-directory")).toContainText("All manageable apps");
  await axeClean(page);
});
