import { cn } from "@/lib/utils";

export function Panel({ className, ...props }: React.ComponentProps<"section">) {
  return <section className={cn("panel", className)} {...props} />;
}

export function PanelHeader({ title, description, meta, action }: { title: string; description?: string; meta?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <header className="panel-header">
      <div>
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
      </div>
      {action || meta ? <div className="panel-header-meta">{action || meta}</div> : null}
    </header>
  );
}

export function PanelBody({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("panel-body", className)} {...props} />;
}
