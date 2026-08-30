import {
  StrategyBadge,
  StrategyStateNotice,
} from "../shared/index.js";
import {
  evidenceName,
  recordedText,
  type KeystoneEvidenceRow,
} from "./model.js";

interface KeystoneEvidenceGridProps {
  readonly rows: readonly KeystoneEvidenceRow[];
  readonly selectedEvidenceId: string | null;
  readonly workingSet: readonly string[];
  readonly annotationState: "available" | "loading" | "unavailable";
  readonly onInspect: (evidenceId: string) => void;
  readonly onWorkingSetChange: (evidenceId: string, selected: boolean) => void;
}

function verificationTone(value: string | null): "neutral" | "success" {
  if (value === "verified") return "success";
  // The contract intentionally permits vocabulary this presentation may not
  // know yet. Render every other recorded word neutrally instead of inventing
  // a caution or failure meaning for it.
  return "neutral";
}

export function KeystoneEvidenceGrid({
  rows,
  selectedEvidenceId,
  workingSet,
  annotationState,
  onInspect,
  onWorkingSetChange,
}: KeystoneEvidenceGridProps) {
  if (rows.length === 0) {
    return (
      <StrategyStateNotice title="No matching evidence">
        No evidence in the available inventory matches this search.
      </StrategyStateNotice>
    );
  }

  return (
    <div className="keystone-strategy__evidence-table-wrap">
      <table className="keystone-strategy__evidence-table">
        <thead>
          <tr>
            <th scope="col"><span className="keystone-strategy__visually-hidden">Working set</span></th>
            <th scope="col">Evidence</th>
            <th scope="col">Kind</th>
            <th scope="col">Verification</th>
            <th scope="col">Privacy</th>
            <th scope="col">Source</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ evidence, annotation }) => {
            const name = evidenceName(evidence);
            const checked = workingSet.includes(evidence.id);
            const current = selectedEvidenceId === evidence.id;
            const annotationCopy = annotation?.body?.trim()
              || (annotationState === "loading"
                ? "Annotation is still loading."
                : annotationState === "unavailable"
                  ? "Annotation is unavailable."
                  : evidence.summaryContributionId
                    ? "The recorded annotation link is not available in the current contribution set."
                    : "No linked annotation is recorded.");
            return (
              <tr key={evidence.id} className={current ? "keystone-strategy__evidence-row--current" : undefined}>
                <td data-label="Working set">
                  <label className="keystone-strategy__working-checkbox">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(event) => onWorkingSetChange(evidence.id, event.target.checked)}
                    />
                    <span className="keystone-strategy__visually-hidden">
                      {checked ? "Remove" : "Add"} {name} {checked ? "from" : "to"} working set
                    </span>
                  </label>
                </td>
                <td data-label="Evidence">
                  <button
                    type="button"
                    className="keystone-strategy__evidence-name"
                    aria-current={current ? "true" : undefined}
                    onClick={() => onInspect(evidence.id)}
                  >
                    {name}
                  </button>
                  <small>{annotationCopy}</small>
                </td>
                <td data-label="Kind"><StrategyBadge>{evidence.kind}</StrategyBadge></td>
                <td data-label="Verification">
                  <StrategyBadge tone={verificationTone(evidence.verificationStatus)}>
                    {recordedText(evidence.verificationStatus)}
                  </StrategyBadge>
                </td>
                <td data-label="Privacy"><StrategyBadge>{evidence.privacyClass}</StrategyBadge></td>
                <td data-label="Source"><span className="keystone-strategy__breakable">{recordedText(evidence.sourceId)}</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
