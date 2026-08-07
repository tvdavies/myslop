import * as React from "react";

import { useRouteBusy } from "@/hooks/route-busy";
import { errorMessage } from "@/lib/api";
import { readRouteResourceCache, writeRouteResourceCache } from "@/lib/route-resource-cache";

export type RouteResource<T> =
  | { status: "loading"; data: null; error: null }
  | { status: "ready"; data: T; error: null }
  | { status: "error"; data: null; error: string };

interface KeyedRouteResource<T> {
  key: string;
  resource: RouteResource<T>;
}

function noop(): void {}

function initialResource<T>(key: string): KeyedRouteResource<T> {
  const cached = readRouteResourceCache<T>(key);
  return {
    key,
    resource: cached === undefined
      ? { status: "loading", data: null, error: null }
      : { status: "ready", data: cached, error: null },
  };
}

export function useRouteResource<T>(
  key: string,
  loader: (signal: AbortSignal) => Promise<T>,
  { trackMainBusy = true }: { trackMainBusy?: boolean } = {},
): RouteResource<T> & { retry: () => void } {
  const routeBusy = useRouteBusy();
  const beginRouteBusy = trackMainBusy ? routeBusy?.begin : undefined;
  const [retryState, setRetryState] = React.useState({ key, count: 0 });
  const retryCount = retryState.key === key ? retryState.count : 0;
  const [state, setState] = React.useState<KeyedRouteResource<T>>(() => initialResource<T>(key));
  const loaderRef = React.useRef(loader);
  loaderRef.current = loader;

  const current = state.key === key ? state.resource : initialResource<T>(key).resource;

  React.useEffect(() => {
    const cached = readRouteResourceCache<T>(key);
    if (cached !== undefined && retryCount === 0) {
      setState({ key, resource: { status: "ready", data: cached, error: null } });
      return;
    }

    const controller = new AbortController();
    const finish = beginRouteBusy?.() ?? noop;
    setState({ key, resource: { status: "loading", data: null, error: null } });
    loaderRef.current(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) {
          writeRouteResourceCache(key, data);
          setState({ key, resource: { status: "ready", data, error: null } });
        }
        finish();
      },
      (error) => {
        if (!controller.signal.aborted) {
          setState({ key, resource: { status: "error", data: null, error: errorMessage(error) } });
        }
        finish();
      },
    );
    return () => {
      controller.abort();
      finish();
    };
  }, [key, retryCount, beginRouteBusy]);

  return {
    ...current,
    retry: () => setRetryState((value) => ({
      key,
      count: value.key === key ? value.count + 1 : 1,
    })),
  };
}
