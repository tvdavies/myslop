import { validBindingName, validSlug } from "./core";
import { parseCron } from "./cron";

const RESERVED_RUNTIME_BINDINGS = ["DB", "FILES", "MYSLOP_APP_ID", "MYSLOP_APP_ORIGIN", "MYSLOP_INTERNAL_SECRET"];

export const MANIFEST_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://myslop.cloud/schema/v1.json",
  title: "Myslop app manifest",
  type: "object",
  additionalProperties: false,
  properties: {
    $schema: { type: "string" },
    version: { const: 1 },
    app: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", minLength: 1, maxLength: 100 },
        description: { type: "string", maxLength: 500 },
        visibility: { enum: ["private", "team", "public"] },
        folder: {
          anyOf: [
            { type: "string", pattern: "^[a-z][a-z0-9-]{1,46}[a-z0-9]$" },
            { type: "null" },
          ],
        },
        domains: {
          type: "array",
          maxItems: 10,
          uniqueItems: true,
          items: { type: "string", pattern: "^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\\.myslop\\.app$" },
        },
        resources: {
          type: "object",
          additionalProperties: false,
          properties: {
            database: {
              type: "object",
              additionalProperties: false,
              required: ["id", "name"],
              properties: { id: { type: "string", minLength: 1 }, name: { type: "string", minLength: 1 } },
            },
            bucket: {
              type: "object",
              additionalProperties: false,
              required: ["name"],
              properties: { name: { type: "string", minLength: 1 } },
            },
          },
        },
      },
    },
    access: {
      type: "object",
      additionalProperties: false,
      required: ["audience"],
      properties: {
        audience: { enum: ["restricted", "team", "public"] },
        users: {
          type: "array",
          maxItems: 100,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["email", "role"],
            properties: {
              email: { type: "string", format: "email", maxLength: 254 },
              role: { enum: ["viewer", "editor", "owner"] },
            },
          },
        },
        groups: {
          type: "array",
          maxItems: 100,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["slug", "role"],
            properties: {
              slug: { type: "string", pattern: "^[a-z][a-z0-9-]{1,46}[a-z0-9]$" },
              role: { enum: ["viewer", "editor"] },
            },
          },
        },
      },
    },
    capabilities: {
      type: "object",
      additionalProperties: false,
      properties: {
        database: { type: "boolean" },
        files: { type: "boolean" },
        secrets: {
          type: "array",
          uniqueItems: true,
          items: { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,63}$", not: { enum: RESERVED_RUNTIME_BINDINGS } },
        },
        network: { type: "array", uniqueItems: true, items: { type: "string", pattern: "^(?!.*\\.\\.)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$" } },
        email: { type: "boolean" },
        schedules: {
          type: "array",
          maxItems: 3,
          uniqueItems: true,
          items: { type: "string", minLength: 9, maxLength: 100 },
        },
        durableObjects: {
          type: "array",
          maxItems: 8,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["class"],
            properties: {
              class: { type: "string", pattern: "^[A-Za-z_$][A-Za-z0-9_$]{0,127}$" },
              binding: { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,63}$" },
            },
          },
        },
      },
    },
  },
} as const;

export interface AppResourcesManifest {
  database?: { id: string; name: string };
  bucket?: { name: string };
}

export interface AccessUserManifest {
  email: string;
  role: "viewer" | "editor" | "owner";
}

export interface AccessGroupManifest {
  slug: string;
  role: "viewer" | "editor";
}

export interface AccessManifest {
  audience: "restricted" | "team" | "public";
  users?: AccessUserManifest[];
  groups?: AccessGroupManifest[];
}

export interface ResolvedAccessManifest {
  audience: "restricted" | "team" | "public";
  users: AccessUserManifest[];
  groups: AccessGroupManifest[];
}

export interface AppManifest {
  name?: string;
  description?: string;
  visibility?: "private" | "team" | "public";
  folder?: string | null;
  domains?: string[];
  resources?: AppResourcesManifest;
}

export interface ResolvedAppManifest {
  name: string;
  description: string;
  visibility: "private" | "team" | "public";
  domains: string[];
  resources: AppResourcesManifest;
  folder?: string | null;
  access?: ResolvedAccessManifest;
}

export interface SourceDurableObject {
  class: string;
  binding?: string;
}

export interface SourceManifest {
  $schema?: string;
  version?: 1;
  app?: AppManifest;
  access?: AccessManifest;
  capabilities?: {
    database?: boolean;
    files?: boolean;
    secrets?: string[];
    network?: string[];
    email?: boolean;
    schedules?: string[];
    durableObjects?: SourceDurableObject[];
  };
}

