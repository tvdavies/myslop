import { APP_HOST_SUFFIX, validAppSlug, validSlug } from "./domains";

const enc = new TextEncoder();

export const TOKEN_PREFIX = "msa_";
export const SESSION_COOKIE = "__Host-msa_sid";
export const LEGACY_SESSION_COOKIE = "msa_sid";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const RESERVED_BINDINGS = new Set(["DB", "FILES", "MYSLOP_APP_ID", "MYSLOP_APP_ORIGIN", "MYSLOP_INTERNAL_SECRET"]);

export { validAppSlug, validSlug } from "./domains";

export function validBindingName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) && !RESERVED_BINDINGS.has(value);
}

export function validAppReturnUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.port || url.username || url.password) return false;
    if (!url.hostname.endsWith(APP_HOST_SUFFIX)) return false;
    return validAppSlug(url.hostname.slice(0, -APP_HOST_SUFFIX.length));
  } catch {
    return false;
  }
}

export function safeAssetPath(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.includes("\\")) return false;
  const parts = value.split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== "..");
}

export function isUniqueViolation(error: unknown): boolean {
  return String(error instanceof Error ? error.message : error).includes("UNIQUE");
}

export function sqlPlaceholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(",");
}

export function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function decodeBase64url(value: string): Uint8Array {
  let input = value.replace(/-/g, "+").replace(/_/g, "/");
  input += "=".repeat((4 - (input.length % 4)) % 4);
  return Uint8Array.from(atob(input), (char) => char.charCodeAt(0));
}

export function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? enc.encode(value) : value;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function readCookie(req: Request, name: string): string | null {
  const cookie = req.headers.get("cookie") ?? "";
  for (const part of cookie.split(/;\s*/)) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index) === name) return part.slice(index + 1);
  }
  return null;
}

export function sessionCookie(id: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function contentType(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase();
  const types: Record<string, string> = {
    html: "text/html; charset=utf-8",
    css: "text/css; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    mjs: "text/javascript; charset=utf-8",
    json: "application/json; charset=utf-8",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    ico: "image/x-icon",
    txt: "text/plain; charset=utf-8",
    csv: "text/csv; charset=utf-8",
    pdf: "application/pdf",
    wasm: "application/wasm",
    map: "application/json; charset=utf-8",
  };
  return types[extension ?? ""] ?? "application/octet-stream";
}

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}
