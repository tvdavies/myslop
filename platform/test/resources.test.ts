import { describe, expect, test } from "bun:test";
import { buildResourceTopology } from "../src/resources";
import { isDashboardPath } from "../src/ui";
import type { AppRow } from "../src/types";

function app(overrides: Partial<AppRow> = {}): AppRow {
  return {
    id: "app",
    slug: "demo",
    name: "Demo",
    description: "",
    owner_id: "owner",
    visibility: "team",
    worker_name: "worker",
    d1_id: null,
    d1_name: null,
    r2_bucket: null,
    custom_domain_id: null,
    d1_delete_after: null,
    r2_delete_after: null,
    active_version: 2,
    created_at: 0,
    updated_at: 0,
    archived_at: null,
    managed_by: "manual",
    source_hash: null,
    d1_adopted: 0,
    r2_adopted: 0,
    team_id: "team_default",
    folder_id: null,
    deployment_hash: null,
    ...overrides,
  };
}

describe("resource topology", () => {
  test("uses product terminology for connected app resources", () => {
    const topology = buildResourceTopology({
      app: app({ d1_id: "database", r2_bucket: "storage" }),
      manifestJson: JSON.stringify({
        version: 1,
        assets: true,
        worker: true,
        capabilities: {
          database: true,
          files: true,
          secrets: ["TOKEN"],
          network: ["api.example.com"],
          email: true,
          identity: false,
          schedules: ["17 3 * * *"],
          durableObjects: [],
        },
      }),
      domains: [{ hostname: "demo.myslop.app", status: "active" }],
      schedules: [{ expression: "17 3 * * *", last_status: "succeeded" }],
      configuredSecrets: ["TOKEN"],
    });
    expect(topology.nodes.map(({ label }) => label)).toEqual([
      "App / runtime",
      "Database",
      "Storage",
      "Schedules",
      "Domain",
      "Email",
      "Secrets",
    ]);
    const primaryText = topology.nodes.map(({ label, detail }) => `${label} ${detail}`).join(" ");
    expect(primaryText).not.toMatch(/Cloudflare|Worker|\bD1\b|\bR2\b/);
  });
});

describe("dashboard routes", () => {
  test("serves deep links without catching APIs or assets", () => {
    expect(isDashboardPath("/apps/app-id/settings")).toBe(true);
    expect(isDashboardPath("/folders/folder-id")).toBe(true);
    expect(isDashboardPath("/team/groups")).toBe(true);
    expect(isDashboardPath("/api/apps/app-id")).toBe(false);
    expect(isDashboardPath("/schema/v1.json")).toBe(false);
    expect(isDashboardPath("/skill.md")).toBe(false);
  });
});
