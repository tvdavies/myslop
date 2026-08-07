import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export function FieldBlock({ label, htmlFor, help, children, className }: {
  label: string;
  htmlFor?: string;
  help?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("field-block", className)}>
      {htmlFor ? <Label htmlFor={htmlFor}>{label}</Label> : <span className="field-label">{label}</span>}
      {children}
      {help ? <p className="field-help">{help}</p> : null}
    </div>
  );
}

export function NativeSelect(props: React.ComponentProps<"select">) {
  return <select {...props} className={cn("native-select", props.className)} />;
}
