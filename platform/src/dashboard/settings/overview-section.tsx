import { LoaderCircle } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { FieldBlock } from "@/components/form-controls";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest, errorMessage } from "@/lib/api";
import { nestedFolders } from "@/lib/folders";
import { useDashboard } from "@/shell/dashboard-context";
import { SettingsSection } from "@/settings/settings-section";
import type { AppDetailResponse } from "@/types/api";

export function OverviewSection({ detail, refresh }: { detail: AppDetailResponse; refresh: () => void }) {
  const dashboard = useDashboard();
  const { app, access } = detail;
  const [name, setName] = React.useState(app.name);
  const [description, setDescription] = React.useState(app.description || "");
  const [folderId, setFolderId] = React.useState(app.folderId || "");
  const [busy, setBusy] = React.useState<string | null>(null);

  React.useEffect(() => {
    setName(app.name);
    setDescription(app.description || "");
    setFolderId(app.folderId || "");
  }, [app.name, app.description, app.folderId]);

  async function saveMetadata(event: React.FormEvent) {
    event.preventDefault();
    setBusy("metadata");
    try {
      await apiRequest(`/api/apps/${encodeURIComponent(app.id)}`, { method: "PATCH", body: { name, description } });
      toast.success("Overview saved");
      refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function moveApp(event: React.FormEvent) {
    event.preventDefault();
    setBusy("folder");
    try {
      await apiRequest(`/api/apps/${encodeURIComponent(app.id)}/folder`, { method: "PATCH", body: { folderId: folderId || null } });
      await dashboard.refetchFolders();
      toast.success("App moved");
      refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  return (
    <SettingsSection id="overview" title="Overview" description="Identity, ownership and library location.">
      <form onSubmit={saveMetadata}>
        <div className="form-grid sm:grid-cols-2">
          <FieldBlock label="Name" htmlFor="settings-name">
            <Input
              id="settings-name"
              maxLength={100}
              value={name}
              disabled={!app.permissions.modifyMetadata}
              onChange={(event) => setName(event.target.value)}
            />
          </FieldBlock>
          <FieldBlock label="Primary owner" htmlFor="settings-owner">
            <Input id="settings-owner" value={access.owner?.name || access.owner?.email || "Unknown"} disabled />
          </FieldBlock>
        </div>
        <FieldBlock label="Description" htmlFor="settings-description">
          <Textarea
            id="settings-description"
            maxLength={500}
            value={description}
            disabled={!app.permissions.modifyMetadata}
            onChange={(event) => setDescription(event.target.value)}
          />
        </FieldBlock>
        {app.permissions.modifyMetadata ? (
          <div className="form-actions">
            <Button type="submit" disabled={busy === "metadata"}>
              {busy === "metadata" ? <LoaderCircle className="animate-spin" /> : null}Save overview
            </Button>
          </div>
        ) : null}
      </form>
      <div className="section-divider" />
      <form onSubmit={moveApp}>
        <FieldBlock label="Folder" htmlFor="settings-folder" help="Moving an app changes where it appears, not its URL.">
          <NativeSelect
            className="w-full"
            id="settings-folder"
            value={folderId}
            disabled={!app.permissions.moveApp}
            onChange={(event) => setFolderId(event.target.value)}
          >
            <option value="">Root</option>
            {nestedFolders(dashboard.folders).map(({ folder, depth }) => (
              <option key={folder.id} value={folder.id}>{"— ".repeat(depth)}{folder.name}</option>
            ))}
          </NativeSelect>
        </FieldBlock>
        {app.permissions.moveApp ? (
          <div className="form-actions">
            <Button type="submit" variant="outline" disabled={busy === "folder"}>
              {busy === "folder" ? <LoaderCircle className="animate-spin" /> : null}Move app
            </Button>
          </div>
        ) : null}
      </form>
    </SettingsSection>
  );
}
