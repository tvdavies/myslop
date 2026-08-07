import { LoaderCircle } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FieldBlock } from "@/components/form-controls";
import { apiRequest, errorMessage } from "@/lib/api";
import { slugify } from "@/lib/format";
import { useDashboard } from "@/shell/dashboard-context";
import type { GroupSummary } from "@/types/api";

export function GroupDialog({ open, onOpenChange, group, onSaved }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  group: GroupSummary | null;
  onSaved: () => void;
}) {
  const dashboard = useDashboard();
  const [name, setName] = React.useState("");
  const [slug, setSlug] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setName(group?.name || "");
    setSlug(group?.slug || "");
    setDescription(group?.description || "");
  }, [open, group]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const path = `/api/teams/${encodeURIComponent(dashboard.teamId)}/groups${group ? `/${encodeURIComponent(group.id)}` : ""}`;
      await apiRequest(path, {
        method: group ? "PATCH" : "POST",
        body: group ? { name, description } : { name, slug, description },
      });
      toast.success(group ? "Group saved" : "Group created");
      onOpenChange(false);
      onSaved();
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
            <DialogTitle>{group ? "Edit group" : "Create group"}</DialogTitle>
            <DialogDescription>Groups grant the same app role to several team members.</DialogDescription>
          </DialogHeader>
          <div className="dialog-form-grid">
            <FieldBlock label="Name" htmlFor="group-name">
              <Input
                id="group-name"
                required
                maxLength={100}
                placeholder="Commercial team"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  if (!group) setSlug(slugify(event.target.value));
                }}
                autoFocus
              />
            </FieldBlock>
            {!group ? (
              <FieldBlock label="Slug" htmlFor="group-slug">
                <Input
                  id="group-slug"
                  required
                  maxLength={48}
                  pattern="[a-z][a-z0-9-]{1,46}[a-z0-9]"
                  placeholder="commercial-team"
                  value={slug}
                  onChange={(event) => setSlug(event.target.value)}
                />
              </FieldBlock>
            ) : null}
            <FieldBlock label="Description" htmlFor="group-description">
              <Textarea
                id="group-description"
                maxLength={500}
                placeholder="Who belongs in this group"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </FieldBlock>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy}>
              {busy ? <LoaderCircle className="animate-spin" /> : null}{group ? "Save group" : "Create group"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
