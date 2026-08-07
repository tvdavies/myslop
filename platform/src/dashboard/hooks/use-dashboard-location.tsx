import * as React from "react";

import {
  currentDashboardLocation,
  isSafeInternalDashboardRoute,
  shouldHandleAnchorClick,
  type DashboardLocation,
} from "@/lib/routing";

const LOCATION_EVENT = "myslop:location-change";
const LOCATION_EVENTS = ["popstate", "hashchange", LOCATION_EVENT];

function notifyLocationChange(): void {
  window.dispatchEvent(new Event(LOCATION_EVENT));
}

export function navigate(path: string, replace = false): void {
  if (!isSafeInternalDashboardRoute(path, location.origin)) return;
  history[replace ? "replaceState" : "pushState"]({}, "", path);
  notifyLocationChange();
}

export function useDashboardLocation(): DashboardLocation {
  const [current, setCurrent] = React.useState(currentDashboardLocation);
  React.useEffect(() => {
    const update = () => setCurrent(currentDashboardLocation());
    for (const name of LOCATION_EVENTS) window.addEventListener(name, update);
    return () => {
      for (const name of LOCATION_EVENTS) window.removeEventListener(name, update);
    };
  }, []);
  return current;
}

export function DashboardLink({
  href,
  onClick,
  ...props
}: React.ComponentProps<"a">) {
  return (
    <a
      href={href}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || !shouldHandleAnchorClick(event) || event.currentTarget.target === "_blank") return;
        const url = new URL(event.currentTarget.href);
        const target = `${url.pathname}${url.search}${url.hash}`;
        if (url.origin !== location.origin || !isSafeInternalDashboardRoute(target, location.origin)) return;
        event.preventDefault();
        navigate(target);
      }}
      {...props}
    />
  );
}
