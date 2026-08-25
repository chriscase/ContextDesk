import { createHash } from "node:crypto";
import {
  snapshotFingerprintDigest,
  type ArtifactV1,
  type CaseBoardGoldStatus,
  type CaseBoardV1,
  type ContributionV1,
} from "@cd-collab/contracts";

export interface AcceptedDecisionBoardInput {
  id: string;
  statement: string;
  evidenceRefs: string[];
  contributionRefs?: string[];
  snapshotFingerprint?: string | null;
}

export interface CaseBoardInput {
  caseId: string;
  snapshotId: string | null;
  selectedSnapshotFingerprint?: string | null;
  generatedAt: string;
  artifacts: ArtifactV1[];
  contributions: ContributionV1[];
  acceptedDecisions?: AcceptedDecisionBoardInput[];
  goldStatus?: CaseBoardGoldStatus;
}

function findingId(prefix: string, value: string): string {
  return `${prefix}-${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16)}`;
}

function artifactLabel(artifact: ArtifactV1): string {
  return artifact.filename ?? `${artifact.kind} evidence`;
}

function contributionStatement(contribution: ContributionV1): string {
  if (contribution.privacyClass === "share_safe" && contribution.body) {
    return contribution.body;
  }
  return `Hypothesis ${contribution.hypothesisStatus ?? "unknown"} (${contribution.id})`;
}

/**
 * Derive a presentation board from current case memory. This is deliberately
 * a projection: it does not mutate truth, create gold, or turn convergence
 * into correctness.
 */
export function deriveCaseBoard(input: CaseBoardInput): CaseBoardV1 {
  const findings: CaseBoardV1["findings"] = [];
  const supportedByEvidence = new Map<string, string[]>();

  for (const artifact of [...input.artifacts].sort((a, b) => a.id.localeCompare(b.id))) {
    const label = artifactLabel(artifact);
    const verified = artifact.contentHash !== null && artifact.verificationStatus === "verified";
    findings.push({
      id: findingId(verified ? "known" : "unknown", artifact.id),
      bucket: verified ? "known" : "unknown",
      statement: verified
        ? `Verified evidence available: ${label}.`
        : `Evidence verification is unknown: ${label}.`,
      evidenceRefs: [artifact.id],
      contributionRefs: artifact.summaryContributionId ? [artifact.summaryContributionId] : [],
      agreement: "unknown",
      confidence: verified ? "high" : "unknown",
      basis: "evidence",
    });
  }

  for (const contribution of [...input.contributions].sort((a, b) => a.id.localeCompare(b.id))) {
    if (contribution.kind !== "hypothesis" || contribution.tombstoned) continue;
    const evidenceRefs = (contribution.hypothesisLinks ?? [])
      .filter((link) => link.kind === "artifact")
      .map((link) => link.id)
      .sort();
    if (contribution.hypothesisStatus === "supported") {
      for (const evidenceRef of evidenceRefs) {
        supportedByEvidence.set(evidenceRef, [
          ...(supportedByEvidence.get(evidenceRef) ?? []),
          contribution.id,
        ]);
      }
      findings.push({
        id: findingId("hypothesis", contribution.id),
        bucket: "known",
        statement: contributionStatement(contribution),
        evidenceRefs,
        contributionRefs: [contribution.id],
        agreement: "unknown",
        confidence: "medium",
        basis: "hypothesis",
      });
    } else if (contribution.hypothesisStatus === "contradicted") {
      findings.push({
        id: findingId("hypothesis", contribution.id),
        bucket: "disputed",
        statement: contributionStatement(contribution),
        evidenceRefs,
        contributionRefs: [contribution.id],
        agreement: "conflicted",
        confidence: "medium",
        basis: "hypothesis",
      });
    } else if (contribution.hypothesisStatus === "proposed") {
      findings.push({
        id: findingId("hypothesis", contribution.id),
        bucket: "unknown",
        statement: contributionStatement(contribution),
        evidenceRefs,
        contributionRefs: [contribution.id],
        agreement: "unknown",
        confidence: "unknown",
        basis: "hypothesis",
      });
    }
  }

  for (const [evidenceRef, contributionRefs] of [...supportedByEvidence.entries()].sort()) {
    if (contributionRefs.length < 2) continue;
    findings.push({
      id: findingId("agreed", evidenceRef),
      bucket: "agreed",
      statement: "Multiple supported hypotheses reference the same evidence.",
      evidenceRefs: [evidenceRef],
      contributionRefs: [...new Set(contributionRefs)].sort(),
      agreement: "shared",
      confidence: "medium",
      basis: "evidence",
    });
  }

  const selectedDigest = snapshotFingerprintDigest(input.selectedSnapshotFingerprint);
  for (const decision of input.acceptedDecisions ?? []) {
    if (selectedDigest) {
      const decisionDigest = snapshotFingerprintDigest(decision.snapshotFingerprint);
      if (decisionDigest !== selectedDigest) continue;
    }
    findings.push({
      id: findingId("concluded", decision.id),
      bucket: "newly_concluded",
      statement: decision.statement,
      evidenceRefs: [...decision.evidenceRefs].sort(),
      contributionRefs: [...(decision.contributionRefs ?? [])].sort(),
      agreement: "unknown",
      confidence: "unknown",
      basis: "accepted_decision",
    });
  }

  if (findings.length === 0) {
    findings.push({
      id: "unknown-no-findings",
      bucket: "unknown",
      statement: "No supported finding has been established yet.",
      evidenceRefs: [],
      contributionRefs: [],
      agreement: "unknown",
      confidence: "unknown",
      basis: "unknown",
    });
  }

  return {
    schemaId: "cd-collab.case_board.v1",
    caseId: input.caseId,
    snapshotId: input.snapshotId,
    generatedAt: input.generatedAt,
    goldStatus: input.goldStatus ?? "unknown",
    findings,
    notice: "Agreement is not proof of correctness.",
  };
}
