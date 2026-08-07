import * as React from "react";

const RouteBusyContext = React.createContext<{
  busy: boolean;
  begin: () => () => void;
} | null>(null);

export function RouteBusyProvider({ children }: { children: React.ReactNode }) {
  const [count, setCount] = React.useState(0);
  const begin = React.useCallback(() => {
    let finished = false;
    setCount((value) => value + 1);
    return () => {
      if (finished) return;
      finished = true;
      setCount((value) => Math.max(0, value - 1));
    };
  }, []);
  const value = React.useMemo(() => ({ busy: count > 0, begin }), [count, begin]);
  return <RouteBusyContext.Provider value={value}>{children}</RouteBusyContext.Provider>;
}

export function useRouteBusy() {
  return React.useContext(RouteBusyContext);
}
