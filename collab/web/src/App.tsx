import { useCallback, useEffect, useRef, useState } from "react";
import {
  HOME,
  SIGN_IN,
  historyUrl,
  isShellLocation,
  isSignInLocation,
  isUnknownLocation,
  isWorkLocation,
  parseHashStage,
  parsePathname,
  restoreAfterSignIn,
  sameLocation,
  titleFor,
  type AreaId,
  type ShellLocation,
  type WorkLocation,
} from "./app-location.js";
import { Cases } from "./Cases.js";
import { Catalog } from "./Catalog.js";
import { HelpCenter } from "./HelpCenter.js";
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

const PRIMARY_NAV: readonly { area: AreaId; label: string }[] = [
  { area: "overview", label: "Overview" },
  { area: "investigations", label: "Investigations" },
  { area: "sources", label: "Sources" },
  { area: "help", label: "Help" },
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

function writeHistory(location: ShellLocation, mode: "push" | "replace") {
  const url = historyUrl(location, window.location.pathname);
  try {
    if (mode === "replace") {
      window.history.replaceState(location, "", url);
    } else {
      window.history.pushState(location, "", url);
    }
  } catch {
    // History can be unavailable in embedded shells; in-app state still works.
  }
}

export function App() {
  const syntheticDemo = import.meta.env.VITE_CONTEXTDESK_SYNTHETIC_DEMO === "1";
  const staticReadOnly = window.__CONTEXTDESK_STATIC_READ_ONLY__ === true;
  const [session, setSession] = useState<SessionView | null>(null);
  const [ready, setReady] = useState(false);
  const [theme, setTheme] = useState<ThemeName>(savedTheme);
  const [location, setLocation] = useState<ShellLocation>(() =>
    parsePathname(window.location.pathname),
  );
  const [navOpen, setNavOpen] = useState(false);
  const [startSignal, setStartSignal] = useState(0);
  const locationRef = useRef(location);
  locationRef.current = location;
  const restoreRef = useRef<WorkLocation | null>(
    isWorkLocation(parsePathname(window.location.pathname))
      ? (parsePathname(window.location.pathname) as WorkLocation)
      : null,
  );
  const mainRef = useRef<HTMLElement>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  useEffect(() => {
    document.title = titleFor(location);
  }, [location]);

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

  const navigate = useCallback((next: ShellLocation, mode: "push" | "replace" = "push") => {
    setLocation((current) => {
      if (sameLocation(current, next)) {
        return current;
      }
      return next;
    });
    setNavOpen(false);
    writeHistory(next, mode);
  }, []);

  useEffect(() => {
    if (!ready) {
      return;
    }
    if (!session) {
      const current = locationRef.current;
      if (isWorkLocation(current)) {
        restoreRef.current = current;
      } else if (isUnknownLocation(current)) {
        restoreRef.current = null;
      }
      if (!isSignInLocation(current)) {
        setLocation(SIGN_IN);
        writeHistory(SIGN_IN, "replace");
      }
      return;
    }
    const current = locationRef.current;
    if (isSignInLocation(current)) {
      const next = restoreAfterSignIn(restoreRef.current);
      restoreRef.current = null;
      setLocation(next);
      writeHistory(next, "replace");
    }
  }, [ready, session]);

  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      const hashStage = parseHashStage(window.location.hash);
      if (hashStage) {
        // A legacy fragment link fires popstate with a null state before the
        // hashchange event; that navigation belongs to the hashchange handler.
        return;
      }
      const next = isShellLocation(event.state)
        ? event.state
        : parsePathname(window.location.pathname);
      setLocation(next);
      setNavOpen(false);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // Legacy in-page anchors (triage rail, review queue) route to the stage that
  // now presents their target, then hand scrolling back to the browser.
  useEffect(() => {
    const onHashChange = () => {
      const stage = parseHashStage(window.location.hash);
      const current = locationRef.current;
      if (!stage || !isWorkLocation(current) || !current.caseId) return;
      const next: WorkLocation = {
        area: "investigations",
        caseId: current.caseId,
        stage,
      };
      setLocation(next);
      window.setTimeout(() => {
        document.getElementById(window.location.hash.replace(/^#/, ""))?.scrollIntoView?.();
      }, 0);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  function logout() {
    restoreRef.current = null;
    setSession(null);
    setLocation(SIGN_IN);
    writeHistory(SIGN_IN, "replace");
    void fetch("/api/auth/logout", { method: "POST" });
  }

  function goToArea(area: AreaId) {
    const current = locationRef.current;
    const caseId =
      area === "help" && isWorkLocation(current) ? current.caseId : null;
    const stage =
      area === "help" && isWorkLocation(current) ? current.stage : "situation";
    navigate({ area, caseId, stage });
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
  const work: WorkLocation = isWorkLocation(location) ? location : HOME;
  const inCasesArea = work.area === "overview" || work.area === "investigations";
  const unknown = isUnknownLocation(location);
  const currentArea = unknown ? null : work.area;

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
                const activeArea = item.area === currentArea;
                // Help keeps the focused investigation in the location so its
                // articles can offer a real way back to that work; the Help
                // page itself is still the exact destination.
                const exact =
                  activeArea && (work.caseId === null || item.area === "help") && !unknown;
                return (
                  <li key={item.area}>
                    <button
                      type="button"
                      className="topbar__nav-link"
                      aria-current={exact ? "page" : activeArea ? "true" : undefined}
                      onClick={() => goToArea(item.area)}
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
              onSignOut={staticReadOnly ? null : () => logout()}
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
      <main id="war-room-main" className="app__main" ref={mainRef} tabIndex={-1}>
        {unknown ? (
          <section className="not-found" aria-labelledby="not-found-title">
            <h2 className="not-found__title" id="not-found-title">
              This page is not in the War Room
            </h2>
            <p className="not-found__copy" role="status">
              <code className="not-found__path">{location.attempted}</code> is not a page this
              workspace serves. Nothing else was opened from that address.
            </p>
            <button
              type="button"
              className="not-found__home"
              onClick={() => navigate(HOME)}
            >
              Back to overview
            </button>
          </section>
        ) : (
          <>
            <section className="app__area" aria-label="Investigations" hidden={!inCasesArea}>
              <Cases
                roles={roles}
                readOnly={staticReadOnly}
                participant={{ username: session.username, roles }}
                view={work.area === "investigations" ? "investigations" : "overview"}
                focusCaseId={inCasesArea ? work.caseId : null}
                stage={work.stage}
                startSignal={startSignal}
                onOpenCase={(id) =>
                  navigate({ area: "investigations", caseId: id, stage: "situation" })
                }
                onStageChange={(stage) =>
                  isWorkLocation(locationRef.current) && locationRef.current.caseId
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
              hidden={work.area !== "sources"}
            >
              <Catalog canLead={canLeadCatalog} />
            </section>
            <section className="app__area" aria-label="Help" hidden={work.area !== "help"}>
              <HelpCenter
                onOpenArea={(area) => navigate({ area, caseId: null, stage: "situation" })}
                onOpenStage={
                  work.caseId
                    ? (stage) =>
                        navigate({
                          area: "investigations",
                          caseId: locationRef.current && isWorkLocation(locationRef.current)
                            ? locationRef.current.caseId
                            : work.caseId,
                          stage,
                        })
                    : null
                }
              />
            </section>
          </>
        )}
      </main>
    </div>
  );
}
