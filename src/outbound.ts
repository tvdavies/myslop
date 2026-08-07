interface OutboundPolicy {
  appId?: string;
  hosts?: string[];
}

interface Env {
  policy?: OutboundPolicy;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const hostname = new URL(request.url).hostname.toLowerCase();
    const allowed = new Set(env.policy?.hosts ?? []);
    if (!allowed.has(hostname)) {
      console.warn("blocked app egress", { appId: env.policy?.appId, hostname });
      return Response.json({ error: "outbound host is not declared in myslop.json" }, { status: 403 });
    }
    // Return redirects to the user Worker. If it chooses to follow one, that
    // becomes a new outbound fetch and is checked against the allowlist again.
    return fetch(new Request(request, { redirect: "manual" }));
  },
} satisfies ExportedHandler<Env>;
