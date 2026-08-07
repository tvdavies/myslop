export interface Dispatcher {
  get(
    name: string,
    args?: Record<string, unknown>,
    options?: {
      limits?: { cpuMs?: number; subRequests?: number };
      outbound?: { policy: { appId: string; hosts: string[] } };
    },
  ): Fetcher;
}

export interface Env {
  CONTROL_DB: D1Database;
  ASSETS: R2Bucket;
  DISPATCHER: Dispatcher;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN: string;
  SECRET_ENCRYPTION_KEY: string;
  DISPATCH_NAMESPACE?: string;
  ALLOWED_EMAIL_DOMAIN?: string;
}

export interface User {
  id: string;
  email: string | null;
  name: string | null;
  picture: string | null;
  platform_role: "member" | "owner";
}

export interface AppRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  owner_id: string;
  visibility: "private" | "team" | "public";
  worker_name: string;
  d1_id: string | null;
  d1_name: string | null;
  r2_bucket: string | null;
  custom_domain_id: string | null;
  d1_delete_after: number | null;
  r2_delete_after: number | null;
  active_version: number | null;
  created_at: number;
  updated_at: number;
}

export interface DeploymentRow {
  id: string;
  app_id: string;
  version: number;
  asset_prefix: string;
  worker_key: string | null;
  worker_name: string | null;
  worker_sha256: string | null;
  manifest_json: string;
  status: "pending" | "active" | "failed";
  created_by: string;
  created_at: number;
}
