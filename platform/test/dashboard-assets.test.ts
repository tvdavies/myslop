import { describe, expect, test } from "bun:test";
import { serveDashboardAsset, type DashboardAsset } from "../src/dashboard-assets";

const asset: DashboardAsset = {
  body: "console.log('dashboard');\n",
  contentType: "text/javascript; charset=utf-8",
  etag: '"sha256-abc123"',
};

describe("dashboard asset responses", () => {
  test("serves GET requests with validation and security headers", async () => {
    const response = serveDashboardAsset(new Request("https://myslop.cloud/assets/dashboard.js"), asset);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(asset.body);
    expect(response.headers.get("content-type")).toBe(asset.contentType);
    expect(response.headers.get("content-length")).toBe(String(Buffer.byteLength(asset.body)));
    expect(response.headers.get("etag")).toBe(asset.etag);
    expect(response.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("serves HEAD requests without a body", async () => {
    const response = serveDashboardAsset(
      new Request("https://myslop.cloud/assets/dashboard.js", { method: "HEAD" }),
      asset,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(response.headers.get("content-length")).toBe(String(Buffer.byteLength(asset.body)));
    expect(response.headers.get("etag")).toBe(asset.etag);
  });

  test("returns 304 for matching strong or weak validators", () => {
    for (const validator of [asset.etag, `"other", W/${asset.etag}`, "*"]) {
      const response = serveDashboardAsset(
        new Request("https://myslop.cloud/assets/dashboard.js", {
          headers: { "if-none-match": validator },
        }),
        asset,
      );

      expect(response.status).toBe(304);
      expect(response.body).toBeNull();
      expect(response.headers.get("etag")).toBe(asset.etag);
      expect(response.headers.get("content-length")).toBeNull();
    }
  });

  test("rejects unsupported methods", async () => {
    const response = serveDashboardAsset(
      new Request("https://myslop.cloud/assets/dashboard.js", { method: "POST" }),
      asset,
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("method not allowed\n");
  });
});
