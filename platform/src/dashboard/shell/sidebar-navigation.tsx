import { Boxes, Folder, FolderCog, KeyRound, LayoutGrid, ShieldCheck, UsersRound } from "lucide-react";

import { NativeSelect } from "@/components/ui/native-select";
import { DashboardLink } from "@/hooks/use-dashboard-location";
import { nestedFolders } from "@/lib/folders";
import { parseDashboardRoute, type DashboardLocation } from "@/lib/routing";
import { cn } from "@/lib/utils";
import { useDashboard } from "@/shell/dashboard-context";

function NavLink({ href, active, icon: Icon, label, count, depth = 0, onNavigate }: {
  href: string;
  active: boolean;
  icon: typeof Boxes;
  label: string;
  count?: number;
  depth?: number;
  onNavigate?: () => void;
}) {
  return (
    <li>
      <DashboardLink
        href={href}
        onClick={onNavigate}
        aria-current={active ? "page" : undefined}
        className={cn("sidebar-link", active && "is-active")}
        style={{ paddingInlineStart: `${0.625 + depth * 0.8}rem` }}
      >
        <Icon aria-hidden="true" />
        <span>{label}</span>
        {count !== undefined ? <span className="sidebar-count">{count}</span> : null}
      </DashboardLink>
    </li>
  );
}

export function SidebarNavigation({ current, onNavigate }: { current: DashboardLocation; onNavigate?: () => void }) {
  const dashboard = useDashboard();
  const active = parseDashboardRoute(current.pathname);
  return (
    <div className="sidebar-layout">
      <div className="sidebar-team">
        <label htmlFor="team-selector">Team</label>
        <NativeSelect
          className="w-full"
          id="team-selector"
          value={dashboard.teamId}
          onChange={(event) => {
            dashboard.switchTeam(event.target.value);
            onNavigate?.();
          }}
        >
          {dashboard.me.teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
        </NativeSelect>
        <p>Your team role: <strong>{dashboard.team.role}</strong></p>
      </div>
      <nav aria-label="Application library" className="sidebar-nav">
        <p className="sidebar-label">Library</p>
        <ul>
          <NavLink
            href={dashboard.href("/dashboard")}
            active={active.name === "apps" && active.scope === "all"}
            icon={LayoutGrid}
            label="All apps"
            onNavigate={onNavigate}
          />
          <NavLink
            href={dashboard.href("/")}
            active={active.name === "apps" && active.scope === "root"}
            icon={Boxes}
            label="Root"
            count={dashboard.rootAppCount}
            onNavigate={onNavigate}
          />
          {nestedFolders(dashboard.folders).map(({ folder, depth }) => (
            <NavLink
              key={folder.id}
              href={dashboard.href(`/folders/${encodeURIComponent(folder.id)}`)}
              active={active.name === "apps" && active.scope === "folder" && active.folderId === folder.id}
              icon={Folder}
              label={folder.name}
              count={folder.appCount}
              depth={depth + 1}
              onNavigate={onNavigate}
            />
          ))}
        </ul>
        <p className="sidebar-label">Team administration</p>
        <ul>
          <NavLink href={dashboard.href("/team/folders")} active={active.name === "folders"} icon={FolderCog} label="Folders" onNavigate={onNavigate} />
          <NavLink href={dashboard.href("/team/groups")} active={active.name === "groups"} icon={ShieldCheck} label="Groups" onNavigate={onNavigate} />
          <NavLink href={dashboard.href("/team/members")} active={active.name === "members"} icon={UsersRound} label="Members" onNavigate={onNavigate} />
        </ul>
      </nav>
      <ul className="sidebar-footer-link">
        <NavLink href={dashboard.href("/account/tokens")} active={active.name === "tokens"} icon={KeyRound} label="Tokens" onNavigate={onNavigate} />
      </ul>
    </div>
  );
}
