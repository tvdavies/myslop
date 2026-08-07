import * as React from "react";

import { ApiError, apiRequest, setUnauthorizedHandler } from "@/lib/api";
import { isSafeInternalDashboardRoute, safeExternalAppReturn } from "@/lib/routing";
import type { MeResponse, TokenCreationResponse } from "@/types/api";

const SHOO = "https://shoo.dev";
const OAUTH_REDIRECT = `${location.origin}/`;

interface SetupToken {
  name: string;
  secret: string;
}

type AuthState =
  | { status: "loading"; error: null; me: null; setupToken: null }
  | { status: "signin"; error: string | null; me: null; setupToken: null }
  | { status: "setup"; error: null; me: MeResponse; setupToken: SetupToken }
  | { status: "authenticated"; error: null; me: MeResponse; setupToken: null };

type AuthContextValue = AuthState & {
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = React.createContext<AuthContextValue | null>(null);

function readStoredJson<T>(key: string): T | null {
  try {
    return JSON.parse(sessionStorage.getItem(key) || "null") as T | null;
  } catch {
    return null;
  }
}

function randomString(length: number): string {
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((byte) => characters[byte % characters.length]).join("");
}

function base64url(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
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

  const verifier = randomString(64);
  const oauthState = randomString(32);
  sessionStorage.setItem("shoo_pkce", JSON.stringify({ verifier, state: oauthState, time: Date.now() }));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const authorize = new URL("/authorize", SHOO);
  for (const [key, value] of Object.entries({
    client_id: `origin:${location.origin}`,
    redirect_uri: OAUTH_REDIRECT,
    state: oauthState,
    code_challenge: base64url(new Uint8Array(digest)),
    code_challenge_method: "S256",
    pii: "true",
  })) {
    authorize.searchParams.set(key, value);
  }
  location.assign(authorize);
}

async function completeCallback(): Promise<void> {
  const parameters = new URLSearchParams(location.search);
  const code = parameters.get("code");
  const oauthState = parameters.get("state");
  if (!code || !oauthState) return;

  history.replaceState({}, "", "/");
  const pkce = readStoredJson<{ verifier?: string; state?: string }>("shoo_pkce");
  sessionStorage.removeItem("shoo_pkce");
  if (!pkce?.verifier || pkce.state !== oauthState) throw new Error("Sign-in expired. Please try again.");

  const tokenResponse = await fetch(new URL("/token", SHOO), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: `origin:${location.origin}`,
      redirect_uri: OAUTH_REDIRECT,
      code,
      code_verifier: pkce.verifier,
    }),
  });
  if (!tokenResponse.ok) throw new Error("Token exchange failed");
  const token = await tokenResponse.json() as { id_token?: string };
  await apiRequest("/api/session", { method: "POST", body: { id_token: token.id_token } });

  const restorePath = sessionStorage.getItem("post_auth_path");
  sessionStorage.removeItem("post_auth_path");
  if (isSafeInternalDashboardRoute(restorePath, location.origin)) history.replaceState({}, "", restorePath!);
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
        await completeCallback();
        const me = await apiRequest<MeResponse>("/api/me", { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (location.pathname === "/setup") {
          const setupToken = await createSetupToken();
          if (!controller.signal.aborted) setState({ status: "setup", error: null, me, setupToken });
          return;
        }
        const external = safeExternalAppReturn(new URLSearchParams(location.search).get("returnTo") || sessionStorage.getItem("returnTo"));
        sessionStorage.removeItem("returnTo");
        if (external) {
          location.assign(external);
          return;
        }
        setState({ status: "authenticated", error: null, me, setupToken: null });
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

  const value = React.useMemo<AuthContextValue>(() => ({ ...state, signIn: beginSignIn, signOut }), [state, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = React.useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}
