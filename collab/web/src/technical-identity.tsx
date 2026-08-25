import { useEffect, useRef, useState } from "react";

/**
 * Progressive disclosure for the identifiers a record is addressed by.
 *
 * Fingerprints, run ids, and content hashes are how ContextDesk addresses a
 * record, not how a person recognises one. Printed inline — usually truncated
 * to a dozen characters — they crowd out the facts a triage engineer is
 * actually reading, and a truncated hash cannot even be used for the one job a
 * hash is good for, which is matching it against another system exactly.
 *
 * So the surface states what the thing *is* in words, and keeps the exact
 * identifiers one disclosure away, complete and copyable. Nothing is hidden:
 * the count is in the summary, and every value is shown in full when opened.
 */

export interface TechnicalIdentifier {
  /** What this identifier addresses, in words. */
  label: string;
  /** The exact value. Never truncated inside the disclosure. */
  value: string | null | undefined;
  /** Optional one-line explanation of what the identifier is for. */
  hint?: string;
}

/**
 * Copy controls for a group of identifiers, sharing one announcement region.
 *
 * A live region per identifier would put several of them in the accessibility
 * tree for every record on screen. One region per disclosure announces the
 * same outcome without that noise.
 */
function useCopyAnnouncement(): {
  message: string;
  copy: (value: string) => void;
} {
  const [message, setMessage] = useState("");
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const copy = (value: string) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    void navigator.clipboard
      .writeText(value)
      .then(() => setMessage("Copied."))
      // A blocked clipboard is reported, never reported as a success.
      .catch(() => setMessage("The browser blocked the clipboard — select the value to copy it."));
    timer.current = window.setTimeout(() => setMessage(""), 4000);
  };

  return { message, copy };
}

/**
 * A collapsed list of the exact identifiers behind the record on screen.
 *
 * Renders nothing when the record carries no identifier worth showing, so
 * callers can pass a mixed list without guarding each entry.
 */
export function TechnicalIdentifiers(props: {
  items: TechnicalIdentifier[];
  /** Overrides the summary text. Defaults to a count. */
  summary?: string;
  className?: string;
}) {
  const { message, copy } = useCopyAnnouncement();
  const present = props.items.filter(
    (item): item is TechnicalIdentifier & { value: string } =>
      typeof item.value === "string" && item.value.trim().length > 0,
  );
  if (!present.length) return null;
  const summary = props.summary ?? `Technical identifiers (${present.length})`;
  return (
    <details className={props.className ? `technical-id ${props.className}` : "technical-id"}>
      <summary>{summary}</summary>
      <dl className="technical-id__list">
        {present.map((item) => (
          <div className="technical-id__row" key={`${item.label}:${item.value}`}>
            <dt>{item.label}</dt>
            <dd>
              <code className="technical-id__value">{item.value}</code>
              {item.hint ? <small className="technical-id__hint">{item.hint}</small> : null}
              <button
                type="button"
                className="technical-id__copy-button"
                onClick={() => copy(item.value)}
              >
                Copy {item.label.toLowerCase()}
              </button>
            </dd>
          </div>
        ))}
      </dl>
      <p className="technical-id__status" role="status">{message}</p>
    </details>
  );
}

/**
 * A short, stable, human-facing name for a record addressed by an identifier.
 *
 * This is a *name*, not the identifier: it exists so two records on the same
 * screen can be told apart and referred to out loud. The exact value always
 * stays available through `TechnicalIdentifiers`.
 */
export function recordNickname(prefix: string, value: string | null | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return `${prefix} (identifier not recorded)`;
  // The last characters of a UUID or hash vary the most between neighbouring
  // records, so they distinguish better than the leading ones a prefix scheme
  // tends to share.
  return `${prefix} ${trimmed.replace(/[^A-Za-z0-9]/g, "").slice(-4).toUpperCase()}`;
}
