import { useId, useLayoutEffect, useRef, useState } from "react";
import {
  RECORDED_CONTEXT_FIELDS,
  RECORDED_CONTEXT_LIMIT,
  recordedContextOptions,
  recordedContextTuples,
  type RecordedContextCatalog,
  type RecordedContextDraft,
  type RecordedContextField,
  type RecordedContextTuple,
} from "./recorded-context-options.js";

const DEFAULT_LABELS: Record<RecordedContextField, string> = {
  productName: "Software or product", version: "Version", build: "Build",
  component: "Component", environment: "Environment", organization: "Organization, customer, or entity",
};

export interface RecordedContextFieldsProps {
  readonly scopeKey: string;
  readonly draft: RecordedContextDraft;
  readonly catalog: RecordedContextCatalog;
  readonly onFieldChange: (field: RecordedContextField, value: string) => void;
  readonly onTupleApply: (tuple: RecordedContextTuple) => void;
  readonly fields?: readonly RecordedContextField[];
  readonly labels?: Partial<Record<RecordedContextField, string>>;
  readonly ariaPrefix?: string;
  readonly fieldClassName?: string;
  readonly inputClassName?: string;
  readonly tupleClassName?: string;
  readonly normalizesOuterWhitespace?: boolean;
  readonly maxLength?: number;
  readonly disabled?: boolean;
}

function fieldHint(
  catalog: RecordedContextCatalog,
  field: RecordedContextField,
  draft: RecordedContextDraft,
  normalizesOuterWhitespace: boolean,
): string {
  const suffix = normalizesOuterWhitespace
    ? " Outer whitespace will be removed by this form when saved."
    : " This form retains nonblank field text as entered, subject to server validation.";
  if (catalog.status === "not-requested") return `Suggestions were not requested because investigation read access is unavailable. Manual entry remains available.${suffix}`;
  if (catalog.status === "idle") return `Investigation suggestions have not been requested for this view. Manual entry remains available.${suffix}`;
  if (catalog.status === "loading") return `Loaded investigation suggestions are still loading. Manual entry remains available.${suffix}`;
  if (catalog.status === "unavailable") return `Loaded investigation suggestions are unavailable. Manual entry remains available.${suffix}`;
  if (catalog.status === "refreshing") return `Last loaded investigation suggestions are being refreshed; they cannot prove a current match. Manual entry remains available.${suffix}`;
  if (catalog.status === "stale") return `Last loaded investigation suggestions are stale because refresh failed; they cannot prove a current match. Manual entry remains available.${suffix}`;
  const options = recordedContextOptions(catalog.records, field, draft);
  const value = normalizesOuterWhitespace ? draft[field].trim() : draft[field];
  if (catalog.status === "empty") return `No values in the currently loaded investigation records. Manual entry remains available.${suffix}`;
  if (!value) {
    if (options.values.length === 0 && (field === "version" || field === "build"))
      return `No related values for the exact parent fields among loaded records. Manual entry remains available.${suffix}`;
    return `Choose a value from loaded authorized investigations or enter one manually.${suffix}`;
  }
  // Match all eligible loaded records, including literals beyond the 100-option display window.
  const inWindow = options.values.some((option) => (normalizesOuterWhitespace ? option.trim() : option) === value);
  const matches = inWindow || (options.truncated &&
    catalog.records.some((record) => {
      const context = record.investigationContext;
      if ((field === "version" || field === "build") && draft.productName.trim() && context?.productName !== draft.productName) return false;
      if (field === "build" && draft.version.trim() && context?.version !== draft.version) return false;
      const recorded = context?.[field];
      return (normalizesOuterWhitespace && typeof recorded === "string" ? recorded.trim() : recorded) === value;
    }));
  return matches
    ? `Matches a value in the loaded investigation records${inWindow ? "" : ", outside the displayed options"}.${suffix}`
    : `Not found among the loaded suggestions; manual entry is still available.${suffix}`;
}

function tupleLabel(tuple: RecordedContextTuple): string {
  return `Product: ${tuple.productName || "not recorded"} · Version: ${tuple.version || "not recorded"} · Build: ${tuple.build || "not recorded"}`;
}

