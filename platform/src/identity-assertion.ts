import { AUTH_ORIGIN } from "./domains";

const encoder = new TextEncoder();
const MAX_ASSERTION_AGE_SECONDS = 30;
const CLOCK_SKEW_SECONDS = 5;

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64url(value: string): Uint8Array {
  let input = value.replace(/-/g, "+").replace(/_/g, "/");
  input += "=".repeat((4 - input.length % 4) % 4);
  return Uint8Array.from(atob(input), (character) => character.charCodeAt(0));
}

async function hmac(secret: string, usage: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usage);
}

export interface IdentityAssertionClaims {
  v: 1;
  k: number;
  iss: string;
  aud: string;
  sub: string;
  uid: string;
  email: string;
  email_verified: true;
  name?: string;
  picture?: string;
  role: "viewer" | "editor" | "owner";
  sg: number;
  iat: number;
  exp: number;
  jti: string;
  method: string;
  host: string;
  target: string;
  body_sha256?: string;
}

export type IdentityAssertionInput = Omit<IdentityAssertionClaims, "v" | "k" | "iss" | "iat" | "exp" | "jti" | "method" | "host" | "target">;

export async function signIdentityAssertion(
  secret: string,
  request: Request,
  input: IdentityAssertionInput,
  options: { now?: number; bodyHash?: string; keyVersion?: number } = {},
): Promise<string> {
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  const url = new URL(request.url);
  const claims: IdentityAssertionClaims = {
    v: 1,
    k: options.keyVersion ?? 1,
    iss: AUTH_ORIGIN,
    ...input,
    iat: now,
    exp: now + MAX_ASSERTION_AGE_SECONDS,
    jti: crypto.randomUUID(),
    method: request.method.toUpperCase(),
    host: url.hostname,
    target: `${url.pathname}${url.search}`,
    ...(options.bodyHash ? { body_sha256: options.bodyHash } : {}),
  };
  const payload = base64url(encoder.encode(JSON.stringify(claims)));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await hmac(secret, ["sign"]), encoder.encode(payload)));
  return `${payload}.${base64url(signature)}`;
}

function validClaims(value: unknown): value is IdentityAssertionClaims {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const claims = value as Partial<IdentityAssertionClaims>;
  return claims.v === 1 && typeof claims.k === "number" && Number.isSafeInteger(claims.k) && claims.k > 0 && claims.iss === AUTH_ORIGIN &&
    typeof claims.aud === "string" && Boolean(claims.aud) &&
    typeof claims.sub === "string" && /^mui_[a-f0-9]{32}$/.test(claims.sub) &&
    typeof claims.uid === "string" && Boolean(claims.uid) &&
    typeof claims.email === "string" && Boolean(claims.email) && claims.email_verified === true &&
    ["viewer", "editor", "owner"].includes(claims.role ?? "") &&
    typeof claims.sg === "number" && Number.isSafeInteger(claims.sg) && claims.sg > 0 &&
    typeof claims.iat === "number" && typeof claims.exp === "number" &&
    typeof claims.jti === "string" && Boolean(claims.jti) &&
    typeof claims.method === "string" && typeof claims.host === "string" && typeof claims.target === "string" &&
    (claims.name === undefined || typeof claims.name === "string") &&
    (claims.picture === undefined || typeof claims.picture === "string") &&
    (claims.body_sha256 === undefined || /^[a-f0-9]{64}$/.test(claims.body_sha256));
}

export async function verifyIdentityAssertion(
  secret: string | Record<string, string>,
  assertion: string,
  request: Request,
  expectedAudience: string,
  options: { now?: number; bodyHash?: string } = {},
): Promise<IdentityAssertionClaims | null> {
  const parts = assertion.split(".");
  if (parts.length !== 2) return null;
  try {
    const claims = JSON.parse(new TextDecoder().decode(decodeBase64url(parts[0]!))) as unknown;
    if (!validClaims(claims) || claims.aud !== expectedAudience) return null;
    const verificationSecret = typeof secret === "string" ? secret : secret[String(claims.k)];
    if (!verificationSecret) return null;
    const verified = await crypto.subtle.verify(
      "HMAC",
      await hmac(verificationSecret, ["verify"]),
      decodeBase64url(parts[1]!) as BufferSource,
      encoder.encode(parts[0]!),
    );
    if (!verified) return null;
    const url = new URL(request.url);
    if (claims.method !== request.method.toUpperCase() || claims.host !== url.hostname || claims.target !== `${url.pathname}${url.search}`) return null;
    if ((claims.body_sha256 ?? undefined) !== (options.bodyHash ?? undefined)) return null;
    const now = Math.floor((options.now ?? Date.now()) / 1000);
    if (claims.iat > now + CLOCK_SKEW_SECONDS || claims.exp < now - CLOCK_SKEW_SECONDS) return null;
    if (claims.exp - claims.iat > MAX_ASSERTION_AGE_SECONDS || claims.exp <= claims.iat) return null;
    return claims;
  } catch {
    return null;
  }
}
