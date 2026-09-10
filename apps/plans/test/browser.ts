// Run explicitly with `bun run test:browser`; no production calls or real keys.
import { chromium, expect as baseExpect, type Browser } from "@playwright/test";
import { Database } from "bun:sqlite";
import worker from "../src/index";
import { AUTHOR_PERMISSIONS, PERMISSION_PRESETS } from "../src/permissions";
import { d1 } from "./d1";

const expect = baseExpect.configure({ timeout: 5_000 });
const db = new Database(":memory:");
db.exec("PRAGMA foreign_keys=ON");
db.exec(await Bun.file(new URL("../migrations/001_init.sql", import.meta.url)).text());
const now = Date.now();
const sid = "a".repeat(32);
const existingKey = "msp_browser-test-only";
const originalHash = new Bun.CryptoHasher("sha256").update(existingKey).digest("hex");
db.query("INSERT INTO users (id,name,created_at) VALUES ('owner','Owner',?)").run(now);
db.query("INSERT INTO sessions (id,user_id,created_at,expires_at) VALUES (?,'owner',?,?)").run(sid, now, now + 60_000);
db.query("INSERT INTO tokens (id,user_id,hash,name,prefix,created_at) VALUES ('existing','owner',?,'Existing local key','msp_browser',?)").run(originalHash, now);
db.exec(await Bun.file(new URL("../migrations/002_agent_review_permissions.sql", import.meta.url)).text());
const pending: Promise<unknown>[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch: (req) => worker.fetch(req as never, { DB: d1(db) } as never, {
    waitUntil(promise: Promise<unknown>) { pending.push(promise); },
  } as never) as unknown as Promise<Response>,
});
const origin = server.url.origin;
let browser: Browser | undefined;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addCookies([{ name: "sid", value: sid, url: origin, sameSite: "Lax" }]);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  async function api(key: string, path: string, method = "GET", body?: unknown) {
    return fetch(origin + path, {
      method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  const planResponse = await api(existingKey, "/api/agent/plans", "POST", { title: "Browser review test", markdown: "# A plan\n\nA safe change." });
  expect(planResponse.status).toBe(201);
  const plan = await planResponse.json() as { id: string };
  await page.goto(origin + "/dashboard");
  const row = page.locator('#tokens-body tr[data-id="existing"]');
  await expect(row).toContainText("read, write, comment, resolve");
  await row.getByRole("button", { name: "Permissions", exact: true }).click();
  await page.locator("#edit-permissions").getByRole("checkbox", { name: "Approve and request changes" }).check();
  await expect(page.locator("#edit-preset")).toHaveValue("custom");
  await page.getByRole("button", { name: "Save permissions", exact: true }).click();
  await expect(page.locator("#permissions-dialog")).not.toBeVisible();
  await expect(row).toContainText("read, write, comment, resolve, review");
  expect(db.query("SELECT hash FROM tokens WHERE id='existing'").get()).toEqual({ hash: originalHash });
  const approved = await api(existingKey, `/api/agent/plans/${plan.id}/review`, "POST", { version: 1, verdict: "approved" });
  expect(approved.status).toBe(200);

  await page.goto(origin + `/p/${plan.id}`);
  await expect(page.locator('#review-strip [data-reviewer-type="agent"]')).toContainText("Agent · Existing local key");
  await expect(page.locator("#approve-btn")).toHaveText("Approve"); // Not the human's approval.
  await expect(page.locator("#plan-status")).toHaveText("Approved");

  await page.goto(origin + "/dashboard");
  await row.getByRole("button", { name: "Permissions", exact: true }).click();
  await page.locator("#edit-preset").selectOption("reader");
  await page.getByRole("button", { name: "Save permissions", exact: true }).click();
  await expect(row.locator(".permission-summary")).toHaveText("read");
  expect((await api(existingKey, "/api/agent/plans", "POST", { title: "Denied", markdown: "# No" })).status).toBe(403);
  expect((await api(existingKey, `/api/agent/plans/${plan.id}/review`, "POST", { version: 1, verdict: "approved" })).status).toBe(403);
  expect((await api(existingKey, "/api/agent/plans")).status).toBe(200);

  await page.getByLabel("Token name", { exact: true }).fill("Oracle");
  await page.locator("#token-preset").selectOption("oracle");
  await page.getByRole("button", { name: "Generate token", exact: true }).click();
  const oracleRow = page.locator("#tokens-body tr").filter({ has: page.getByRole("cell", { name: "Oracle", exact: true }) });
  await expect(oracleRow.locator(".permission-summary")).toHaveText("read, comment, review");
  await expect(page.locator("#token-preset")).toHaveValue("author");
  const oracleKey = (await page.locator("#secret-value").textContent())!;
  const verified = await (await api(oracleKey, "/api/verify")).json() as { permissions: string[] };
  expect(verified.permissions).toEqual(PERMISSION_PRESETS.oracle!);

  await oracleRow.getByRole("button", { name: "Permissions", exact: true }).click();
  for (const input of await page.locator("#edit-permissions input").all()) await input.uncheck();
  await page.getByRole("button", { name: "Save permissions", exact: true }).click();
  await expect(oracleRow.locator(".permission-summary")).toHaveText("None");
  expect((await api(oracleKey, "/api/agent/plans")).status).toBe(403);

  await page.setViewportSize({ width: 390, height: 844 });
  await row.getByRole("button", { name: "Permissions", exact: true }).click();
  const bounds = await page.locator("#permissions-dialog").boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await page.locator("#edit-preset").selectOption("oracle");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect((await (await api(existingKey, "/api/verify")).json() as { permissions: string[] }).permissions).toEqual(["plans:read"]);

  page.once("dialog", (dialog) => dialog.accept());
  await oracleRow.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(oracleRow).toHaveCount(0);
  expect((await api(oracleKey, "/api/verify")).status).toBe(401);

  // Setup must not let a crafted query string opt a newly minted key into review.
  await page.goto(origin + "/setup?name=setup-test&permissions=plans:review&preset=oracle");
  await expect(page.locator("#setup-secret")).not.toBeEmpty();
  const setupKey = (await page.locator("#setup-secret").textContent())!;
  expect((await (await api(setupKey, "/api/verify")).json() as { permissions: string[] }).permissions).toEqual(AUTHOR_PERMISSIONS);
  expect(errors).toEqual([]);
  console.log("PASS: existing-key upgrade/downgrade, review attribution, presets, empty permissions, cancel, mobile dialog, revocation, and safe setup");
} finally {
  await browser?.close();
  await Promise.all(pending);
  await server.stop(true);
  db.close();
}
