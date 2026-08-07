export class ApiError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly unauthorized: boolean;

  constructor(message: string, status: number, body: Record<string, unknown> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    this.unauthorized = status === 401;
  }
}

let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

export async function apiRequest<T>(
  path: string,
  options: Omit<RequestInit, "body"> & { body?: unknown } = {},
): Promise<T> {
  const hasBody = options.body !== undefined;
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(hasBody ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
    body: hasBody ? JSON.stringify(options.body) : undefined,
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    if (response.status === 401) unauthorizedHandler?.();
    throw new ApiError(String(body.error || response.statusText || "Request failed"), response.status, body);
  }
  return body as T;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed";
}
