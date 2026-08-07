import { Info, Trash2 } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/settings/settings-section";
import type { AppConfirmation } from "@/components/dialogs/app-confirm-dialog";
import type { AppDetailResponse } from "@/types/api";

export function DangerSection({ detail, confirm }: { detail: AppDetailResponse; confirm: (action: AppConfirmation) => void }) {
  const { app } = detail;
  const blockedReason = app.managedBy === "git"
    ? "Git-managed apps must be removed through reconciliation."
    : "Only an app owner can prune resources or delete this app.";

  return (
    <SettingsSection id="danger" title="Danger" description="Destructive actions require the app slug as confirmation." danger>
      {app.permissions.destroy ? (
        <div className="danger-actions">
          <div>
            <strong>Prune unused resources</strong>
            <p>Permanently remove database or storage no longer declared by the active deployment.</p>
          </div>
          <Button variant="outline" onClick={() => confirm({ type: "prune" })}>Prune resources</Button>
          <div>
            <strong>Delete app</strong>
            <p>Archive the app now. Backend recovery policy applies before final purge.</p>
          </div>
          <Button variant="destructive" onClick={() => confirm({ type: "delete" })}><Trash2 />Delete app</Button>
        </div>
      ) : (
        <Alert>
          <Info />
          <AlertDescription>{blockedReason}</AlertDescription>
        </Alert>
      )}
    </SettingsSection>
  );
}
