import * as React from "react";

import { ApiError, apiRequest, setUnauthorizedHandler } from "@/lib/api";
import { isSafeInternalDashboardRoute, safeExternalAppReturn } from "@/lib/routing";
import type { MeResponse, TokenCreationResponse } from "@/types/api";

const AUTH_ORIGIN = "https://auth.myslop.app";

interface SetupToken {
  name: string;
  secret: string;
}

type AuthState =
  | { status: "loading"; error: null; me: null; setupToken: null }
  | { status: "signin"; error: string | null; me: null; setupToken: null }
  | { status: "setup"; error: null; me: MeResponse; setupToken: SetupToken }
  | { status: "authenticated"; error: null; me: MeResponse; setupToken: null; appReturn: string | null };

type AuthContextValue = AuthState & {
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  continueToApp: (returnTo: string) => Promise<void>;
  cancelAppReturn: () => void;
};

const AuthContext = React.createContext<AuthContextValue | null>(null);

function readStoredJson<T>(key: string): T | null {
  try {
    return JSON.parse(sessionStorage.getItem(key) || "null") as T | null;
  } catch {
    return null;
  }
}

async function beginSignIn(): Promise<void> {
  const parameters = new URLSearchParams(location.search);
  const external = safeExternalAppReturn(parameters.get("returnTo"));
  if (external) sessionStorage.setItem("returnTo", external);

  const internalPath = `${location.pathname}${location.search}${location.hash}`;
  if (isSafeInternalDashboardRoute(internalPath, location.origin) && internalPath !== "/") {
    sessionStorage.setItem("post_auth_path", internalPath);
  }
  if (location.pathname === "/setup") {
    const name = parameters.get("name");
    if (name) sessionStorage.setItem("setup_name", name);
  }

  const login = new URL("/login", AUTH_ORIGIN);
  login.searchParams.set("returnTo", location.href);
  location.assign(login);
}

async function createSetupToken(): Promise<SetupToken> {
  const parameters = new URLSearchParams(location.search);
  const name = parameters.get("name") || sessionStorage.getItem("setup_name") || "cli";
  sessionStorage.removeItem("setup_name");
  const saved = readStoredJson<SetupToken>("setup_token");
  let token = saved?.name === name && saved.secret?.startsWith("msa_") ? saved : null;
  if (!token) {
    const created = await apiRequest<TokenCreationResponse>("/api/tokens", { method: "POST", body: { name } });
    token = { name, secret: created.token.secret };
    sessionStorage.setItem("setup_token", JSON.stringify(token));
  }
  history.replaceState({}, "", "/setup");
  sessionStorage.removeItem("setup_auth_tried");
  return token;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<AuthState>({ status: "loading", error: null, me: null, setupToken: null });

  React.useEffect(() => {
    setUnauthorizedHandler(() => {
      const internalPath = `${location.pathname}${location.search}${location.hash}`;
      if (isSafeInternalDashboardRoute(internalPath, location.origin) && internalPath !== "/") {
        sessionStorage.setItem("post_auth_path", internalPath);
      }
      setState({ status: "signin", error: "Your session expired. Sign in again.", me: null, setupToken: null });
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  React.useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const me = await apiRequest<MeResponse>("/api/me", { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (location.pathname === "/setup") {
          const setupToken = await createSetupToken();
          if (!controller.signal.aborted) setState({ status: "setup", error: null, me, setupToken });
          return;
        }
        const external = safeExternalAppReturn(new URLSearchParams(location.search).get("returnTo") || sessionStorage.getItem("returnTo"));
        sessionStorage.removeItem("returnTo");
        setState({ status: "authenticated", error: null, me, setupToken: null, appReturn: external });
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.unauthorized && location.pathname === "/setup" && !sessionStorage.getItem("setup_auth_tried")) {
          sessionStorage.setItem("setup_auth_tried", "1");
          await beginSignIn();
          return;
        }
        const message = error instanceof Error && !(error instanceof ApiError && error.unauthorized) ? error.message : null;
        setState({ status: "signin", error: message, me: null, setupToken: null });
      }
    })();
    return () => controller.abort();
  }, []);

  const signOut = React.useCallback(async () => {
    try {
      await apiRequest("/api/session", { method: "DELETE" });
    } finally {
      location.assign("/");
    }
  }, []);

  const continueToApp = React.useCallback(async (returnTo: string) => {
    const result = await apiRequest<{ callback: string }>("/api/app-session-exchange", {
      method: "POST",
      body: { returnTo },
    });
    location.assign(result.callback);
  }, []);

  const cancelAppReturn = React.useCallback(() => {
    setState((current) => current.status === "authenticated" ? { ...current, appReturn: null } : current);
    history.replaceState({}, "", "/dashboard");
  }, []);

  const value = React.useMemo<AuthContextValue>(
    () => ({ ...state, signIn: beginSignIn, signOut, continueToApp, cancelAppReturn }),
    [state, signOut, continueToApp, cancelAppReturn],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = React.useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}
