import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type {
  CaseV1,
  CommandIgnoredReason,
  CommandOutcome,
  InvestigationSituationCommand,
  MutationState,
} from "../../runtime/public.js";

type InvestigationContext = NonNullable<CaseV1["investigationContext"]>;
type InvestigationContextField = keyof InvestigationContext;
type RuntimeFailure = Extract<CommandOutcome<never>, { status: "failed" }>["error"];
type UpdateSituation = (
  command: InvestigationSituationCommand,
) => Promise<CommandOutcome<CaseV1>>;

export interface KeystoneSituationEditorProps {
  /**
   * The shell-owned identity fence for browser-local draft state. It is opaque
   * and descriptive only; the presence or value of this key never grants edit
   * authority.
   */
  readonly identityKey: string;
  /** The latest canonical case published to this presentation. */
  readonly investigation: CaseV1;
  /** Null is the complete, fail-closed read-only presentation seam. */
  readonly updateSituation: UpdateSituation | null;
  readonly mutation: MutationState<CaseV1>;
  readonly onSuccess?: (investigation: CaseV1) => void;
  readonly onCancel?: () => void;
}

interface SituationDraft {
  readonly problemStatement: string;
  readonly affectedParties: string;
  readonly impact: string;
  readonly scope: string;
  readonly openQuestions: string;
  readonly investigationContext: InvestigationContext;
}

interface EditorState {
  readonly scope: string;
  readonly editing: boolean;
  readonly draft: SituationDraft;
  readonly baseline: CaseV1;
  readonly authoritativeResult: CaseV1 | null;
  readonly attempted: boolean;
  readonly pending: boolean;
  readonly conflicted: boolean;
  readonly failure: RuntimeFailure | null;
  readonly ignored: CommandIgnoredReason | null;
}

interface SaveToken {
  readonly scope: string;
  readonly sequence: number;
}

const CONTEXT_FIELDS: readonly {
  readonly field: InvestigationContextField;
  readonly label: string;
}[] = [
  { field: "productName", label: "Product or software" },
  { field: "version", label: "Version" },
  { field: "build", label: "Build" },
  { field: "component", label: "Component" },
  { field: "environment", label: "Environment" },
  { field: "organization", label: "Customer, team, or organization" },
];

const EMPTY_CONTEXT: InvestigationContext = {
  productName: "",
  version: "",
  build: "",
  component: "",
  environment: "",
  organization: "",
};

function editorScope(
  identityKey: string,
  investigationId: string,
  writable: boolean,
): string {
  return `${identityKey.length}:${identityKey}${investigationId.length}:${investigationId}:${writable ? "write" : "read"}`;
}

function contextFor(investigation: CaseV1): InvestigationContext {
  const context = investigation.investigationContext;
  return context === null ? { ...EMPTY_CONTEXT } : { ...context };
}

function draftFor(investigation: CaseV1): SituationDraft {
  return {
    problemStatement: investigation.problemStatement,
    affectedParties: investigation.affectedParties,
    impact: investigation.impact,
    scope: investigation.scope,
    openQuestions: investigation.openQuestions.join("\n"),
    investigationContext: contextFor(investigation),
  };
}

function initialState(scope: string, investigation: CaseV1): EditorState {
  return {
    scope,
    editing: false,
    draft: draftFor(investigation),
    baseline: investigation,
    authoritativeResult: null,
    attempted: false,
    pending: false,
    conflicted: false,
    failure: null,
    ignored: null,
  };
}

function normalizedQuestions(value: string): readonly string[] {
  return value
    .split(/\r?\n/u)
    .map((question) => question.trim())
    .filter((question) => question.length > 0);
}

function normalizedContextValue(value: string): string {
  return value.trim().length === 0 ? "" : value;
}

function normalizedContext(context: InvestigationContext): InvestigationContext | null {
  const normalized: InvestigationContext = {
    productName: normalizedContextValue(context.productName),
    version: normalizedContextValue(context.version),
    build: normalizedContextValue(context.build),
    component: normalizedContextValue(context.component),
    environment: normalizedContextValue(context.environment),
    organization: normalizedContextValue(context.organization),
  };
  return Object.values(normalized).some((value) => value.length > 0) ? normalized : null;
}

function sameQuestions(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((question, index) => question === right[index]);
}

function sameContext(
  left: InvestigationContext | null,
  right: InvestigationContext | null,
): boolean {
  if (left === null || right === null) return left === right;
  return CONTEXT_FIELDS.every(({ field }) => left[field] === right[field]);
}

