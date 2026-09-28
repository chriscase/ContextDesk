import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import {
  useInvestigationRuntime,
  type ArtifactV1,
  type ContributionV1,
  type ExternalRunJudgmentLinkV1,
  type ExternalRunJudgmentListV1,
  type ExternalRunJudgmentRecordV1,
  type ResourceState,
} from "../runtime/public.js";
import {
  HumanAssessmentsPanel,
  type HumanAssessmentCitationChoice,
  type HumanAssessmentCreateInput,
  type HumanAssessmentCreateResult,
  type HumanAssessmentLink,
  type HumanAssessmentRecord,
  type HumanAssessmentsMutationState,
  type HumanAssessmentsReadError,
  type HumanAssessmentsResourceState,
  type HumanAssessmentsWriteError,
} from "./shared/index.js";

const CONTRIBUTION_BODY_BOUND = 120;

type CitationFocus = {
  section: string;
  item: string;
  itemKind: "evidence" | "contribution";
  lane: null;
  experiment: null;
};

type RuntimeFailure = Extract<ResourceState<never>, { status: "failed" }>["error"];

function publishedValue<T>(state: ResourceState<T>): T | undefined {
  if (state.status === "ready") return state.value;
  if (state.status === "loading" || state.status === "failed") return state.previous;
  return undefined;
}

function publishedCitationValue<T>(state: ResourceState<T>): T | undefined {
  if (
    state.status === "failed"
    && (state.error.kind === "auth_lost" || state.error.kind === "not_found")
  ) return undefined;
  return publishedValue(state);
}

function readError(error: RuntimeFailure): HumanAssessmentsReadError {
  if (error.kind === "auth_lost") return "auth_lost";
  if (error.kind === "not_found") return "not_found";
  return "unavailable";
}

function writeError(error: RuntimeFailure): HumanAssessmentsWriteError {
  switch (error.kind) {
    case "judgment_conflict":
      return "conflict";
    case "judgment_limit_reached":
      return "judgment_limit_reached";
    case "judgment_refused":
      return error.reason;
    case "unavailable":
    case "network":
    case "protocol":
    case "unexpected_response":
    case "server_failure":
    case "unexpected":
    case "aborted":
      return "commit_outcome_unknown";
    case "auth_lost":
      return "auth_lost";
    case "not_found":
      return "not_found";
    case "validation":
    case "input":
      return "validation";
    default:
      return "definitive";
  }
}

function evidenceLabel(artifact: ArtifactV1): string {
  return artifact.filename?.trim() || artifact.uri?.trim() || "Unnamed evidence";
}

function contributionLabel(contribution: ContributionV1): string {
  const body = contribution.body?.trim() ?? "";
  const bounded = body.length > CONTRIBUTION_BODY_BOUND
    ? `${body.slice(0, CONTRIBUTION_BODY_BOUND - 1)}…`
    : body;
  return bounded.length > 0 ? `${contribution.kind}: ${bounded}` : contribution.kind;
}

function citationChoices(
  evidence: ResourceState<readonly ArtifactV1[]>,
  contributions: ResourceState<readonly ContributionV1[]>,
): readonly HumanAssessmentCitationChoice[] {
  const artifacts = publishedCitationValue(evidence);
  const rows = publishedCitationValue(contributions);
  const choices: HumanAssessmentCitationChoice[] = [];
  if (artifacts !== undefined) {
    for (const artifact of artifacts) {
      choices.push({
        kind: "artifact",
        id: artifact.id,
        label: evidenceLabel(artifact),
      });
    }
  }
  if (rows !== undefined) {
    for (const contribution of rows) {
      if (contribution.tombstoned) continue;
      choices.push({
        kind: "contribution",
        id: contribution.id,
        label: contributionLabel(contribution),
      });
    }
  }
  return choices;
}

function linkLabel(
  link: ExternalRunJudgmentLinkV1,
  choices: readonly HumanAssessmentCitationChoice[],
): string {
  if (link.kind === "snapshot") return "Snapshot";
  const match = choices.find((choice) => choice.kind === link.kind && choice.id === link.id);
  if (match) return match.label;
  return link.kind === "artifact" ? "Evidence" : "Contribution";
}

function mappedRecord(
  row: ExternalRunJudgmentRecordV1,
  choices: readonly HumanAssessmentCitationChoice[],
): HumanAssessmentRecord {
  return {
    seq: row.seq,
    value: row.judgment,
    actorUsername: row.actor.username,
    recordedAt: row.recordedAt,
    rationale: row.rationale,
    links: row.links.map((link): HumanAssessmentLink => ({
      kind: link.kind,
      id: link.id,
      label: linkLabel(link, choices),
    })),
  };
}

function mappedRecords(
  list: ExternalRunJudgmentListV1,
  choices: readonly HumanAssessmentCitationChoice[],
): readonly HumanAssessmentRecord[] {
  return list.judgments.map((row) => mappedRecord(row, choices));
}

function mappedResource(
  state: ResourceState<ExternalRunJudgmentListV1>,
  choices: readonly HumanAssessmentCitationChoice[],
): HumanAssessmentsResourceState {
  switch (state.status) {
    case "idle":
      return { status: "idle" };
    case "loading":
      return state.previous === undefined
        ? { status: "loading" }
        : { status: "loading", previous: mappedRecords(state.previous, choices) };
    case "ready":
      return { status: "ready", value: mappedRecords(state.value, choices) };
    case "failed": {
      const error = readError(state.error);
      if (error === "auth_lost" || error === "not_found") {
        return { status: "failed", error };
      }
      return state.previous === undefined
        ? { status: "failed", error }
        : {
            status: "failed",
            error,
            previous: mappedRecords(state.previous, choices),
          };
    }
  }
}

