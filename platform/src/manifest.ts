import { validBindingName } from "./core";

export const MANIFEST_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://apps.myslop.app/schema/v1.json",
  title: "Myslop Apps capability manifest",
  type: "object",
  additionalProperties: false,
  properties: {
    $schema: { type: "string" },
    version: { const: 1 },
    capabilities: {
      type: "object",
      additionalProperties: false,
      properties: {
        database: { type: "boolean" },
        files: { type: "boolean" },
        secrets: {
          type: "array",
          uniqueItems: true,
          items: { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,63}$", not: { enum: ["DB", "FILES", "MYSLOP_APP_ID", "MYSLOP_APP_ORIGIN"] } },
        },
        network: { type: "array", uniqueItems: true, items: { type: "string", pattern: "^(?!.*\\.\\.)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$" } },
      },
    },
  },
} as const;

export interface SourceManifest {
  version?: 1;
  capabilities?: {
    database?: boolean;
    files?: boolean;
    secrets?: string[];
    network?: string[];
  };
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
  };
}

interface Detection {
  assets: boolean;
  worker: boolean;
  migrations: boolean;
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

export function resolveManifest(source: unknown, detected: Detection): ResolvedManifest {
  if (source === null || source === undefined) source = {};
  if (typeof source !== "object" || Array.isArray(source)) throw new Error("myslop.json must contain an object");
  const input = source as SourceManifest;
  const topLevel = Object.keys(input as object);
  const unknownTopLevel = topLevel.filter((key) => !["$schema", "version", "capabilities"].includes(key));
  if (unknownTopLevel.length) throw new Error(`unknown myslop.json field: ${unknownTopLevel[0]}`);
  if ((input as { $schema?: unknown }).$schema !== undefined && typeof (input as { $schema?: unknown }).$schema !== "string") {
    throw new Error("$schema must be a string");
  }
  if (input.version !== undefined && input.version !== 1) throw new Error("unsupported myslop.json version");
  if (input.capabilities !== undefined && (typeof input.capabilities !== "object" || Array.isArray(input.capabilities))) {
    throw new Error("capabilities must be an object");
  }
  const capabilities = input.capabilities ?? {};
  const unknownCapability = Object.keys(capabilities).find((key) => !["database", "files", "secrets", "network"].includes(key));
  if (unknownCapability) throw new Error(`unknown capability: ${unknownCapability}`);
  for (const key of ["database", "files"] as const) {
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
      database: detected.migrations || capabilities.database === true,
      files: capabilities.files === true,
      secrets: unique(secrets),
      network: unique(network.map((host) => host.toLowerCase())),
    },
  };
  const needsWorker = resolved.capabilities.database || resolved.capabilities.files || resolved.capabilities.secrets.length > 0 || resolved.capabilities.network.length > 0;
  if (needsWorker && !resolved.worker) throw new Error("database, files, secrets, and network capabilities require worker.ts");
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
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    throw new Error("invalid deployment capabilities");
  }
  const unknownCapability = Object.keys(capabilities).find((key) => !["database", "files", "secrets", "network"].includes(key));
  if (unknownCapability) throw new Error(`unknown deployment capability: ${unknownCapability}`);
  if (
    typeof capabilities.database !== "boolean" ||
    typeof capabilities.files !== "boolean" ||
    !Array.isArray(capabilities.secrets) ||
    !Array.isArray(capabilities.network)
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
      },
    },
    { assets: input.assets, worker: input.worker, migrations: false },
  );
}
