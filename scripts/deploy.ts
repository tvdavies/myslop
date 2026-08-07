#!/usr/bin/env bun
import { unlink } from "node:fs/promises";

const root = new URL("..", import.meta.url).pathname;
const baseConfig = JSON.parse(await Bun.file(`${root}/wrangler.jsonc`).text()) as {
  d1_databases: { database_id: string }[];
  [key: string]: unknown;
};
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || "aac2b1acf442d4019d2912d96f7afe34";
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) throw new Error("CLOUDFLARE_API_TOKEN is required");
const databaseId = baseConfig.d1_databases[0]?.database_id;
if (!databaseId) throw new Error("control D1 database id is missing from wrangler.jsonc");
const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;

async function d1<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ sql, params }),
  });
  const payload = await response.json() as {
    success: boolean;
    result?: { results?: T[] }[];
    errors?: { message: string }[];
  };
  if (!response.ok || !payload.success) {
    throw new Error(payload.errors?.map((error) => error.message).join("; ") || `D1 query failed: ${response.status}`);
  }
  return payload.result?.[0]?.results ?? [];
}

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, {
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${command.join(" ")} exited ${code}`);
}

await run(["bun", "scripts/gen-distribution.ts"]);

const holder = `deploy-${crypto.randomUUID()}`;
const now = Date.now();
await d1("DELETE FROM platform_locks WHERE name='domains' AND expires_at<?", [now]);
await d1("INSERT OR IGNORE INTO platform_locks (name,holder,expires_at) VALUES ('domains',?,?)", [holder, now + 10 * 60_000]);
const lock = await d1<{ holder: string }>("SELECT holder FROM platform_locks WHERE name='domains'");
if (lock[0]?.holder !== holder) throw new Error("an app is being created or another platform deployment is running; retry shortly");

const generated = `${root}/.wrangler.deploy-${crypto.randomUUID()}.json`;
try {
  const rows = await d1<{ slug: string }>("SELECT slug FROM apps WHERE archived_at IS NULL ORDER BY slug");
  const config = {
    ...baseConfig,
    routes: [
      { pattern: "apps.myslop.app", custom_domain: true },
      ...rows.map(({ slug }) => ({ pattern: `${slug}.apps.myslop.app`, custom_domain: true })),
    ],
  };
  await Bun.write(generated, JSON.stringify(config, null, 2));
  console.log("Deploying outbound egress policy…");
  await run(["bunx", "wrangler", "deploy", "--config", "wrangler.outbound.jsonc"]);
  console.log(`Deploying control plane with ${rows.length} app domain${rows.length === 1 ? "" : "s"} preserved…`);
  await run(["bunx", "wrangler", "deploy", "--config", generated]);
} finally {
  await unlink(generated).catch(() => undefined);
  await d1("DELETE FROM platform_locks WHERE name='domains' AND holder=?", [holder]).catch((error) => console.error("lock release failed", error));
}
