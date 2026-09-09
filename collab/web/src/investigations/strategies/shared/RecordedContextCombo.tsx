import type { RecordedContextCatalogStatus } from "./recorded-context-options.js";

export interface RecordedContextComboProps {
  readonly id: string;
  readonly label: string;
  readonly ariaLabel?: string;
  readonly listId?: string;
  readonly value: string;
  readonly submittedValue?: string;
  readonly options: readonly string[];
  readonly catalogStatus: RecordedContextCatalogStatus;
  readonly className?: string;
  readonly inputClassName?: string;
  readonly normalizesOuterWhitespace?: boolean;
  readonly onChange: (value: string) => void;
}

function hint(
  status: RecordedContextCatalogStatus,
  value: string,
  options: readonly string[],
  normalizesOuterWhitespace: boolean,
): string {
  if (normalizesOuterWhitespace) {
    if (status === "loading") return "Recorded values are still loading, so this cannot be compared yet. Outer whitespace will be removed when it is saved.";
    if (status === "unavailable") return "Recorded values are unavailable, so this cannot be compared. Outer whitespace will be removed when it is saved.";
    if (status === "stale") return "Showing the last recorded values because refresh failed. Outer whitespace will be removed when it is saved.";
    if (status === "empty" || options.length === 0) return value
      ? "No recorded values yet. This will be saved as a new value after removing outer whitespace."
      : "No recorded values yet; enter a new value. Outer whitespace will be removed when saved.";
    if (!value) return "Choose a recorded value or enter a new one. Outer whitespace will be removed when saved.";
    return options.some((option) => option.trim() === value)
      ? "Matches a recorded value after removing outer whitespace; it will be saved without outer whitespace."
      : "No recorded value matches after removing outer whitespace. This will be saved as a new value without outer whitespace.";
  }
  if (status === "loading") return "Recorded values are loading. You can still enter a value.";
  if (status === "unavailable") return "Recorded values are unavailable. You can still enter a value.";
  if (status === "stale") return "Showing the last recorded values while refresh is unavailable. You can still enter a value.";
  if (!value) return options.length === 0
    ? "No recorded values yet. Enter a new value."
    : "Choose a recorded value or enter a new one.";
  return options.includes(value)
    ? "Existing recorded value selected."
    : "New value; it will be recorded exactly as entered.";
}

/** Native input[list]; the browser owns popup and option semantics. */
export function RecordedContextCombo(props: RecordedContextComboProps) {
  const listId = props.listId ?? `${props.id}-options`;
  const hintId = `${listId}-hint`;
  const submittedValue = props.submittedValue ?? props.value;
  return (
    <label className={props.className} htmlFor={props.id}>
      <span>{props.label}</span>
      <input
        id={props.id}
        className={props.inputClassName}
        type="text"
        list={listId}
        aria-label={props.ariaLabel ?? props.label}
        aria-describedby={hintId}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
      <datalist id={listId}>
        {props.options.map((option) => <option key={option} value={option} />)}
      </datalist>
      <small id={hintId} className="recorded-context-combo__hint" aria-live="polite">
        {hint(props.catalogStatus, submittedValue, props.options, props.normalizesOuterWhitespace === true)}
      </small>
    </label>
  );
}
