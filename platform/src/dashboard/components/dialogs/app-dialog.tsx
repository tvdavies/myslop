import { LoaderCircle } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { FieldBlock } from "@/components/form-controls";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest, errorMessage } from "@/lib/api";
import { nestedFolders } from "@/lib/folders";
import { slugify } from "@/lib/format";
import { useDashboard } from "@/shell/dashboard-context";
import type { AppAudience } from "@/types/api";

export function AppDialog({ open, onOpenChange, defaultFolderId = "", onCreated }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultFolderId?: string;
  onCreated: () => void;
}) {
  const dashboard = useDashboard();
  const [name, setName] = React.useState("");
  const [slug, setSlug] = React.useState("");
  const [slugTouched, setSlugTouched] = React.useState(false);
  const [description, setDescription] = React.useState("");
  const [audience, setAudience] = React.useState<AppAudience>("team");
  const [folderId, setFolderId] = React.useState(defaultFolderId);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setName("");
    setSlug("");
    setSlugTouched(false);
    setDescription("");
    setAudience("team");
    setFolderId(defaultFolderId);
  }, [open, defaultFolderId]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await apiRequest("/api/apps", {
        method: "POST",
        body: { teamId: dashboard.teamId, folderId: folderId || null, name, slug, description, audience },
      });
      await dashboard.refetchFolders();
      toast.success("App created and ready for deployment");
      onOpenChange(false);
      onCreated();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Create an app</DialogTitle>
            <DialogDescription>Add a stable app address and place it in the team library.</DialogDescription>
          </DialogHeader>
          <div className="dialog-form-grid">
            <FieldBlock label="Name" htmlFor="app-name">
              <Input
                id="app-name"
                required
                maxLength={100}
                placeholder="Commercial dashboard"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  if (!slugTouched) setSlug(slugify(event.target.value));
                }}
                autoFocus
              />
            </FieldBlock>
            <FieldBlock label="URL slug" htmlFor="app-slug" help="Used for the permanent apps.myslop.app address.">
              <Input
                id="app-slug"
                required
                maxLength={48}
                pattern="[a-z][a-z0-9-]{1,46}[a-z0-9]"
                placeholder="commercial-dashboard"
                value={slug}
                onChange={(event) => {
                  setSlug(event.target.value);
                  setSlugTouched(true);
                }}
              />
            </FieldBlock>
            <FieldBlock label="Description" htmlFor="app-description">
              <Textarea
                id="app-description"
                maxLength={500}
                placeholder="What this app does"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </FieldBlock>
            <div className="form-grid sm:grid-cols-2">
              <FieldBlock label="Audience" htmlFor="app-audience">
                <NativeSelect className="w-full" id="app-audience" value={audience} onChange={(event) => setAudience(event.target.value as AppAudience)}>
                  <option value="team">Team</option>
                  <option value="restricted">Restricted</option>
                  <option value="public">Public</option>
                </NativeSelect>
              </FieldBlock>
              <FieldBlock label="Location" htmlFor="app-folder">
                <NativeSelect className="w-full" id="app-folder" value={folderId} onChange={(event) => setFolderId(event.target.value)}>
                  <option value="">Root</option>
                  {nestedFolders(dashboard.folders).map(({ folder, depth }) => (
                    <option key={folder.id} value={folder.id}>{"— ".repeat(depth)}{folder.name}</option>
                  ))}
                </NativeSelect>
              </FieldBlock>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? <LoaderCircle className="animate-spin" /> : null}Create app</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
