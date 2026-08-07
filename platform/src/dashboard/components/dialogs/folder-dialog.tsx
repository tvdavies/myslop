import { LoaderCircle } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { FieldBlock, NativeSelect } from "@/components/form-controls";
import { apiRequest, errorMessage } from "@/lib/api";
import { availableFolderOptions } from "@/lib/folders";
import { slugify } from "@/lib/format";
import { useDashboard } from "@/shell/dashboard-context";
import type { FolderSummary } from "@/types/api";

export function FolderDialog({ open, onOpenChange, folder, onSaved }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  folder: FolderSummary | null;
  onSaved?: () => void;
}) {
  const dashboard = useDashboard();
  const [name, setName] = React.useState("");
  const [slug, setSlug] = React.useState("");
  const [parentId, setParentId] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setName(folder?.name || "");
    setSlug(folder?.slug || "");
    setParentId(folder?.parentId || "");
  }, [open, folder]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const path = `/api/teams/${encodeURIComponent(dashboard.teamId)}/folders${folder ? `/${encodeURIComponent(folder.id)}` : ""}`;
      await apiRequest(path, {
        method: folder ? "PATCH" : "POST",
        body: folder ? { name, parentId: parentId || null } : { name, slug, parentId: parentId || null },
      });
      await dashboard.refetchFolders();
      toast.success(folder ? "Folder saved" : "Folder created");
      onOpenChange(false);
      onSaved?.();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{folder ? "Edit folder" : "Create folder"}</DialogTitle>
            <DialogDescription>Folders organise the library without changing app addresses.</DialogDescription>
          </DialogHeader>
          <div className="dialog-form-grid">
            <FieldBlock label="Name" htmlFor="folder-name">
              <Input
                id="folder-name"
                required
                maxLength={100}
                placeholder="Operations"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  if (!folder) setSlug(slugify(event.target.value));
                }}
                autoFocus
              />
            </FieldBlock>
            {!folder ? (
              <FieldBlock label="Slug" htmlFor="folder-slug">
                <Input
                  id="folder-slug"
                  required
                  maxLength={48}
                  pattern="[a-z][a-z0-9-]{1,46}[a-z0-9]"
                  placeholder="operations"
                  value={slug}
                  onChange={(event) => setSlug(event.target.value)}
                />
              </FieldBlock>
            ) : null}
            <FieldBlock label="Parent folder" htmlFor="folder-parent">
              <NativeSelect id="folder-parent" value={parentId} onChange={(event) => setParentId(event.target.value)}>
                <option value="">Root</option>
                {availableFolderOptions(dashboard.folders, folder?.id || "").map(({ folder: option, depth }) => (
                  <option key={option.id} value={option.id}>{"— ".repeat(depth)}{option.name}</option>
                ))}
              </NativeSelect>
            </FieldBlock>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy}>
              {busy ? <LoaderCircle className="animate-spin" /> : null}{folder ? "Save folder" : "Create folder"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
