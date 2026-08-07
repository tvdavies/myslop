import { AlertCircle, RefreshCcw } from "lucide-react";

import { Panel, PanelBody, PanelHeader } from "@/components/panel";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

const CELL_WIDTHS = ["w-36", "w-24", "w-20", "w-28", "w-16"];

export function RouteLoading({ label = "Loading page…" }: { label?: string }) {
  return (
    <div className="route-loading loading-surface" data-loading-skeleton role="status" aria-live="polite" aria-label={label}>
      <span className="sr-only">{label}</span>
      <div className="grid gap-4">
        <div className="grid gap-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-64 max-w-full" />
        </div>
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    </div>
  );
}

export function TableLoading({
  label,
  headers,
  title,
  description,
  rows = 5,
  hasActions = true,
}: {
  label: string;
  headers: string[];
  title?: string;
  description?: string;
  rows?: number;
  hasActions?: boolean;
}) {
  return (
    <Panel
      className="table-loading loading-surface"
      data-loading-skeleton
      role="status"
      aria-live="polite"
      aria-label={label}
      aria-busy="true"
    >
      <span className="sr-only">{label}</span>
      {title ? (
        <PanelHeader
          title={title}
          description={description}
          meta={<Skeleton className="h-4 w-16" />}
        />
      ) : null}
      <div className="desktop-directory" aria-hidden="true">
        <Table>
          <TableHeader>
            <TableRow>
              {headers.map((header, index) => (
                <TableHead key={`${header}-${index}`}>{header || <span className="sr-only">Actions</span>}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {Array.from({ length: rows }, (_, row) => (
              <TableRow key={row}>
                {headers.map((_, column) => (
                  <TableCell key={column}>
                    {column === 0 ? (
                      <div className="flex items-center gap-3">
                        <Skeleton className="size-8 shrink-0" />
                        <div className="grid gap-1.5">
                          <Skeleton className="h-4 w-36" />
                          <Skeleton className="h-3 w-24" />
                        </div>
                      </div>
                    ) : hasActions && column === headers.length - 1 ? (
                      <div className="flex justify-end"><Skeleton className="h-8 w-20" /></div>
                    ) : (
                      <Skeleton className={cn("h-4 max-w-full", CELL_WIDTHS[column % CELL_WIDTHS.length])} />
                    )}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="mobile-directory" aria-hidden="true">
        {Array.from({ length: Math.min(rows, 4) }, (_, row) => (
          <div className="mobile-admin-row" key={row}>
            <div className="flex items-center gap-3">
              <Skeleton className="size-9 shrink-0" />
              <div className="grid flex-1 gap-2">
                <Skeleton className="h-4 w-36 max-w-full" />
                <Skeleton className="h-3 w-48 max-w-full" />
              </div>
            </div>
            <div className="flex gap-2">
              <Skeleton className="h-5 w-16" />
              <Skeleton className="h-5 w-20" />
            </div>
            {hasActions ? <Skeleton className="h-9 w-24" /> : null}
          </div>
        ))}
      </div>
    </Panel>
  );
}

export function FormLoading({
  label,
  title,
  description,
  fields = 2,
  className,
}: {
  label: string;
  title: string;
  description?: string;
  fields?: number;
  className?: string;
}) {
  return (
    <Panel
      className={cn("loading-surface", className)}
      data-loading-skeleton
      role="status"
      aria-live="polite"
      aria-label={label}
      aria-busy="true"
    >
      <span className="sr-only">{label}</span>
      <PanelHeader title={title} description={description} />
      <PanelBody aria-hidden="true">
        <div className="form-grid sm:grid-cols-2">
          {Array.from({ length: fields }, (_, index) => (
            <div className="grid gap-2" key={index}>
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-9 w-full" />
            </div>
          ))}
        </div>
        <div className="mt-5 flex justify-end"><Skeleton className="h-9 w-28" /></div>
      </PanelBody>
    </Panel>
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
