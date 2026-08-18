import {
  TRIAGE_REQUEST_SCHEMA_V2,
  modelSelectionKey,
  parseTriageRequestV2,
  parseModelSelectionKey,
  type ModelOptionDto,
  type TriageRequestV2,
  type TriageRunEventV2,
} from "@contextdesk/contracts";
import type { TriageRunOptions, TriageService } from "@contextdesk/client";

export const TRIAGE_POLICY_MODES = [
  { value: "standard", label: "Standard", available: true },
  { value: "enhanced", label: "Enhanced", available: false },
  { value: "advanced", label: "Advanced", available: false },
] as const;

export type TriagePolicyMode = (typeof TRIAGE_POLICY_MODES)[number]["value"];

export type TriageTurnSelection = {
  mode: TriagePolicyMode;
  corpusId: string;
};

export type TriageModelRef = { profileId: string; modelId: string };

/** Resolve the selected model as an exact gateway/profile-scoped identity. */
export function resolveSelectedTriageModel(args: {
  sessionModel: string | null;
  sessionProvider: string | null;
  modelOptions: ModelOptionDto[];
  defaultModelKey: string;
}): TriageModelRef | null {
  const { sessionModel, sessionProvider, modelOptions, defaultModelKey } = args;
  let selectionKey = "";
  if (sessionModel && sessionProvider) {
    selectionKey = modelSelectionKey(sessionProvider, sessionModel);
  } else if (sessionModel) {
    selectionKey =
      modelOptions.find((option) => option.id === sessionModel)?.selection_key ??
      "";
  }
  if (!selectionKey) {
    selectionKey =
      defaultModelKey ||
      modelOptions.find((option) => option.is_default)?.selection_key ||
      modelOptions[0]?.selection_key ||
      "";
  }
  const selected = modelOptions.find(
    (option) => option.selection_key === selectionKey,
  );
  if (selected?.provider_id.trim() && selected.id.trim()) {
    return { profileId: selected.provider_id, modelId: selected.id };
  }
  const parsed = parseModelSelectionKey(selectionKey);
  return parsed.providerId && parsed.modelId
    ? { profileId: parsed.providerId, modelId: parsed.modelId }
    : null;
}

export const CONFIGURED_TRIAGE_MODE_UNAVAILABLE =
  "Enhanced and Advanced need an explicitly saved or inline policy, but this desktop cannot resolve one yet. Choose Standard here, or use the CLI or SDK.";

export class TriagePolicyModeUnavailableError extends Error {
  constructor(readonly mode: Exclude<TriagePolicyMode, "standard">) {
    super(
      `${mode === "enhanced" ? "Enhanced" : "Advanced"} is unavailable. ${CONFIGURED_TRIAGE_MODE_UNAVAILABLE}`,
    );
    this.name = "TriagePolicyModeUnavailableError";
  }
}

export function triageModeAvailable(mode: TriagePolicyMode): boolean {
  return mode === "standard";
}

export type BuildTriageRequestV2Args = {
  mode: TriagePolicyMode;
  task: string;
  corpusId: string;
  profileId: string;
  modelId: string;
  runId: string;
  cancellationId: string;
};

/**
 * Build the one policy selection the desktop can currently resolve without
 * inventing configuration. The shared parser remains the final wire guard.
 */
export function buildTriageRequestV2(
  args: BuildTriageRequestV2Args,
): TriageRequestV2 {
  if (args.mode !== "standard") {
    throw new TriagePolicyModeUnavailableError(args.mode);
  }
  return parseTriageRequestV2({
    schema_id: TRIAGE_REQUEST_SCHEMA_V2,
    run_id: args.runId,
    privacy: "owner_only",
    task: args.task,
    scope: {
      corpus_id: args.corpusId,
    },
    policy: {
      kind: "standard",
      model: {
        profile_id: args.profileId,
        model_id: args.modelId,
      },
    },
    overrides: {},
    cancellation_id: args.cancellationId,
  });
}

/** Build before calling the service so unavailable modes fail without IPC. */
export function runTriageSelection(
  service: TriageService,
  args: BuildTriageRequestV2Args,
  options?: TriageRunOptions,
): Promise<TriageRunEventV2> {
  const request = buildTriageRequestV2(args);
  return service.run(request, options);
}