export interface ResolvedDurableObject {
  className: string;
  binding: string;
}

export interface ResolvedManifest {
  version: 1;
  assets: boolean;
  worker: boolean;
  capabilities: {
    database: boolean;
    files: boolean;
    secrets: string[];
    network: string[];
    email: boolean;
    schedules: string[];
    durableObjects: ResolvedDurableObject[];
  };
}

interface Detection {
  assets: boolean;
  worker: boolean;
  migrations: boolean;
  schema?: boolean;
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function validNetworkHost(value: string): boolean {
  if (!/^[a-z0-9.-]+$/i.test(value) || value.startsWith(".") || value.endsWith(".") || value.includes("..")) return false;
  try {
    const url = new URL(`https://${value}`);
    return url.hostname === value.toLowerCase() && !url.port && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function normalizeAppDomain(value: string): string {
  const hostname = value.trim().toLowerCase();
  if (!hostname.endsWith(".myslop.app") || hostname === "apps.myslop.app" || hostname.endsWith(".apps.myslop.app")) {
    throw new Error("app.domains must contain aliases in the myslop.app zone outside apps.myslop.app");
  }
  try {
    const url = new URL(`https://${hostname}`);
    if (url.hostname !== hostname || url.port || url.username || url.password || !hostname.includes(".")) throw new Error();
  } catch {
    throw new Error(`invalid app domain: ${value}`);
  }
  return hostname;
}

// `restricted` is the manifest-facing name for the stored `private` visibility.
function audienceForVisibility(visibility: AppManifest["visibility"]): AccessManifest["audience"] | undefined {
  return visibility === "private" ? "restricted" : visibility;
}

function visibilityForAudience(audience: AccessManifest["audience"]): NonNullable<AppManifest["visibility"]> {
  return audience === "restricted" ? "private" : audience;
}

function normalizeAccessManifest(value: unknown, legacyVisibility: AppManifest["visibility"]): ResolvedAccessManifest | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("access must be an object");
  const access = value as Partial<AccessManifest>;
  const unknown = Object.keys(access).find((key) => !["audience", "users", "groups"].includes(key));
  if (unknown) throw new Error(`unknown access field: ${unknown}`);
  if (!access.audience || !["restricted", "team", "public"].includes(access.audience)) throw new Error("access.audience is invalid");
  const legacyAudience = audienceForVisibility(legacyVisibility);
  if (legacyAudience && legacyAudience !== access.audience) throw new Error("app.visibility and access.audience must agree");
  const users = access.users ?? [];
  if (!Array.isArray(users) || users.length > 100) throw new Error("access.users must contain at most 100 assignments");
  const normalizedUsers = users.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("access.users entries must be objects");
    const unknownUser = Object.keys(entry).find((key) => !["email", "role"].includes(key));
    if (unknownUser) throw new Error(`unknown access user field: ${unknownUser}`);
    const email = String(entry.email ?? "").trim().toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`invalid access user email: ${entry.email}`);
    if (!["viewer", "editor", "owner"].includes(entry.role)) throw new Error("access user role is invalid");
    return { email, role: entry.role } as AccessUserManifest;
  }).sort((left, right) => left.email.localeCompare(right.email));
  if (new Set(normalizedUsers.map(({ email }) => email)).size !== normalizedUsers.length) throw new Error("access.users must not contain duplicates");
  const groups = access.groups ?? [];
  if (!Array.isArray(groups) || groups.length > 100) throw new Error("access.groups must contain at most 100 assignments");
  const normalizedGroups = groups.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("access.groups entries must be objects");
    const unknownGroup = Object.keys(entry).find((key) => !["slug", "role"].includes(key));
    if (unknownGroup) throw new Error(`unknown access group field: ${unknownGroup}`);
    const slug = String(entry.slug ?? "").trim().toLowerCase();
    if (!validSlug(slug)) throw new Error(`invalid access group slug: ${entry.slug}`);
    if (!["viewer", "editor"].includes(entry.role)) throw new Error("access group role is invalid");
    return { slug, role: entry.role } as AccessGroupManifest;
  }).sort((left, right) => left.slug.localeCompare(right.slug));
  if (new Set(normalizedGroups.map(({ slug }) => slug)).size !== normalizedGroups.length) throw new Error("access.groups must not contain duplicates");
  return { audience: access.audience, users: normalizedUsers, groups: normalizedGroups };
}

