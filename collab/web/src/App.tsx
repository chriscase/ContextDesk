import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  APP_ROLES,
  hasCapability,
  isCapability,
  roleCapabilities,
  type AppRole,
  type Capability,
} from "@cd-collab/contracts/admin";
import {
  ADMINISTRATION,
  HOME,
  LDAP_ADMIN,
  MODEL_POLICY,
  PEOPLE,
  PROFILE,
  SIGN_IN,
  historyUrl,
  isLdapAdminLocation,
  isModelPolicyLocation,
  isPeopleLocation,
  isProfileLocation,
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
import { InvestigationFirst } from "./InvestigationFirst.js";
import { Catalog } from "./Catalog.js";
import { Entities } from "./Entities.js";
import { Administration } from "./Administration.js";
import { HelpCenter } from "./HelpCenter.js";
import { LoginForm } from "./LoginForm.js";
import { SetupWizard } from "./SetupWizard.js";
import { SelfProfilePanel } from "./SelfProfilePanel.js";
import { BrandMark } from "./graphics.js";
import { AUTH_LOST_EVENT } from "./protected-api.js";
import {
  InvestigationRuntimeProvider,
  useInvestigationRuntime,
} from "./investigations/runtime/public.js";
import {
  InvestigationStrategyRenderer,
} from "./investigations/strategies/StrategyRenderer.js";
import {
  INVESTIGATION_STRATEGY_PRESENTATION_CONTRACT,
  defineInvestigationStrategyRegistrations,
  type InvestigationStrategyShellProps,
} from "./investigations/strategies/contract.js";
import {
  DEFAULT_UI_STRATEGY_ID,
  UI_STRATEGIES,
  resolveUiStrategy,
  type UiStrategyDescriptor,
  type UiStrategyId,
} from "./ui-strategy.js";

interface SessionView {
  identityId: string;
  username: string;
  displayName: string;
  roles: string[];
  capabilities?: string[];
  authorityGeneration: number;
}

function asAppRoles(roles: readonly string[]): AppRole[] {
  return roles.filter((role): role is AppRole => (APP_ROLES as readonly string[]).includes(role));
}

function sessionCapabilities(session: SessionView): Capability[] {
  if (session.capabilities) {
    return session.capabilities.filter(isCapability);
  }
  return roleCapabilities(asAppRoles(session.roles));
}

function investigationAuthorityKey(session: SessionView, readOnly: boolean): string {
  return JSON.stringify([
    "cd-investigation-authority.v1",
    session.identityId,
    session.authorityGeneration,
    readOnly ? "read-only" : "interactive",
    [...session.roles].sort(),
    [...(session.capabilities ?? [])].sort(),
  ]);
}

interface WarRoomStrategyBindings {
  readonly roles: string[];
  readonly capabilities: readonly string[];
  readonly readOnly: boolean;
  readonly participant: { username: string; roles: string[] };
  readonly onStageChange: (stage: WorkLocation["stage"]) => void;
  readonly onDeepNavigate: (stage: WorkLocation["stage"], focus: NonNullable<WorkLocation["focus"]>) => void;
  readonly onActivityOpen: (
    caseId: string,
    stage: WorkLocation["stage"],
    focus: NonNullable<WorkLocation["focus"]>,
  ) => void;
  readonly onExitFocus: (target: "overview" | "investigations") => void;
}

const WarRoomStrategyContext = createContext<WarRoomStrategyBindings | null>(null);

/** Reference presentation adapter; all investigation authority comes from Runtime V1. */
function WarRoomStrategy(props: InvestigationStrategyShellProps) {
  const bindings = useContext(WarRoomStrategyContext);
  const runtime = useInvestigationRuntime();
  if (bindings === null) return null;

  return (
    <Cases
      roles={bindings.roles}
      capabilities={bindings.capabilities}
      readOnly={bindings.readOnly}
      participant={bindings.participant}
      view={props.view}
      focusCaseId={props.focusCaseId}
      stage={props.stage}
      {...(props.focus ? { focus: props.focus } : {})}
      {...(props.startSignal === undefined ? {} : { startSignal: props.startSignal })}
      onOpenCase={props.onOpenCase}
      onStageChange={bindings.onStageChange}
      onDeepNavigate={bindings.onDeepNavigate}
      onActivityOpen={bindings.onActivityOpen}
      onExitFocus={bindings.onExitFocus}
      {...(props.onFocusedCaseTitle
        ? { onFocusedCaseTitle: props.onFocusedCaseTitle }
        : {})}
      lifecycleBinding={{
        lifecycle: runtime.resources.lifecycle,
        lifecycleMutation: runtime.mutations.lifecycle,
        canManage: runtime.capabilities.canManageLifecycle,
        readOnly: bindings.readOnly,
        applyAction: runtime.commands.applyLifecycle,
        retryLifecycle: () => {
          runtime.refresh.investigation();
          runtime.refresh.investigations();
          runtime.refresh.lifecycle();
        },
      }}
    />
  );
}

/** Investigation First is intentionally only a Runtime V1 presentation. */
function InvestigationFirstStrategy(props: InvestigationStrategyShellProps) {
  return <InvestigationFirst {...props} />;
}

const INVESTIGATION_STRATEGY_REGISTRATIONS = defineInvestigationStrategyRegistrations({
  "war-room": {
    id: "war-room",
    presentationContract: INVESTIGATION_STRATEGY_PRESENTATION_CONTRACT,
    component: WarRoomStrategy,
  },
  "investigation-first": {
    id: "investigation-first",
    presentationContract: INVESTIGATION_STRATEGY_PRESENTATION_CONTRACT,
    component: InvestigationFirstStrategy,
  },
});

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

const UI_STRATEGY_STORAGE_PREFIX = "cd-ui-strategy:";

function uiStrategyStorageKey(username: string): string {
  return `${UI_STRATEGY_STORAGE_PREFIX}${encodeURIComponent(username)}`;
}

function savedUiStrategy(username: string): UiStrategyDescriptor {
  try {
    const preferred = window.localStorage?.getItem(uiStrategyStorageKey(username));
    return resolveUiStrategy({ preferred });
  } catch {
    return resolveUiStrategy({ preferred: DEFAULT_UI_STRATEGY_ID });
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
  { area: "entities", label: "Entities" },
  { area: "sources", label: "Attribution" },
  { area: "administration", label: "Administration" },
  { area: "help", label: "Help" },
];

function AccountMenu(props: {
  username: string;
  displayName: string;
  roles: string[];
  theme: ThemeName;
  profileActive: boolean;
  onOpenProfile: () => void;
  onThemeChange: (theme: ThemeName) => void;
  /** Saved personal preference, distinct from a history-scoped handoff. */
  strategy: UiStrategyDescriptor;
  temporaryStrategy: UiStrategyDescriptor | null;
  onStrategyChange: (strategy: UiStrategyId) => void;
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
          data-initial={props.displayName.slice(0, 1).toUpperCase() || "?"}
        />
        <span className="account__name">{props.displayName}</span>
      </button>
      {open ? (
        <div className="account__panel" id="account-panel" role="group" aria-label="Account">
          <p className="account__identity">
            <strong>{props.displayName}</strong>
            {props.displayName !== props.username ? <span>@{props.username}</span> : null}
          </p>
          <p className="account__roles">
            Access: {props.roles.map((role) => role === "case-lead" ? "Case lead" : role[0]?.toUpperCase() + role.slice(1)).join(", ") || "None"}
          </p>
          <a
            className="account__profile"
            href="/profile"
            aria-current={props.profileActive ? "page" : undefined}
            onClick={(event) => {
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
                return;
              }
              event.preventDefault();
              setOpen(false);
              props.onOpenProfile();
            }}
          >
            My profile
          </a>
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
          <fieldset className="account__strategies">
            <legend>Investigation experience</legend>
            <p className="account__strategy-note">
              Presentation and navigation only. Your case data, evidence, permissions, and audit
              history stay shared.
            </p>
            {props.temporaryStrategy ? (
              <p className="account__strategy-note" role="status">
                Temporarily using {props.temporaryStrategy.name} for this history entry. Your saved
                preference remains {props.strategy.name}.
              </p>
            ) : null}
            {UI_STRATEGIES.map((strategy) => (
              <label key={strategy.id} className="account__strategy-option">
                <input
                  type="radio"
                  name="ui-strategy"
                  value={strategy.id}
                  checked={props.strategy.id === strategy.id}
                  onChange={() => props.onStrategyChange(strategy.id)}
                />
                <span className="account__strategy-preview" data-preview={strategy.previewToken} aria-hidden="true" />
                <span>
                  <strong>{strategy.name}</strong>
                  <small>{strategy.description}</small>
                  <small>{strategy.maturity === "reference" ? "Reference" : "Pilot"} · {strategy.status} · v{strategy.version}</small>
                  <small>Compatible with {strategy.compatibility.schemaId} {strategy.compatibility.version}</small>
                </span>
              </label>
            ))}
          </fieldset>
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

function historyUiStrategyId(value: unknown): UiStrategyId | null {
  if (!value || typeof value !== "object") return null;
  const candidate = (value as { uiStrategyId?: unknown }).uiStrategyId;
  return UI_STRATEGIES.some((strategy) => strategy.id === candidate)
    ? candidate as UiStrategyId
    : null;
}

function writeHistory(
  location: ShellLocation,
  mode: "push" | "replace",
  uiStrategyId?: UiStrategyId,
) {
  const url = historyUrl(location, window.location.pathname);
  const state = uiStrategyId === undefined ? location : { ...location, uiStrategyId };
  try {
    if (mode === "replace") {
      window.history.replaceState(state, "", url);
    } else {
      window.history.pushState(state, "", url);
    }
  } catch {
    // History can be unavailable in embedded shells; in-app state still works.
  }
}

export function App() {
  const syntheticDemo = import.meta.env.VITE_CONTEXTDESK_SYNTHETIC_DEMO === "1";
  const staticReadOnly = window.__CONTEXTDESK_STATIC_READ_ONLY__ === true;
  const [session, setSession] = useState<SessionView | null>(null);
  const [sessionIssue, setSessionIssue] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [setupAvailable, setSetupAvailable] = useState<boolean | null>(null);
  const [theme, setTheme] = useState<ThemeName>(savedTheme);
  const [preferredUiStrategy, setPreferredUiStrategy] = useState<UiStrategyDescriptor>(() =>
    resolveUiStrategy({ preferred: DEFAULT_UI_STRATEGY_ID }),
  );
  const [transientUiStrategyId, setTransientUiStrategyId] = useState<UiStrategyId | null>(() =>
    historyUiStrategyId(window.history.state),
  );
  const [uiStrategyOwner, setUiStrategyOwner] = useState<string | null>(null);
  const [location, setLocation] = useState<ShellLocation>(() =>
    parsePathname(window.location.pathname, window.location.search, window.location.hash),
  );
  const [navOpen, setNavOpen] = useState(false);
  const [startSignal, setStartSignal] = useState(0);
  const [focusedCaseTitle, setFocusedCaseTitle] = useState<string | null>(null);
  const [profileDirty, setProfileDirty] = useState(false);
  const [leaveRequest, setLeaveRequest] = useState(false);
  const locationRef = useRef(location);
  locationRef.current = location;
  const profileDirtyRef = useRef(false);
  profileDirtyRef.current = profileDirty;
  const pendingLeaveRef = useRef<
    | { kind: "navigate"; next: ShellLocation; mode: "push" | "replace" }
    | { kind: "logout" }
    | null
  >(null);
  const restoreRef = useRef<WorkLocation | null>(
    isWorkLocation(parsePathname(window.location.pathname, window.location.search, window.location.hash))
      ? (parsePathname(window.location.pathname, window.location.search, window.location.hash) as WorkLocation)
      : null,
  );
  const mainRef = useRef<HTMLElement>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const authorityGenerationRef = useRef(0);
  const uiStrategy = transientUiStrategyId
    ? resolveUiStrategy({ preferred: transientUiStrategyId })
    : preferredUiStrategy;

  useEffect(() => {
    document.title = titleFor(location, focusedCaseTitle, {
      surfaceName: uiStrategy.name,
      includeInvestigationStage: uiStrategy.id === DEFAULT_UI_STRATEGY_ID,
    });
  }, [location, focusedCaseTitle, uiStrategy.id, uiStrategy.name]);

  useEffect(() => {
    const invalidate = () => {
      const current = locationRef.current;
      restoreRef.current = isWorkLocation(current) ? current : null;
      setFocusedCaseTitle(null);
      setSession(null);
      setSessionIssue(null);
      setReady(true);
      setLocation(SIGN_IN);
      writeHistory(SIGN_IN, "replace");
    };
    window.addEventListener(AUTH_LOST_EVENT, invalidate);
    return () => window.removeEventListener(AUTH_LOST_EVENT, invalidate);
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

  useEffect(() => {
    if (!ready) return;
    if (!session?.username) {
      setUiStrategyOwner(null);
      setPreferredUiStrategy(resolveUiStrategy({ preferred: DEFAULT_UI_STRATEGY_ID }));
      setTransientUiStrategyId(null);
      return;
    }
    const changedAuthenticatedUser = uiStrategyOwner !== null && uiStrategyOwner !== session.username;
    setUiStrategyOwner(session.username);
    setPreferredUiStrategy(savedUiStrategy(session.username));
    if (changedAuthenticatedUser) setTransientUiStrategyId(null);
  }, [ready, session?.username, uiStrategyOwner]);

  useEffect(() => {
    if (!session?.username || uiStrategyOwner !== session.username) return;
    try {
      window.localStorage?.setItem(uiStrategyStorageKey(session.username), preferredUiStrategy.id);
    } catch {
      // A blocked browser store should not prevent the selected surface from working this session.
    }
  }, [session?.username, preferredUiStrategy.id, uiStrategyOwner]);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/auth/me");
    if (res.status === 503) {
      setSession(null);
      setSessionIssue(
        "Your sign-in is valid, but the directory is temporarily unavailable. Try again when the directory connection is restored.",
      );
      setReady(true);
      return;
    }
    if (!res.ok) {
      setSession(null);
      setSessionIssue(null);
      setReady(true);
      return;
    }
    const body = (await res.json()) as {
      identity?: { id?: string; username?: string; displayName?: string };
      roles?: string[];
      capabilities?: string[];
    };
    const username = body.identity?.username ?? "";
    authorityGenerationRef.current += 1;
    setSession({
      identityId: body.identity?.id?.trim() || username,
      username,
      displayName: body.identity?.displayName?.trim() || username,
      roles: body.roles ?? [],
      ...(body.capabilities ? { capabilities: body.capabilities } : {}),
      authorityGeneration: authorityGenerationRef.current,
    });
    setSessionIssue(null);
    setReady(true);
  }, []);

  useEffect(() => {
    let active = true;
    void fetch("/api/setup/status", {
      headers: { accept: "application/json" },
      cache: "no-store",
    })
      .then((response) => {
        if (!active) return;
        if (response.ok) {
          setSetupAvailable(true);
          setReady(true);
          return;
        }
        setSetupAvailable(false);
        void refresh();
      })
      .catch(() => {
        if (!active) return;
        setSetupAvailable(false);
        void refresh();
      });
    return () => {
      active = false;
    };
  }, [refresh]);

  const navigate = useCallback((
    next: ShellLocation,
    mode: "push" | "replace" = "push",
    historyStrategyId: UiStrategyId | undefined = transientUiStrategyId ?? undefined,
  ) => {
    setLocation((current) => {
      if (sameLocation(current, next)) {
        return current;
      }
      return next;
    });
    setNavOpen(false);
    writeHistory(next, mode, historyStrategyId);
  }, [transientUiStrategyId]);

  const openCreatedInvestigation = useCallback((investigationId: string) => {
    navigate({
      area: "investigations",
      caseId: investigationId,
      stage: "situation",
    });
  }, [navigate]);

  const requestLeave = useCallback((
    action: { kind: "navigate"; next: ShellLocation; mode: "push" | "replace" } | { kind: "logout" },
  ) => {
    pendingLeaveRef.current = action;
    setLeaveRequest(true);
  }, []);

  const guardedNavigate = useCallback((next: ShellLocation, mode: "push" | "replace" = "push") => {
    if (
      profileDirtyRef.current
      && isProfileLocation(locationRef.current)
      && !isProfileLocation(next)
    ) {
      requestLeave({ kind: "navigate", next, mode });
      return;
    }
    navigate(next, mode);
  }, [navigate, requestLeave]);

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
      return;
    }
    if (!isWorkLocation(current)) return;
    // Direct and restored locators may still carry a legacy alias
    // (`case-discussion`). Rewrite to the copyable canonical URL without
    // changing the in-memory destination.
    const canonical = historyUrl(current, window.location.pathname);
    const live = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (canonical !== live) {
      writeHistory(current, "replace");
    }
  }, [ready, session, location]);

  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      const hashStage = parseHashStage(window.location.hash);
      const hasStructuredFocus = new URLSearchParams(window.location.search).has("section");
      if (hashStage && !hasStructuredFocus) {
        // A legacy fragment link fires popstate with a null state before the
        // hashchange event; that navigation belongs to the hashchange handler.
        return;
      }
      const next = isShellLocation(event.state)
        ? event.state
        : parsePathname(window.location.pathname, window.location.search, window.location.hash);
      if (
        profileDirtyRef.current
        && isProfileLocation(locationRef.current)
        && !isProfileLocation(next)
      ) {
        writeHistory(PROFILE, "push");
        requestLeave({ kind: "navigate", next, mode: "push" });
        return;
      }
      const historyStrategyId = historyUiStrategyId(event.state);
      setTransientUiStrategyId(historyStrategyId);
      setLocation(next);
      setNavOpen(false);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [requestLeave]);

  // Legacy in-page anchors (triage rail, review queue) route to the stage that
  // now presents their target, then hand scrolling back to the browser.
  useEffect(() => {
    const onHashChange = () => {
      if (new URLSearchParams(window.location.search).has("section")) return;
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

  function confirmLeave() {
    const pending = pendingLeaveRef.current;
    pendingLeaveRef.current = null;
    setLeaveRequest(false);
    setProfileDirty(false);
    profileDirtyRef.current = false;
    if (pending?.kind === "logout") {
      logout();
      return;
    }
    if (pending?.kind === "navigate") {
      navigate(pending.next, pending.mode);
    }
  }

  function cancelLeave() {
    pendingLeaveRef.current = null;
    setLeaveRequest(false);
  }

  function guardedLogout() {
    if (profileDirtyRef.current && isProfileLocation(locationRef.current)) {
      requestLeave({ kind: "logout" });
      return;
    }
    logout();
  }

  function goToArea(area: AreaId) {
    const current = locationRef.current;
    const caseId =
      area === "help" && isWorkLocation(current) ? current.caseId : null;
    const stage =
      area === "help" && isWorkLocation(current) ? current.stage : "situation";
    guardedNavigate({ area, caseId, stage });
  }

  if (setupAvailable === true) {
    return (
      <SetupWizard
        onUnavailable={() => {
          setSetupAvailable(false);
          setReady(false);
          void refresh();
        }}
      />
    );
  }

  if (!ready || setupAvailable === null) {
    return (
      <main className="shell shell--gate" aria-busy="true">
        <div className="shell__brand">
          <BrandMark size={34} />
        </div>
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
          <div className="shell__brand">
            <BrandMark size={34} />
          </div>
          <p className="shell__eyebrow">ContextDesk</p>
          <h1 className="shell__title" id="login-screen-title">
            ContextDesk War Room
          </h1>
          <p className="shell__copy">
            A shared command center where your team works many hard investigations side by side.
          </p>
          {sessionIssue ? (
            <p className="login-screen__error" role="alert">
              {sessionIssue}
            </p>
          ) : null}
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
  const capabilities = sessionCapabilities(session);
  const canWrite = !staticReadOnly && hasCapability(capabilities, "investigation:write");
  const canLeadCatalog =
    !staticReadOnly &&
    (hasCapability(capabilities, "run:strategies") ||
      hasCapability(capabilities, "admin:system_config"));
  const canAdmin = !staticReadOnly && hasCapability(capabilities, "admin:users");
  const work: WorkLocation = isWorkLocation(location) ? location : HOME;
  const inCasesArea = work.area === "overview" || work.area === "investigations";
  const unknown = isUnknownLocation(location);
  const currentArea = unknown ? null : work.area;
  const warRoomBindings: WarRoomStrategyBindings = {
    roles,
    capabilities,
    readOnly: staticReadOnly,
    participant: { username: session.username, roles },
    onStageChange: (stage) =>
      isWorkLocation(locationRef.current) && locationRef.current.caseId
        ? navigate({
            area: "investigations",
            caseId: locationRef.current.caseId,
            stage,
          })
        : undefined,
    onDeepNavigate: (stage, focus) =>
      isWorkLocation(locationRef.current) && locationRef.current.caseId
        ? navigate({
            area: "investigations",
            caseId: locationRef.current.caseId,
            stage,
            focus,
          })
        : undefined,
    onActivityOpen: (caseId, stage, focus) =>
      navigate({ area: "investigations", caseId, stage, focus }),
    onExitFocus: (target) =>
      navigate({ area: target, caseId: null, stage: "situation" }),
  };

  function startInvestigation() {
    guardedNavigate({ area: "investigations", caseId: null, stage: "situation" });
    setStartSignal((value) => value + 1);
  }

  return (
    <div className="app">
      <a className="skip-link" href="#war-room-main">
        Skip to main content
      </a>
      <header className="topbar">
        <div className="topbar__brand">
          <BrandMark />
          <h1 className="topbar__title">
            <span className="topbar__title-product">ContextDesk</span>{" "}
            <span className="topbar__title-app">{uiStrategy.name}</span>
          </h1>
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
              {PRIMARY_NAV.filter(
                (item) => item.area !== "administration" || canAdmin,
              ).map((item) => {
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
              displayName={session.displayName}
              roles={roles}
              theme={theme}
              strategy={preferredUiStrategy}
              temporaryStrategy={transientUiStrategyId ? uiStrategy : null}
              profileActive={work.area === "profile"}
              onOpenProfile={() => guardedNavigate(PROFILE)}
              onThemeChange={setTheme}
              onStrategyChange={(strategyId) => {
                setPreferredUiStrategy(resolveUiStrategy({ preferred: strategyId }));
                setTransientUiStrategyId(null);
                writeHistory(locationRef.current, "replace");
              }}
              onSignOut={staticReadOnly ? null : () => guardedLogout()}
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
              onClick={() => guardedNavigate(HOME)}
            >
              Back to overview
            </button>
          </section>
        ) : (
          <>
            <section className="app__area" aria-label="Investigations" hidden={!inCasesArea}>
              <InvestigationRuntimeProvider
                identityKey={session.identityId}
                // Descriptive only, and deliberately just these three already
                // sanitized fields: roles and capabilities reach the runtime
                // through the capability projection below, never through here.
                identity={{
                  id: session.identityId,
                  username: session.username,
                  displayName: session.displayName,
                }}
                authorityKey={investigationAuthorityKey(session, staticReadOnly)}
                capabilities={capabilities}
                readOnly={staticReadOnly}
                active={inCasesArea}
                focusCaseId={inCasesArea ? work.caseId : null}
                isInvestigationLocation={inCasesArea}
                onOpenCreated={openCreatedInvestigation}
              >
                <WarRoomStrategyContext.Provider value={warRoomBindings}>
                  <InvestigationStrategyRenderer
                    strategy={uiStrategy}
                    registrations={INVESTIGATION_STRATEGY_REGISTRATIONS}
                    view={work.area === "investigations" ? "investigations" : "overview"}
                    focusCaseId={inCasesArea ? work.caseId : null}
                    stage={work.stage}
                    {...(work.focus ? { focus: work.focus } : {})}
                    startSignal={startSignal}
                    onOpenCase={(id) =>
                      navigate({ area: "investigations", caseId: id, stage: "situation" })
                    }
                    onExitFocus={() =>
                      navigate({ area: "investigations", caseId: null, stage: "situation" })
                    }
                    onOpenAdvancedTools={(caseId, stage) => {
                      // Specialist tools remain in the reference War Room. The
                      // switch is explicit in the button label and preserves the
                      // canonical case/stage URL and all shared record state.
                      setTransientUiStrategyId(DEFAULT_UI_STRATEGY_ID);
                      navigate(
                        { area: "investigations", caseId, stage },
                        "push",
                        DEFAULT_UI_STRATEGY_ID,
                      );
                    }}
                    onFocusedCaseTitle={setFocusedCaseTitle}
                  />
                </WarRoomStrategyContext.Provider>
              </InvestigationRuntimeProvider>
            </section>
            <section
              className="app__area"
              aria-label="Entities"
              hidden={work.area !== "entities"}
            >
              <Entities canWrite={canWrite} canLead={canLeadCatalog} />
            </section>
            <section
              className="app__area"
              aria-label="Attribution"
              hidden={work.area !== "sources"}
            >
              <Catalog canLead={canLeadCatalog} />
            </section>
            <section className="app__area" aria-label="Help" hidden={work.area !== "help"}>
              <HelpCenter
                onOpenArea={(area) => guardedNavigate({ area, caseId: null, stage: "situation" })}
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
            {work.area === "profile" ? (
              <section className="app__area" aria-label="My profile">
                <SelfProfilePanel
                  readOnly={staticReadOnly}
                  leaveRequest={leaveRequest}
                  onLeaveConfirm={confirmLeave}
                  onLeaveCancel={cancelLeave}
                  onDirtyChange={setProfileDirty}
                  onSaved={(profile) => {
                    setSession((current) =>
                      current
                        ? { ...current, displayName: profile.displayName.trim() || current.username }
                        : current,
                    );
                  }}
                />
              </section>
            ) : null}
            {work.area === "administration" ? (
              canAdmin ? (
                <section className="app__area" aria-label="Administration">
                  <Administration
                    tab={
                      isPeopleLocation(work)
                        ? "people"
                        : isLdapAdminLocation(work)
                          ? "ldap"
                          : isModelPolicyLocation(work)
                            ? "model-policy"
                            : "roles"
                    }
                    onSelectTab={(tab) =>
                      guardedNavigate(
                        tab === "people"
                          ? PEOPLE
                          : tab === "ldap"
                            ? LDAP_ADMIN
                            : tab === "model-policy"
                              ? MODEL_POLICY
                              : ADMINISTRATION,
                      )
                    }
                  />
                </section>
              ) : (
                <section className="not-found" aria-labelledby="administration-denied-title">
                  <h2 className="not-found__title" id="administration-denied-title">
                    Administration is unavailable
                  </h2>
                  <p className="not-found__copy" role="status">
                    Your current account does not include the admin:users capability, so
                    administration is unavailable. No directory or permission data was requested.
                  </p>
                  <button type="button" className="not-found__home" onClick={() => guardedNavigate(HOME)}>
                    Back to overview
                  </button>
                </section>
              )
            ) : null}
          </>
        )}
      </main>
    </div>
  );
}