type ProjectedTriageMessage = {
  content: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function humanize(value: string): string {
  return value.replaceAll("_", " ");
}

function projectResult(resultValue: unknown): ProjectedTriageMessage {
  const result = record(resultValue);
  if (!result) {
    return { content: "Triage finished without a readable result." };
  }
  const answerEnvelope = record(result.answer);
  const answer = record(answerEnvelope?.answer);
  const reconciliation = record(result.reconciliation);
  const rootCause = reconciliation?.root_cause_established === true;
  const kind = typeof result.kind === "string" ? result.kind : "unknown";
  const validation =
    typeof result.validation_state === "string"
      ? result.validation_state
      : "unknown";
  const lines = [
    "# Investigation answer",
    "",
    `- Result: ${humanize(kind)}`,
    `- Validation: ${humanize(validation)}`,
    `- Root cause established: ${rootCause ? "yes" : "no"}`,
    "- Confidence: not rated by this contract",
  ];

  const candidates = Array.isArray(answer?.candidates)
    ? answer.candidates.map(record).filter((entry) => entry !== null)
    : [];
  for (const candidate of candidates) {
    const candidateId =
      typeof candidate.candidate_id === "string"
        ? candidate.candidate_id
        : "unidentified";
    lines.push("", `## Candidate ${candidateId}`);
    const claims = Array.isArray(candidate.claims)
      ? candidate.claims.map(record).filter((entry) => entry !== null)
      : [];
    if (claims.length === 0) {
      lines.push("", "No claims were reported for this candidate.");
      continue;
    }
    for (const claim of claims) {
      const text = typeof claim.text === "string" ? claim.text : "";
      const claimKind =
        typeof claim.claim_kind === "string"
          ? humanize(claim.claim_kind)
          : "claim";
      const status =
        typeof claim.status === "string" && claim.status !== "supported"
          ? ` (${humanize(claim.status)})`
          : "";
      lines.push(`- **${claimKind}${status}:** ${text || "No text supplied."}`);
    }
  }
  if (candidates.length === 0) {
    lines.push("", "No validated candidate answer was available for this turn.");
  }

  const reasons = stringArray(result.reason_codes);
  if (reasons.length > 0) {
    lines.push("", `Reason codes: ${reasons.map(humanize).join(", ")}.`);
  }

  const citations = Array.isArray(answer?.canonical_citations)
    ? answer.canonical_citations
        .map(record)
        .filter((entry) => entry !== null)
    : [];
  if (citations.length > 0) {
    lines.push("", "## Evidence");
    for (const citation of citations) {
      const evidenceId =
        typeof citation.evidence_id === "string"
          ? citation.evidence_id
          : "evidence";
      const source =
        typeof citation.source_label === "string"
          ? citation.source_label
          : "source";
      const locator =
        typeof citation.locator === "string"
          ? citation.locator
          : "location unavailable";
      // V2 locators such as `seq=42` are canonical evidence metadata, not a
      // desktop navigation identity. Keep them readable without fabricating a
      // clickable log_event/log_template citation.
      lines.push(`- ${evidenceId} — ${source} · ${locator}`);
    }
  }

  return { content: lines.join("\n") };
}

/** Project only authoritative terminal payloads into the existing chat shape. */
export function projectTriageTerminalEvent(
  event: TriageRunEventV2,
): ProjectedTriageMessage | null {
  const payload = event.event;
  if (payload.kind === "completed") {
    return projectResult(payload.result);
  }
  if (
    payload.kind !== "failed" &&
    payload.kind !== "timed_out" &&
    payload.kind !== "cancelled"
  ) {
    return null;
  }
  const partial = projectResult(payload.partial_result);
  const category =
    typeof payload.category === "string"
      ? ` (${humanize(payload.category)})`
      : "";
  const heading =
    payload.kind === "cancelled"
      ? "Triage was cancelled."
      : payload.kind === "timed_out"
        ? `Triage timed out${category}.`
        : `Triage failed${category}.`;
  return {
    ...partial,
    content: `${heading}\n\n${partial.content}`,
  };
}
