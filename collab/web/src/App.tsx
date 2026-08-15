import { useCallback, useEffect, useState } from "react";
import { Cases } from "./Cases.js";
import { LoginForm } from "./LoginForm.js";

interface SessionView {
  username: string;
  roles: string[];
}

export function App() {
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
      <p className="shell__eyebrow">working name</p>
      <h1 className="shell__title">cd-collab</h1>
      <p className="shell__copy">
        Collaboration and case-memory shell. Source catalog and exports land in
        later slices. This surface is separately deployable and does not embed
        the desktop or evaluation bench.
      </p>
      {!ready ? null : session ? (
        <>
          <section className="session">
            <p>
              Signed in as <strong>{session.username}</strong>
            </p>
            <p className="session__roles">Roles: {session.roles.join(", ") || "none"}</p>
            <button className="login__logout" type="button" onClick={() => void logout()}>
              Sign out
            </button>
          </section>
          <Cases roles={session.roles} />
        </>
      ) : (
        <LoginForm onSuccess={() => void refresh()} />
      )}
    </main>
  );
}
