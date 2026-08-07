import { decodeBase64, base64url, decodeBase64url } from "./core";
import type { Env } from "./types";

async function encryptionKey(env: Env): Promise<CryptoKey> {
  if (!env.SECRET_ENCRYPTION_KEY) throw new Error("SECRET_ENCRYPTION_KEY is not configured");
  const raw = decodeBase64(env.SECRET_ENCRYPTION_KEY);
  if (raw.byteLength !== 32) throw new Error("SECRET_ENCRYPTION_KEY must be base64-encoded 32 bytes");
  return crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(env: Env, value: string): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    await encryptionKey(env),
    new TextEncoder().encode(value) as BufferSource,
  );
  return { ciphertext: base64url(new Uint8Array(encrypted)), iv: base64url(iv) };
}

export async function decryptSecret(env: Env, ciphertext: string, iv: string): Promise<string> {
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: decodeBase64url(iv) as BufferSource },
    await encryptionKey(env),
    decodeBase64url(ciphertext) as BufferSource,
  );
  return new TextDecoder().decode(decrypted);
}

export async function loadAppSecrets(env: Env, appId: string, names?: string[]): Promise<{ name: string; value: string }[]> {
  if (names && names.length === 0) return [];
  const placeholders = names?.map(() => "?").join(",");
  const statement = names
    ? env.CONTROL_DB.prepare(`SELECT name,ciphertext,iv FROM app_secrets WHERE app_id=? AND name IN (${placeholders}) ORDER BY name`).bind(appId, ...names)
    : env.CONTROL_DB.prepare("SELECT name,ciphertext,iv FROM app_secrets WHERE app_id=? ORDER BY name").bind(appId);
  const { results } = await statement.all<{ name: string; ciphertext: string; iv: string }>();
  return Promise.all(results.map(async (row) => ({
    name: row.name,
    value: await decryptSecret(env, row.ciphertext, row.iv),
  })));
}
