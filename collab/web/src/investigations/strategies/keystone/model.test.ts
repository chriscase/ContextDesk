import { describe, expect, it } from "vitest";
import {
  makeCaseList,
  makeContributionList,
  makeEvidenceList,
} from "../../runtime/testkit/index.js";
import {
  contributionsLinkedToEvidence,
  evidenceName,
  filterEvidence,
  filterInvestigations,
  reconcileWorkingSet,
  recordedText,
  type KeystoneEvidenceRow,
} from "./model.js";

describe("Keystone presentation model", () => {
  it("filters sparse investigations without changing server order", () => {
    const rows = makeCaseList().cases;
    expect(filterInvestigations(rows, "", "all").map(({ id }) => id)).toEqual(
      rows.map(({ id }) => id),
    );
    expect(filterInvestigations(rows, "imported", "all").map(({ id }) => id)).toEqual([
      rows[0]?.id,
    ]);
    expect(filterInvestigations(rows, "checkout", "monitoring").map(({ id }) => id)).toEqual([
      rows[1]?.id,
    ]);
    expect(recordedText(rows[0]?.problemStatement)).toBe("Not recorded");
  });

  it("keeps evidence order, annotation links, and working-set reconciliation factual", () => {
    const evidence = makeEvidenceList().artifacts[0];
    const contributions = makeContributionList().contributions;
    if (!evidence) throw new Error("missing evidence fixture");
    const annotation = contributions.find(({ id }) => id === evidence.summaryContributionId) ?? null;
    const rows: readonly KeystoneEvidenceRow[] = [{ evidence, annotation }];

    expect(filterEvidence(rows, "gateway timeout")).toEqual(rows);
    expect(evidenceName(evidence)).toBe("checkout-timeout.log");
    expect(contributionsLinkedToEvidence(evidence, annotation, contributions)).toEqual([annotation]);
    expect(reconcileWorkingSet([evidence.id, "missing"], rows)).toEqual([evidence.id]);
  });
});
