import { useCallback, useEffect, useRef, useState } from "react";
import { Cases } from "./Cases.js";
import { Catalog } from "./Catalog.js";
import { LoginForm } from "./LoginForm.js";

interface SessionView {
  username: string;
  roles: string[];
}

const themes = [
  ["dark", "Dark"],
  ["slate", "Slate"],
  ["light", "Light"],
  ["sand", "Sand"],
  ["forest", "Forest"],
  ["grokptah", "GrokPtah"],
] as const;

type ThemeName = (typeof themes)[number][0];

function savedTheme(): ThemeName {
  try {
    const candidate =
      typeof window.localStorage?.getItem === "function"
        ? window.localStorage.getItem("cd-theme")
        : null;
    return themes.some(([name]) => name === candidate) ? (candidate as ThemeName) : "dark";
  } catch {
    return "dark";
  }
}

declare global {
  interface Window {
    __CONTEXTDESK_STATIC_READ_ONLY__?: boolean;
  }
}

const workflowStages = [
  {
    id: "capture",
    name: "Capture",
    kicker: "Manual evidence intake",
    detail:
      "Add evidence to the workspace by hand and note where each item came from. " +
      "Nothing arrives automatically, so every source carries its provenance.",
  },
  {
    id: "analyze",
    name: "Analyze",
    kicker: "AI-assisted normalization",
    detail:
      "AI assistance normalizes raw captures into structured, comparable claims and " +
      "triages what deserves attention first. Every suggestion stays open for human review.",
  },
  {
    id: "compare",
    name: "Compare",
    kicker: "Models side by side",
    detail:
      "Line up runs from different models against the same evidence. Runs are weighed on " +
      "evidence, usefulness, and convergence with a human-accepted benchmark—not wording alone.",
  },
  {
    id: "decide",
    name: "Decide",
    kicker: "Human call, safe export",
    detail:
      "A person—not a model—makes the final call on what a case concludes. Share findings " +
      "through the share-safe export instead of copying raw case data out of the workspace.",
  },
] as const;

function WorkflowGuide() {
  const [stageIndex, setStageIndex] = useState(0);
  const stageRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function selectStage(index: number) {
    const next = (index + workflowStages.length) % workflowStages.length;
    setStageIndex(next);
    stageRefs.current[next]?.focus();
  }

  function onStageKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      selectStage(stageIndex + 1);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      selectStage(stageIndex - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      selectStage(0);
    } else if (event.key === "End") {
      event.preventDefault();
      selectStage(workflowStages.length - 1);
    }
  }

  const activeStage = workflowStages[stageIndex] ?? workflowStages[0];
  return (
    <section className="workflow" aria-labelledby="workflow-title">
      <h2 className="workflow__title" id="workflow-title">
        Workflow guide
      </h2>
      <p className="workflow__intro">
        Casework moves through four stages, in order. Select a stage to see what
        happens there.
      </p>
      <div
        className="workflow__stages"
        role="tablist"
        aria-label="Workflow stages"
        onKeyDown={onStageKeyDown}
      >
        {workflowStages.map((stage, index) => (
          <button
            key={stage.id}
            ref={(el) => {
              stageRefs.current[index] = el;
            }}
            type="button"
            role="tab"
            id={`workflow-tab-${stage.id}`}
            className="workflow__stage"
            aria-label={stage.name}
            aria-selected={index === stageIndex}
            aria-controls="workflow-stage-panel"
            tabIndex={index === stageIndex ? 0 : -1}
            onClick={() => selectStage(index)}
          >
            <span className="workflow__stage-step" aria-hidden="true">
              {index + 1}
            </span>
            <span className="workflow__stage-name">{stage.name}</span>
            <span className="workflow__stage-kicker">{stage.kicker}</span>
          </button>
        ))}
      </div>
      <div
        className="workflow__panel"
        role="tabpanel"
        id="workflow-stage-panel"
        aria-labelledby={`workflow-tab-${activeStage.id}`}
      >
        <p>{activeStage.detail}</p>
      </div>
      <p className="workflow__note">
        This guide is a map of the workflow, not a progress tracker—it does not
        mark stages complete or show live model results.
      </p>
    </section>
  );
}

export function App() {
  const syntheticDemo = import.meta.env.VITE_CONTEXTDESK_SYNTHETIC_DEMO === "1";
  const staticReadOnly = window.__CONTEXTDESK_STATIC_READ_ONLY__ === true;
  const [session, setSession] = useState<SessionView | null>(null);
  const [ready, setReady] = useState(false);
  const [theme, setTheme] = useState<ThemeName>(savedTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      if (typeof window.localStorage?.setItem === "function") {
        window.localStorage.setItem("cd-theme", theme);
      }
    } catch {
      // A blocked or unavailable browser store should not disable the demo.
    }
  }, [theme]);

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
      <WorkflowGuide />
      <section className="shell__toolbar" aria-label="Presentation controls">
        <span className="shell__toolbar-label">Presenter controls</span>
        <label className="shell__theme">
          Skin
          <select
            aria-label="Interface theme"
            value={theme}
            onChange={(event) => setTheme(event.target.value as ThemeName)}
          >
            {themes.map(([name, label]) => (
              <option key={name} value={name}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </section>
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
          <Cases
            roles={session.roles}
            readOnly={staticReadOnly}
            participant={{ username: session.username, roles: session.roles }}
          />
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
