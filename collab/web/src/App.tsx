import { useCallback, useEffect, useRef, useState } from "react";
import { Cases, type StageId } from "./Cases.js";
import { Catalog } from "./Catalog.js";
import { LoginForm } from "./LoginForm.js";

interface SessionView {
  username: string;
  roles: string[];
}

// The stored ids stay stable so existing saved preferences keep resolving;
// only the display names are user-facing. "Command" is the gold-accent skin
// historically stored as "grokptah".
const themes = [
  ["dark", "Dark"],
  ["slate", "Slate"],
  ["light", "Light"],
  ["sand", "Sand"],
  ["forest", "Forest"],
  ["grokptah", "Command"],
] as const;

type ThemeName = (typeof themes)[number][0];

/** The default skin when no valid saved preference exists. */
const DEFAULT_THEME: ThemeName = "grokptah";

function savedTheme(): ThemeName {
  try {
    const candidate =
      typeof window.localStorage?.getItem === "function"
        ? window.localStorage.getItem("cd-theme")
        : null;
    return themes.some(([name]) => name === candidate)
      ? (candidate as ThemeName)
      : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
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
      <h3 className="workflow__title" id="workflow-title">
        Workflow guide
      </h3>
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

type AreaId = "overview" | "investigations" | "sources" | "how-it-works";

/** The whole navigable position of the War Room, kept in one object so the
 *  browser history can restore any point with a single popstate payload. */
interface WarRoomLocation {
  area: AreaId;
  caseId: string | null;
  stage: StageId;
}

const HOME: WarRoomLocation = { area: "overview", caseId: null, stage: "situation" };

const STAGE_IDS: readonly StageId[] = ["situation", "capture", "analyze", "compare", "decide"];
const AREA_IDS: readonly AreaId[] = ["overview", "investigations", "sources", "how-it-works"];

function isWarRoomLocation(value: unknown): value is WarRoomLocation {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    AREA_IDS.includes(row.area as AreaId) &&
    (row.caseId === null || typeof row.caseId === "string") &&
    STAGE_IDS.includes(row.stage as StageId)
  );
}

/**
 * Fragment ids that pre-shell surfaces still emit as plain `#anchor` links
 * (the TriageWorkspace rail and the Experiment Lab review queue). Each one
 * names content that now lives on a specific focused stage, so a click routes
 * to that stage instead of dying against a hidden panel.
 */
const LEGACY_ANCHOR_STAGES: Record<string, StageId> = {
  "triage-capture": "capture",
  "triage-analyze": "analyze",
  "triage-evidence-board": "analyze",
  "triage-lane-runner": "analyze",
  "triage-compare": "compare",
  "triage-comparison-lab": "compare",
  "triage-decide": "decide",
  "decision-heading": "decide",
  "export-heading": "decide",
};

const PRIMARY_NAV: readonly { area: AreaId; label: string }[] = [
  { area: "overview", label: "Overview" },
  { area: "investigations", label: "Investigations" },
  { area: "sources", label: "Sources" },
  { area: "how-it-works", label: "How it works" },
];

function AccountMenu(props: {
  username: string;
  roles: string[];
  theme: ThemeName;
  onThemeChange: (theme: ThemeName) => void;
  onSignOut: (() => void) | null;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape" && open) {
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    }
  }

  return (
    <div className="account" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className="account__trigger"
        aria-expanded={open}
        aria-controls="account-panel"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="sr-only">Signed in as </span>
        {/* The initial is CSS-generated so the button's text reads exactly
            "Signed in as <username>" for assistive tech and text matching. */}
        <span
          className="account__avatar"
          aria-hidden="true"
          data-initial={props.username.slice(0, 1).toUpperCase() || "?"}
        />
        <span className="account__name">{props.username}</span>
      </button>
      {open ? (
        <div className="account__panel" id="account-panel" role="group" aria-label="Account">
          <p className="account__identity">
            <strong>{props.username}</strong>
          </p>
          <p className="account__roles">Roles: {props.roles.join(", ") || "none"}</p>
          <label className="account__theme">
            Theme
            <select
              aria-label="Interface theme"
              value={props.theme}
              onChange={(event) => props.onThemeChange(event.target.value as ThemeName)}
            >
              {themes.map(([name, label]) => (
                <option key={name} value={name}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {props.onSignOut ? (
            <button
              className="account__signout"
              type="button"
              onClick={() => {
                setOpen(false);
                props.onSignOut?.();
              }}
            >
              Sign out
            </button>
          ) : (
            <p className="account__static-note">Static read-only session — no sign-out.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function App() {
  const syntheticDemo = import.meta.env.VITE_CONTEXTDESK_SYNTHETIC_DEMO === "1";
  const staticReadOnly = window.__CONTEXTDESK_STATIC_READ_ONLY__ === true;
  const [session, setSession] = useState<SessionView | null>(null);
  const [ready, setReady] = useState(false);
  const [theme, setTheme] = useState<ThemeName>(savedTheme);
  // Always starts at HOME on a fresh load; history state is only replayed
  // through popstate so browser Back works without a reload re-entering focus.
  const [location, setLocation] = useState<WarRoomLocation>(HOME);
  const [navOpen, setNavOpen] = useState(false);
  const [startSignal, setStartSignal] = useState(0);
  const locationRef = useRef(location);
  locationRef.current = location;

  // index.html still carries the pre-rename title and is outside this
  // change's file surface; the shell owns the document title instead.
  useEffect(() => {
    document.title = "ContextDesk War Room";
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      if (typeof window.localStorage?.setItem === "function") {
        window.localStorage.setItem("cd-theme", theme);
      }
    } catch {
      // A blocked or unavailable browser store should not disable the app.
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

  const navigate = useCallback((next: WarRoomLocation) => {
    setLocation(next);
    setNavOpen(false);
    try {
      // The explicit URL drops any leftover legacy #anchor from the address.
      window.history.pushState(next, "", window.location.pathname + window.location.search);
    } catch {
      // History can be unavailable in embedded shells; in-app state still works.
    }
  }, []);

  useEffect(() => {
    try {
      window.history.replaceState(HOME, "");
    } catch {
      // Same guard as above.
    }
    const onPopState = (event: PopStateEvent) => {
      if (isWarRoomLocation(event.state)) {
        setLocation(event.state);
        setNavOpen(false);
        return;
      }
      // A legacy fragment link fires popstate with a null state before the
      // hashchange event; that navigation belongs to the hashchange handler.
      if (LEGACY_ANCHOR_STAGES[window.location.hash.replace(/^#/, "")]) return;
      setLocation(HOME);
      setNavOpen(false);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // Legacy in-page anchors (triage rail, review queue) route to the stage that
  // now presents their target, then hand scrolling back to the browser.
  useEffect(() => {
    const onHashChange = () => {
      const anchor = window.location.hash.replace(/^#/, "");
      const stage = LEGACY_ANCHOR_STAGES[anchor];
      const current = locationRef.current;
      if (!stage || !current.caseId) return;
      setLocation({ area: "investigations", caseId: current.caseId, stage });
      window.setTimeout(() => {
        document.getElementById(anchor)?.scrollIntoView?.();
      }, 0);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    setSession(null);
    setLocation(HOME);
  }

  if (!ready) {
    return (
      <main className="shell shell--gate" aria-busy="true">
        <p className="shell__eyebrow">ContextDesk</p>
        <h1 className="shell__title">ContextDesk War Room</h1>
        <p className="shell__loading" role="status">
          Checking your session…
        </p>
      </main>
    );
  }

  if (!session) {
    return (
      <main className="shell shell--gate">
        <section className="login-screen" aria-labelledby="login-screen-title">
          <p className="shell__eyebrow">ContextDesk</p>
          <h1 className="shell__title" id="login-screen-title">
            ContextDesk War Room
          </h1>
          <p className="shell__copy">
            A shared command center where your team works many hard investigations side by side.
          </p>
          {syntheticDemo ? (
            <p className="login-screen__hint">
              Sample data mode: sign in with <code>demo</code> / <code>demo</code>. Local sample
              state may reset when its service stops.
            </p>
          ) : null}
          <LoginForm
            onSuccess={() => void refresh()}
            {...(syntheticDemo
              ? { defaults: { username: "demo", password: "demo" } }
              : {})}
          />
        </section>
      </main>
    );
  }

  const roles = session.roles;
  const canWrite =
    !staticReadOnly &&
    (roles.includes("case-lead") || roles.includes("admin") || roles.includes("contributor"));
  const canLeadCatalog =
    !staticReadOnly && (roles.includes("case-lead") || roles.includes("admin"));
  const inCasesArea = location.area === "overview" || location.area === "investigations";

  function startInvestigation() {
    navigate(HOME);
    setStartSignal((value) => value + 1);
  }

  return (
    <div className="app">
      <a className="skip-link" href="#war-room-main">
        Skip to main content
      </a>
      <header className="topbar">
        <div className="topbar__brand">
          <h1 className="topbar__title">ContextDesk War Room</h1>
        </div>
        <button
          type="button"
          className="topbar__menu-toggle"
          aria-expanded={navOpen}
          aria-controls="primary-nav"
          onClick={() => setNavOpen((current) => !current)}
        >
          Menu
        </button>
        <div className="topbar__spread" data-open={navOpen ? "true" : undefined}>
          <nav id="primary-nav" className="topbar__nav" aria-label="Primary">
            <ul>
              {PRIMARY_NAV.map((item) => {
                const activeArea = item.area === location.area;
                const exact = activeArea && location.caseId === null;
                return (
                  <li key={item.area}>
                    <button
                      type="button"
                      className="topbar__nav-link"
                      aria-current={exact ? "page" : activeArea ? "true" : undefined}
                      onClick={() =>
                        navigate({ area: item.area, caseId: null, stage: "situation" })
                      }
                    >
                      {item.label}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
          <div className="topbar__actions">
            {canWrite ? (
              <button
                type="button"
                className="topbar__start"
                onClick={() => startInvestigation()}
              >
                Start investigation
              </button>
            ) : null}
            <AccountMenu
              username={session.username}
              roles={roles}
              theme={theme}
              onThemeChange={setTheme}
              onSignOut={staticReadOnly ? null : () => void logout()}
            />
          </div>
        </div>
      </header>
      {staticReadOnly ? (
        <p className="app-notice app-notice--static" role="note">
          Static read-only snapshot: browse the recorded investigations and share-safe reviews.
          Editing is unavailable in this build.
        </p>
      ) : syntheticDemo ? (
        <p className="app-notice" role="note">
          Sample investigation data is loaded. Each run records whether it is synthetic, live
          gateway, or imported; local sample state may reset when its service stops.
        </p>
      ) : null}
      <main id="war-room-main" className="app__main">
        <section className="app__area" aria-label="Investigations" hidden={!inCasesArea}>
          <Cases
            roles={roles}
            readOnly={staticReadOnly}
            participant={{ username: session.username, roles }}
            view={location.area === "investigations" ? "investigations" : "overview"}
            focusCaseId={inCasesArea ? location.caseId : null}
            stage={location.stage}
            startSignal={startSignal}
            onOpenCase={(id) =>
              navigate({ area: "investigations", caseId: id, stage: "situation" })
            }
            onStageChange={(stage) =>
              locationRef.current.caseId
                ? navigate({
                    area: "investigations",
                    caseId: locationRef.current.caseId,
                    stage,
                  })
                : undefined
            }
            onExitFocus={(target) =>
              navigate({ area: target, caseId: null, stage: "situation" })
            }
          />
        </section>
        <section
          className="app__area"
          aria-label="Source library"
          hidden={location.area !== "sources"}
        >
          <Catalog canLead={canLeadCatalog} />
        </section>
        <section
          className="app__area"
          aria-label="How it works"
          hidden={location.area !== "how-it-works"}
        >
          <div className="how-it-works">
            <h2 className="app__area-title">How it works</h2>
            <p className="app__area-copy">
              Every investigation moves through the same four work stages. This guide is the map;
              each investigation&rsquo;s focused view carries the actual work surfaces.
            </p>
            <WorkflowGuide />
          </div>
        </section>
      </main>
    </div>
  );
}
