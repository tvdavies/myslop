export const PERMISSION_OPTIONS = [
  { id: "plans:read", label: "Read plans and feedback" },
  { id: "plans:write", label: "Create and revise plans" },
  { id: "plans:comment", label: "Comment and reply" },
  { id: "plans:resolve", label: "Resolve and reopen threads" },
  { id: "plans:review", label: "Approve and request changes" },
] as const;

export type Permission = (typeof PERMISSION_OPTIONS)[number]["id"];

// Preserve existing author behavior. Review authority is always an explicit grant.
export const AUTHOR_PERMISSIONS: Permission[] = [
  "plans:read", "plans:write", "plans:comment", "plans:resolve",
];
export const PERMISSION_PRESETS: Record<string, Permission[]> = {
  author: AUTHOR_PERMISSIONS,
  oracle: ["plans:read", "plans:comment", "plans:review"],
  reader: ["plans:read"],
};

export function parsePermissions(value: unknown): Permission[] | null {
  if (!Array.isArray(value) || value.length > PERMISSION_OPTIONS.length ||
    value.some((item) => !PERMISSION_OPTIONS.some(({ id }) => id === item))) return null;
  // Canonical order, no duplicates. An explicit empty array grants nothing.
  return PERMISSION_OPTIONS.filter(({ id }) => value.includes(id)).map(({ id }) => id);
}

export function storedPermissions(value: string): Permission[] {
  try {
    return parsePermissions(JSON.parse(value)) ?? [];
  } catch {
    return []; // Corrupt persisted permissions must not restore the author defaults.
  }
}

// Unknown routes have no permission mapping and must remain 404, never fall through.
export function agentPermission(method: string, segments: string[]): Permission | null {
  if (segments.length === 0) {
    return method === "GET" ? "plans:read" : method === "POST" ? "plans:write" : null;
  }
  if (segments.length === 1) {
    return method === "GET" ? "plans:read" : method === "PUT" ? "plans:write" : null;
  }
  if (segments.length === 2 && segments[1] === "comments") {
    return method === "GET" ? "plans:read" : method === "POST" ? "plans:comment" : null;
  }
  if (segments.length === 2 && segments[1] === "review" && method === "POST") return "plans:review";
  if (segments.length === 4 && segments[1] === "comments" && segments[3] === "resolve" && method === "POST") {
    return "plans:resolve";
  }
  return null;
}
