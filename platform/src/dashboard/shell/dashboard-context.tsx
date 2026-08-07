import * as React from "react";

import { useAuth } from "@/auth/auth-provider";
import { NoTeamScreen } from "@/auth/auth-screens";
import { apiRequest, errorMessage } from "@/lib/api";
import { selectActiveTeamId } from "@/lib/dashboard-state";
import { dashboardHref } from "@/lib/routing";
import { navigate } from "@/hooks/use-dashboard-location";
import type { FolderSummary, FoldersResponse, MeResponse, TeamSummary } from "@/types/api";

interface DashboardContextValue {
  me: MeResponse;
  teamId: string;
  team: TeamSummary;
  folders: FolderSummary[];
  rootAppCount: number;
  foldersCanAdmin: boolean;
  foldersLoading: boolean;
  foldersError: string | null;
  href: (pathname: string, extra?: Record<string, string | null | undefined>) => string;
  switchTeam: (teamId: string) => void;
  selectTeamForCurrentRoute: (teamId: string) => void;
  refetchFolders: () => Promise<void>;
}

const DashboardContext = React.createContext<DashboardContextValue | null>(null);

export function DashboardProvider({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  if (auth.status !== "authenticated") throw new Error("DashboardProvider requires an authenticated session");
  const { me } = auth;
  const requestedTeamId = new URLSearchParams(location.search).get("teamId");
  const [teamId, setTeamId] = React.useState(() =>
    selectActiveTeamId(me.teams, requestedTeamId, me.defaultTeamId) || "",
  );
  const [folders, setFolders] = React.useState<FolderSummary[]>([]);
  const [rootAppCount, setRootAppCount] = React.useState(0);
  const [foldersCanAdmin, setFoldersCanAdmin] = React.useState(false);
  const [foldersLoading, setFoldersLoading] = React.useState(true);
  const [foldersError, setFoldersError] = React.useState<string | null>(null);
  const requestRef = React.useRef<AbortController | null>(null);

  const loadFolders = React.useCallback(async () => {
    if (!teamId) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setFoldersLoading(true);
    setFoldersError(null);
    try {
      const data = await apiRequest<FoldersResponse>(`/api/teams/${encodeURIComponent(teamId)}/folders`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setFolders(data.folders || []);
      setRootAppCount(data.rootAppCount || 0);
      setFoldersCanAdmin(Boolean(data.canAdmin));
    } catch (error) {
      if (!controller.signal.aborted) setFoldersError(errorMessage(error));
    } finally {
      if (!controller.signal.aborted) setFoldersLoading(false);
    }
  }, [teamId]);

  React.useEffect(() => {
    void loadFolders();
    return () => requestRef.current?.abort();
  }, [loadFolders]);

  const switchTeam = React.useCallback((nextTeamId: string) => {
    if (!me.teams.some((team) => team.id === nextTeamId)) return;
    setTeamId(nextTeamId);
    navigate(dashboardHref("/dashboard", nextTeamId));
  }, [me.teams]);

  const selectTeamForCurrentRoute = React.useCallback((nextTeamId: string) => {
    if (!me.teams.some((team) => team.id === nextTeamId)) return;
    setTeamId(nextTeamId);
    const url = new URL(location.href);
    url.searchParams.set("teamId", nextTeamId);
    navigate(`${url.pathname}${url.search}${url.hash}`, true);
  }, [me.teams]);

  const team = me.teams.find((item) => item.id === teamId);
  if (!team) return <NoTeamScreen />;

  const value: DashboardContextValue = {
    me,
    teamId,
    team,
    folders,
    rootAppCount,
    foldersCanAdmin,
    foldersLoading,
    foldersError,
    href: (pathname, extra) => dashboardHref(pathname, teamId, extra),
    switchTeam,
    selectTeamForCurrentRoute,
    refetchFolders: loadFolders,
  };

  return <DashboardContext.Provider value={value}>{children}</DashboardContext.Provider>;
}

export function useDashboard(): DashboardContextValue {
  const context = React.useContext(DashboardContext);
  if (!context) throw new Error("useDashboard must be used inside DashboardProvider");
  return context;
}
