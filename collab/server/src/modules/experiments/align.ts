import {
  alignCitedEvidence,
  type CandidateGoldAlignmentV1,
  type ExperimentAgreementV1,
  type ExperimentCandidateV1,
  type GoldReferenceV1,
} from "@cd-collab/contracts";

function citedEvidence(
  agreement: ExperimentAgreementV1,
  candidateId: string,
): { refs: string[]; roles: Map<string, string> } {
  const refs = new Set<string>();
  const roles = new Map<string, string>();
  for (const anchor of agreement.sharedAnchors) {
    if (anchor.candidateIds.includes(candidateId)) {
      refs.add(anchor.evidenceRef);
      roles.set(anchor.evidenceRef, anchor.role);
    }
  }
  for (const row of agreement.candidateSpecific) {
    if (row.candidateId === candidateId) {
      for (const ref of row.evidenceRefs) refs.add(ref);
    }
  }
  for (const conflict of agreement.roleConflicts) {
    for (const assignment of conflict.assignments) {
      if (assignment.candidateId === candidateId) {
        refs.add(conflict.evidenceRef);
        roles.set(conflict.evidenceRef, assignment.role);
      }
    }
  }
  return { refs: [...refs], roles };
}

export function alignExperimentCandidates(
  candidates: ExperimentCandidateV1[],
  agreement: ExperimentAgreementV1,
  gold: GoldReferenceV1 | null,
): CandidateGoldAlignmentV1[] {
  return candidates.map((candidate) => {
    const cited = citedEvidence(agreement, candidate.candidateId);
    return alignCitedEvidence({
      candidateId: candidate.candidateId,
      cited: cited.refs,
      observedRoles: cited.roles,
      gold,
      goldState: candidate.goldState === "absent" ? "absent" : "unknown",
    });
  });
}

export function knownAgreementEvidence(agreement: ExperimentAgreementV1): Set<string> {
  const ids = new Set<string>();
  for (const anchor of agreement.sharedAnchors) ids.add(anchor.evidenceRef);
  for (const row of agreement.candidateSpecific) {
    for (const ref of row.evidenceRefs) ids.add(ref);
  }
  for (const conflict of agreement.roleConflicts) ids.add(conflict.evidenceRef);
  return ids;
}
