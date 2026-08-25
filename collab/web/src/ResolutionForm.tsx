/**
 * Recording why an investigation was resolved.
 *
 * An investigation can be concluded by a person reading the notes and evidence,
 * with no model run anywhere in the case. That is an ordinary outcome and this
 * form treats it as the default, not as a fallback for when a comparison is
 * missing. What it does not allow is concluding silently: a status that says
 * the question was answered has to say who answered it, on what basis, and what
 * is still unknown.
 *
 * Closing a case without a substantive conclusion is a real outcome too, so it
 * is modelled explicitly as a reasoned exception rather than left as an
 * undocumented status change.
 */
import { useState, type FormEvent } from "react";

export const RESOLUTION_BASES = [
  "human_only",
  "experiment_decision",
  "reasoned_exception",
] as const;
export type ResolutionBasis = (typeof RESOLUTION_BASES)[number];

export const BASIS_LABELS: Readonly<Record<ResolutionBasis, string>> = {
  human_only: "People reasoned it out",
  experiment_decision: "An accepted comparison decision",
  reasoned_exception: "Closing without a conclusion",
};

export const BASIS_HELP: Readonly<Record<ResolutionBasis, string>> = {
  human_only:
    "The conclusion came from reading the recorded notes and evidence. No model run is needed or implied.",
  experiment_decision:
    "The conclusion rests on a decision accepted in Compare. Name that decision so the two records stay connected.",
  reasoned_exception:
    "The investigation is being closed without answering its question — a duplicate, withdrawn, or overtaken by events. Say which.",
};

export interface ResolutionDraft {
  basis: ResolutionBasis;
  rationale: string;
  unknowns: string;
  exceptionReason: string;
  experimentDecisionId: string;
  occurredAt: string;
}

export const EMPTY_RESOLUTION: ResolutionDraft = {
  basis: "human_only",
  rationale: "",
  unknowns: "",
  exceptionReason: "",
  experimentDecisionId: "",
  occurredAt: "",
};

/** Wire shape for the resolution the server records with the transition. */
export function resolutionPayload(draft: ResolutionDraft): Record<string, unknown> {
  const unknowns = draft.unknowns
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    basis: draft.basis,
    rationale: draft.rationale,
    unknowns,
    ...(draft.basis === "reasoned_exception" ? { exceptionReason: draft.exceptionReason } : {}),
    ...(draft.basis === "experiment_decision"
      ? { experimentDecisionId: draft.experimentDecisionId }
      : {}),
    ...(draft.occurredAt.trim() ? { occurredAt: draft.occurredAt.trim() } : {}),
  };
}

export function ResolutionForm(props: {
  /** Shown when the server refused a transition for want of a record. */
  prompted: boolean;
  error: string | null;
  onSubmit: (payload: Record<string, unknown>) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<ResolutionDraft>(EMPTY_RESOLUTION);

  function submit(event: FormEvent) {
    event.preventDefault();
    void props.onSubmit(resolutionPayload(draft));
  }

  return (
    <form className="composer" aria-label="Record why this is resolved" onSubmit={submit}>
      <h5>Record why this is resolved</h5>
      {props.prompted ? (
        <p className="triage-step__note" role="status">
          Resolving an investigation records a conclusion, so it needs a reason attached. Nothing
          was changed yet.
        </p>
      ) : null}
      {props.error ? (
        <p className="catalog__error" role="alert">
          {props.error}
        </p>
      ) : null}

      <label>
        <span>How was this reached?</span>
        <select
          className="login__input"
          aria-label="How was this reached?"
          value={draft.basis}
          onChange={(event) =>
            setDraft((current) => ({ ...current, basis: event.target.value as ResolutionBasis }))
          }
        >
          {RESOLUTION_BASES.map((basis) => (
            <option key={basis} value={basis}>
              {BASIS_LABELS[basis]}
            </option>
          ))}
        </select>
      </label>
      <p className="triage-step__note">{BASIS_HELP[draft.basis]}</p>

      <label>
        <span>Why</span>
        <textarea
          value={draft.rationale}
          onChange={(event) =>
            setDraft((current) => ({ ...current, rationale: event.target.value }))
          }
          placeholder="What the conclusion is, and what it rests on."
          aria-label="Why"
          rows={4}
          required
        />
      </label>

      {draft.basis === "reasoned_exception" ? (
        <label>
          <span>What the exception is</span>
          <input
            className="login__input"
            value={draft.exceptionReason}
            onChange={(event) =>
              setDraft((current) => ({ ...current, exceptionReason: event.target.value }))
            }
            placeholder="Duplicate, withdrawn, overtaken by events…"
            aria-label="What the exception is"
            required
          />
        </label>
      ) : null}

      {draft.basis === "experiment_decision" ? (
        <label>
          <span>Accepted decision</span>
          <input
            className="login__input"
            value={draft.experimentDecisionId}
            onChange={(event) =>
              setDraft((current) => ({ ...current, experimentDecisionId: event.target.value }))
            }
            placeholder="Identifier of the accepted decision in Compare"
            aria-label="Accepted decision"
            required
          />
        </label>
      ) : null}

      <label>
        <span>Still unknown</span>
        <textarea
          value={draft.unknowns}
          onChange={(event) => setDraft((current) => ({ ...current, unknowns: event.target.value }))}
          placeholder="One unresolved question per line. Leave empty only if nothing is outstanding."
          aria-label="Still unknown"
          rows={3}
        />
      </label>

      <label>
        <span>When it was concluded</span>
        <input
          className="login__input"
          value={draft.occurredAt}
          onChange={(event) =>
            setDraft((current) => ({ ...current, occurredAt: event.target.value }))
          }
          placeholder="Optional date, e.g. 2024-11-06"
          aria-label="When it was concluded"
        />
      </label>

      <button className="login__submit" type="submit">
        Resolve with this record
      </button>
      <button type="button" className="situation__cancel" onClick={props.onCancel}>
        Cancel
      </button>
    </form>
  );
}
