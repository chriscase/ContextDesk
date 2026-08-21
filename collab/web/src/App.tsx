import { useCallback, useEffect, useState } from "react";
import { Cases } from "./Cases.js";
import { Catalog } from "./Catalog.js";
import { LoginForm } from "./LoginForm.js";

interface SessionView {
  username: string;
  roles: string[];
}

declare global {
  interface Window {
    __CONTEXTDESK_STATIC_READ_ONLY__?: boolean;
  }
}

export function App() {
  const syntheticDemo = import.meta.env.VITE_CONTEXTDESK_SYNTHETIC_DEMO === "1";
  const staticReadOnly = window.__CONTEXTDESK_STATIC_READ_ONLY__ === true;
  const [session, setSession] = useState<SessionView | null>(null);
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/auth/me");
    if (!res.ok) {
      setSession(null);
      setReady(true);
      return;
    }
    const body = (await res.json()) as {
      identity?: { username?: string };
      roles?: string[];
    };
    setSession({
      username: body.identity?.username ?? "",
      roles: body.roles ?? [],
    });
    setReady(true);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    setSession(null);
  }

  return (
    <main className="shell">
      <p className="shell__eyebrow">
        {syntheticDemo || staticReadOnly ? "synthetic showcase" : "collaborative triage"}
      </p>
      <h1 className="shell__title">ContextDesk Experiment Lab</h1>
      <p className="shell__copy">
        Compare model outputs and investigation strategies by evidence, usefulness,
        and convergence on a human-accepted benchmark—not wording alone.
      </p>
      {syntheticDemo || staticReadOnly ? (
        <section className="shell__demo" aria-label="Synthetic demo notice">
          <strong>
            {staticReadOnly
              ? "Static read-only fallback — presentation controls only."
              : "Synthetic, offline, and safe to explore."}
          </strong>
          <span>
            {staticReadOnly ? (
              <>
                No provider calls or employer data. Review the seeded results and use the
                Experiment Lab share-safe export; edits are intentionally unavailable.
              </>
            ) : (
              <>
                No provider calls or employer data. Sign in with <code>demo</code> /{" "}
                <code>demo</code>; all changes disappear when the demo stops.
              </>
            )}
          </span>
        </section>
      ) : null}
      {!ready ? null : session ? (
        <>
          <section className="session">
            <p>
              Signed in as <strong>{session.username}</strong>
            </p>
            <p className="session__roles">Roles: {session.roles.join(", ") || "none"}</p>
            {!staticReadOnly ? (
              <button className="login__logout" type="button" onClick={() => void logout()}>
                Sign out
              </button>
            ) : null}
          </section>
          <Cases roles={session.roles} readOnly={staticReadOnly} />
          <Catalog
            canLead={
              !staticReadOnly &&
              (session.roles.includes("case-lead") || session.roles.includes("admin"))
            }
          />
        </>
      ) : (
        <LoginForm
          onSuccess={() => void refresh()}
          {...(syntheticDemo
            ? { defaults: { username: "demo", password: "demo" } }
            : {})}
        />
      )}
    </main>
  );
}
