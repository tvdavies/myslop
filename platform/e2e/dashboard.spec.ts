import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const team = { id: "team_default", slug: "lleverage", name: "Lleverage", role: "admin" as const };
const folders = [
  { id: "folder-commercial", slug: "commercial", name: "Commercial", parentId: null, appCount: 1, createdAt: 1, updatedAt: 1 },
  { id: "folder-reports", slug: "reports", name: "Reports", parentId: "folder-commercial", appCount: 0, createdAt: 1, updatedAt: 1 },
];
const resources = {
  summary: ["App / runtime", "Database", "Domain", "Secrets"],
  nodes: [
    { kind: "runtime", label: "App / runtime", status: "active", detail: "Version 4 is active" },
    { kind: "database", label: "Database", status: "active", detail: "Attached" },
    { kind: "storage", label: "Storage", status: "disabled", detail: "Not attached" },
    { kind: "schedules", label: "Schedules", status: "pending", detail: "One schedule" },
    { kind: "domain", label: "Domain", status: "active", detail: "commercial-dashboard.apps.myslop.app" },
    { kind: "email", label: "Email", status: "disabled", detail: "Not enabled" },
    { kind: "secrets", label: "Secrets", status: "active", detail: "2 configured" },
  ],
};
const permissions = {
  role: "owner" as const,
  open: true,
  viewSettings: true,
  modifyMetadata: true,
  modifyRuntime: true,
  modifySecrets: true,
  modifyAccess: true,
  moveApp: true,
  destroy: true,
};
const app = {
  id: "app-1",
  slug: "commercial-dashboard",
  name: "Commercial Dashboard",
  description: "Pipeline, forecast and revenue operations",
  visibility: "private" as const,
  audience: "restricted" as const,
  teamId: team.id,
  folderId: folders[0]!.id,
  url: "https://commercial-dashboard.apps.myslop.app",
  activeVersion: 4,
  hasDatabase: true,
  hasFiles: false,
  databaseDeleteAfter: null,
  filesDeleteAfter: null,
  databaseAdopted: false,
  filesAdopted: false,
  managedBy: "manual" as const,
  sourceHash: null,
  deploymentHash: null,
  createdAt: Date.UTC(2026, 6, 1),
  updatedAt: Date.UTC(2026, 7, 7),
  role: "owner" as const,
  permissions,
  owner: { id: "user-1", name: "Tom Davies", email: "tom@example.com" },
  resources,
};
const members = [
  { id: "user-1", email: "tom@example.com", name: "Tom Davies", picture: null, role: "admin" as const, status: "active" as const, created_at: 1, updated_at: 1 },
  { id: "user-2", email: "alex@example.com", name: "Alex Morgan", picture: null, role: "member" as const, status: "active" as const, created_at: 1, updated_at: 1 },
];
const groups = [
  { id: "group-sales", slug: "sales", name: "Sales", description: "Commercial team", memberCount: 4, appCount: 1, createdAt: 1, updatedAt: 1 },
];

interface MockOptions {
  noTeam?: boolean;
  onCreateApp?: (body: Record<string, unknown>) => void;
}

function json(route: Route, value: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
}

async function mockDashboard(page: Page, options: MockOptions = {}) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path === "/api/me") {
      return json(route, {
        user: { id: "user-1", email: "tom@example.com", name: "Tom Davies", picture: null, platform_role: "owner" },
        teams: options.noTeam ? [] : [team],
        defaultTeamId: options.noTeam ? null : team.id,
        platformOwner: true,
      });
    }
    if (path === `/api/teams/${team.id}/folders`) return json(route, { folders, rootAppCount: 0, canAdmin: true });
    if (path === `/api/teams/${team.id}/members`) return json(route, { members, canAdmin: true });
    if (path === `/api/teams/${team.id}/groups`) return json(route, { groups, canAdmin: true });
    if (path === "/api/apps" && request.method() === "POST") {
      options.onCreateApp?.(request.postDataJSON() as Record<string, unknown>);
      return json(route, { app }, 201);
    }
    if (path === "/api/apps") return json(route, { apps: [app] });
    if (path === `/api/apps/${app.id}`) {
      return json(route, {
        app,
        access: {
          audience: "restricted",
          effectiveRole: "owner",
          sources: [{ type: "owner", role: "owner", label: "Primary app owner", id: "user-1" }],
          owner: { id: "user-1", email: "tom@example.com", name: "Tom Davies", picture: null },
          users: [
            { id: "user-1", email: "tom@example.com", name: "Tom Davies", picture: null, role: "owner" },
            { id: "user-2", email: "alex@example.com", name: "Alex Morgan", picture: null, role: "viewer" },
          ],
          groups: [{ id: "group-sales", slug: "sales", name: "Sales", description: "Commercial team", role: "editor", member_count: 4 }],
          managedBy: "manual",
          readOnly: false,
        },
        deployments: [
          { version: 4, created_at: Date.UTC(2026, 7, 7), status: "active", has_worker: true, created_by_name: "Tom Davies" },
          { version: 3, created_at: Date.UTC(2026, 7, 1), status: "active", has_worker: true, created_by_name: "Alex Morgan" },
        ],
        secrets: [{ name: "CRM_TOKEN", updated_at: Date.UTC(2026, 7, 6) }],
        domains: [{ hostname: "commercial-dashboard.apps.myslop.app", status: "active", error: null, created_at: 1, updated_at: 1 }],
        schedules: [{ id: "daily", expression: "0 7 * * 1-5", next_run_at: Date.UTC(2026, 7, 8, 7), last_run_at: null, last_status: "pending", last_error: null }],
        activity: [{ id: "audit-1", action: "app.deployed", detail: { version: 4 }, created_at: Date.UTC(2026, 7, 7), user_name: "Tom Davies", user_email: "tom@example.com" }],
        resources,
      });
    }
    return json(route, { error: `unmocked ${request.method()} ${path}` }, 404);
  });
}

async function expectNoSeriousAccessibilityViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  const violations = results.violations.filter((violation) => violation.impact === "critical" || violation.impact === "serious");
  expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
}

async function expectNoPageOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test("renders the authenticated app library and persists a dark theme", async ({ page }) => {
  await mockDashboard(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/dashboard?teamId=${team.id}`);

  await expect(page.getByRole("heading", { level: 1, name: "All apps" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Commercial Dashboard Pipeline, forecast and revenue operations" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open" })).toHaveAttribute("target", "_blank");
  await expect(page.getByRole("link", { name: "Settings" })).toBeVisible();

  await page.getByRole("button", { name: "Choose color theme" }).click();
  await page.getByRole("menuitem", { name: "Dark theme" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("myslop-dashboard-theme"))).toBe("dark");

  await expectNoPageOverflow(page);
  await expectNoSeriousAccessibilityViolations(page);
});

test("keeps access and modification audiences explicit on app settings", async ({ page }) => {
  await mockDashboard(page);
  await page.goto(`/apps/${app.id}/settings?teamId=${team.id}#access`);

  await expect(page.getByRole("heading", { level: 1, name: app.name })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "Who can open" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "Who can modify" })).toBeVisible();
  await expect(page.getByText("Primary owner: Tom Davies")).toBeVisible();
  await expect(page.getByText("Editor groups: Sales")).toBeVisible();
  await expect(page.getByRole("link", { name: "Danger" })).toBeVisible();

  await expectNoPageOverflow(page);
  await expectNoSeriousAccessibilityViolations(page);
});

test("uses a labelled mobile navigation sheet and divider-based app rows", async ({ page }) => {
  await mockDashboard(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/dashboard?teamId=${team.id}`);

  await expect(page.locator(".mobile-app-row")).toBeVisible();
  await expect(page.locator(".desktop-directory")).toBeHidden();
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("dialog", { name: "Navigation" })).toBeVisible();
  await expect(page.getByRole("link", { name: "All apps" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Tokens" })).toBeVisible();

  await expectNoPageOverflow(page);
  await expectNoSeriousAccessibilityViolations(page);
});

test("shows an actionable empty-team state without requesting team resources", async ({ page }) => {
  let teamRequests = 0;
  await page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/teams/")) teamRequests += 1;
  });
  await mockDashboard(page, { noTeam: true });
  await page.goto("/dashboard");

  await expect(page.getByRole("heading", { level: 1, name: "No team is available yet." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  expect(teamRequests).toBe(0);
});

test("submits app creation with the selected team, location and audience", async ({ page }) => {
  let submitted: Record<string, unknown> | null = null;
  await mockDashboard(page, { onCreateApp: (body) => { submitted = body; } });
  await page.goto(`/folders/${folders[0]!.id}?teamId=${team.id}`);

  await page.getByRole("button", { name: "New app" }).click();
  await page.getByLabel("Name").fill("Quarterly Planning");
  await page.getByLabel("Description").fill("Planning and target setting");
  await page.getByRole("dialog", { name: "Create an app" }).getByLabel("Audience").selectOption("restricted");
  await page.getByRole("button", { name: "Create app" }).click();

  await expect.poll(() => submitted).not.toBeNull();
  expect(submitted).toMatchObject({
    teamId: team.id,
    folderId: folders[0]!.id,
    name: "Quarterly Planning",
    slug: "quarterly-planning",
    description: "Planning and target setting",
    audience: "restricted",
  });
});
