import type { ResolvedManifest } from "./manifest";
import { deriveAppInternalSecret } from "./internal";
import type { AppRow, Env } from "./types";

interface ApiEnvelope<T> {
  success: boolean;
  result: T;
  errors?: { message: string }[];
}

async function cf<T>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      ...(init.body instanceof FormData ? {} : { "content-type": "application/json" }),
      ...init.headers,
    },
  });
  const body = (await response.json().catch(() => null)) as ApiEnvelope<T> | null;
  if (!response.ok || !body?.success) {
    throw new Error(body?.errors?.map((error) => error.message).join("; ") || `Cloudflare API ${response.status}`);
  }
  return body.result;
}

async function cfDelete(env: Env, path: string): Promise<void> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}${path}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
  });
  if (response.ok || response.status === 404) return;
  const body = await response.text();
  throw new Error(`Cloudflare delete failed (${response.status}): ${body}`);
}

export async function createD1(env: Env, name: string): Promise<{ uuid: string; name: string }> {
  return cf(env, "/d1/database", { method: "POST", body: JSON.stringify({ name }) });
}

export async function getD1(env: Env, id: string): Promise<{ uuid: string; name: string }> {
  return cf(env, `/d1/database/${encodeURIComponent(id)}`);
}

export async function getR2Bucket(env: Env, name: string): Promise<{ name: string }> {
  return cf(env, `/r2/buckets/${encodeURIComponent(name)}`);
}

export async function createR2Bucket(env: Env, name: string): Promise<void> {
  await cf(env, "/r2/buckets", { method: "POST", body: JSON.stringify({ name }) });
}

export async function deleteD1(env: Env, id: string): Promise<void> {
  await cfDelete(env, `/d1/database/${id}`);
}

export async function deleteR2Bucket(env: Env, name: string): Promise<void> {
  await cfDelete(env, `/r2/buckets/${encodeURIComponent(name)}`);
}

export async function attachCustomDomain(
  env: Env,
  hostname: string,
  options: { overrideExistingOrigin?: boolean } = {},
): Promise<{ id: string }> {
  return cf(env, "/workers/domains", {
    method: "PUT",
    body: JSON.stringify({
      hostname,
      service: "myslop-apps",
      zone_name: hostname === "myslop.cloud" || hostname.endsWith(".myslop.cloud") ? "myslop.cloud" : "myslop.app",
      override_existing_origin: options.overrideExistingOrigin === true,
    }),
  });
}

export async function customDomainOwner(env: Env, hostname: string): Promise<string | null> {
  const domains = await cf<{ hostname: string; service: string }[]>(env, "/workers/domains");
  return domains.find((domain) => domain.hostname === hostname)?.service ?? null;
}

export async function deleteCustomDomain(env: Env, id: string): Promise<void> {
  await cfDelete(env, `/workers/domains/${encodeURIComponent(id)}`);
}

export async function deleteUserWorker(env: Env, workerName: string): Promise<void> {
  const namespace = env.DISPATCH_NAMESPACE || "myslop-apps-production";
  await cfDelete(
    env,
    `/workers/dispatch/namespaces/${encodeURIComponent(namespace)}/scripts/${encodeURIComponent(workerName)}?force=true`,
  );
}

export async function runD1Sql(env: Env, databaseId: string, sql: string): Promise<void> {
  await cf(env, `/d1/database/${databaseId}/query`, {
    method: "POST",
    body: JSON.stringify({ sql }),
  });
}

export async function queryD1<T>(env: Env, databaseId: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await cf<{ results?: T[] }[]>(env, `/d1/database/${databaseId}/query`, {
    method: "POST",
    body: JSON.stringify({ sql, params }),
  });
  return result[0]?.results ?? [];
}

export async function runD1Batch(
  env: Env,
  databaseId: string,
  statements: { sql: string; params?: unknown[] }[],
): Promise<void> {
  await cf(env, `/d1/database/${databaseId}/query`, {
    method: "POST",
    body: JSON.stringify({ batch: statements }),
  });
}

interface WorkerUploadOptions {
  source: string;
  app: AppRow;
  workerName: string;
  manifest: ResolvedManifest;
  secrets?: { name: string; value: string }[];
  internalSecretVersion?: 1 | 2;
}

export async function uploadUserWorker(env: Env, options: WorkerUploadOptions): Promise<void> {
  const { app, source, manifest, secrets = [], internalSecretVersion = 2 } = options;
  const bindings: Record<string, unknown>[] = [
    { type: "plain_text", name: "MYSLOP_APP_ID", text: app.id },
    { type: "plain_text", name: "MYSLOP_APP_ORIGIN", text: `https://${app.slug}.myslop.app` },
  ];
  if (manifest.capabilities.database) {
    if (!app.d1_id) throw new Error("database capability is not provisioned");
    bindings.push({ type: "d1", name: "DB", id: app.d1_id });
  }
  if (manifest.capabilities.files) {
    if (!app.r2_bucket) throw new Error("files capability is not provisioned");
    bindings.push({ type: "r2_bucket", name: "FILES", bucket_name: app.r2_bucket });
  }
  if (manifest.capabilities.email || manifest.capabilities.schedules.length) {
    bindings.push({
      type: "secret_text",
      name: "MYSLOP_INTERNAL_SECRET",
      text: internalSecretVersion === 2
        ? await deriveAppInternalSecret(env.INTERNAL_DISPATCH_SECRET, app.id)
        : env.INTERNAL_DISPATCH_SECRET,
    });
  }
  for (const durableObject of manifest.capabilities.durableObjects) {
    bindings.push({
      type: "durable_object_namespace",
      name: durableObject.binding,
      class_name: durableObject.className,
    });
  }
  for (const secret of secrets) {
    bindings.push({ type: "secret_text", name: secret.name, text: secret.value });
  }
  const migrations = manifest.capabilities.durableObjects.length
    ? {
      new_tag: `v${options.workerName}`,
      new_sqlite_classes: manifest.capabilities.durableObjects.map(({ className }) => className),
    }
    : undefined;
  const metadata = {
    main_module: "worker.mjs",
    compatibility_date: "2026-07-01",
    compatibility_flags: ["nodejs_compat"],
    bindings,
    ...(migrations ? { migrations } : {}),
    keep_bindings: ["secret_text"],
  };
  const form = new FormData();
  form.set("metadata", JSON.stringify(metadata));
  form.set("worker.mjs", new Blob([source], { type: "application/javascript+module" }), "worker.mjs");
  const namespace = env.DISPATCH_NAMESPACE || "myslop-apps-production";
  await cf(
    env,
    `/workers/dispatch/namespaces/${encodeURIComponent(namespace)}/scripts/${encodeURIComponent(options.workerName)}`,
    { method: "PUT", body: form },
  );
}
