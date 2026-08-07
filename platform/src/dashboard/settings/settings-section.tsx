import { Panel, PanelBody } from "@/components/panel";
import { cn } from "@/lib/utils";

export function SettingsSection({ id, title, description, children, danger = false }: {
  id: string;
  title: string;
  description: string;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <section id={id} className={cn("settings-section", danger && "danger-section")}>
      <header className="settings-section-heading">
        <h2>{title}</h2>
        <p>{description}</p>
      </header>
      <Panel className="settings-section-card">
        <PanelBody>{children}</PanelBody>
      </Panel>
    </section>
  );
}
