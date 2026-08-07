const encoder = new TextEncoder();

export interface DashboardAsset {
  body: string;
  contentType: string;
  etag: string;
}

function ifNoneMatchMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((candidate) => {
    const normalized = candidate.trim();
    return normalized === "*" || normalized === etag || normalized === `W/${etag}`;
  });
}

export function serveDashboardAsset(request: Request, asset: DashboardAsset): Response {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("method not allowed\n", {
      status: 405,
      headers: {
        allow: "GET, HEAD",
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8",
        "x-content-type-options": "nosniff",
      },
    });
  }

  const headers = new Headers({
    "cache-control": "public, max-age=0, must-revalidate",
    "content-type": asset.contentType,
    etag: asset.etag,
    "x-content-type-options": "nosniff",
  });
  if (ifNoneMatchMatches(request.headers.get("if-none-match"), asset.etag)) {
    return new Response(null, { status: 304, headers });
  }

  headers.set("content-length", String(encoder.encode(asset.body).byteLength));
  return new Response(request.method === "HEAD" ? null : asset.body, { headers });
}
