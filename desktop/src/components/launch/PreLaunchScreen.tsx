/**
 * Real pre-launch before main chrome (#394 / #395).
 * Steps: Workspace → AI → Ready (work-context pills).
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

        {step === "workspace" ? (
          <div className="launch-card">
            <h2>Workspace folder</h2>
            <p>
              Allowlist a folder for files and project memory. You can use the
              OS default under Documents, or pick folders later in Settings.
            </p>
            {setup.workspaceRoots.length > 0 ? (
              <p>
                Current: <strong>{setup.workspaceName}</strong> —{" "}
                {setup.workspaceRoots.length} root(s).
              </p>
            ) : null}
            {defaultWs?.path ? (
              <p className="launch-shell__sub">Suggested: {defaultWs.path}</p>
            ) : null}
            {note ? (
              <div className="callout callout--warn" role="alert">
                {note}
              </div>
            ) : null}
            <div className="launch-card__actions">
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy}
                onClick={() => void acceptDefault()}
              >
                Use default folder
              </button>
              {setup.workspaceRoots.length > 0 ? (
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => {
                    markDone("workspace");
                    setStep("ai");
                  }}
                >
                  Continue
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {step === "ai" ? (
          <div className="launch-card">
            <h2>AI provider</h2>
            <p>
              Local Ollama is enough for open-source first launch. Grok Build
              session and gateways are optional.
            </p>
            <AiSetupWizard
              baseId={`${baseId}-ai`}
              draft={draft}
              setDraft={setDraft}
              apiKeyDraft={apiKeyDraft}
              setApiKeyDraft={setApiKeyDraft}
              candidates={candidates}
              onApplyAndSave={async (payload) => {
                await onApplyAi(payload);
                markDone("ai");
                setStep("ready");
                await onRecheck();
              }}
            />
            <div className="launch-card__actions">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setStep("workspace")}
              >
                Back
              </button>
              {setup.providerKind !== "none" && setup.chatModel ? (
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => {
                    markDone("ai");
                    setStep("ready");
                    void onRecheck();
                  }}
                >
                  Skip to ready
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {step === "ready" ? (
          <div className="launch-card">
            <h2>Ready</h2>
            <p>
              Launch-critical checks must pass. Work context (files, memory,
              databases, Confluence, MCP) shows status — warnings do not block
              Enter.
            </p>

            <p className="launch-section-title">Launch-critical</p>
            <ul className="launch-pills" aria-label="Launch-critical">
              {launchCritical
                .filter(
                  (i) =>
                    !i.id.startsWith("confluence.") &&
                    !i.id.startsWith("connector.") &&
                    i.id !== "memory.store",
                )
                .slice(0, 8)
                .map((i) => (
                  <li
                    key={i.id}
                    className="launch-pills__item"
                    data-level={i.level}
                  >
                    <span className="launch-pills__status">
                      {i.level === "pass" ? "●" : i.level === "fail" ? "×" : "!"}
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
            />

            <div className="launch-card__actions">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setStep("ai")}
              >
                Back
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => void onRecheck()}
              >
                Recheck
              </button>
              <button
                type="button"
                className="btn btn--primary"
                disabled={!canEnter}
                onClick={onEnterApp}
              >
                Enter app
              </button>
            </div>
            {!canEnter ? (
              <p className="launch-shell__sub">
                Fix launch-critical failures (workspace + AI) before entering.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
