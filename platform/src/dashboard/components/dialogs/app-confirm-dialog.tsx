import { LoaderCircle, TriangleAlert } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { FieldBlock } from "@/components/form-controls";
import { apiRequest, errorMessage } from "@/lib/api";
import type { ListedApp, PruneResponse } from "@/types/api";

export type AppConfirmation = { type: "rollback"; version: number } | { type: "prune" } | { type: "delete" };

const copy: Record<AppConfirmation["type"], { title: string; label: string; busy: string }> = {
  rollback: { title: "Confirm rollback", label: "Roll back", busy: "Rolling back…" },
  prune: { title: "Confirm resource prune", label: "Prune resources", busy: "Pruning…" },
  delete: { title: "Confirm app deletion", label: "Delete app", busy: "Deleting…" },
};

async function performAppAction(app: ListedApp, action: AppConfirmation): Promise<void> {
  switch (action.type) {
    case "rollback": {
      await apiRequest(`/api/apps/${encodeURIComponent(app.id)}/rollback`, { method: "POST", body: { version: Number(action.version) } });
      toast.success(`Rolled back to version ${action.version}`);
      return;
    }
    case "prune": {
      const result = await apiRequest<PruneResponse>(`/api/apps/${encodeURIComponent(app.id)}/prune`, { method: "POST", body: { confirm: app.slug } });
      toast.success(result.removed.length ? `Removed ${result.removed.join(" and ")}` : "No unused resources to remove");
      return;
    }
    case "delete": {
      await apiRequest(`/api/apps/${encodeURIComponent(app.id)}`, { method: "DELETE", body: { confirm: app.slug } });
      toast.success(`${app.name} deleted`);
      return;
    }
  }
}

function confirmationDescription(app: ListedApp, action: AppConfirmation): React.ReactNode {
  switch (action.type) {
    case "rollback":
      return <>Roll back <strong>{app.name}</strong> to version {action.version}. Database migrations are not reversed.</>;
    case "prune":
      return <>Permanently remove unused stored resources from <strong>{app.name}</strong>.</>;
    case "delete":
      return <>Delete <strong>{app.name}</strong>. The app will stop appearing in the library immediately.</>;
  }
}

export function AppConfirmDialog({ app, action, onOpenChange, onComplete }: {
  app: ListedApp;
  action: AppConfirmation | null;
  onOpenChange: (open: boolean) => void;
  onComplete: (deleted: boolean) => void;
}) {
  const [confirmation, setConfirmation] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { if (action) setConfirmation(""); }, [action]);

  async function runAction(current: AppConfirmation) {
    setBusy(true);
    try {
      await performAppAction(app, current);
      onOpenChange(false);
      onComplete(current.type === "delete");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  if (!action) return null;
  const config = copy[action.type];
  const description = confirmationDescription(app, action);

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="dialog-warning-icon"><TriangleAlert /></div>
          <DialogTitle>{config.title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <FieldBlock label={`Type ${app.slug} to continue`} htmlFor="app-confirm">
          <Input
            id="app-confirm"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            autoFocus
          />
        </FieldBlock>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant={action.type === "delete" ? "destructive" : "default"}
            disabled={confirmation !== app.slug || busy}
            onClick={() => void runAction(action)}
          >
            {busy ? <><LoaderCircle className="animate-spin" />{config.busy}</> : config.label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
