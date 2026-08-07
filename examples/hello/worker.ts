interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  MYSLOP_APP_ID: string;
  MYSLOP_APP_ORIGIN: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const user = {
      id: request.headers.get("x-myslop-user-id"),
      email: request.headers.get("x-myslop-user-email"),
      name: request.headers.get("x-myslop-user-name"),
    };
    if (url.pathname === "/api/me" && request.method === "GET") return Response.json(user);
    if (url.pathname === "/api/count" && request.method === "GET") {
      const row = await env.DB.prepare("SELECT value FROM counters WHERE id='main'").first<{ value: number }>();
      return Response.json({ value: row?.value ?? 0 });
    }
    if (url.pathname === "/api/count" && request.method === "POST") {
      await env.DB.prepare("UPDATE counters SET value=value+1 WHERE id='main'").run();
      const row = await env.DB.prepare("SELECT value FROM counters WHERE id='main'").first<{ value: number }>();
      return Response.json({ value: row?.value ?? 0 });
    }
    return new Response("not found", { status: 404 });
  },
};