function mappedMutation(
  state: ReturnType<typeof useInvestigationRuntime>["mutations"]["externalRunJudgment"],
): HumanAssessmentsMutationState {
  switch (state.status) {
    case "idle":
      return { status: "idle" };
    case "running":
      return { status: "running" };
    case "succeeded":
      return { status: "succeeded" };
    case "failed":
      return { status: "failed", error: writeError(state.error) };
  }
}

function compareLinks(
  left: { readonly kind: string; readonly id: string },
  right: { readonly kind: string; readonly id: string },
): number {
  if (left.kind !== right.kind) return left.kind < right.kind ? -1 : 1;
  if (left.id !== right.id) return left.id < right.id ? -1 : 1;
  return 0;
}

function commandLinks(
  links: HumanAssessmentCreateInput["links"],
): ExternalRunJudgmentLinkV1[] {
  return [...links]
    .map((link) => ({ kind: link.kind, id: link.id }))
    .sort(compareLinks);
}

/**
 * Runtime-to-presentation adapter for the shared human assessments panel.
 *
 * Strategies own placement. This adapter is the only place that maps the
 * public runtime's dedicated judgment resource, mutation, refresh, and create
 * command into the transport-free shared kit contract.
 */
export function RuntimeExternalRunJudgments({ caseId, runId, onDeepNavigate }: {
  readonly caseId: string;
  readonly runId: string;
  readonly onDeepNavigate?: (stage: "capture" | "analyze", focus: CitationFocus) => void;
}) {
  const runtime = useInvestigationRuntime();
  const query = runtime.commands.queryExternalRunJudgments;
  const create = runtime.commands.createExternalRunJudgment;
  const queryAvailable = query !== null;
  const compositionToken = useMemo(() => Object.freeze({}), [
    caseId,
    runId,
    runtime.presentationScopeKey,
    queryAvailable,
    create !== null,
  ]);
  const committedTokenRef = useRef<object | null>(null);
  const navigationRef = useRef<{
    evidence: ResourceState<readonly ArtifactV1[]>;
    contributions: ResourceState<readonly ContributionV1[]>;
  } | null>(null);
  useLayoutEffect(() => {
    committedTokenRef.current = compositionToken;
    return () => {
      if (committedTokenRef.current === compositionToken) {
        committedTokenRef.current = null;
        navigationRef.current = null;
      }
    };
  }, [compositionToken]);
  useLayoutEffect(() => {
    navigationRef.current = {
      evidence: runtime.resources.evidence,
      contributions: runtime.resources.contributions,
    };
  });
  const isCurrent = () => committedTokenRef.current === compositionToken;
  const matching = queryAvailable && runtime.resources.externalRunJudgmentsRunId === runId;
  const choices = citationChoices(
    runtime.resources.evidence,
    runtime.resources.contributions,
  );
  const resource: HumanAssessmentsResourceState = !queryAvailable
    ? { status: "failed", error: "unavailable" }
    : matching
      ? mappedResource(runtime.resources.externalRunJudgments, choices)
      : { status: "idle" };
  const mutation = queryAvailable && matching
    ? mappedMutation(runtime.mutations.externalRunJudgment)
    : { status: "idle" as const };
  const readDenied = resource.status === "failed"
    && (resource.error === "auth_lost" || resource.error === "not_found");
  const createAssessment = !queryAvailable || create === null || !matching || readDenied
    ? null
    : async (input: HumanAssessmentCreateInput): Promise<HumanAssessmentCreateResult> => {
        if (!isCurrent()) return { status: "ignored", reason: "stale" };
        const outcome = await create({
          runId,
          judgment: input.judgment,
          links: commandLinks(input.links),
          rationale: input.rationale,
          idempotencyKey: input.idempotencyKey,
        });
        if (!isCurrent()) return { status: "ignored", reason: "stale" };
        if (outcome.status === "succeeded") return {
          status: "succeeded",
          applied: mappedRecord(outcome.value.applied, choices),
          replayed: outcome.value.replayed,
        };
        if (outcome.status === "ignored") return outcome;
        return { status: "failed", error: writeError(outcome.error) };
      };

  useEffect(() => {
    if (query === null || !isCurrent()) return;
    query(runId);
  }, [query, runId, compositionToken]);

  return (
    <HumanAssessmentsPanel
      key={`${runtime.presentationScopeKey}:${caseId}:${runId}`}
      resource={resource}
      readCompletion={matching
        ? runtime.resources.externalRunJudgmentsCompletedReadGeneration ?? null
        : null}
      mutation={mutation}
      citationChoices={choices}
      {...(onDeepNavigate ? { onOpenCitation: (link: HumanAssessmentLink) => {
        if (!isCurrent()) return;
        const current = navigationRef.current;
        if (link.kind === "artifact") {
          const eligible = current?.evidence.status === "ready"
            && current.evidence.value.some((row) => row.caseId === caseId && row.id === link.id);
          if (eligible) onDeepNavigate("analyze", {
            section: "triage-evidence-board", item: link.id, itemKind: "evidence",
            lane: null, experiment: null,
          });
        } else if (link.kind === "contribution") {
          const eligible = current?.contributions.status === "ready"
            && current.contributions.value.some((row) => row.caseId === caseId
              && row.id === link.id && !row.tombstoned);
          if (eligible) onDeepNavigate("capture", {
            section: "triage-capture", item: link.id, itemKind: "contribution",
            lane: null, experiment: null,
          });
        }
      } } : {})}
      createAssessment={createAssessment}
      refresh={() => isCurrent() ? runtime.refresh.externalRunJudgments() : undefined}
    />
  );
}