/** Native datalists are optional input aids; the tuple select is an explicit keyboard action. */
export function RecordedContextFields(props: RecordedContextFieldsProps) {
  const id = useId();
  const scope = useRef({ key: props.scopeKey, epoch: 0, mounted: true });
  if (scope.current.key !== props.scopeKey) {
    scope.current = { key: props.scopeKey, epoch: scope.current.epoch + 1, mounted: true };
  }
  const epoch = scope.current.epoch;
  const isCurrent = () => scope.current.mounted && scope.current.key === props.scopeKey && scope.current.epoch === epoch;
  const latest = useRef({ catalog: props.catalog, onTupleApply: props.onTupleApply });
  latest.current = { catalog: props.catalog, onTupleApply: props.onTupleApply };
  useLayoutEffect(() => {
    scope.current.mounted = true;
    return () => { scope.current.mounted = false; };
  }, [props.scopeKey]);
  const [selection, setSelection] = useState<{ scope: string; key: string }>({ scope: props.scopeKey, key: "" });
  const selectedKey = selection.scope === props.scopeKey ? selection.key : "";
  const tuples = recordedContextTuples(props.catalog.records);
  const candidate = tuples.values.find((tuple) => tuple.key === selectedKey);
  const fields = props.fields ?? RECORDED_CONTEXT_FIELDS;
  const sourceText = props.catalog.status === "stale"
    ? "Showing the last loaded authorized investigation records after a failed refresh."
    : props.catalog.status === "refreshing"
      ? "Showing the last loaded authorized investigation records while a refresh is in progress. These may be stale."
      : props.catalog.status === "idle" || props.catalog.status === "loading" || props.catalog.status === "not-requested" || props.catalog.status === "unavailable"
        ? "Suggestions require an authorized loaded investigation view; manual entry remains available."
        : "Suggestions come only from loaded authorized investigation records for this view; the loaded set may be partial or filtered. This is not a software catalog.";
  return <>
    {fields.map((field) => {
      const fieldId = `${id}-${field}`;
      const listId = `${fieldId}-options`;
      const hintId = `${fieldId}-hint`;
      const options = recordedContextOptions(props.catalog.records, field, props.draft);
      const label = props.labels?.[field] ?? DEFAULT_LABELS[field];
      return <label key={field} className={props.fieldClassName} htmlFor={fieldId}>
        <span>{label}</span>
        <input id={fieldId} className={props.inputClassName} type="text" list={listId}
          aria-label={`${props.ariaPrefix ?? ""}${label}`} aria-describedby={hintId} value={props.draft[field]} maxLength={props.maxLength}
          onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }}
          disabled={props.disabled} onChange={(event) => { if (isCurrent()) props.onFieldChange(field, event.target.value); }} />
        <datalist id={listId}>{options.values.map((option) => <option key={option} value={option} />)}</datalist>
        <small id={hintId} className="recorded-context__hint">{fieldHint(props.catalog, field, props.draft, props.normalizesOuterWhitespace === true)}{options.truncated ? ` Only the first ${RECORDED_CONTEXT_LIMIT} distinct suggestions are displayed; more loaded values are omitted.` : ""}</small>
      </label>;
    })}
    <div className={props.tupleClassName ?? "recorded-context__tuple"}>
      <p className="recorded-context__source">{sourceText}</p>
      <label htmlFor={`${id}-tuple`}>Recorded product / version / build combination</label>
      <select id={`${id}-tuple`} value={candidate?.key ?? ""} disabled={props.disabled || props.catalog.status !== "available" || tuples.values.length === 0}
        onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }}
        onChange={(event) => { if (isCurrent()) setSelection({ scope: props.scopeKey, key: event.target.value }); }}>
        <option value="">Choose a recorded combination</option>
        {tuples.values.map((tuple) => <option key={tuple.key} value={tuple.key}>{tupleLabel(tuple)}</option>)}
      </select>
      {candidate ? <p className="recorded-context__preview">Apply {tupleLabel(candidate)}? Only product, version, and build in this local draft will be replaced. Saving remains a separate action.</p> : null}
      {tuples.truncated ? <p>Only the first {RECORDED_CONTEXT_LIMIT} recorded combinations are displayed; more loaded combinations are omitted.</p> : null}
      <button type="button" disabled={props.disabled || props.catalog.status !== "available" || !candidate}
        onClick={() => {
          if (!isCurrent() || latest.current.catalog.status !== "available" || !candidate) return;
          // Resolve against the latest eligible source at invocation, never an array position.
          const eligible = recordedContextTuples(latest.current.catalog.records).values.find((tuple) => tuple.key === candidate.key);
          if (eligible) latest.current.onTupleApply(eligible);
        }}>Apply combination to draft</button>
    </div>
  </>;
}
