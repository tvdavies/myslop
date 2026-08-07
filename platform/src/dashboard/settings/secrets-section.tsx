import { LoaderCircle, LockKeyhole } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { FieldBlock } from "@/components/form-controls";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiRequest, errorMessage } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { SettingsSection } from "@/settings/settings-section";
import type { AppDetailResponse } from "@/types/api";

export function SecretsSection({ detail, refresh }: { detail: AppDetailResponse; refresh: () => void }) {
  const { app } = detail;
  const [name, setName] = React.useState("");
  const [value, setValue] = React.useState("");
  const [replacements, setReplacements] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState<string | null>(null);

  async function saveSecret(secretName: string, secretValue: string, success: string) {
    if (!secretName || !secretValue) {
      toast.error("Enter a secret name and value");
      return;
    }
    setBusy(secretName);
    try {
      await apiRequest(`/api/apps/${encodeURIComponent(app.id)}/secrets/${encodeURIComponent(secretName)}`, { method: "PUT", body: { value: secretValue } });
      toast.success(success);
      setName("");
      setValue("");
      setReplacements((current) => ({ ...current, [secretName]: "" }));
      refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  function replaceSecret(secretName: string) {
    const replacement = replacements[secretName] || "";
    if (!replacement) {
      toast.error("Enter a replacement secret value");
      return;
    }
    void saveSecret(secretName, replacement, `${secretName} updated`);
  }

  return (
    <SettingsSection id="secrets" title="Secrets" description="Values are write-only and never returned by the API.">
      {app.permissions.modifySecrets ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void saveSecret(name.trim(), value, `${name.trim()} set`);
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <FieldBlock label="Secret name" htmlFor="new-secret-name">
              <Input
                id="new-secret-name"
                className="font-mono"
                pattern="[A-Z][A-Z0-9_]*"
                placeholder="API_TOKEN"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </FieldBlock>
            <FieldBlock label="Value" htmlFor="new-secret-value">
              <Input
                id="new-secret-value"
                type="password"
                autoComplete="new-password"
                placeholder="Secret value"
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
            </FieldBlock>
          </div>
          <div className="form-actions">
            <Button type="submit" variant="outline" disabled={Boolean(busy)}>Set secret</Button>
          </div>
        </form>
      ) : null}
      <div className="section-divider" />
      <div className="secret-list">
        {detail.secrets.length ? (
          detail.secrets.map((secret) => (
            <div className="secret-row" key={secret.name}>
              <span>
                <strong className="font-mono"><LockKeyhole />{secret.name}</strong>
                {secret.updated_at ? <small>Updated {relativeTime(secret.updated_at)}</small> : null}
              </span>
              {app.permissions.modifySecrets ? (
                <>
                  <label>
                    <span className="sr-only">New value for {secret.name}</span>
                    <Input
                      type="password"
                      autoComplete="new-password"
                      placeholder="Enter replacement value"
                      value={replacements[secret.name] || ""}
                      onChange={(event) => setReplacements((current) => ({ ...current, [secret.name]: event.target.value }))}
                    />
                  </label>
                  <Button variant="outline" size="sm" disabled={busy === secret.name} onClick={() => replaceSecret(secret.name)}>
                    {busy === secret.name ? <LoaderCircle className="animate-spin" /> : null}Update
                  </Button>
                </>
              ) : (
                <span className="text-muted-foreground">Value hidden</span>
              )}
            </div>
          ))
        ) : (
          <div className="compact-row text-muted-foreground">No configured secrets</div>
        )}
      </div>
    </SettingsSection>
  );
}
