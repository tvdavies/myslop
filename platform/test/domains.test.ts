import { describe, expect, spyOn, test } from "bun:test";
import worker from "../src/index";
import {
  appSlugFromHostname,
  appUrl,
  legacyAppSlugFromHostname,
  slugSuggestions,
  validAppSlug,
} from "../src/domains";

describe("managed domains", () => {
  test("allocates one first-level hostname and reserves platform labels", () => {
    expect(appUrl("commercial-dashboard")).toBe("https://commercial-dashboard.myslop.app");
    expect(appSlugFromHostname("commercial-dashboard.myslop.app")).toBe("commercial-dashboard");
    expect(appSlugFromHostname("deep.demo.myslop.app")).toBeNull();
    expect(validAppSlug("apps")).toBe(false);
    expect(validAppSlug("auth")).toBe(false);
    expect(validAppSlug("www")).toBe(false);
    expect(validAppSlug("events")).toBe(false);
    expect(slugSuggestions("demo", "myslop", "abc123")).toEqual(["demo-myslop", "demo-abc123"]);
  });

  test("recognizes legacy app hosts without confusing the legacy platform", () => {
    expect(legacyAppSlugFromHostname("demo.apps.myslop.app")).toBe("demo");
    expect(legacyAppSlugFromHostname("apps.myslop.app")).toBeNull();
  });

  test("passes reserved standalone hosts through to their exact Custom Domain Worker", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(new Response("events", { status: 200 }));
    try {
      const request = new Request("https://events.myslop.app/api");
      const response = await worker.fetch(request as never, {} as never, {} as never) as unknown as Response;
      expect(await response.text()).toBe("events");
      expect(fetchMock).toHaveBeenCalledWith(request);
    } finally {
      fetchMock.mockRestore();
    }
  });

  test("preserves path and query on platform and legacy app redirects", async () => {
    const context = {} as ExecutionContext;
    const apex = await worker.fetch(
      new Request("https://myslop.app/setup?name=laptop") as never,
      {} as never,
      context,
    ) as unknown as Response;
    expect(apex.status).toBe(308);
    expect(apex.headers.get("location")).toBe("https://myslop.cloud/setup?name=laptop");

    const legacy = await worker.fetch(
      new Request("https://demo.apps.myslop.app/deep?q=1") as never,
      {} as never,
      context,
    ) as unknown as Response;
    expect(legacy.status).toBe(308);
    expect(legacy.headers.get("location")).toBe("https://demo.myslop.app/deep?q=1");

    const legacyWrite = await worker.fetch(
      new Request("https://apps.myslop.app/api/apps", { method: "POST" }) as never,
      {} as never,
      context,
    ) as unknown as Response;
    expect(legacyWrite.status).toBe(409);
    expect(await legacyWrite.json()).toMatchObject({ code: "platform_origin_moved" });
  });
});
