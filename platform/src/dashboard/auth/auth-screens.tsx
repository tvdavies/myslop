import { Check, Clipboard, LoaderCircle, LogIn } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/auth/auth-provider";

function Brand() {
  return (
    <div className="auth-brand">
      <span className="brand-mark" aria-hidden="true">m</span>
      <span>Myslop Apps</span>
    </div>
  );
}

export function LoadingScreen() {
  return (
    <main className="auth-stage" aria-label="Loading Myslop">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
        Loading Myslop…
      </div>
    </main>
  );
}

export function SignInScreen() {
  const auth = useAuth();
  const [busy, setBusy] = React.useState(false);
  return (
    <main className="auth-stage">
      <section className="auth-panel" aria-labelledby="signin-title">
        <Brand />
        <div className="auth-rule" aria-hidden="true" />
        <p className="eyebrow">Team application library</p>
        <h1 id="signin-title">Apps belong beside the work.</h1>
        <p className="auth-copy">Open, organise and govern team applications with the familiarity of a shared document library.</p>
        {auth.error ? (
          <Alert variant="destructive">
            <AlertTitle>Sign-in could not continue</AlertTitle>
            <AlertDescription>{auth.error}</AlertDescription>
          </Alert>
        ) : null}
        <Button
          size="lg"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void auth.signIn().catch(() => setBusy(false));
          }}
        >
          {busy ? <LoaderCircle className="animate-spin" /> : <LogIn />}
          Sign in with Lleverage Google
        </Button>
        <p className="text-xs text-muted-foreground">Authentication is handled by Shoo and returns you to the page you requested.</p>
      </section>
    </main>
  );
}

export function NoTeamScreen() {
  const auth = useAuth();
  if (auth.status !== "authenticated") return null;
  const account = auth.me.user.name || auth.me.user.email || "this account";
  return (
    <main className="auth-stage">
      <section className="auth-panel" aria-labelledby="no-team-title">
        <Brand />
        <div className="auth-rule" aria-hidden="true" />
        <p className="eyebrow">Team membership required</p>
        <h1 id="no-team-title">No team is available yet.</h1>
        <p className="auth-copy">Your sign-in is active, but this account does not have an active Myslop team membership.</p>
        <Alert>
          <AlertTitle>Ask a team administrator for access</AlertTitle>
          <AlertDescription>After they add or reactivate your membership, return here and refresh the page.</AlertDescription>
        </Alert>
        <p className="text-xs text-muted-foreground">Signed in as <strong className="text-foreground">{account}</strong>.</p>
        <Button variant="outline" onClick={() => void auth.signOut()}>Sign out</Button>
      </section>
    </main>
  );
}

export function SetupScreen() {
  const auth = useAuth();
  if (auth.status !== "setup") return null;
  const { setupToken } = auth;
  return (
    <main className="auth-stage">
      <section className="auth-panel" aria-labelledby="setup-title">
        <Brand />
        <div className="auth-rule" aria-hidden="true" />
        <p className="eyebrow">One-time credential</p>
        <h1 id="setup-title">Your agent token is ready.</h1>
        <p className="auth-copy">Created for “{setupToken.name}”. Copy it into the terminal running setup.</p>
        <code className="secret-reveal">{setupToken.secret}</code>
        <Button
          variant="outline"
          onClick={async () => {
            await navigator.clipboard.writeText(setupToken.secret);
            toast.success("Token copied", { icon: <Check /> });
          }}
        >
          <Clipboard />Copy token
        </Button>
        <p className="text-xs text-muted-foreground">This value is shown once. You can revoke it later from Tokens.</p>
      </section>
    </main>
  );
}
