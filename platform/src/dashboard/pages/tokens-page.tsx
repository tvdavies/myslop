import { Clipboard, KeyRound, LoaderCircle, Plus, Trash2 } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { SimpleConfirmDialog } from "@/components/dialogs/simple-confirm-dialog";
import { EmptyState, RouteError, RouteLoading } from "@/components/feedback/route-state";
import { FieldBlock } from "@/components/form-controls";
import { PageHeader } from "@/components/page-header";
import { Panel, PanelBody, PanelHeader } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useRouteResource } from "@/hooks/use-route-resource";
import { apiRequest, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { useDashboard } from "@/shell/dashboard-context";
import type { ApiToken, AppsResponse, ListedApp, TokenCreationResponse, TokensResponse } from "@/types/api";

export function TokensPage() {
  const dashboard = useDashboard();
  const [revision, setRevision] = React.useState(0);
  const [name, setName] = React.useState("");
  const [scope, setScope] = React.useState("");
  const [secret, setSecret] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [revoking, setRevoking] = React.useState<ApiToken | null>(null);
  useDocumentTitle("Tokens");

  const resource = useRouteResource(`${dashboard.teamId}:${revision}`, async (signal) => {
    const [tokens, apps] = await Promise.all([
      apiRequest<TokensResponse>("/api/tokens", { signal }),
      apiRequest<AppsResponse>(`/api/apps?teamId=${encodeURIComponent(dashboard.teamId)}&sort=name&direction=asc`, { signal }),
    ]);
    return { tokens: tokens.tokens || [], apps: apps.apps || [] };
  });
  const refresh = () => setRevision((value) => value + 1);
  const apps = resource.status === "ready" ? resource.data.apps : [];
  const manageable = apps.filter((app) => app.permissions.modifySecrets);
  const appMap = new Map<string, ListedApp>(apps.map((app) => [app.id, app]));

  function scopeLabel(token: ApiToken): string {
    if (!token.app_id) return "All manageable apps";
    return appMap.get(token.app_id)?.name || "One app";
  }

  async function createToken(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await apiRequest<TokenCreationResponse>("/api/tokens", {
        method: "POST",
        body: { name: name.trim() || "agent", appId: scope || undefined },
      });
      setSecret(result.token.secret);
      setName("");
      setScope("");
      toast.success("Token generated");
      refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function revokeToken() {
    if (!revoking) return;
    try {
      await apiRequest(`/api/tokens/${encodeURIComponent(revoking.id)}`, { method: "DELETE" });
      toast.success("Token revoked");
      refresh();
    } catch (error) {
      toast.error(errorMessage(error));
      throw error;
    }
  }

  return (
    <div className="content-width">
      <PageHeader
        crumbs={["Account", "Tokens"]}
        title="Agent API tokens"
        description="Issue revocable credentials to local machines and agents."
      />
      {resource.status === "loading" ? <RouteLoading label="Loading tokens…" /> : null}
      {resource.status === "error" ? <RouteError message={resource.error} retry={resource.retry} /> : null}
      {resource.status === "ready" ? (
        <>
          <Panel className="mb-3">
            <PanelHeader title="Generate token" description="Use an all-app token or restrict it to one app you can manage." />
            <PanelBody>
              <form onSubmit={createToken}>
                <div className="form-grid sm:grid-cols-2">
                  <FieldBlock label="Token name" htmlFor="token-name">
                    <Input id="token-name" maxLength={100} placeholder="Laptop or agent name" value={name} onChange={(event) => setName(event.target.value)} />
                  </FieldBlock>
                  <FieldBlock label="Scope" htmlFor="token-scope">
                    <NativeSelect className="w-full" id="token-scope" value={scope} onChange={(event) => setScope(event.target.value)}>
                      <option value="">All apps I can manage</option>
                      {manageable.map((app) => <option key={app.id} value={app.id}>Only {app.name}</option>)}
                    </NativeSelect>
                  </FieldBlock>
                </div>
                <div className="form-actions">
                  <Button type="submit" disabled={busy}>{busy ? <LoaderCircle className="animate-spin" /> : <Plus />}Generate token</Button>
                </div>
              </form>
              {secret ? (
                <div className="token-reveal">
                  <p><KeyRound />Shown once — save it before leaving.</p>
                  <code>{secret}</code>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={async () => {
                      await navigator.clipboard.writeText(secret);
                      toast.success("Token copied");
                    }}
                  >
                    <Clipboard />Copy token
                  </Button>
                </div>
              ) : null}
            </PanelBody>
          </Panel>
          <Panel>
            <PanelHeader title="Active tokens" meta={`${resource.data.tokens.length} tokens`} />
            {resource.data.tokens.length ? (
              <>
                <div className="desktop-directory">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Token</TableHead>
                        <TableHead>Scope</TableHead>
                        <TableHead>Created</TableHead>
                        <TableHead>Last used</TableHead>
                        <TableHead><span className="sr-only">Actions</span></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {resource.data.tokens.map((token) => (
                        <TableRow key={token.id}>
                          <TableCell>
                            <div className="name-stack">
                              <strong>{token.name}</strong>
                              <small className="font-mono">{token.prefix}…</small>
                            </div>
                          </TableCell>
                          <TableCell>{scopeLabel(token)}</TableCell>
                          <TableCell>{formatDateTime(token.created_at)}</TableCell>
                          <TableCell>{formatDateTime(token.last_used_at)}</TableCell>
                          <TableCell>
                            <Button variant="outline" size="sm" onClick={() => setRevoking(token)}><Trash2 />Revoke</Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <div className="mobile-directory">
                  {resource.data.tokens.map((token) => (
                    <article className="mobile-admin-row" key={token.id}>
                      <div className="name-stack">
                        <strong>{token.name}</strong>
                        <small>{token.prefix}… · {scopeLabel(token)}</small>
                      </div>
                      <small>Created {formatDateTime(token.created_at)} · Last used {formatDateTime(token.last_used_at)}</small>
                      <Button variant="outline" size="sm" onClick={() => setRevoking(token)}>Revoke</Button>
                    </article>
                  ))}
                </div>
              </>
            ) : (
              <EmptyState title="No active tokens" description="Generate one when an agent or machine needs to deploy and manage apps." />
            )}
            <div className="setup-command">New machine? Run <code>curl -fsS https://apps.myslop.app/setup.sh | bash</code></div>
          </Panel>
        </>
      ) : null}
      <SimpleConfirmDialog
        open={Boolean(revoking)}
        onOpenChange={(open) => { if (!open) setRevoking(null); }}
        title="Revoke token"
        description="Revoke this token? Any agent using it will lose access."
        confirmLabel="Revoke token"
        destructive
        onConfirm={revokeToken}
      />
    </div>
  );
}
