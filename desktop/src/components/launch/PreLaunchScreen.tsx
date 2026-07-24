/**
 * Real pre-launch before main chrome (#394 / #395).
 * Steps: Workspace → AI → Ready (work-context status).
 * Wide layout + explicit primary CTAs; auto gateway check when configured.
 */
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import {
  hostEnsureDefaultWorkspace,
  hostListLocalCandidates,
  hostSuggestDefaultWorkspace,
  hostSetWorkspace,
  type DefaultWorkspaceDto,
  type LocalCandidateDto,
} from "../../lib/host";
import type { AppSetupState, PreflightReport } from "../../lib/preflight";
import {
  AiSetupWizard,
  type WizardApplyPayload,
} from "../settings/AiSetupWizard";
import { ContextDeskMark } from "./ContextDeskMark";
import {
  WizardStepIndicator,
  type LaunchStepId,
} from "./WizardStepIndicator";
import { WorkContextPills } from "./WorkContextPills";
import "./launch.css";

type Props = {
  productName: string;
  tagline: string;
  setup: AppSetupState;
  preflight: PreflightReport;
  onSaveSetup: (next: AppSetupState) => void;
  onApplyAi: (payload: WizardApplyPayload) => void | Promise<void>;
  onRecheck: () => void | Promise<void>;
  onEnterApp: () => void;
  onOpenSettings?: (section?: string) => void;
};

function statusGlyph(level: string): string {
  if (level === "pass") return "●";
  if (level === "warn") return "!";
  if (level === "off") return "○";
  return "×";
}

