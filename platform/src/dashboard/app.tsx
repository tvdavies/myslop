import * as React from "react";

import { AuthProvider, useAuth } from "@/auth/auth-provider";
import { LoadingScreen, NoTeamScreen, SetupScreen, SignInScreen } from "@/auth/auth-screens";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { RouteLoading } from "@/components/feedback/route-state";
import { useDashboardLocation, navigate } from "@/hooks/use-dashboard-location";
import { parseDashboardRoute } from "@/lib/routing";
import { AppsPage } from "@/pages/apps-page";
import { FoldersPage } from "@/pages/folders-page";
import { GroupsPage } from "@/pages/groups-page";
import { MembersPage } from "@/pages/members-page";
import { SettingsPage } from "@/pages/settings-page";
import { TokensPage } from "@/pages/tokens-page";
import { AppShell } from "@/shell/app-shell";
import { ThemeProvider } from "@/theme/theme-provider";

function DashboardRouter() {
  const current = useDashboardLocation();
  const route = parseDashboardRoute(current.pathname);
  const redirecting = route.name === "not-found" || route.name === "setup";

  React.useEffect(() => {
    if (redirecting) navigate(`/dashboard${current.search}`, true);
  }, [redirecting, current.search]);

  if (redirecting) return <div className="content-width"><RouteLoading label="Opening app library…" /></div>;

  switch (route.name) {
    case "apps":
      return <AppsPage route={route} current={current} />;
    case "folders":
      return <FoldersPage />;
    case "groups":
      return <GroupsPage />;
    case "members":
      return <MembersPage />;
    case "tokens":
      return <TokensPage />;
    case "settings":
      return <SettingsPage appId={route.appId} hash={current.hash} />;
    default:
      return null;
  }
}

function AuthenticatedApp() {
  const auth = useAuth();
  switch (auth.status) {
    case "loading":
      return <LoadingScreen />;
    case "signin":
      return <SignInScreen />;
    case "setup":
      return <SetupScreen />;
    case "authenticated":
      return auth.me.teams.length > 0 ? <AppShell><DashboardRouter /></AppShell> : <NoTeamScreen />;
  }
}

export function App() {
  return (
    <ThemeProvider>
      <TooltipProvider>
        <AuthProvider>
          <AuthenticatedApp />
          <Toaster position="bottom-center" richColors />
        </AuthProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
}
