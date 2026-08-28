import { describe, expect, test } from "bun:test";
import { appRequestHeaders } from "../src/index";
import type { AppRow, User } from "../src/types";

function app(visibility: AppRow["visibility"]): AppRow {
  return {
    id: "app-id",
    slug: "demo",
    name: "Demo",
    description: "",
    owner_id: "owner",
    visibility,
    worker_name: "worker",
    d1_id: null,
    d1_name: null,
    r2_bucket: null,
    custom_domain_id: null,
    d1_delete_after: null,
    r2_delete_after: null,
    active_version: 1,
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
  };
}

const user: User = {
  id: "user-id",
  email: "user@example.com",
  name: "User",
  picture: null,
  platform_role: "member",
};

describe("app request trust models", () => {
  test("anonymous public requests keep their own credentials and receive no identity", () => {
    const headers = appRequestHeaders(new Request("https://demo.myslop.app/api", {
      headers: {
        authorization: "Bearer msf_existing",
        cookie: "sid=existing; __Host-msa_sid=platform-secret; msa_sid=legacy-secret",
        "x-myslop-user-id": "spoofed",
        "x-myslop-app-role": "owner",
        "x-myslop-internal-signature": "spoofed",
      },
    }), app("public"), null);
    expect(headers.get("authorization")).toBe("Bearer msf_existing");
    expect(headers.get("cookie")).toBe("sid=existing");
    expect(headers.get("x-myslop-user-id")).toBeNull();
    expect(headers.get("x-myslop-app-id")).toBeNull();
    expect(headers.get("x-myslop-app-role")).toBeNull();
    expect(headers.get("x-myslop-internal-signature")).toBeNull();

    const platformBearer = appRequestHeaders(new Request("https://demo.myslop.app/api", {
      headers: { authorization: "Bearer msa_platform-secret" },
    }), app("public"), null);
    expect(platformBearer.get("authorization")).toBeNull();
  });

  test("verified users on public apps get injected identity without losing app credentials", () => {
    const headers = appRequestHeaders(new Request("https://demo.myslop.app/api", {
      headers: {
        authorization: "Bearer msf_existing",
        cookie: "sid=existing; __Host-msa_sid=platform-secret",
        "x-myslop-user-id": "spoofed",
      },
    }), app("public"), user, "viewer");
    expect(headers.get("authorization")).toBe("Bearer msf_existing");
    expect(headers.get("cookie")).toBe("sid=existing");
    expect(headers.get("x-myslop-app-id")).toBe("app-id");
    expect(headers.get("x-myslop-user-id")).toBe("user-id");
    expect(headers.get("x-myslop-user-email")).toBe("user@example.com");
    expect(headers.get("x-myslop-app-role")).toBe("viewer");
  });

  test("platform bearer tokens are consumed by the dispatcher, never forwarded", () => {
    const headers = appRequestHeaders(new Request("https://demo.myslop.app/api", {
      headers: { authorization: "Bearer msa_agent-token" },
    }), app("public"), user, "editor");
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-myslop-user-id")).toBe("user-id");
    expect(headers.get("x-myslop-app-role")).toBe("editor");
  });

  test("team apps strip client credentials and inject verified platform identity", () => {
    const headers = appRequestHeaders(new Request("https://demo.myslop.app/api", {
      headers: { authorization: "Bearer client", cookie: "sid=client", "x-myslop-user-id": "spoofed" },
    }), app("team"), user, "editor");
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("x-myslop-app-id")).toBe("app-id");
    expect(headers.get("x-myslop-user-id")).toBe("user-id");
    expect(headers.get("x-myslop-user-email")).toBe("user@example.com");
    expect(headers.get("x-myslop-app-role")).toBe("editor");
  });
});