export function PreLaunchScreen({
  productName,
  tagline,
  setup,
  preflight,
  onSaveSetup,
  onApplyAi,
  onRecheck,
  onEnterApp,
  onOpenSettings,
}: Props) {
  const baseId = useId();
  const [step, setStep] = useState<LaunchStepId>("workspace");
  const [completed, setCompleted] = useState<LaunchStepId[]>([]);
  const [defaultWs, setDefaultWs] = useState<DefaultWorkspaceDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [draft, setDraft] = useState<AppSetupState>(setup);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [candidates, setCandidates] = useState<LocalCandidateDto[]>([]);

  useEffect(() => {
    setDraft(setup);
  }, [setup]);

  useEffect(() => {
    void hostListLocalCandidates().then((c) => {
      if (c) setCandidates(c);
    });
  }, []);

  const canEnter = !preflight.hasBlocking;

  useEffect(() => {
    void hostSuggestDefaultWorkspace().then((d) => {
      if (d) setDefaultWs(d);
    });
  }, []);

  // Advance past workspace if already configured
  useEffect(() => {
    if (
      setup.workspaceRoots.length > 0 &&
      setup.workspaceName &&
      step === "workspace"
    ) {
      setCompleted((c) => (c.includes("workspace") ? c : [...c, "workspace"]));
    }
  }, [setup.workspaceRoots, setup.workspaceName, step]);

  // Auto-skip to AI when workspace is already set (clear path through setup).
  useEffect(() => {
    if (
      step === "workspace" &&
      setup.workspaceRoots.length > 0 &&
      setup.workspaceName
    ) {
      // Stay on workspace only if user hasn't completed it yet — still show
      // Continue; do not force-skip so they can re-confirm path.
    }
  }, [step, setup.workspaceRoots.length, setup.workspaceName]);

  const markDone = useCallback((s: LaunchStepId) => {
    setCompleted((c) => (c.includes(s) ? c : [...c, s]));
  }, []);

  const acceptDefault = async () => {
    setBusy(true);
    setNote(null);
    try {
      const ensured = await hostEnsureDefaultWorkspace();
      const path = ensured?.path ?? defaultWs?.path;
      if (!path) {
        setNote("Could not create default workspace folder.");
        return;
      }
      await hostSetWorkspace("Workspace", [path]);
      onSaveSetup({
        ...setup,
        workspaceName: "Workspace",
        workspaceRoots: [path],
      });
      markDone("workspace");
      setStep("ai");
      await onRecheck();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const goAi = () => {
    markDone("workspace");
    setStep("ai");
  };

  const goReady = () => {
    markDone("ai");
    setStep("ready");
    void onRecheck();
  };

  const launchCritical = useMemo(
    () =>
      preflight.items.filter(
        (i) =>
          i.level === "fail" ||
          i.id.startsWith("provider.") ||
          i.id.startsWith("workspace.") ||
          i.id.startsWith("app."),
      ),
    [preflight.items],
  );

  const hasWorkspace = setup.workspaceRoots.length > 0;
  const hasAi =
    setup.providerKind !== "none" && Boolean(setup.chatModel?.trim());

  const asideCopy =
    step === "workspace"
      ? {
          title: "Workspace folder",
          body: "Allowlist a folder for files and project memory. Use the OS default under Documents, or continue if you already set one.",
          next: hasWorkspace
            ? "Primary action: Continue to AI setup"
            : "Primary action: Use default folder",
        }
      : step === "ai"
        ? {
            title: "AI provider",
            body: "If a gateway or Ollama is already configured, we check it automatically. Confirm the model, then continue.",
            next: hasAi
              ? "Primary action: Continue to Ready"
              : "Primary action: Discover / Apply & Save in the panel, then Continue",
          }
        : {
            title: "Ready to enter",
            body: "Launch-critical checks must pass. Work-context rows are informational — warnings do not block Enter.",
            next: canEnter
              ? "Primary action: Enter app"
              : "Fix launch-critical failures (workspace + AI), then Enter app",
          };

  return (
    <div className="launch-root">
      <div className="launch-shell">
        <div className="launch-shell__brand">
          <ContextDeskMark size={48} />
          <div>
            <h1>{productName}</h1>
            <p className="launch-shell__sub">{tagline}</p>
          </div>
        </div>

        <WizardStepIndicator active={step} completed={completed} />

        <div className="launch-body">
          <aside className="launch-aside">
            <div className="launch-aside__copy">
              <h2>{asideCopy.title}</h2>
              <p>{asideCopy.body}</p>
            </div>
            <p className="launch-next-hint" role="status">
              <strong>What to press:</strong> {asideCopy.next}
            </p>
          </aside>

          <div className="launch-panel">
            {step === "workspace" ? (
              <>
                {hasWorkspace ? (
                  <p>
                    Current: <strong>{setup.workspaceName}</strong> —{" "}
                    {setup.workspaceRoots.length} root(s).
                  </p>
                ) : (
                  <p>
                    No workspace yet. Use the default folder or configure one in
                    Settings later.
                  </p>
                )}
                {defaultWs?.path ? (
                  <p className="launch-shell__sub">Suggested: {defaultWs.path}</p>
                ) : null}
                {note ? (
                  <div className="callout callout--warn" role="alert">
                    {note}
                  </div>
                ) : null}
                <div className="launch-cta">
                  {hasWorkspace ? (
                    <button
                      type="button"
                      className="btn btn--primary launch-cta__primary"
                      onClick={goAi}
                    >
                      Continue to AI setup →
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn--primary launch-cta__primary"
                      disabled={busy}
                      onClick={() => void acceptDefault()}
                    >
                      {busy ? "Creating…" : "Use default folder"}
                    </button>
                  )}
                  {hasWorkspace ? (
                    <button
                      type="button"
                      className="btn btn--ghost launch-cta__secondary"
                      disabled={busy}
                      onClick={() => void acceptDefault()}
                    >
                      Reset to default folder
                    </button>
                  ) : null}
                  <p className="launch-cta__hint">
                    {hasWorkspace
                      ? "You already have a workspace — press Continue."
                      : "One click creates the suggested folder and moves on."}
                  </p>
                </div>
              </>
            ) : null}

            {step === "ai" ? (
              <>
                <AiSetupWizard
                  baseId={`${baseId}-ai`}
                  draft={draft}
                  setDraft={setDraft}
                  apiKeyDraft={apiKeyDraft}
                  setApiKeyDraft={setApiKeyDraft}
                  candidates={candidates}
                  autoDiscover
                  onApplyAndSave={async (payload) => {
                    await onApplyAi(payload);
                    markDone("ai");
                    setStep("ready");
                    await onRecheck();
                  }}
                />
                <div className="launch-cta">
                  <button
                    type="button"
                    className="btn btn--ghost launch-cta__secondary"
                    onClick={() => setStep("workspace")}
                  >
                    ← Back
                  </button>
                  {hasAi || draft.providerKind !== "none" ? (
                    <button
                      type="button"
                      className="btn btn--primary launch-cta__primary"
                      onClick={goReady}
                    >
                      Continue to Ready →
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn--primary launch-cta__primary"
                      disabled
                      title="Discover and apply a provider first"
                    >
                      Continue to Ready →
                    </button>
                  )}
                  <p className="launch-cta__hint">
                    {hasAi
                      ? "Provider looks configured — Continue checks status on Ready."
                      : "Use Discover / Apply & Save above, or Continue after a model is set."}
                  </p>
                </div>
              </>
            ) : null}

            {step === "ready" ? (
              <>
                <p className="launch-section-title">Launch-critical</p>
                <ul
                  className="launch-status-grid"
                  aria-label="Launch-critical checks"
                >
                  {launchCritical
                    .filter(
                      (i) =>
                        !i.id.startsWith("confluence.") &&
                        !i.id.startsWith("connector.") &&
                        i.id !== "memory.store",
                    )
                    .slice(0, 8)
                    .map((i) => (
                      <li key={i.id} data-level={i.level}>
                        <span className="launch-pills__status" aria-hidden>
                          {statusGlyph(i.level)}
                        </span>
                        <div className="launch-pills__body">
                          <div className="launch-pills__title">{i.title}</div>
                          <div className="launch-pills__detail">{i.detail}</div>
                        </div>
                      </li>
                    ))}
                </ul>

                <p className="launch-section-title">Work context</p>
                <WorkContextPills
                  items={preflight.items}
                  onFix={(sec) => onOpenSettings?.(sec ?? "connectors")}
                  layout="grid"
                />

                <div className="launch-cta">
                  <button
                    type="button"
                    className="btn btn--ghost launch-cta__secondary"
                    onClick={() => setStep("ai")}
                  >
                    ← Back
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost launch-cta__secondary"
                    onClick={() => void onRecheck()}
                  >
                    Recheck
                  </button>
                  <button
                    type="button"
                    className="btn btn--primary launch-cta__primary"
                    disabled={!canEnter}
                    onClick={onEnterApp}
                  >
                    Enter app
                  </button>
                  <p className="launch-cta__hint">
                    {canEnter
                      ? "All clear — press Enter app to open the main workspace."
                      : "Fix red launch-critical items (workspace + AI), then Enter app enables."}
                  </p>
                </div>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
