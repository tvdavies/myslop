const encoder = new TextEncoder();
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64url(value: string): Uint8Array {
  let input = value.replace(/-/g, "+").replace(/_/g, "/");
  input += "=".repeat((4 - (input.length % 4)) % 4);
  return Uint8Array.from(atob(input), (character) => character.charCodeAt(0));
}

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function canonical(method: string, path: string, timestamp: string, nonce: string, bodyHash: string): string {
  return `${method.toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`;
}

export interface InternalSignature {
  timestamp: string;
  nonce: string;
  signature: string;
}

export async function signInternalRequest(
  secret: string,
  method: string,
  path: string,
  bodyHash: string,
  now = Date.now(),
): Promise<InternalSignature> {
  const timestamp = String(now);
  const nonce = crypto.randomUUID();
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", await key(secret), encoder.encode(canonical(method, path, timestamp, nonce, bodyHash))),
  );
  return { timestamp, nonce, signature: base64url(signature) };
}

export async function verifyInternalRequest(
  secret: string,
  method: string,
  path: string,
  bodyHash: string,
  headers: Headers,
  now = Date.now(),
): Promise<boolean> {
  const timestamp = headers.get("x-myslop-internal-timestamp") ?? "";
  const nonce = headers.get("x-myslop-internal-nonce") ?? "";
  const signature = headers.get("x-myslop-internal-signature") ?? "";
  if (!/^\d{13}$/.test(timestamp) || !nonce || !signature || Math.abs(now - Number(timestamp)) > MAX_CLOCK_SKEW_MS) return false;
  try {
    return crypto.subtle.verify(
      "HMAC",
      await key(secret),
      decodeBase64url(signature) as BufferSource,
      encoder.encode(canonical(method, path, timestamp, nonce, bodyHash)),
    );
  } catch {
    return false;
  }
}

export function internalNonceKey(headers: Headers): string | null {
  const timestamp = headers.get("x-myslop-internal-timestamp");
  const nonce = headers.get("x-myslop-internal-nonce");
  return timestamp && nonce ? `${timestamp}:${nonce}` : null;
}
