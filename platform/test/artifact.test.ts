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
