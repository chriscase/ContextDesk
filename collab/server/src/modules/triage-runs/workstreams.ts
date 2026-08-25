import {
  WORKSTREAM_LIST_SCHEMA_ID,
  projectWorkstreams,
  type WorkstreamListV1,
} from "@cd-collab/contracts";
import type { Actor, CaseService } from "../cases/index.js";
import type { TriageRunService } from "./service.js";

/**
 * Assemble the readable workstream projection for one investigation.
 *
 * The join happens on the server so the browser never has to reconstruct
 * human meaning from identifiers, and so a caller that cannot read the case
 * gets an empty list rather than a partially-authorized view. Authorization
 * for each underlying record stays with the services that own it.
 */
export async function listCaseWorkstreams(deps: {
  cases: CaseService;
  runs: TriageRunService;
  caseId: string;
  actor: Actor;
  isAdmin: boolean;
}): Promise<WorkstreamListV1> {
  const { cases, runs, caseId, actor, isAdmin } = deps;
  const visible = await cases.getCase(caseId, actor, isAdmin);
  if (!visible) {
    return { schemaId: WORKSTREAM_LIST_SCHEMA_ID, caseId, workstreams: [] };
  }
  const [jobs, artifacts, snapshots, timeline, contributions] = await Promise.all([
    runs.list(caseId, actor, isAdmin),
    cases.listArtifacts(caseId, actor, isAdmin),
    cases.listSnapshots(caseId, actor, isAdmin),
    cases.listTimeline(caseId),
    cases.listContributions(caseId, actor, isAdmin),
  ]);
  // An artifact's human summary lives on the contribution registered with it.
  // A removed (tombstoned) summary stays removed rather than resurfacing here.
  const summaryById = new Map(
    contributions
      .filter((row) => !row.tombstoned && typeof row.body === "string")
      .map((row) => [row.id, row.body as string]),
  );
  return projectWorkstreams({
    caseId,
    jobs,
    evidence: artifacts.map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      filename: artifact.filename,
      summary: artifact.summaryContributionId
        ? summaryById.get(artifact.summaryContributionId) ?? null
        : null,
      verificationStatus: artifact.verificationStatus,
    })),
    snapshots: snapshots.map((snapshot) => ({
      id: snapshot.id,
      createdAt: snapshot.createdAt,
      evidenceIds: snapshot.evidence.map((row) => row.evidenceId),
    })),
    timeline: timeline.map((event) => ({
      kind: event.kind,
      actorUsername: event.actorUsername,
      targetId: event.targetId,
      serverTime: event.serverTime,
    })),
  });
}