/**
 * Produces intent for changed Runtime fields only. In particular, empty text,
 * an empty question list, and null context remain explicit erasures rather
 * than disappearing as omitted properties.
 */
function changedSituation(
  draft: SituationDraft,
  baseline: CaseV1,
): InvestigationSituationCommand {
  const command: {
    problemStatement?: string;
    affectedParties?: string;
    impact?: string;
    scope?: string;
    openQuestions?: readonly string[];
    investigationContext?: CaseV1["investigationContext"];
  } = {};

  if (draft.problemStatement !== baseline.problemStatement) {
    command.problemStatement = draft.problemStatement;
  }
  if (draft.affectedParties !== baseline.affectedParties) {
    command.affectedParties = draft.affectedParties;
  }
  if (draft.impact !== baseline.impact) command.impact = draft.impact;
  if (draft.scope !== baseline.scope) command.scope = draft.scope;

  const questions = normalizedQuestions(draft.openQuestions);
  const seededQuestions = baseline.openQuestions.join("\n");
  if (
    draft.openQuestions !== seededQuestions
    && !sameQuestions(questions, baseline.openQuestions)
  ) {
    command.openQuestions = questions;
  }

  const context = normalizedContext(draft.investigationContext);
  const baselineContext = normalizedContext(contextFor(baseline));
  if (!sameContext(context, baselineContext)) command.investigationContext = context;

  return command;
}

function hasSituationField(
  command: InvestigationSituationCommand,
  field: keyof SituationDraft,
): boolean {
  return Object.prototype.hasOwnProperty.call(command, field);
}

function rebaseContext(
  draft: InvestigationContext,
  previousBaseline: CaseV1,
  latest: CaseV1,
): InvestigationContext {
  const previous = contextFor(previousBaseline);
  const latestContext = contextFor(latest);
  const value = (field: InvestigationContextField): string => (
    normalizedContextValue(draft[field]) !== normalizedContextValue(previous[field])
      ? draft[field]
      : latestContext[field]
  );
  return {
    productName: value("productName"),
    version: value("version"),
    build: value("build"),
    component: value("component"),
    environment: value("environment"),
    organization: value("organization"),
  };
}

/**
 * Rebase preserves actual local corrections, not the stale values that merely
 * seeded the form. Untouched fields adopt the latest canonical record so they
 * cannot be written back over somebody else's newer correction.
 */
function rebaseDraft(
  draft: SituationDraft,
  previousBaseline: CaseV1,
  latest: CaseV1,
): SituationDraft {
  const localChanges = changedSituation(draft, previousBaseline);
  const latestDraft = draftFor(latest);
  return {
    problemStatement: hasSituationField(localChanges, "problemStatement")
      ? draft.problemStatement
      : latestDraft.problemStatement,
    affectedParties: hasSituationField(localChanges, "affectedParties")
      ? draft.affectedParties
      : latestDraft.affectedParties,
    impact: hasSituationField(localChanges, "impact") ? draft.impact : latestDraft.impact,
    scope: hasSituationField(localChanges, "scope") ? draft.scope : latestDraft.scope,
    openQuestions: hasSituationField(localChanges, "openQuestions")
      ? draft.openQuestions
      : latestDraft.openQuestions,
    investigationContext: rebaseContext(
      draft.investigationContext,
      previousBaseline,
      latest,
    ),
  };
}

function recorded(value: string): string {
  return value.trim().length > 0 ? value : "Not recorded";
}

function failureCopy(error: RuntimeFailure): string {
  if (error.kind === "conflict") {
    return "The recorded situation changed before this save completed. Your draft is still here, but Save is blocked until the latest record arrives and you explicitly rebase.";
  }
  if (error.kind === "validation" || error.kind === "input") {
    return "The recorded values could not be accepted. Review the fields and try again; your draft is still here.";
  }
  if (error.kind === "auth_lost") {
    return "Your access changed before this save completed. Nothing from this draft is shown as recorded.";
  }
  if (error.kind === "not_found") {
    return "This investigation is no longer available in the current scope. Nothing from this draft is shown as recorded.";
  }
  if (error.kind === "aborted") {
    return "The save did not complete. Your draft is still here.";
  }
  if (
    error.kind === "network"
    || error.kind === "unavailable"
    || error.kind === "server_failure"
  ) {
    return "The situation could not be saved right now. Your draft is still here; try again when the service is available.";
  }
  return "The situation could not be saved safely. Your draft is still here.";
}

