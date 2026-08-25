import { useEffect, useRef, useState } from "react";

/**
 * Shared presentation for a recorded log excerpt or stack trace.
 *
 * Engineers read these constantly, so the rules are the same everywhere they
 * appear: show a bounded preview, keep the complete text one keyboard-
 * reachable disclosure away, and state the real scale so nobody mistakes a
 * truncated view for the whole record. Nothing here rewrites the underlying
 * bytes — only the preview drops bare identifiers that carry no meaning for a
 * reader, and the expanded text is always verbatim.
 *
 * The `experiment-lab__artifact-*` class names are the shipped styling
 * contract for this component and are intentionally kept while it is shared,
 * rather than duplicating the stylesheet under a second prefix.
 */

/** Preview text with bare `evidence ev-…` identifiers removed. */
export function readableTraceExcerpt(value: string): string {
  const withoutTechnicalRefs = value
    .replace(/(?:;\s*)?evidence\s+ev-[a-z0-9][a-z0-9-]*/gi, "")
    .replace(/\s+([,.;:])/g, "$1")
    .trim();
  return withoutTechnicalRefs || "This step contains only a technical evidence reference.";
}

function CopyExcerpt(props: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "unavailable">("idle");
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  async function copy() {
    if (timer.current !== null) window.clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(props.text);
      setState("copied");
    } catch {
      // A blocked or absent clipboard is reported, never silently swallowed
      // and never faked as a successful copy.
      setState("unavailable");
    }
    timer.current = window.setTimeout(() => setState("idle"), 4000);
  }

  return (
    <p className="evidence-excerpt__copy">
      <button
        type="button"
        className="evidence-excerpt__copy-button"
        onClick={() => void copy()}
      >
        Copy {props.label}
      </button>
      <span role="status">
        {state === "copied"
          ? "Copied to the clipboard."
          : state === "unavailable"
            ? "This browser blocked the clipboard — select the text to copy it."
            : ""}
      </span>
    </p>
  );
}

export function ArtifactExcerpt(props: {
  text: string;
  /**
   * Names the artifact in the disclosure's accessible name and the copy
   * control, so assistive technology hears which log is being expanded.
   */
  label?: string;
  /** Adds a copy control for the complete text. Off by default. */
  copyable?: boolean;
}) {
  const fullText = props.text;
  const previewText = readableTraceExcerpt(fullText);
  const fullLines = fullText.split(/\r?\n/);
  const previewLines = previewText.split(/\r?\n/);
  const isLarge = fullLines.length > 6 || fullText.length > 480;
  const copyLabel = props.label ? `${props.label} text` : "excerpt";
  if (!isLarge) {
    return (
      <>
        <pre className="experiment-lab__artifact-excerpt">{previewText}</pre>
        {props.copyable ? <CopyExcerpt text={fullText} label={copyLabel} /> : null}
      </>
    );
  }
  const previewByLines = previewLines.slice(0, 6).join("\n");
  const preview = previewByLines.length > 480
    ? `${previewByLines.slice(0, 479)}…`
    : `${previewByLines}\n…`;
  const lineCount = `${fullLines.length} line${fullLines.length === 1 ? "" : "s"}`;
  const excerptScale = `${lineCount} · ${fullText.length.toLocaleString()} characters`;
  const summaryLabel = props.label
    ? `Expand or collapse the complete ${props.label} — ${excerptScale}`
    : undefined;
  return (
    <div className="experiment-lab__artifact-collapsible">
      <pre className="experiment-lab__artifact-excerpt experiment-lab__artifact-preview">
        {preview}
      </pre>
      <details>
        <summary {...(summaryLabel ? { "aria-label": summaryLabel } : {})}>
          <span className="experiment-lab__artifact-expand">
            Expand complete log or stack trace · {excerptScale}
          </span>
          <span className="experiment-lab__artifact-collapse">
            Collapse complete log or stack trace · {excerptScale}
          </span>
        </summary>
        <pre className="experiment-lab__artifact-excerpt experiment-lab__artifact-full">
          {fullText}
        </pre>
        {props.copyable ? <CopyExcerpt text={fullText} label={copyLabel} /> : null}
      </details>
    </div>
  );
}
