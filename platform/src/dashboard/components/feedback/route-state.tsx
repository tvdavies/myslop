import { AlertCircle, LoaderCircle, RefreshCcw } from "lucide-react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export function RouteLoading({ label = "Loading page…" }: { label?: string }) {
  return (
    <div className="route-loading" role="status" aria-live="polite">
      <div className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" aria-hidden="true" />{label}</div>
      <div className="mt-5 grid gap-2"><Skeleton className="h-9 w-full" /><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div>
    </div>
  );
}

export function RouteError({ message, retry }: { message: string; retry: () => void }) {
  return (
    <Alert variant="destructive" className="route-error">
      <AlertCircle />
      <AlertTitle>Could not load this page</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
      <AlertAction><Button variant="outline" size="sm" onClick={retry}><RefreshCcw />Retry</Button></AlertAction>
    </Alert>
  );
}

export function EmptyState({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) {
  return (
    <section className="empty-state">
      <div className="empty-marker" aria-hidden="true" />
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </section>
  );
}