function ignoredCopy(reason: CommandIgnoredReason): string {
  if (reason === "busy") return "A situation save is already in progress.";
  if (reason === "stale") {
    return "The case or signed-in identity changed before this save completed. The result was not applied to this editor.";
  }
  return "Situation editing is no longer available in this view. Your draft has not been shown as recorded.";
}

function recordFor(state: EditorState, investigation: CaseV1): CaseV1 {
  const result = state.authoritativeResult;
  return result !== null
    && result.id === investigation.id
    && result.situationVersion >= investigation.situationVersion
      ? result
      : investigation;
}

function SituationRecord({ investigation }: { readonly investigation: CaseV1 }) {
  const context = investigation.investigationContext;
  return (
    <dl className="keystone-situation-editor__record">
      <div><dt>Problem statement</dt><dd>{recorded(investigation.problemStatement)}</dd></div>
      <div><dt>Affected people or systems</dt><dd>{recorded(investigation.affectedParties)}</dd></div>
      <div><dt>Impact</dt><dd>{recorded(investigation.impact)}</dd></div>
      <div><dt>Scope</dt><dd>{recorded(investigation.scope)}</dd></div>
      <div>
        <dt>Open questions</dt>
        <dd>
          {investigation.openQuestions.length > 0
            ? (
                <ul>
                  {investigation.openQuestions.map((question, index) => (
                    <li key={`${index}:${question}`}>{question}</li>
                  ))}
                </ul>
              )
            : "None recorded"}
        </dd>
      </div>
      <div>
        <dt>Structured investigation context</dt>
        <dd>
          <dl className="keystone-situation-editor__context-record">
            {CONTEXT_FIELDS.map(({ field, label }) => (
              <div key={field}><dt>{label}</dt><dd>{recorded(context?.[field] ?? "")}</dd></div>
            ))}
          </dl>
        </dd>
      </div>
    </dl>
  );
}

/**
 * Keystone K2's bounded correction surface. It has no runtime context or
 * transport access: the controller-owned command is its only write seam.
 */
