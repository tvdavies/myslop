import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { createAppArtifact } from "../src/artifact";

const root = `/tmp/myslop-artifact-${crypto.randomUUID()}`;

async function appFixture(name: string, manifest: object, html = "<h1>Hello</h1>") {
  const directory = `${root}/${name}`;
  await mkdir(`${directory}/public`, { recursive: true });
  await Bun.write(`${directory}/myslop.json`, JSON.stringify(manifest));
  await Bun.write(`${directory}/public/index.html`, html);
  return directory;
}

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("app artifact hashes", () => {
  test("policy-only changes do not change the deployment hash", async () => {
    const legacy = await createAppArtifact(await appFixture("legacy", {
      version: 1,
      app: { name: "Demo", visibility: "team" },
    }));
    const policy = await createAppArtifact(await appFixture("policy", {
      version: 1,
      app: { name: "Demo", visibility: "team", folder: "business-apps" },
      access: {
        audience: "team",
        groups: [{ slug: "developers", role: "editor" }],
      },
    }));
    expect(policy.deploymentHash).toBe(legacy.deploymentHash);
    expect(policy.sourceHash).not.toBe(legacy.sourceHash);
    expect(Object.hasOwn(legacy.app, "folder")).toBe(false);
    expect(Object.hasOwn(legacy.app, "access")).toBe(false);
  });

  test("runtime changes update both hashes", async () => {
    const first = await createAppArtifact(await appFixture("first", { version: 1 }));
    const second = await createAppArtifact(await appFixture("second", { version: 1 }, "<h1>Changed</h1>"));
    expect(second.deploymentHash).not.toBe(first.deploymentHash);
    expect(second.sourceHash).not.toBe(first.sourceHash);
  });
});

describe("manifest files", () => {
  test("myslop.yaml is accepted", async () => {
    const directory = `${root}/yaml-app`;
    await mkdir(`${directory}/public`, { recursive: true });
    await Bun.write(`${directory}/public/index.html`, "<h1>Hi</h1>");
    await Bun.write(`${directory}/myslop.yaml`, "version: 1\napp:\n  name: Yaml App\n  visibility: team\n");
    const artifact = await createAppArtifact(directory);
    expect(artifact.app.name).toBe("Yaml App");
    expect(artifact.app.visibility).toBe("team");
  });

  test("multiple manifest files are rejected", async () => {
    const directory = `${root}/dual-manifest`;
    await mkdir(`${directory}/public`, { recursive: true });
    await Bun.write(`${directory}/public/index.html`, "<h1>Hi</h1>");
    await Bun.write(`${directory}/myslop.json`, "{}");
    await Bun.write(`${directory}/myslop.yaml`, "version: 1\n");
    expect(createAppArtifact(directory)).rejects.toThrow(/single manifest file/);
  });
});

describe("root index.html bundling", () => {
  test("bundles referenced scripts and styles, excludes worker and schema", async () => {
    const directory = `${root}/bundled`;
    await mkdir(directory, { recursive: true });
    await Bun.write(`${directory}/index.html`, [
      "<html><head><link rel=\"stylesheet\" href=\"./app.css\"></head>",
      "<body><div id=\"root\"></div><script type=\"module\" src=\"./app.tsx\"></script></body></html>",
    ].join(""));
    await Bun.write(`${directory}/app.tsx`, `document.getElementById("root")!.textContent = "hello" as string;`);
    await Bun.write(`${directory}/app.css`, "body { color: red }");
    await Bun.write(`${directory}/worker.ts`, "export default { fetch: () => new Response(\"ok\") };");
    await Bun.write(`${directory}/schema.sql`, "CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT);");
    const artifact = await createAppArtifact(directory);
    const paths = artifact.deployment.assets.map(({ path }) => path);
    expect(paths).toContain("index.html");
    expect(paths.some((path) => path.endsWith(".js"))).toBe(true);
    expect(paths.some((path) => path.endsWith(".css"))).toBe(true);
    expect(paths).not.toContain("worker.ts");
    expect(paths).not.toContain("schema.sql");
    const html = Buffer.from(artifact.deployment.assets.find(({ path }) => path === "index.html")!.data, "base64").toString();
    expect(html).not.toContain("app.tsx");
    expect(artifact.deployment.worker).toBeDefined();
    expect(artifact.deployment.schema).toContain("CREATE TABLE notes");
    expect(artifact.deployment.manifest.capabilities.database).toBe(true);
  });

  test("public/ takes precedence over root bundling and stays raw", async () => {
    const directory = `${root}/raw-public`;
    await mkdir(`${directory}/public`, { recursive: true });
    await Bun.write(`${directory}/index.html`, "<h1>root</h1>");
    await Bun.write(`${directory}/public/index.html`, "<h1>public</h1>");
    const artifact = await createAppArtifact(directory);
    expect(artifact.deployment.assets).toHaveLength(1);
    expect(Buffer.from(artifact.deployment.assets[0]!.data, "base64").toString()).toBe("<h1>public</h1>");
  });
});

describe("declarative schema", () => {
  test("invalid schema.sql fails locally with a parse error", async () => {
    const directory = `${root}/bad-schema`;
    await mkdir(directory, { recursive: true });
    await Bun.write(`${directory}/worker.ts`, "export default { fetch: () => new Response(\"ok\") };");
    await Bun.write(`${directory}/schema.sql`, "DROP TABLE users;");
    expect(createAppArtifact(directory)).rejects.toThrow(/unsupported statement/);
  });

  test("schema.sql without a worker is rejected", async () => {
    const directory = `${root}/schema-no-worker`;
    await mkdir(`${directory}/public`, { recursive: true });
    await Bun.write(`${directory}/public/index.html`, "<h1>Hi</h1>");
    await Bun.write(`${directory}/schema.sql`, "CREATE TABLE notes (id TEXT PRIMARY KEY);");
    expect(createAppArtifact(directory)).rejects.toThrow(/schema.sql requires worker.ts/);
  });
});
