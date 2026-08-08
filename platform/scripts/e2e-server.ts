import { DASHBOARD_CSS, DASHBOARD_JS } from "../src/dashboard-assets.generated";

const argument = process.argv.indexOf("--port");
const port = argument >= 0 ? Number(process.argv[argument + 1]) : 8799;
const html = await Bun.file(new URL("../src/dashboard.html", import.meta.url)).text();

Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/assets/dashboard.js") {
      return new Response(DASHBOARD_JS, { headers: { "content-type": "text/javascript; charset=utf-8" } });
    }
    if (pathname === "/assets/dashboard.css") {
      return new Response(DASHBOARD_CSS, { headers: { "content-type": "text/css; charset=utf-8" } });
    }
    if (pathname.startsWith("/api/")) return Response.json({ error: "unmocked test API" }, { status: 500 });
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  },
});
