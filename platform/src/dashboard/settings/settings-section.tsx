import { Panel, PanelBody, PanelHeader } from "@/components/panel";

export function SettingsSection({ id, title, description, children, danger = false }: {
  id: string;
  title: string;
  description: string;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <Panel id={id} className={danger ? "settings-section danger-section" : "settings-section"}>
      <PanelHeader title={title} description={description} />
      <PanelBody>{children}</PanelBody>
    </Panel>
  );
}
