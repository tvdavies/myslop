import { afterEach, expect, spyOn, test } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";

import { beginGoogleLogin, completeGoogleLogin, consumeAuthCompletion } from "../src/google-auth";
import type { Env } from "../src/types";

class Statement {
  private values: SQLQueryBindings[] = [];
  constructor(private database: Database, private sql: string) {}
  bind(...values: SQLQueryBindings[]) { this.values = values; return this; }
  async first<T>() { return (this.database.query(this.sql).get(...this.values) as T | null) ?? null; }
  async all<T>() { return { results: this.database.query(this.sql).all(...this.values) as T[] }; }
  async run() {
    const result = this.database.query(this.sql).run(...this.values);
    return { success: true, meta: { changes: result.changes } };
  }
}

const databases: Database[] = [];
const schema = await Bun.file(new URL("../schema.sql", import.meta.url)).text();
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function environment(): { database: Database; env: Env } {
  const database = new Database(":memory:");
  databases.push(database);
  database.exec(schema);
  const control = {
    prepare: (sql: string) => new Statement(database, sql),
    batch: async (statements: Statement[]) => Promise.all(statements.map((statement) => statement.run())),
  };
  const raw = new Uint8Array(32).fill(7);
  let binary = "";
  for (const byte of raw) binary += String.fromCharCode(byte);
  return {
    database,
    env: {
      CONTROL_DB: control,
      SECRET_ENCRYPTION_KEY: btoa(binary),
      GOOGLE_OAUTH_CLIENT_ID: "google-client",
      GOOGLE_OAUTH_CLIENT_SECRET: "google-secret",
    } as unknown as Env,
  };
}

function b64url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function signedIdToken(privateKey: CryptoKey, nonce: string, kid: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })));
  const payload = b64url(new TextEncoder().encode(JSON.stringify({
    iss: "https://accounts.google.com",
    aud: "google-client",
    sub: "google-subject",
    email: "new.user@example.com",
    email_verified: true,
    name: "New User",
    nonce,
    iat: now,
    exp: now + 300,
  })));
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(`${header}.${payload}`)));
  return `${header}.${payload}.${b64url(signature)}`;
}

test("first-party Google flow uses one-time state and a separate host-only completion", async () => {
  const { database, env } = environment();
  const keyPair = await crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  }, true, ["sign", "verify"]);
  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const kid = "google-key";
  let expectedNonce = "";
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    if (url.pathname === "/.well-known/openid-configuration") {
      return Response.json({
        issuer: "https://accounts.google.com",
        authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        token_endpoint: "https://oauth2.googleapis.test/token",
        jwks_uri: "https://oauth2.googleapis.test/jwks",
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
      });
    }
    if (url.pathname === "/token") {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("client_id")).toBe("google-client");
      expect(body.get("client_secret")).toBe("google-secret");
      expect(body.get("code_verifier")).toBeTruthy();
      return Response.json({
        access_token: "unused-access-token",
        token_type: "Bearer",
        expires_in: 300,
        id_token: await signedIdToken(keyPair.privateKey, expectedNonce, kid),
      });
    }
    if (url.pathname === "/jwks") return Response.json({ keys: [{ ...publicJwk, kid, alg: "RS256", use: "sig" }] });
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch);

  try {
    const start = await beginGoogleLogin(new Request("https://auth.myslop.app/login?returnTo=https%3A%2F%2Fmyslop.cloud%2Ftokens", {
      headers: { "cf-connecting-ip": "203.0.113.10" },
    }), env);
    expect(start.status).toBe(302);
    const authorize = new URL(start.headers.get("location")!);
    expectedNonce = authorize.searchParams.get("nonce")!;
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("redirect_uri")).toBe("https://auth.myslop.app/oauth/callback");

    const callbackUrl = new URL("https://auth.myslop.app/oauth/callback");
    callbackUrl.searchParams.set("code", "google-code");
    callbackUrl.searchParams.set("state", authorize.searchParams.get("state")!);
    const callback = await completeGoogleLogin(new Request(callbackUrl, {
      headers: { "cf-connecting-ip": "203.0.113.10" },
    }), env);
    expect(callback.status).toBe(302);
    const completionUrl = new URL(callback.headers.get("location")!);
    expect(completionUrl.origin).toBe("https://myslop.cloud");
    expect([...completionUrl.searchParams.keys()]).toEqual(["code"]);

    const duplicate = await completeGoogleLogin(new Request(callbackUrl, {
      headers: { "cf-connecting-ip": "203.0.113.10" },
    }), env);
    expect(duplicate.status).toBe(400);

    const completion = await consumeAuthCompletion(new Request(completionUrl), env);
    expect(completion.status).toBe(302);
    expect(completion.headers.get("location")).toBe("https://myslop.cloud/tokens");
    expect(completion.headers.get("set-cookie")).toStartWith("__Host-msa_sid=");
    expect(completion.headers.get("set-cookie")).not.toContain("Domain=");
    expect(database.query("SELECT id,email,status FROM identity_users").get()).toMatchObject({
      email: "new.user@example.com",
      status: "active",
    });
    expect(database.query("SELECT identity_id FROM users WHERE email='new.user@example.com'").get()).toMatchObject({
      identity_id: expect.stringMatching(/^mui_/),
    });
  } finally {
    fetchMock.mockRestore();
  }
});

test("dual possession links a legacy platform user even after an email change", async () => {
  const { database, env } = environment();
  const now = Date.now();
  database.query(
    "INSERT INTO identity_users (id,email,email_verified,status,session_generation,created_at,updated_at,last_login_at) VALUES (?,?,1,'active',1,?,?,?)",
  ).run("mui_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "new@example.com", now, now, now);
  database.query(
    "INSERT INTO users (id,email,name,picture,platform_role,created_at) VALUES (?,?,?,?,?,?)",
  ).run("legacy-user", "old@example.com", "Legacy", null, "owner", now);
  database.query(
    "INSERT INTO sessions (id,user_id,created_at,expires_at,identity_generation) VALUES (?,?,?,?,0)",
  ).run("legacy-session", "legacy-user", now, now + 60_000);
  const code = "c".repeat(64);
  const { sha256Hex } = await import("../src/core");
  database.query(
    `INSERT INTO auth_completion_codes
     (code_hash,identity_id,candidate_user_id,return_to,expires_at,created_at) VALUES (?,?,?,?,?,?)`,
  ).run(await sha256Hex(code), "mui_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", null, "https://myslop.cloud/", now + 60_000, now);
  const { consumeAuthCompletion } = await import("../src/google-auth");
  const response = await consumeAuthCompletion(new Request(`https://myslop.cloud/__myslop/auth-callback?code=${code}`, {
    headers: { cookie: "__Host-msa_sid=legacy-session" },
  }), env);
  expect(response.status).toBe(302);
  expect(database.query("SELECT identity_id FROM users WHERE id='legacy-user'").get()).toEqual({
    identity_id: "mui_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  });
});