export function normalizeAppManifest(source: SourceManifest): ResolvedAppManifest {
  const app = source.app ?? {};
  const unknown = Object.keys(app).find((key) => !["name", "description", "visibility", "folder", "domains", "resources"].includes(key));
  if (unknown) throw new Error(`unknown app field: ${unknown}`);
  const name = app.name === undefined ? "" : String(app.name).trim();
  const description = app.description === undefined ? "" : String(app.description).trim();
  if (name.length > 100) throw new Error("app.name must be at most 100 characters");
  if (description.length > 500) throw new Error("app.description must be at most 500 characters");
  if (app.visibility !== undefined && !["private", "team", "public"].includes(app.visibility)) {
    throw new Error("app.visibility is invalid");
  }
  const folder = app.folder === undefined ? undefined : app.folder;
  if (folder !== undefined && folder !== null && (typeof folder !== "string" || !validSlug(folder))) {
    throw new Error("app.folder must be a folder slug or null");
  }
  const access = normalizeAccessManifest(source.access, app.visibility);
  // An explicit access block is the source of truth once the legacy visibility field is omitted.
  const visibility = app.visibility ?? (access ? visibilityForAudience(access.audience) : "team");
  const rawDomains = app.domains ?? [];
  if (!Array.isArray(rawDomains) || rawDomains.length > 10 || !rawDomains.every((domain) => typeof domain === "string")) {
    throw new Error("app.domains must contain at most 10 hostnames");
  }
  if (rawDomains.length) {
    throw new Error("app.domains cannot claim managed myslop.app hostnames; the default hostname is allocated from the app slug");
  }
  const domains: string[] = [];
  const resources = app.resources ?? {};
  if (typeof resources !== "object" || Array.isArray(resources)) throw new Error("app.resources must be an object");
  const unknownResource = Object.keys(resources).find((key) => !["database", "bucket"].includes(key));
  if (unknownResource) throw new Error(`unknown app resource: ${unknownResource}`);
  if (resources.database && (!resources.database.id?.trim() || !resources.database.name?.trim())) {
    throw new Error("app.resources.database requires id and name");
  }
  if (resources.bucket && !resources.bucket.name?.trim()) throw new Error("app.resources.bucket requires name");
  return {
    name,
    description,
    visibility,
    domains,
    resources: {
      ...(resources.database ? { database: { id: resources.database.id.trim(), name: resources.database.name.trim() } } : {}),
      ...(resources.bucket ? { bucket: { name: resources.bucket.name.trim() } } : {}),
    },
    ...(folder !== undefined ? { folder: folder === null ? null : folder.trim().toLowerCase() } : {}),
    ...(access ? { access } : {}),
  };
}

function defaultBinding(className: string): string {
  const binding = className
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  if (!binding || !/^[A-Z][A-Z0-9_]{0,63}$/.test(binding)) {
    throw new Error(`durable object class ${className} needs an explicit binding`);
  }
  return binding;
}

function normalizeDurableObjects(value: unknown): ResolvedDurableObject[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) throw new Error("capabilities.durableObjects must contain at most 8 classes");
  const resolved = value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("durable object declarations must be objects");
    const input = entry as Partial<SourceDurableObject>;
    const unknown = Object.keys(input).find((key) => !["class", "binding"].includes(key));
    if (unknown) throw new Error(`unknown durable object field: ${unknown}`);
    if (typeof input.class !== "string" || !/^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(input.class)) {
      throw new Error("durable object class names must be JavaScript identifiers");
    }
    const binding = input.binding ?? defaultBinding(input.class);
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(binding) || RESERVED_RUNTIME_BINDINGS.includes(binding)) {
      throw new Error(`invalid durable object binding: ${binding}`);
    }
    return { className: input.class, binding };
  });
  if (new Set(resolved.map(({ className }) => className)).size !== resolved.length) throw new Error("durable object classes must be unique");
  if (new Set(resolved.map(({ binding }) => binding)).size !== resolved.length) throw new Error("durable object bindings must be unique");
  return resolved.sort((left, right) => left.binding.localeCompare(right.binding));
}

function normalizeSchedules(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 3 || !value.every((schedule) => typeof schedule === "string")) {
    throw new Error("capabilities.schedules must contain at most 3 cron expressions");
  }
  const schedules = value.map((schedule) => parseCron(schedule).expression);
  if (new Set(schedules).size !== schedules.length) throw new Error("capabilities.schedules must not contain duplicates");
  return schedules.sort();
}

