/**
 * Structured probe / preflight diagnostics — summary first, raw detail collapsed.
 */

export type ProbeDiagKind =
  | "ok"
  | "rate_limited"
  | "auth"
  | "unreachable"
  | "unknown";

/** Exported for unit tests. */
export function classifyProbeDiagnostics(
  errors: string[],
  notes: string[],
): ProbeDiagKind {
  const blob = [...errors, ...notes].join("\n").toLowerCase();
  if (blob.includes("429") || blob.includes("rate limit")) return "rate_limited";
  if (blob.includes("401") || blob.includes("403") || blob.includes("auth failed"))
    return "auth";
  if (
    blob.includes("connect") ||
    blob.includes("dns") ||
    blob.includes("timed out") ||
    blob.includes("unreachable")
  ) {
    return "unreachable";
  }
  if (errors.length === 0 && notes.some((n) => /model/i.test(n))) return "ok";
  return "unknown";
}

const TITLES: Record<ProbeDiagKind, string> = {
  ok: "Gateway check succeeded",
  rate_limited:
    "Gateway rate-limited listing (HTTP 429) — wait, then retry once",
  auth: "Gateway rejected credentials",
  unreachable: "Gateway not reachable from this machine",
  unknown: "Could not list models",
};

const HINTS: Record<ProbeDiagKind, string> = {
  ok: "Choose a model below, then use the primary button to continue.",
  rate_limited:
    "The host answered but is throttling list requests. Wait 30–60s. You can still enter a known model id in Advanced if needed.",
  auth: "Confirm the API key in the OS keychain or paste a new key, then retry.",
  unreachable: "Check VPN, URL spelling, and that the host is allowed from this network.",
  unknown: "Review the detail list, fix URL/key, then retry discovery.",
};

type Props = {
  errors: string[];
  notes: string[];
  busy?: boolean;
  autoRan?: boolean;
};

export function ProbeDiagnostics({ errors, notes, busy, autoRan }: Props) {
  if (busy) {
    return (
      <div className="probe-diag probe-diag--busy" role="status">
        <div className="probe-diag__title">Checking AI gateway…</div>
        <div className="probe-diag__hint">
          {autoRan
            ? "Running automatically because a provider is already configured."
            : "Contacting the gateway — this may take a few seconds."}
        </div>
      </div>
    );
  }
  if (!errors.length && !notes.length) return null;

  const kind = classifyProbeDiagnostics(errors, notes);
  const summaryNotes = notes.filter(
    (n) => !n.startsWith("Checking gateway") && !n.startsWith("Trying "),
  );
  const detailLines = [...errors, ...summaryNotes.filter((n) => /https?:\/\//i.test(n))];

  return (
    <div className="probe-diag" data-kind={kind} role="status">
      <div className="probe-diag__title">{TITLES[kind]}</div>
      <div className="probe-diag__hint">{HINTS[kind]}</div>
      {summaryNotes.length > 0 ? (
        <ul className="probe-diag__bullets">
          {summaryNotes.slice(0, 4).map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
      {detailLines.length > 0 ? (
        <details className="probe-diag__details">
          <summary>Technical detail ({detailLines.length})</summary>
          <ul>
            {detailLines.slice(0, 12).map((line) => (
              <li key={line}>
                <code>{line}</code>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
