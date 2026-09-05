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
  DEFAULT_COLLECTION_QUERY,
  DEFAULT_OPERATIONS_QUEUE_QUERY,
  EVIDENCE_STORAGE_ADMIN,
  HOME,
  LDAP_ADMIN,
  MODEL_POLICY,
  PEOPLE,
  PROFILE,
  SIGN_IN,
  UI_STRATEGY_POLICY,
  historyUrl,
  isLdapAdminLocation,
  isModelPolicyLocation,
  isPeopleLocation,
  isProfileLocation,
  isShellLocation,
  isSignInLocation,
  isUnknownLocation,
  isUiStrategyPolicyLocation,
  isEvidenceStorageAdminLocation,
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
import { KeystoneStrategy } from "./investigations/strategies/keystone/index.js";
import { BeaconStrategy } from "./investigations/strategies/beacon/index.js";
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
import { RuntimeHandoffPanel } from "./investigations/strategies/runtime-handoff.js";
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
import { useUiStrategyGovernance } from "./useUiStrategyGovernance.js";
import { ActivityCenter } from "./overview/ActivityCenter.js";
import { useWarRoomCollectionQuery } from "./investigations/war-room/useWarRoomCollectionQuery.js";
import { OperationsQueue } from "./operations-queue/index.js";

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
  const collection = useWarRoomCollectionQuery(
    props.focusCaseId === null ? props.collectionQuery : undefined,
  );
  if (bindings === null) return null;

  return (
    <>
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
        onCollectionRefresh={collection.refresh}
        {...(props.onFocusedCaseTitle
          ? { onFocusedCaseTitle: props.onFocusedCaseTitle }
          : {})}
        {...(props.collectionQuery === undefined
          ? {}
          : {
              collectionPage: collection.view,
              collectionQuery: props.collectionQuery,
              onCollectionQueryChange: props.onCollectionQueryChange,
              onCollectionNextPage: collection.nextPage,
            })}
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
      {props.focusCaseId !== null && runtime.resources.investigation.status === "ready" ? (
        <div className="war-room-handoff-bridge">
          <RuntimeHandoffPanel investigation={runtime.resources.investigation.value} />
        </div>
      ) : null}
    </>
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
  "keystone": {
    id: "keystone",
    presentationContract: INVESTIGATION_STRATEGY_PRESENTATION_CONTRACT,
    component: KeystoneStrategy,
  },
  "beacon": {
    id: "beacon",
    presentationContract: INVESTIGATION_STRATEGY_PRESENTATION_CONTRACT,
    component: BeaconStrategy,
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

declare global {
  interface Window {
    __CONTEXTDESK_STATIC_READ_ONLY__?: boolean;
  }
}

const PRIMARY_NAV: readonly { area: AreaId; label: string }[] = [
  { area: "overview", label: "Overview" },
  { area: "investigations", label: "Investigations" },
  { area: "operations", label: "Operations" },
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
  strategyOptions: readonly UiStrategyDescriptor[];
  strategyStatus: "idle" | "loading" | "ready" | "saving" | "unavailable" | "conflict";
  strategyMessage: string;
  temporaryStrategy: UiStrategyDescriptor | null;
  onStrategyChange: (strategy: UiStrategyId) => Promise<boolean>;
  onRefreshStrategies: () => void;
  onSignOut: (() => void) | null;
}) {
  const [open, setOpen] = useState(false);
  const [draftStrategyId, setDraftStrategyId] = useState<UiStrategyId>(props.strategy.id);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const strategySaveAttemptRef = useRef(0);
  const strategySaveOwnsFocusRef = useRef(false);

  function closeMenu() {
    strategySaveOwnsFocusRef.current = false;
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) closeMenu();
    };
    const onFocusIn = (event: FocusEvent) => {
      if (
        strategySaveOwnsFocusRef.current
        && event.target !== document.body
      ) {
        strategySaveOwnsFocusRef.current = false;
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [open]);

  useEffect(() => {
    const draftIsSelectable = props.strategyOptions.some(({ id }) => id === draftStrategyId);
    if (!open || !draftIsSelectable) setDraftStrategyId(props.strategy.id);
  }, [draftStrategyId, open, props.strategy.id, props.strategyOptions]);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape" && open) {
      event.stopPropagation();
      closeMenu();
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
        onClick={() => setOpen((current) => {
          if (current) strategySaveOwnsFocusRef.current = false;
          return !current;
        })}
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
              closeMenu();
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
              history stay shared. This choice applies inside Investigations; Overview remains the
              War Room activity dashboard.
            </p>
            {props.temporaryStrategy ? (
              <p className="account__strategy-note" role="status">
                Temporarily using {props.temporaryStrategy.name} for this history entry. Your saved
                preference remains {props.strategy.name}.
              </p>
            ) : null}
            {props.strategyOptions.map((strategy) => (
              <label key={strategy.id} className="account__strategy-option">
                <input
                  type="radio"
                  name="ui-strategy"
                  value={strategy.id}
                  checked={draftStrategyId === strategy.id}
                  disabled={props.strategyStatus === "saving"}
                  onChange={() => setDraftStrategyId(strategy.id)}
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
            {props.strategyOptions.length === 0 ? (
              <p className="account__strategy-note">
                Personal selection is not available under the current workspace policy.
              </p>
            ) : (
              <button
                type="button"
                disabled={draftStrategyId === props.strategy.id || props.strategyStatus !== "ready"}
                onClick={() => {
                  const attempt = ++strategySaveAttemptRef.current;
                  strategySaveOwnsFocusRef.current = true;
                  void props.onStrategyChange(draftStrategyId).then(() => {
                    // Saving disables this button while it owns focus. Move
                    // focus deliberately instead of allowing the browser to
                    // drop it to <body>. If the user dismissed the chooser or
                    // moved elsewhere while the request was pending, preserve
                    // that newer focus intent instead.
                    if (
                      strategySaveAttemptRef.current !== attempt
                      || !strategySaveOwnsFocusRef.current
                    ) return;
                    triggerRef.current?.focus();
                  });
                }}
              >
                {props.strategyStatus === "saving" ? "Saving…" : "Use selected experience"}
              </button>
            )}
            {props.strategyMessage ? (
              <p
                className="account__strategy-note"
                role={props.strategyStatus === "unavailable" || props.strategyStatus === "conflict" ? "alert" : "status"}
              >
                {props.strategyMessage}
                {props.strategyStatus === "conflict" || props.strategyStatus === "unavailable" ? (
                  <> <button type="button" onClick={props.onRefreshStrategies}>Refresh policy</button></>
                ) : null}
              </p>
            ) : null}
          </fieldset>
          {props.onSignOut ? (
            <button
              className="account__signout"
              type="button"
              onClick={() => {
                closeMenu();
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
  const [transientUiStrategyId, setTransientUiStrategyId] = useState<UiStrategyId | null>(() =>
    historyUiStrategyId(window.history.state),
  );
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
  const strategyGovernance = useUiStrategyGovernance({
    identityId: session?.identityId ?? null,
    authorityGeneration: session?.authorityGeneration ?? 0,
    enabled: ready && session !== null && !staticReadOnly,
  });
  const preferredUiStrategy = resolveUiStrategy({
    preferred: strategyGovernance.effective.effectiveId,
    instanceDefault: strategyGovernance.effective.defaultId,
    allowedIds: strategyGovernance.effective.enabledIds,
  });
  const uiStrategy = transientUiStrategyId
    ? resolveUiStrategy({
        preferred: transientUiStrategyId,
        instanceDefault: preferredUiStrategy.id,
        allowedIds: transientUiStrategyId === DEFAULT_UI_STRATEGY_ID
          ? [DEFAULT_UI_STRATEGY_ID]
          : strategyGovernance.effective.enabledIds,
      })
    : preferredUiStrategy;
  // UI strategies are alternate investigation workspaces, not shell themes.
  // Overview and the rest of the application keep the canonical War Room
  // identity and dashboard even when the user prefers another investigation
  // strategy. This prevents a saved investigation preference from replacing
  // Overview with a second copy of the Investigations surface.
  const surfaceStrategy =
    isWorkLocation(location) && location.area === "investigations"
      ? uiStrategy
      : resolveUiStrategy({ preferred: DEFAULT_UI_STRATEGY_ID });

  useEffect(() => {
    document.title = titleFor(location, focusedCaseTitle, {
      surfaceName: surfaceStrategy.name,
      includeInvestigationStage: surfaceStrategy.id === DEFAULT_UI_STRATEGY_ID,
    });
  }, [location, focusedCaseTitle, surfaceStrategy.id, surfaceStrategy.name]);

  useEffect(() => {
    const invalidate = () => {
      const current = locationRef.current;
      restoreRef.current = isWorkLocation(current) ? current : null;
      setFocusedCaseTitle(null);
      setTransientUiStrategyId(null);
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

  const refresh = useCallback(async () => {
    const res = await fetch("/api/auth/me");
    if (res.status === 503) {
      setTransientUiStrategyId(null);
      setSession(null);
      setSessionIssue(
        "Your sign-in is valid, but the directory is temporarily unavailable. Try again when the directory connection is restored.",
      );
      setReady(true);
      return;
    }
    if (!res.ok) {
      setTransientUiStrategyId(null);
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
    const identityId = body.identity?.id?.trim() || username;
    if (sessionRef.current && sessionRef.current.identityId !== identityId) {
      setTransientUiStrategyId(null);
    }
    authorityGenerationRef.current += 1;
    setSession({
      identityId,
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
    historyStrategyId: UiStrategyId | null | undefined = transientUiStrategyId ?? undefined,
  ) => {
    const investigationStrategyId = isWorkLocation(next) && next.area === "investigations"
      ? historyStrategyId ?? undefined
      : undefined;
    if (investigationStrategyId === undefined) setTransientUiStrategyId(null);
    setLocation((current) => {
      if (sameLocation(current, next)) {
        return current;
      }
      return next;
    });
    setNavOpen(false);
    writeHistory(next, mode, investigationStrategyId);
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
      setTransientUiStrategyId(
        isWorkLocation(next) && next.area === "investigations" ? historyStrategyId : null,
      );
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

  useEffect(() => {
    if (!session || staticReadOnly || !isWorkLocation(location) || location.area !== "administration") return;
    const capabilities = sessionCapabilities(session);
    const canUsers = hasCapability(capabilities, "admin:users");
    const canSystem = hasCapability(capabilities, "admin:system_config");
    const systemTab = isModelPolicyLocation(location) || isUiStrategyPolicyLocation(location) || isEvidenceStorageAdminLocation(location);
    const target = systemTab && !canSystem && canUsers
      ? ADMINISTRATION
      : !systemTab && !canUsers && canSystem
        ? UI_STRATEGY_POLICY
        : null;
    if (target) {
      setLocation(target);
      writeHistory(target, "replace");
    }
  }, [location, session, staticReadOnly]);

  function logout() {
    restoreRef.current = null;
    setTransientUiStrategyId(null);
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
    const navigationCapabilities = session ? sessionCapabilities(session) : [];
    if (
      area === "administration"
      && !staticReadOnly
      && !hasCapability(navigationCapabilities, "admin:users")
      && hasCapability(navigationCapabilities, "admin:system_config")
    ) {
      guardedNavigate(UI_STRATEGY_POLICY);
      return;
    }
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
  const canReadInvestigations = hasCapability(capabilities, "investigation:read");
  const canWrite = !staticReadOnly && hasCapability(capabilities, "investigation:write");
  const canLeadCatalog =
    !staticReadOnly &&
    (hasCapability(capabilities, "run:strategies") ||
      hasCapability(capabilities, "admin:system_config"));
  const canAdminUsers = !staticReadOnly && hasCapability(capabilities, "admin:users");
  const canAdminSystem = !staticReadOnly && hasCapability(capabilities, "admin:system_config");
  const canAdmin = canAdminUsers || canAdminSystem;
  const work: WorkLocation = isWorkLocation(location) ? location : HOME;
  const inInvestigationsArea = work.area === "investigations";
  const inOperationsArea = work.area === "operations";
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

  const requestedAdminTab = isPeopleLocation(work)
    ? "people"
    : isLdapAdminLocation(work)
      ? "ldap"
      : isModelPolicyLocation(work)
        ? "model-policy"
        : isUiStrategyPolicyLocation(work)
          ? "ui-strategies"
          : isEvidenceStorageAdminLocation(work)
            ? "storage"
            : "roles";
  const authorizedAdminTab = canAdminUsers && canAdminSystem
    ? requestedAdminTab
    : canAdminUsers
      ? (requestedAdminTab === "model-policy" || requestedAdminTab === "ui-strategies" || requestedAdminTab === "storage" ? "roles" : requestedAdminTab)
      : (requestedAdminTab === "roles" || requestedAdminTab === "people" || requestedAdminTab === "ldap" ? "ui-strategies" : requestedAdminTab);

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
            <span className="topbar__title-app">{surfaceStrategy.name}</span>
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
              strategyOptions={UI_STRATEGIES.filter((strategy) =>
                strategyGovernance.effective.selectableIds.includes(strategy.id))}
              strategyStatus={strategyGovernance.status}
              strategyMessage={strategyGovernance.message}
              temporaryStrategy={transientUiStrategyId ? uiStrategy : null}
              profileActive={work.area === "profile"}
              onOpenProfile={() => guardedNavigate(PROFILE)}
              onThemeChange={setTheme}
              onStrategyChange={async (strategyId) => {
                const saved = await strategyGovernance.savePreference(strategyId);
                if (saved) {
                  setTransientUiStrategyId(null);
                  writeHistory(locationRef.current, "replace");
                }
                return saved;
              }}
              onRefreshStrategies={strategyGovernance.refresh}
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
            <section className="app__area" aria-label="Overview" hidden={work.area !== "overview"}>
              {work.area === "overview" ? (
                <ActivityCenter
                  canRead={canReadInvestigations}
                  identityKey={session.identityId}
                  authorityKey={investigationAuthorityKey(session, staticReadOnly)}
                  onOpenInvestigations={() =>
                    navigate({ area: "investigations", caseId: null, stage: "situation" })}
                  onOpenRoute={(pathname) => {
                    const url = new URL(pathname, window.location.origin);
                    const destination = parsePathname(url.pathname, url.search, url.hash);
                    if (isWorkLocation(destination) && destination.area === "investigations") {
                      navigate(destination);
                    }
                  }}
                />
              ) : null}
            </section>
            <section className="app__area" aria-label="Operations" hidden={!inOperationsArea}>
              {inOperationsArea ? (
                <InvestigationRuntimeProvider
                  identityKey={session.identityId}
                  identity={{
                    id: session.identityId,
                    username: session.username,
                    displayName: session.displayName,
                  }}
                  authorityKey={investigationAuthorityKey(session, staticReadOnly)}
                  capabilities={capabilities}
                  readOnly={staticReadOnly}
                  active={false}
                  focusCaseId={null}
                  isInvestigationLocation={false}
                  onOpenCreated={openCreatedInvestigation}
                >
                  <OperationsQueue
                    query={work.operationsQueueQuery ?? DEFAULT_OPERATIONS_QUEUE_QUERY}
                    onQueryChange={(operationsQueueQuery) => navigate({
                      area: "operations",
                      caseId: null,
                      stage: "situation",
                      operationsQueueQuery,
                    }, "replace")}
                    onOpenInvestigation={(caseId) => navigate({
                      area: "investigations",
                      caseId,
                      stage: "situation",
                    }, "push", null)}
                  />
                </InvestigationRuntimeProvider>
              ) : null}
            </section>
            <section className="app__area" aria-label="Investigations" hidden={!inInvestigationsArea}>
              {inInvestigationsArea ? <InvestigationRuntimeProvider
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
                active
                focusCaseId={work.caseId}
                isInvestigationLocation
                onOpenCreated={openCreatedInvestigation}
              >
                {!canReadInvestigations && surfaceStrategy.id === DEFAULT_UI_STRATEGY_ID ? (
                  <section className="not-found" aria-labelledby="investigations-read-denied-title">
                    <h2 className="not-found__title" id="investigations-read-denied-title">
                      Investigations unavailable in this view
                    </h2>
                    <p className="not-found__copy" role="status">
                      Your current account cannot read investigations, so no investigation or
                      evidence data was requested.
                    </p>
                  </section>
                ) : (
                  <WarRoomStrategyContext.Provider value={warRoomBindings}>
                    <InvestigationStrategyRenderer
                      strategy={surfaceStrategy}
                      registrations={INVESTIGATION_STRATEGY_REGISTRATIONS}
                      view="investigations"
                      focusCaseId={work.caseId}
                      stage={work.stage}
                      {...(work.focus ? { focus: work.focus } : {})}
                      startSignal={startSignal}
                      onOpenCase={(id) =>
                        navigate({ area: "investigations", caseId: id, stage: "situation" })
                      }
                      onNavigateInvestigation={({ investigationId, stage, focus }) =>
                        navigate({
                          area: "investigations",
                          caseId: investigationId,
                          stage,
                          ...(focus ? { focus } : {}),
                        })
                      }
                      onExitFocus={() =>
                        navigate({ area: "investigations", caseId: null, stage: "situation" })
                      }
                      {...(work.caseId === null
                        ? {
                            collectionQuery: work.collectionQuery ?? DEFAULT_COLLECTION_QUERY,
                            onCollectionQueryChange: (collectionQuery) =>
                              navigate({
                                area: "investigations",
                                caseId: null,
                                stage: "situation",
                                collectionQuery,
                              }, "replace"),
                          }
                        : {})}
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
                )}
              </InvestigationRuntimeProvider> : null}
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
                    canManageUsers={canAdminUsers}
                    canManageSystem={canAdminSystem}
                    tab={authorizedAdminTab}
                    onSelectTab={(tab) =>
                      guardedNavigate(
                        tab === "people"
                          ? PEOPLE
                          : tab === "ldap"
                            ? LDAP_ADMIN
                            : tab === "model-policy"
                              ? MODEL_POLICY
                              : tab === "ui-strategies"
                                ? UI_STRATEGY_POLICY
                                : tab === "storage"
                                  ? EVIDENCE_STORAGE_ADMIN
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
                    Your current account does not include an administration capability, so
                    administration is unavailable. No directory, permission, or policy data was requested.
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