export function resolveManifest(source: unknown, detected: Detection): ResolvedManifest {
  if (source === null || source === undefined) source = {};
  if (typeof source !== "object" || Array.isArray(source)) throw new Error("myslop.json must contain an object");
  const input = source as SourceManifest;
  const unknownTopLevel = Object.keys(input).find((key) => !["$schema", "version", "app", "access", "capabilities"].includes(key));
  if (unknownTopLevel) throw new Error(`unknown myslop.json field: ${unknownTopLevel}`);
  if (input.$schema !== undefined && typeof input.$schema !== "string") throw new Error("$schema must be a string");
  if (input.version !== undefined && input.version !== 1) throw new Error("unsupported myslop.json version");
  if (input.app !== undefined && (typeof input.app !== "object" || Array.isArray(input.app))) throw new Error("app must be an object");
  normalizeAppManifest(input);
  if (input.capabilities !== undefined && (typeof input.capabilities !== "object" || Array.isArray(input.capabilities))) {
    throw new Error("capabilities must be an object");
  }
  const capabilities = input.capabilities ?? {};
  const unknownCapability = Object.keys(capabilities).find((key) => !["database", "files", "secrets", "network", "email", "schedules", "durableObjects"].includes(key));
  if (unknownCapability) throw new Error(`unknown capability: ${unknownCapability}`);
  for (const key of ["database", "files", "email"] as const) {
    if (capabilities[key] !== undefined && typeof capabilities[key] !== "boolean") {
      throw new Error(`capabilities.${key} must be true or false`);
    }
  }
  const secrets = capabilities.secrets ?? [];
  const network = capabilities.network ?? [];
  if (!Array.isArray(secrets) || !secrets.every(validBindingName)) {
    throw new Error("capabilities.secrets must contain uppercase, non-reserved binding names");
  }
  if (new Set(secrets).size !== secrets.length) throw new Error("capabilities.secrets must not contain duplicates");
  if (!Array.isArray(network) || !network.every((host) => typeof host === "string" && validNetworkHost(host))) {
    throw new Error("capabilities.network must contain hostnames without schemes or paths");
  }
  if (new Set(network.map((host) => host.toLowerCase())).size !== network.length) {
    throw new Error("capabilities.network must not contain duplicates");
  }
  const resolved: ResolvedManifest = {
    version: 1,
    assets: detected.assets,
    worker: detected.worker,
    capabilities: {
      database: detected.migrations || detected.schema === true || capabilities.database === true,
      files: capabilities.files === true,
      secrets: unique(secrets),
      network: unique(network.map((host) => host.toLowerCase())),
      email: capabilities.email === true,
      schedules: normalizeSchedules(capabilities.schedules),
      durableObjects: normalizeDurableObjects(capabilities.durableObjects),
    },
  };
  const runtime = resolved.capabilities;
  const needsWorker = runtime.database || runtime.files || runtime.secrets.length > 0 || runtime.network.length > 0 || runtime.email || runtime.schedules.length > 0 || runtime.durableObjects.length > 0;
  if (needsWorker && !resolved.worker) {
    throw new Error(detected.schema ? "schema.sql requires worker.ts" : "runtime capabilities require worker.ts");
  }
  return resolved;
}

export function parseResolvedManifest(value: unknown): ResolvedManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("deployment manifest is required");
  const input = value as Partial<ResolvedManifest>;
  const unknownTopLevel = Object.keys(input).find((key) => !["version", "assets", "worker", "capabilities"].includes(key));
  if (unknownTopLevel) throw new Error(`unknown deployment manifest field: ${unknownTopLevel}`);
  if (input.version !== 1 || typeof input.assets !== "boolean" || typeof input.worker !== "boolean") {
    throw new Error("invalid deployment manifest");
  }
  const capabilities = input.capabilities;
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) throw new Error("invalid deployment capabilities");
  const unknownCapability = Object.keys(capabilities).find((key) => !["database", "files", "secrets", "network", "email", "schedules", "durableObjects"].includes(key));
  if (unknownCapability) throw new Error(`unknown deployment capability: ${unknownCapability}`);
  if (
    typeof capabilities.database !== "boolean" ||
    typeof capabilities.files !== "boolean" ||
    !Array.isArray(capabilities.secrets) ||
    !Array.isArray(capabilities.network) ||
    (capabilities.email !== undefined && typeof capabilities.email !== "boolean") ||
    (capabilities.schedules !== undefined && !Array.isArray(capabilities.schedules)) ||
    (capabilities.durableObjects !== undefined && !Array.isArray(capabilities.durableObjects))
  ) {
    throw new Error("resolved deployment capabilities must be complete");
  }
  return resolveManifest(
    {
      version: 1,
      capabilities: {
        database: capabilities.database,
        files: capabilities.files,
        secrets: capabilities.secrets,
        network: capabilities.network,
        email: capabilities.email ?? false,
        schedules: capabilities.schedules ?? [],
        durableObjects: (capabilities.durableObjects ?? []).map(({ className, binding }) => ({ class: className, binding })),
      },
    },
    { assets: input.assets, worker: input.worker, migrations: false },
  );
}
