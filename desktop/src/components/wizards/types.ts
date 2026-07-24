/**
 * Session process wizard types (#442 / #444).
 * Declarative catalog + multi-step shell — optional, never blocks New chat.
 */

export type WizardStepId = string;

export type WizardStepBody =
  | "info"
  | "path_pick"
  | "mode_select"
  | "confirm_softwrite"
  | "run_progress"
  | "ready"
  | "custom";

export type WizardStepDef = {
  id: WizardStepId;
  title: string;
  /** Stage SVG key from StageArt. */
  stageSvgId?: string;
  /** Help page id when Help Center is present (#434 / #449). */
  helpPageId?: string;
  body: WizardStepBody;
  /** When true, Skip is offered on this step. */
  allowSkip?: boolean;
};

export type WizardDef = {
  id: string;
  title: string;
  description: string;
  /** Catalog thumbnail SVG key. */
  thumbnailSvgId?: string;
  helpPageId?: string;
  /** Skill to pin on success (never elevates write tiers). */
  skillPinId?: string | null;
  steps: WizardStepDef[];
};

export type ProcessProgressKind = "log_ingest" | "session_context_import";

export type ProcessProgressPhase =
  | "starting"
  | "scan"
  | "parse"
  | "template"
  | "redact"
  | "store"
  | "embed"
  | "read"
  | "validate"
  | "extract"
  | "write"
  | "completed"
  | "failed"
  | "cancelled";

/** Mirrors cd_core::process_progress::ProcessProgress wire shape. */
export type ProcessProgressDto = {
  kind: ProcessProgressKind;
  phase: ProcessProgressPhase;
  message: string;
  fraction: number | null;
  lines_processed: number | null;
  files_processed: number | null;
  bytes_processed: number | null;
  templates: number | null;
  cancellable: boolean;
};

export type WizardOutcome = {
  wizardId: string;
  /** Seed composer with this text when non-null. */
  composerSeed: string | null;
  skillPinId: string | null;
  corpusId: string | null;
  sessionId: string | null;
  /** Optional pane to open after close. */
  openPane?: "logs" | "memory" | "chat" | "help";
  /** Optional help page deep link. */
  helpPageId?: string | null;
};

/** Pure navigation state for unit tests (#444). */
export type WizardNavState = {
  stepIndex: number;
  stepCount: number;
  cancelled: boolean;
  completed: boolean;
};

export function createWizardNav(stepCount: number): WizardNavState {
  return { stepIndex: 0, stepCount, cancelled: false, completed: false };
}

export function wizardNavContinue(state: WizardNavState): WizardNavState {
  if (state.cancelled || state.completed) return state;
  if (state.stepIndex >= state.stepCount - 1) {
    return { ...state, completed: true };
  }
  return { ...state, stepIndex: state.stepIndex + 1 };
}

export function wizardNavBack(state: WizardNavState): WizardNavState {
  if (state.cancelled || state.completed) return state;
  if (state.stepIndex <= 0) return state;
  return { ...state, stepIndex: state.stepIndex - 1 };
}

export function wizardNavSkip(state: WizardNavState): WizardNavState {
  return wizardNavContinue(state);
}

export function wizardNavCancel(state: WizardNavState): WizardNavState {
  return { ...state, cancelled: true };
}

/** Log ingest pipeline phase order for ProcessProgressPanel. */
export const LOG_INGEST_PIPELINE: ProcessProgressPhase[] = [
  "scan",
  "parse",
  "template",
  "redact",
  "store",
  "embed",
];

export const SESSION_IMPORT_PIPELINE: ProcessProgressPhase[] = [
  "read",
  "validate",
  "extract",
  "write",
];

export function phaseLabel(phase: ProcessProgressPhase): string {
  const map: Record<ProcessProgressPhase, string> = {
    starting: "Starting",
    scan: "Scan",
    parse: "Parse",
    template: "Template",
    redact: "Redact",
    store: "Store",
    embed: "Embed",
    read: "Read",
    validate: "Validate",
    extract: "Extract",
    write: "Write",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
  };
  return map[phase] ?? phase;
}
