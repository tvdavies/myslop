import { LogOut, Menu } from "lucide-react";
import * as React from "react";

import { useAuth } from "@/auth/auth-provider";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useDashboardLocation } from "@/hooks/use-dashboard-location";
import { RouteBusyProvider, useRouteBusy } from "@/hooks/route-busy";
import { shouldFocusMainRoute } from "@/lib/dashboard-state";
import { safeImageUrl } from "@/lib/format";
import { DashboardProvider, useDashboard } from "@/shell/dashboard-context";
import { SidebarNavigation } from "@/shell/sidebar-navigation";
import { ThemeMenu } from "@/shell/theme-menu";

function ShellFrame({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  const dashboard = useDashboard();
  const current = useDashboardLocation();
  const routeBusy = useRouteBusy();
  const previousPathname = React.useRef(current.pathname);
  const mainRef = React.useRef<HTMLElement>(null);
  const [mobileOpen, setMobileOpen] = React.useState(false);

  React.useEffect(() => setMobileOpen(false), [current.pathname, current.search]);
  React.useEffect(() => {
    const previous = previousPathname.current;
    previousPathname.current = current.pathname;
    const main = mainRef.current;
    if (!main) return;
    const focusIsWithinMain = main.contains(document.activeElement);
    if (!shouldFocusMainRoute(previous, current.pathname, focusIsWithinMain)) return;
    const frame = requestAnimationFrame(() => main.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [current.pathname]);

  if (auth.status !== "authenticated") return null;
  const userLabel = auth.me.user.name || auth.me.user.email || "Signed in";
  const picture = safeImageUrl(auth.me.user.picture);

  return (
    <div className="dashboard-frame">
      <a href="#main-content" className="skip-link">Skip to content</a>
      <header className="topbar">
        <Button className="md:hidden" variant="ghost" size="icon" onClick={() => setMobileOpen(true)} aria-label="Open navigation"><Menu /></Button>
        <a className="topbar-brand" href="/"><span className="brand-mark" aria-hidden="true">m</span><span>Myslop Apps</span><small>microcloud</small></a>
        <div className="topbar-spacer" />
        <ThemeMenu />
        <div className="topbar-user">
          <Avatar size="sm">
            {picture ? <AvatarImage src={picture} alt="" /> : null}
            <AvatarFallback aria-hidden="true">{userLabel.charAt(0).toUpperCase()}</AvatarFallback>
          </Avatar>
          <span>{userLabel}</span>
        </div>
        <Button variant="ghost" size="sm" aria-label="Sign out" onClick={() => void auth.signOut()}><LogOut /><span className="hidden sm:inline">Sign out</span></Button>
      </header>
      <div className="dashboard-body">
        <aside className="desktop-sidebar" aria-label="Team and app navigation"><SidebarNavigation current={current} /></aside>
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetContent side="left" className="w-[18rem] p-0" showCloseButton>
            <SheetHeader className="sr-only">
              <SheetTitle>Navigation</SheetTitle>
              <SheetDescription>Team, app library, administration and token navigation.</SheetDescription>
            </SheetHeader>
            <SidebarNavigation current={current} onNavigate={() => setMobileOpen(false)} />
          </SheetContent>
        </Sheet>
        <main ref={mainRef} id="main-content" className="dashboard-main" tabIndex={-1} aria-busy={Boolean(routeBusy?.busy || dashboard.foldersLoading)}>{children}</main>
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <DashboardProvider>
      <RouteBusyProvider>
        <ShellFrame>{children}</ShellFrame>
      </RouteBusyProvider>
    </DashboardProvider>
  );
}
