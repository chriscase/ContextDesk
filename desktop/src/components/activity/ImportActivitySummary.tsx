import { useId, useState } from "react";
import {
  compactImportSummary,
  importLedgerSections,
} from "../../lib/activity/importLedger";
import type { ImportRunInput } from "../../lib/activity/types";

/**
 * Compact one-line import summary with an opt-in detailed ledger.
 * Quiet by default: one text row (same visual weight as the existing
 * `log-pane__note` line it augments) plus a "Details" disclosure; the
 * full ledger renders only after the user asks.
 */
export function ImportActivitySummary({ run }: { run: ImportRunInput }) {
  const [open, setOpen] = useState(false);
  const regionId = useId();
  const summary = compactImportSummary(run);

  const line = [
    summary.filesLine,
    summary.eventsLine,
    summary.elapsedLine,
    summary.timestampQuality ? `time: ${summary.timestampQuality}` : null,
    summary.analysisMode,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      className="activity-import-summary"
      data-testid="activity-import-summary"
      data-outcome={summary.outcome}
      data-source-kind={run.sourceKind}
    >
      <p className="activity-import-summary__line">
        <span>{line}</span>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          aria-expanded={open}
          aria-controls={regionId}
          data-testid="activity-import-details-toggle"
          onClick={() => setOpen((current) => !current)}
        >
          {open ? "Hide details" : "Details"}
        </button>
      </p>
      {open ? (
        <section
          id={regionId}
          className="activity-import-ledger"
          aria-label="Import ledger"
          data-testid="activity-import-ledger"
        >
          {importLedgerSections(run).map((section) => (
            <section
              key={section.id}
              className="activity-import-ledger__section"
              data-ledger-section={section.id}
            >
              <h4>{section.title}</h4>
              <dl>
                {section.rows.map((row, index) => (
                  <div
                    key={`${section.id}-${index}`}
                    className="activity-import-ledger__row"
                  >
                    <dt>{row.term}</dt>
                    <dd>{row.detail}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </section>
      ) : null}
    </div>
  );
}
