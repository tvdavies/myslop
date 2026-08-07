import * as React from "react";

import { useRouteBusy } from "@/hooks/route-busy";
import { errorMessage } from "@/lib/api";

export type RouteResource<T> =
  | { status: "loading"; data: null; error: null }
  | { status: "ready"; data: T; error: null }
  | { status: "error"; data: null; error: string };

function noop(): void {}

export function useRouteResource<T>(
  key: string,
  loader: (signal: AbortSignal) => Promise<T>,
  { trackMainBusy = true }: { trackMainBusy?: boolean } = {},
): RouteResource<T> & { retry: () => void } {
  const routeBusy = useRouteBusy();
  const beginRouteBusy = trackMainBusy ? routeBusy?.begin : undefined;
  const [attempt, setAttempt] = React.useState(0);
  const [state, setState] = React.useState<RouteResource<T>>({ status: "loading", data: null, error: null });
  const loaderRef = React.useRef(loader);
  loaderRef.current = loader;

  React.useEffect(() => {
    const controller = new AbortController();
    const finish = beginRouteBusy?.() ?? noop;
    setState({ status: "loading", data: null, error: null });
    loaderRef.current(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ status: "ready", data, error: null });
        finish();
      },
      (error) => {
        if (!controller.signal.aborted) setState({ status: "error", data: null, error: errorMessage(error) });
        finish();
      },
    );
    return () => {
      controller.abort();
      finish();
    };
  }, [key, attempt, beginRouteBusy]);

  return { ...state, retry: () => setAttempt((value) => value + 1) };
}