export function KeystoneSituationEditor({
  identityKey,
  investigation,
  updateSituation,
  mutation,
  onSuccess,
  onCancel,
}: KeystoneSituationEditorProps) {
  const headingId = useId();
  const editHeadingId = useId();
  const questionsHintId = useId();
  const latestRecordHeadingId = useId();
  const scope = editorScope(identityKey, investigation.id, updateSituation !== null);
  const [storedState, setStoredState] = useState(() => initialState(scope, investigation));
  const activeSaveRef = useRef<SaveToken | null>(null);
  const saveSequenceRef = useRef(0);
  const currentScopeRef = useRef<string | null>(scope);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const firstFieldRef = useRef<HTMLTextAreaElement>(null);
  const returnFocusRef = useRef(false);
  currentScopeRef.current = scope;

  // The render-time fallback is the privacy fence: a case or identity change
  // renders the new authoritative record immediately, before this layout
  // effect commits a fresh local state object.
  const state = storedState.scope === scope
    ? storedState
    : initialState(scope, investigation);
  const authoritativeRecord = recordFor(state, investigation);
  const command = changedSituation(state.draft, state.baseline);
  const hasChanges = Object.keys(command).length > 0;
  const running = state.pending || mutation.status === "running";
  const canonicalRecordIsNewer = investigation.situationVersion > state.baseline.situationVersion;
  const reviewBlocked = state.conflicted || canonicalRecordIsNewer;
  const visibleFailure = state.attempted
    ? state.failure ?? (mutation.status === "failed" ? mutation.error : null)
    : null;

  useLayoutEffect(() => {
    currentScopeRef.current = scope;
    if (activeSaveRef.current?.scope !== scope) activeSaveRef.current = null;
    setStoredState((current) => current.scope === scope
      ? current
      : initialState(scope, investigation));
    return () => {
      if (activeSaveRef.current?.scope === scope) activeSaveRef.current = null;
      if (currentScopeRef.current === scope) currentScopeRef.current = null;
    };
  }, [scope]);

  useLayoutEffect(() => {
    if (state.editing) {
      firstFieldRef.current?.focus();
      return;
    }
    if (returnFocusRef.current) {
      returnFocusRef.current = false;
      editButtonRef.current?.focus();
    }
  }, [state.baseline.situationVersion, state.editing, state.scope]);

  function beginEditing() {
    if (updateSituation === null || mutation.status === "running") return;
    setStoredState((current) => {
      const scoped = current.scope === scope ? current : initialState(scope, investigation);
      const baseline = recordFor(scoped, investigation);
      return {
        ...scoped,
        editing: true,
        draft: draftFor(baseline),
        baseline,
        attempted: false,
        pending: false,
        conflicted: false,
        failure: null,
        ignored: null,
      };
    });
  }

  function cancelEditing() {
    if (running) return;
    returnFocusRef.current = true;
    setStoredState((current) => {
      const scoped = current.scope === scope ? current : initialState(scope, investigation);
      const baseline = recordFor(scoped, investigation);
      return {
        ...scoped,
        editing: false,
        draft: draftFor(baseline),
        baseline,
        attempted: false,
        pending: false,
        conflicted: false,
        failure: null,
        ignored: null,
      };
    });
    onCancel?.();
  }

  function updateDraft<K extends keyof SituationDraft>(field: K, value: SituationDraft[K]) {
    setStoredState((current) => {
      const scoped = current.scope === scope ? current : initialState(scope, investigation);
      return {
        ...scoped,
        draft: { ...scoped.draft, [field]: value },
        failure: scoped.conflicted ? scoped.failure : null,
        ignored: null,
      };
    });
  }

  function updateContext(field: InvestigationContextField, value: string) {
    setStoredState((current) => {
      const scoped = current.scope === scope ? current : initialState(scope, investigation);
      return {
        ...scoped,
        draft: {
          ...scoped.draft,
          investigationContext: { ...scoped.draft.investigationContext, [field]: value },
        },
        failure: scoped.conflicted ? scoped.failure : null,
        ignored: null,
      };
    });
  }

  function rebaseOntoLatest() {
    if (running) return;
    setStoredState((current) => {
      const scoped = current.scope === scope ? current : initialState(scope, investigation);
      if (
        scoped.pending
        || activeSaveRef.current?.scope === scope
        || currentScopeRef.current !== scope
        || investigation.situationVersion <= scoped.baseline.situationVersion
      ) {
        return scoped;
      }
      return {
        ...scoped,
        draft: rebaseDraft(scoped.draft, scoped.baseline, investigation),
        baseline: investigation,
        authoritativeResult: null,
        attempted: false,
        pending: false,
        conflicted: false,
        failure: null,
        ignored: null,
      };
    });
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      updateSituation === null
      || running
      || reviewBlocked
      || !hasChanges
      || activeSaveRef.current?.scope === scope
    ) {
      return;
    }

    const token: SaveToken = { scope, sequence: saveSequenceRef.current + 1 };
    saveSequenceRef.current = token.sequence;
    activeSaveRef.current = token;
    setStoredState((current) => {
      const scoped = current.scope === scope ? current : initialState(scope, investigation);
      return {
        ...scoped,
        attempted: true,
        pending: true,
        conflicted: false,
        failure: null,
        ignored: null,
      };
    });

    let outcome: CommandOutcome<CaseV1>;
    try {
      outcome = await updateSituation(command);
    } catch {
      outcome = { status: "failed", error: { kind: "unexpected" } };
    }

    // Equality is the completion grant. Scope exit, unmount, or a newer save
    // clears/replaces this token, so an older promise may never publish state
    // or invoke the success callback even if the UI later returns to its scope.
    if (activeSaveRef.current !== token) return;
    activeSaveRef.current = null;
    if (currentScopeRef.current !== token.scope) return;

    if (outcome.status === "succeeded") {
      if (outcome.value.id !== investigation.id) {
        setStoredState((current) => current.scope === scope
          ? {
              ...current,
              pending: false,
              conflicted: false,
              failure: { kind: "unexpected" },
            }
          : current);
        return;
      }
      returnFocusRef.current = true;
      setStoredState((current) => current.scope === scope
        ? {
            ...current,
            editing: false,
            draft: draftFor(outcome.value),
            baseline: outcome.value,
            authoritativeResult: outcome.value,
            attempted: false,
            pending: false,
            conflicted: false,
            failure: null,
            ignored: null,
          }
        : current);
      onSuccess?.(outcome.value);
      return;
    }

    if (outcome.status === "failed") {
      setStoredState((current) => current.scope === scope
        ? {
            ...current,
            pending: false,
            conflicted: outcome.error.kind === "conflict",
            failure: outcome.error,
            ignored: null,
          }
        : current);
      return;
    }

    setStoredState((current) => current.scope === scope
      ? {
          ...current,
          pending: false,
          conflicted: false,
          failure: null,
          ignored: outcome.reason,
        }
      : current);
  }

  return (
    <section className="keystone-situation-editor" aria-labelledby={headingId}>
      <header className="keystone-situation-editor__header">
        <div>
          <h3 id={headingId}>Recorded situation</h3>
          <p>Review the shared situation first. Corrections are recorded only after the server accepts them.</p>
        </div>
        {!state.editing && updateSituation !== null ? (
          <button
            ref={editButtonRef}
            type="button"
            onClick={beginEditing}
            disabled={mutation.status === "running"}
          >
            Edit situation
          </button>
        ) : null}
      </header>

      {state.editing ? (
        <form
          className="keystone-situation-editor__form"
          aria-labelledby={editHeadingId}
          aria-busy={running || undefined}
          onSubmit={(event) => void save(event)}
        >
          <h4 id={editHeadingId}>Edit recorded situation</h4>
          <p>Change only what the shared record should say. Empty fields explicitly clear recorded values.</p>

          <label>
            <span>Problem statement</span>
            <textarea
              ref={firstFieldRef}
              rows={4}
              value={state.draft.problemStatement}
              onChange={(event) => updateDraft("problemStatement", event.target.value)}
            />
          </label>
          <label>
            <span>Affected people or systems</span>
            <textarea
              rows={3}
              value={state.draft.affectedParties}
              onChange={(event) => updateDraft("affectedParties", event.target.value)}
            />
          </label>
          <label>
            <span>Impact</span>
            <textarea
              rows={3}
              value={state.draft.impact}
              onChange={(event) => updateDraft("impact", event.target.value)}
            />
          </label>
          <label>
            <span>Scope</span>
            <textarea
              rows={3}
              value={state.draft.scope}
              onChange={(event) => updateDraft("scope", event.target.value)}
            />
          </label>
          <label>
            <span>Open questions</span>
            <textarea
              rows={4}
              aria-label="Open questions"
              aria-describedby={questionsHintId}
              value={state.draft.openQuestions}
              onChange={(event) => updateDraft("openQuestions", event.target.value)}
            />
            <small id={questionsHintId}>One unresolved question per line. Blank lines are not recorded.</small>
          </label>

          <fieldset>
            <legend>Structured investigation context</legend>
            <p>Enter recorded values directly. This editor does not infer or suggest domain values.</p>
            <div className="keystone-situation-editor__context-fields">
              {CONTEXT_FIELDS.map(({ field, label }) => (
                <label key={field}>
                  <span>{label}</span>
                  <input
                    type="text"
                    maxLength={200}
                    value={state.draft.investigationContext[field]}
                    onChange={(event) => updateContext(field, event.target.value)}
                  />
                </label>
              ))}
            </div>
          </fieldset>

          {visibleFailure !== null ? <p role="alert">{failureCopy(visibleFailure)}</p> : null}
          {reviewBlocked ? (
            <section
              className="keystone-situation-editor__conflict-review"
              aria-labelledby={latestRecordHeadingId}
            >
              <h5 id={latestRecordHeadingId}>Latest recorded situation</h5>
              {canonicalRecordIsNewer ? (
                <>
                  <p>Compare every recorded field with your retained draft before rebasing.</p>
                  <SituationRecord investigation={investigation} />
                  <button type="button" onClick={rebaseOntoLatest} disabled={running}>
                    I reviewed this record — rebase my draft
                  </button>
                </>
              ) : (
                <p role="status">
                  Awaiting the latest recorded situation. Save remains blocked until a newer record is available.
                </p>
              )}
            </section>
          ) : null}
          {state.ignored !== null ? <p role="status">{ignoredCopy(state.ignored)}</p> : null}
          {running ? <p role="status">Saving the situation…</p> : null}
          {!running && !hasChanges ? <p role="status">No changes to save.</p> : null}

          <div className="keystone-situation-editor__actions">
            <button type="submit" disabled={running || reviewBlocked || !hasChanges}>
              Save changes
            </button>
            <button type="button" onClick={cancelEditing} disabled={running}>Cancel</button>
          </div>
        </form>
      ) : (
        <>
          <SituationRecord investigation={authoritativeRecord} />
          {updateSituation === null ? (
            <p role="status">This view can read recorded situation context, but editing is unavailable.</p>
          ) : null}
          {mutation.status === "running" ? <p role="status">A situation save is already in progress.</p> : null}
        </>
      )}
    </section>
  );
}
