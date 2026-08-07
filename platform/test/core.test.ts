import { describe, expect, test } from "bun:test";
import { contentType, safeAssetPath, validAppReturnUrl, validBindingName, validSlug } from "../src/core";
import { decryptSecret, encryptSecret } from "../src/secrets";
import type { Env } from "../src/types";

describe("artifact validation", () => {
  test("accepts safe slugs", () => {
    expect(validSlug("commercial-dashboard")).toBe(true);
    expect(validSlug("ab")).toBe(false);
    expect(validSlug("Bad_App")).toBe(false);
    expect(validSlug("a--b")).toBe(true);
  });

  test("rejects path traversal", () => {
    expect(safeAssetPath("index.html")).toBe(true);
    expect(safeAssetPath("assets/app.js")).toBe(true);
    expect(safeAssetPath("../secret")).toBe(false);
    expect(safeAssetPath("assets//app.js")).toBe(false);
    expect(safeAssetPath("/index.html")).toBe(false);
  });

  test("validates secret binding names", () => {
    expect(validBindingName("HUBSPOT_TOKEN")).toBe(true);
    expect(validBindingName("hubspot-token")).toBe(false);
    expect(validBindingName("DB")).toBe(false);
  });

  test("accepts only exact app return origins", () => {
    expect(validAppReturnUrl("https://commercial-dashboard.apps.myslop.app/report")).toBe(true);
    expect(validAppReturnUrl("https://evil.example/?x=.apps.myslop.app")).toBe(false);
    expect(validAppReturnUrl("https://apps.myslop.app")).toBe(false);
  });

  test("encrypts secrets at rest", async () => {
    const env = { SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") } as Env;
    const encrypted = await encryptSecret(env, "super-secret");
    expect(encrypted.ciphertext).not.toContain("super-secret");
    expect(await decryptSecret(env, encrypted.ciphertext, encrypted.iv)).toBe("super-secret");
  });

  test("infers common content types", () => {
    expect(contentType("index.html")).toContain("text/html");
    expect(contentType("app.wasm")).toBe("application/wasm");
  });
});
