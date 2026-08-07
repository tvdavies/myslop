import { Card, CardAction, CardContent, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function Panel({ className, ...props }: React.ComponentProps<typeof Card>) {
  return <Card size="sm" className={cn("panel gap-0 py-0", className)} {...props} />;
}

export function PanelHeader({ title, description, meta, action }: { title: string; description?: string; meta?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <CardHeader className="panel-header">
      <div>
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
      </div>
      {action || meta ? <CardAction className="panel-header-meta">{action || meta}</CardAction> : null}
    </CardHeader>
  );
}

export function PanelBody({ className, ...props }: React.ComponentProps<typeof CardContent>) {
  return <CardContent className={cn("panel-body", className)} {...props} />;
}
