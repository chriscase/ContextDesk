import { createHash } from "node:crypto";
import { checkObject, f, type ObjectShape, ContractViolation } from "./parse.js";

import {
  AGREEMENT_NOT_CORRECTNESS,
  parseExperimentImport,
  parseExperimentReviewExport,
  type ExperimentAgreementV1,
  type ExperimentCandidateV1,
  type ExperimentPackageV1,
  type ExperimentReviewExportV1,
  type ExperimentSummaryV1,
  type HelpfulnessState,
  type ObservedLatencyV1,
  type RoleConflictV1,
} from "./experiment.js";
import {
  GOLD_ALIGNMENT_NOT_CORRECTNESS,
  GOLD_IS_HUMAN_BENCHMARK,
  type GoldReferenceV1,
} from "./gold.js";

export const INTERACTION_TRACE_SCHEMA_ID = "cd-collab.interaction_trace.v1" as const;
export const PLAIN_TRANSCRIPT_SCHEMA_ID = "cd-collab.plain_transcript.v1" as const;
export const STRATEGY_PACKAGE_SCHEMA_ID = "cd-collab.strategy_package.v1" as const;
export const STRATEGY_COMPARISON_SCHEMA_ID = "cd-collab.strategy_comparison.v1" as const;
export const LAB_EXPORT_SCHEMA_ID = "cd-collab.experiment_lab_export.v1" as const;

export const TRACE_UNKNOWN_STAYS_UNKNOWN = "Ambiguous transcript structure stays unknown." as const;
export const TEXTUAL_SIMILARITY_NOT_WINNER = "Textual similarity is not a winner." as const;

export const TRACE_SOURCE_KINDS = ["programmatic", "plain_text"] as const;
export type TraceSourceKind = (typeof TRACE_SOURCE_KINDS)[number];

export const TRACE_COMPLETENESS = ["exact", "partial", "unknown"] as const;
export type TraceCompleteness = (typeof TRACE_COMPLETENESS)[number];

export const TRACE_EVENT_KINDS = [
  "question",
  "assistant_response",
  "tool_call",
  "tool_result",
  "evidence_anchor",
  "hypothesis",
  "recommendation",
  "human_annotation",
] as const;
export type TraceEventKind = (typeof TRACE_EVENT_KINDS)[number];

export const TRACE_ACTORS = ["human", "assistant", "tool", "importer", "unknown"] as const;
export type TraceActor = (typeof TRACE_ACTORS)[number];

export const MAX_TRACE_EXCERPT = 240;

const TURN_LABELS: Record<string, TraceEventKind> = {
  user: "question",
  human: "question",
  question: "question",
  assistant: "assistant_response",
  ai: "assistant_response",
  answer: "assistant_response",
  tool: "tool_call",
  "tool result": "tool_result",
  function: "tool_call",
  hypothesis: "hypothesis",
  recommendation: "recommendation",
  annotation: "human_annotation",
};

export type ObservedCountV1 =
  | { status: "unknown" }
  | { status: "observed"; count: number };

export type ObservedCostV1 =
  | { status: "unknown" }
  | { status: "observed"; amount: string };

export type ObservedTimestampV1 =
  | { status: "unknown" }
  | { status: "observed"; timestamp: string };

export interface TraceEfficiencyV1 {
  turnCount: ObservedCountV1;
  evidenceAcquisitionSteps: ObservedCountV1;
  latency: ObservedLatencyV1;
  cost: ObservedCostV1;
  providerCalls: ObservedCountV1;
}

export interface InteractionEventV1 {
  eventId: string;
  sequence: number;
  kind: TraceEventKind;
  actor: TraceActor;
  role: string | null;
  parentEventId: string | null;
  evidenceRefs: string[];
  observedAt: ObservedTimestampV1;
  excerpt: string | null;
  excerptHash: string | null;
  unknowns: string[];
}

export interface InteractionTraceV1 {
  schemaId: typeof INTERACTION_TRACE_SCHEMA_ID;
  traceId: string;
  candidateId: string;
  sourceKind: TraceSourceKind;
  completeness: TraceCompleteness;
  privacyClass: "share_safe";
  rawHash: string | null;
  events: InteractionEventV1[];
  efficiency: TraceEfficiencyV1;
  unknowns: string[];
  notes: string[];
  createdAt: string;
}

export interface PlainTranscriptV1 {
  schemaId: typeof PLAIN_TRANSCRIPT_SCHEMA_ID;
  candidateId: string;
  text: string;
}

export interface StrategyPackageV1 {
  schemaId: typeof STRATEGY_PACKAGE_SCHEMA_ID;
  privacyClass: "share_safe";
  experiment: ExperimentPackageV1 | ExperimentSummaryV1;
  traces: InteractionTraceV1[];
}

export interface QuestionPathV1 {
  pathId: string;
  excerpt: string | null;
  candidateIds: string[];
  eventIds: string[];
}

export interface SharedEvidenceV1 {
  evidenceRef: string;
  candidateIds: string[];
  firstSequence: { candidateId: string; sequence: number }[];
}

export interface UniqueEvidenceV1 {
  candidateId: string;
  evidenceRefs: string[];
}

export interface DiscoveryStepV1 {
  evidenceRef: string;
  candidateId: string;
  sequence: number;
}

export interface ConvergenceRowV1 {
  evidenceRef: string;
  candidateIds: string[];
  inGold: boolean;
}

export interface DivergenceRowV1 {
  kind: "evidence" | "role" | "hypothesis" | "question";
  summary: string;
  candidateIds: string[];
}

export interface StrategyComparisonV1 {
  schemaId: typeof STRATEGY_COMPARISON_SCHEMA_ID;
  packageId: string;
  questionPaths: QuestionPathV1[];
  sharedEvidence: SharedEvidenceV1[];
  uniqueEvidence: UniqueEvidenceV1[];
  discoveryOrder: DiscoveryStepV1[];
  roleConflicts: RoleConflictV1[];
  convergence: ConvergenceRowV1[];
  divergence: DivergenceRowV1[];
  efficiency: { candidateId: string; efficiency: TraceEfficiencyV1 }[];
  gold: {
    status: "present" | "unknown" | "absent";
    version: number | null;
    acceptedDecisionId: string | null;
  };
  helpfulness: { candidateId: string; state: HelpfulnessState }[];
  notes: string[];
}

export interface ExperimentLabExportV1 {
  schemaId: typeof LAB_EXPORT_SCHEMA_ID;
  privacyClass: "share_safe";
  review: ExperimentReviewExportV1;
  traces: InteractionTraceV1[];
  comparison: StrategyComparisonV1;
}

const countShape: ObjectShape = {
  status: f.req(f.en("unknown", "observed")),
  count: f.opt(f.u64),
};

const costShape: ObjectShape = {
  status: f.req(f.en("unknown", "observed")),
  amount: f.opt(f.str),
};

const timestampShape: ObjectShape = {
  status: f.req(f.en("unknown", "observed")),
  timestamp: f.opt(f.str),
};

const latencyShape: ObjectShape = {
  status: f.req(f.en("unknown", "observed")),
  milliseconds: f.opt(f.u64),
};

const efficiencyShape: ObjectShape = {
  turnCount: f.req(f.obj(countShape)),
  evidenceAcquisitionSteps: f.req(f.obj(countShape)),
  latency: f.req(f.obj(latencyShape)),
  cost: f.req(f.obj(costShape)),
  providerCalls: f.req(f.obj(countShape)),
};

export const interactionEventShape: ObjectShape = {
  eventId: f.req(f.str),
  sequence: f.req(f.u64),
  kind: f.req(f.en(...TRACE_EVENT_KINDS)),
  actor: f.req(f.en(...TRACE_ACTORS)),
  role: f.nul(f.str),
  parentEventId: f.nul(f.str),
  evidenceRefs: f.req(f.arr(f.str)),
  observedAt: f.req(f.obj(timestampShape)),
  excerpt: f.nul(f.str),
  excerptHash: f.nul(f.str),
  unknowns: f.req(f.arr(f.str)),
};

export const interactionTraceShape: ObjectShape = {
  schemaId: f.req(f.en(INTERACTION_TRACE_SCHEMA_ID)),
  traceId: f.req(f.str),
  candidateId: f.req(f.str),
  sourceKind: f.req(f.en(...TRACE_SOURCE_KINDS)),
  completeness: f.req(f.en(...TRACE_COMPLETENESS)),
  privacyClass: f.req(f.en("share_safe")),
  rawHash: f.nul(f.str),
  events: f.req(f.arr(f.obj(interactionEventShape))),
  efficiency: f.req(f.obj(efficiencyShape)),
  unknowns: f.req(f.arr(f.str)),
  notes: f.req(f.arr(f.str)),
  createdAt: f.req(f.str),
};

const plainShape: ObjectShape = {
  schemaId: f.req(f.en(PLAIN_TRANSCRIPT_SCHEMA_ID)),
  candidateId: f.req(f.str),
  text: f.req(f.str),
};

function assertCount(path: string, value: ObservedCountV1): void {
  if (value.status === "unknown") {
    if ("count" in value) throw new ContractViolation(`${path}.count`, "unknown must omit count");
    return;
  }
  if (typeof value.count !== "number") {
    throw new ContractViolation(`${path}.count`, "observed count requires count");
  }
}

function assertCost(path: string, value: ObservedCostV1): void {
  if (value.status === "unknown") {
    if ("amount" in value) throw new ContractViolation(`${path}.amount`, "unknown must omit amount");
    return;
  }
  if (typeof value.amount !== "string" || !value.amount.trim()) {
    throw new ContractViolation(`${path}.amount`, "observed cost requires amount");
  }
}

function assertTimestamp(path: string, value: ObservedTimestampV1): void {
  if (value.status === "unknown") {
    if ("timestamp" in value) {
      throw new ContractViolation(`${path}.timestamp`, "unknown must omit timestamp");
    }
    return;
  }
  if (typeof value.timestamp !== "string" || !value.timestamp.trim()) {
    throw new ContractViolation(`${path}.timestamp`, "observed timestamp is required");
  }
}

function assertLatency(path: string, value: ObservedLatencyV1): void {
  if (value.status === "unknown") {
    if ("milliseconds" in value) {
      throw new ContractViolation(`${path}.milliseconds`, "unknown latency must omit milliseconds");
    }
    return;
  }
  if (typeof value.milliseconds !== "number") {
    throw new ContractViolation(`${path}.milliseconds`, "observed latency requires milliseconds");
  }
}

function assertExcerpt(event: InteractionEventV1, path: string): void {
  if (event.excerpt && event.excerpt.length > MAX_TRACE_EXCERPT) {
    throw new ContractViolation(`${path}.excerpt`, `must be <= ${MAX_TRACE_EXCERPT} characters`);
  }
  if (event.excerpt && containsForbiddenExcerpt(event.excerpt)) {
    throw new ContractViolation(`${path}.excerpt`, "excerpt is not share-safe");
  }
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function containsForbiddenExcerpt(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("bearer ") ||
    lower.includes("ai-gateway.vercel.sh") ||
    lower.includes("apikey") ||
    lower.includes("api_key") ||
    lower.includes("authorization")
  );
}

export function boundExcerpt(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (containsForbiddenExcerpt(trimmed)) return "[redacted]";
  return trimmed.length <= MAX_TRACE_EXCERPT ? trimmed : trimmed.slice(0, MAX_TRACE_EXCERPT);
}

export function parseInteractionEvent(raw: unknown, path = "$"): InteractionEventV1 {
  checkObject(path, interactionEventShape, raw);
  const row = raw as InteractionEventV1;
  if (!row.eventId.trim()) throw new ContractViolation(`${path}.eventId`, "must not be empty");
  if (row.sequence < 1) throw new ContractViolation(`${path}.sequence`, "must be >= 1");
  assertTimestamp(`${path}.observedAt`, row.observedAt);
  assertExcerpt(row, path);
  return row;
}

export function parseInteractionTrace(raw: unknown): InteractionTraceV1 {
  checkObject("$", interactionTraceShape, raw);
  const row = raw as InteractionTraceV1;
  if (!row.traceId.trim() || !row.candidateId.trim()) {
    throw new ContractViolation("$", "traceId and candidateId are required");
  }
  if (row.sourceKind === "plain_text" && row.completeness === "exact") {
    throw new ContractViolation("$.completeness", "plain-text traces cannot claim exact completeness");
  }
  if (!row.notes.includes(TRACE_UNKNOWN_STAYS_UNKNOWN)) {
    throw new ContractViolation("$.notes", "must include the unknown-structure caveat");
  }
  assertCount("$.efficiency.turnCount", row.efficiency.turnCount);
  assertCount("$.efficiency.evidenceAcquisitionSteps", row.efficiency.evidenceAcquisitionSteps);
  assertCount("$.efficiency.providerCalls", row.efficiency.providerCalls);
  assertCost("$.efficiency.cost", row.efficiency.cost);
  assertLatency("$.efficiency.latency", row.efficiency.latency);
  const sequences = new Set<number>();
  const ids = new Set<string>();
  for (const [i, event] of row.events.entries()) {
    parseInteractionEvent(event, `$.events[${i}]`);
    if (sequences.has(event.sequence)) {
      throw new ContractViolation(`$.events[${i}].sequence`, "duplicate sequence");
    }
    sequences.add(event.sequence);
    if (ids.has(event.eventId)) {
      throw new ContractViolation(`$.events[${i}].eventId`, "duplicate eventId");
    }
    ids.add(event.eventId);
  }
  return row;
}

export function parsePlainTranscript(raw: unknown): PlainTranscriptV1 {
  checkObject("$", plainShape, raw);
  const row = raw as PlainTranscriptV1;
  if (!row.candidateId.trim()) throw new ContractViolation("$.candidateId", "must not be empty");
  if (!row.text.trim()) throw new ContractViolation("$.text", "must not be empty");
  return row;
}

function requireKeys(path: string, raw: unknown, keys: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ContractViolation(path, "expected object");
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) {
      throw new ContractViolation(`${path}.${key}`, "unknown key (contract drift)");
    }
  }
  for (const key of keys) {
    if (!(key in record)) throw new ContractViolation(`${path}.${key}`, "missing required key");
  }
  return record;
}

export function parseStrategyPackage(raw: unknown): StrategyPackageV1 {
  const record = requireKeys("$", raw, ["schemaId", "privacyClass", "experiment", "traces"]);
  if (record.schemaId !== STRATEGY_PACKAGE_SCHEMA_ID) {
    throw new ContractViolation("$.schemaId", `expected ${STRATEGY_PACKAGE_SCHEMA_ID}`);
  }
  if (record.privacyClass !== "share_safe") {
    throw new ContractViolation("$.privacyClass", "strategy packages must be share_safe");
  }
  if (!Array.isArray(record.traces)) {
    throw new ContractViolation("$.traces", "expected array");
  }
  const experiment = parseExperimentImport(record.experiment);
  const traces = record.traces.map((item, i) => {
    const trace = parseInteractionTrace(item);
    if (!experiment.candidates.some((c) => c.candidateId === trace.candidateId)) {
      throw new ContractViolation(`$.traces[${i}].candidateId`, "unknown candidateId");
    }
    return trace;
  });
  return {
    schemaId: STRATEGY_PACKAGE_SCHEMA_ID,
    privacyClass: "share_safe",
    experiment,
    traces,
  };
}

export type LabImport =
  | { kind: "experiment"; envelope: ExperimentPackageV1 | ExperimentSummaryV1 }
  | { kind: "strategy"; package: StrategyPackageV1 };

export function parseLabImport(raw: unknown): LabImport {
  if (!raw || typeof raw !== "object" || !("schemaId" in raw)) {
    throw new ContractViolation("$", "expected experiment or strategy package object");
  }
  const schemaId = (raw as { schemaId: unknown }).schemaId;
  if (schemaId === STRATEGY_PACKAGE_SCHEMA_ID) {
    return { kind: "strategy", package: parseStrategyPackage(raw) };
  }
  return { kind: "experiment", envelope: parseExperimentImport(raw) };
}

function actorForKind(kind: TraceEventKind): TraceActor {
  if (kind === "question" || kind === "human_annotation") return "human";
  if (kind === "tool_call" || kind === "tool_result") return "tool";
  return "assistant";
}

function matchTurnLabel(line: string): { label: string; body: string } | null {
  const idx = line.indexOf(":");
  if (idx <= 0) return null;
  const label = line.slice(0, idx).trim().toLowerCase();
  if (!(label in TURN_LABELS)) return null;
  return { label, body: line.slice(idx + 1).trim() };
}

export function extractEvidenceRefs(text: string): string[] {
  const found = text.match(/\bev-[a-z0-9][a-z0-9-]*\b/gi) ?? [];
  return [...new Set(found.map((id) => id.toLowerCase()))].sort();
}

function unknownEfficiency(): TraceEfficiencyV1 {
  return {
    turnCount: { status: "unknown" },
    evidenceAcquisitionSteps: { status: "unknown" },
    latency: { status: "unknown" },
    cost: { status: "unknown" },
    providerCalls: { status: "unknown" },
  };
}

export function extractPlainTranscript(
  text: string,
  candidateId: string,
  createdAt: string,
): InteractionTraceV1 {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const turns: { label: string; body: string }[] = [];
  let preamble = false;
  for (const line of lines) {
    const matched = matchTurnLabel(line);
    if (matched) {
      turns.push({ label: matched.label, body: matched.body });
    } else if (turns.length === 0) {
      if (line.trim()) preamble = true;
    } else {
      const last = turns[turns.length - 1];
      if (last) last.body = last.body ? `${last.body}\n${line}` : line;
    }
  }

  const unknowns: string[] = [];
  const events: InteractionEventV1[] = [];
  if (turns.length === 0) {
    unknowns.push("turns", "tools");
    const refs = extractEvidenceRefs(text);
    if (refs.length === 0) unknowns.push("evidence");
    events.push({
      eventId: `evt-${candidateId}-1`,
      sequence: 1,
      kind: "assistant_response",
      actor: "unknown",
      role: null,
      parentEventId: null,
      evidenceRefs: refs,
      observedAt: { status: "unknown" },
      excerpt: boundExcerpt(text),
      excerptHash: sha256Hex(text),
      unknowns: ["kind", "actor", "role", "timestamp"],
    });
  } else {
    if (preamble) unknowns.push("preamble");
    for (const [i, turn] of turns.entries()) {
      const sequence = i + 1;
      const kind = TURN_LABELS[turn.label] ?? "assistant_response";
      const refs = extractEvidenceRefs(turn.body);
      const eventUnknowns: string[] = ["timestamp"];
      if (!turn.body.trim()) eventUnknowns.push("text");
      if (kind === "tool_call" || kind === "tool_result") eventUnknowns.push("toolName");
      events.push({
        eventId: `evt-${candidateId}-${sequence}`,
        sequence,
        kind,
        actor: actorForKind(kind),
        role: null,
        parentEventId: sequence === 1 ? null : `evt-${candidateId}-${sequence - 1}`,
        evidenceRefs: refs,
        observedAt: { status: "unknown" },
        excerpt: boundExcerpt(turn.body),
        excerptHash: turn.body.trim() ? sha256Hex(turn.body) : null,
        unknowns: eventUnknowns,
      });
    }
    if (!events.some((event) => event.kind === "tool_call" || event.kind === "tool_result")) {
      unknowns.push("tools");
    }
    if (!events.some((event) => event.evidenceRefs.length > 0)) unknowns.push("evidence");
  }

  const evidenceSteps = events.filter((event) => event.evidenceRefs.length > 0).length;
  const efficiency = unknownEfficiency();
  if (turns.length > 0) {
    efficiency.turnCount = { status: "observed", count: turns.length };
  }
  if (evidenceSteps > 0) {
    efficiency.evidenceAcquisitionSteps = { status: "observed", count: evidenceSteps };
  }

  return parseInteractionTrace({
    schemaId: INTERACTION_TRACE_SCHEMA_ID,
    traceId: `trace-${candidateId}-${sha256Hex(text).slice(0, 12)}`,
    candidateId,
    sourceKind: "plain_text",
    completeness: turns.length === 0 ? "unknown" : "partial",
    privacyClass: "share_safe",
    rawHash: sha256Hex(text),
    events,
    efficiency,
    unknowns,
    notes: [TRACE_UNKNOWN_STAYS_UNKNOWN],
    createdAt,
  });
}

export function traceFingerprint(trace: InteractionTraceV1): string {
  return JSON.stringify({
    candidateId: trace.candidateId,
    sourceKind: trace.sourceKind,
    completeness: trace.completeness,
    rawHash: trace.rawHash,
    events: trace.events.map((event) => ({
      eventId: event.eventId,
      sequence: event.sequence,
      kind: event.kind,
      actor: event.actor,
      role: event.role,
      parentEventId: event.parentEventId,
      evidenceRefs: [...event.evidenceRefs].sort(),
      excerptHash: event.excerptHash,
      unknowns: [...event.unknowns].sort(),
    })),
    efficiency: trace.efficiency,
    unknowns: [...trace.unknowns].sort(),
  });
}

export function projectShareSafeTrace(trace: InteractionTraceV1): InteractionTraceV1 {
  return parseInteractionTrace({
    ...trace,
    privacyClass: "share_safe",
    events: trace.events.map((event) => ({
      ...event,
      evidenceRefs: [...event.evidenceRefs],
      unknowns: [...event.unknowns],
      excerpt: event.excerpt && containsForbiddenExcerpt(event.excerpt) ? "[redacted]" : event.excerpt,
    })),
    unknowns: [...trace.unknowns],
    notes: [...trace.notes],
  });
}

function emptyEfficiency(): TraceEfficiencyV1 {
  return unknownEfficiency();
}

export function buildStrategyComparison(input: {
  packageId: string;
  candidates: ExperimentCandidateV1[];
  traces: InteractionTraceV1[];
  agreement: ExperimentAgreementV1;
  gold: GoldReferenceV1 | null;
}): StrategyComparisonV1 {
  const tracesByCandidate = new Map(input.traces.map((trace) => [trace.candidateId, trace]));
  const evidence = new Map<string, Map<string, number>>();
  const hypotheses = new Map<string, string[]>();
  for (const candidate of input.candidates) {
    const refs = evidence.get(candidate.candidateId) ?? new Map<string, number>();
    const trace = tracesByCandidate.get(candidate.candidateId);
    if (trace) {
      for (const event of trace.events) {
        for (const ref of event.evidenceRefs) {
          if (!refs.has(ref)) refs.set(ref, event.sequence);
        }
        if (event.kind === "hypothesis") {
          const list = hypotheses.get(event.excerptHash ?? event.eventId) ?? [];
          list.push(candidate.candidateId);
          hypotheses.set(event.excerptHash ?? event.eventId, list);
        }
      }
    }
    for (const anchor of input.agreement.sharedAnchors) {
      if (anchor.candidateIds.includes(candidate.candidateId) && !refs.has(anchor.evidenceRef)) {
        refs.set(anchor.evidenceRef, 0);
      }
    }
    for (const row of input.agreement.candidateSpecific) {
      if (row.candidateId === candidate.candidateId) {
        for (const ref of row.evidenceRefs) if (!refs.has(ref)) refs.set(ref, 0);
      }
    }
    evidence.set(candidate.candidateId, refs);
  }

  const refOwners = new Map<string, string[]>();
  for (const [candidateId, refs] of evidence) {
    for (const ref of refs.keys()) {
      const owners = refOwners.get(ref) ?? [];
      owners.push(candidateId);
      refOwners.set(ref, owners);
    }
  }

  const sharedEvidence: SharedEvidenceV1[] = [];
  const uniqueEvidence: UniqueEvidenceV1[] = input.candidates.map((candidate) => ({
    candidateId: candidate.candidateId,
    evidenceRefs: [],
  }));
  for (const [evidenceRef, candidateIds] of [...refOwners.entries()].sort()) {
    const sortedIds = [...candidateIds].sort();
    if (sortedIds.length > 1) {
      sharedEvidence.push({
        evidenceRef,
        candidateIds: sortedIds,
        firstSequence: sortedIds.map((candidateId) => ({
          candidateId,
          sequence: evidence.get(candidateId)?.get(evidenceRef) ?? 0,
        })),
      });
    } else {
      const only = uniqueEvidence.find((row) => row.candidateId === sortedIds[0]);
      if (only) only.evidenceRefs.push(evidenceRef);
    }
  }

  const discoveryOrder: DiscoveryStepV1[] = [];
  for (const [candidateId, refs] of evidence) {
    for (const [evidenceRef, sequence] of refs) {
      discoveryOrder.push({ evidenceRef, candidateId, sequence });
    }
  }
  discoveryOrder.sort(
    (a, b) =>
      a.sequence - b.sequence ||
      a.candidateId.localeCompare(b.candidateId) ||
      a.evidenceRef.localeCompare(b.evidenceRef),
  );

  const questionGroups = new Map<string, QuestionPathV1>();
  for (const trace of input.traces) {
    for (const event of trace.events) {
      if (event.kind !== "question") continue;
      const pathId = event.excerptHash ?? event.eventId;
      const existing = questionGroups.get(pathId);
      if (existing) {
        if (!existing.candidateIds.includes(trace.candidateId)) existing.candidateIds.push(trace.candidateId);
        existing.eventIds.push(event.eventId);
      } else {
        questionGroups.set(pathId, {
          pathId,
          excerpt: event.excerpt,
          candidateIds: [trace.candidateId],
          eventIds: [event.eventId],
        });
      }
    }
  }
  const questionPaths = [...questionGroups.values()].sort((a, b) => a.pathId.localeCompare(b.pathId));

  const goldRefs = new Set(input.gold?.evidenceAnchors ?? []);
  const convergence: ConvergenceRowV1[] = sharedEvidence.map((row) => ({
    evidenceRef: row.evidenceRef,
    candidateIds: row.candidateIds,
    inGold: goldRefs.has(row.evidenceRef),
  }));

  const divergence: DivergenceRowV1[] = [];
  for (const row of uniqueEvidence) {
    if (row.evidenceRefs.length > 0) {
      divergence.push({
        kind: "evidence",
        summary: `${row.candidateId} cited candidate-specific evidence`,
        candidateIds: [row.candidateId],
      });
    }
  }
  for (const conflict of input.agreement.roleConflicts) {
    divergence.push({
      kind: "role",
      summary: `Role conflict on ${conflict.evidenceRef}`,
      candidateIds: conflict.assignments.map((a) => a.candidateId),
    });
  }
  if (questionPaths.length > 1) {
    divergence.push({
      kind: "question",
      summary: "Approaches asked different questions",
      candidateIds: [...new Set(questionPaths.flatMap((path) => path.candidateIds))],
    });
  }
  if (hypotheses.size > 1) {
    divergence.push({
      kind: "hypothesis",
      summary: "Hypotheses are not identical across approaches",
      candidateIds: [...new Set([...hypotheses.values()].flat())],
    });
  }

  const notes = [
    AGREEMENT_NOT_CORRECTNESS,
    GOLD_ALIGNMENT_NOT_CORRECTNESS,
    GOLD_IS_HUMAN_BENCHMARK,
    TRACE_UNKNOWN_STAYS_UNKNOWN,
    TEXTUAL_SIMILARITY_NOT_WINNER,
  ];

  return {
    schemaId: STRATEGY_COMPARISON_SCHEMA_ID,
    packageId: input.packageId,
    questionPaths,
    sharedEvidence,
    uniqueEvidence,
    discoveryOrder,
    roleConflicts: input.agreement.roleConflicts.map((row) => ({
      evidenceRef: row.evidenceRef,
      assignments: row.assignments.map((a) => ({ ...a })),
    })),
    convergence,
    divergence,
    efficiency: input.candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      efficiency: tracesByCandidate.get(candidate.candidateId)?.efficiency ?? emptyEfficiency(),
    })),
    gold: {
      status: input.gold ? "present" : "unknown",
      version: input.gold?.version ?? null,
      acceptedDecisionId: input.gold?.acceptedDecisionId ?? null,
    },
    helpfulness: input.candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      state: candidate.helpfulnessState,
    })),
    notes,
  };
}

const questionPathShape: ObjectShape = {
  pathId: f.req(f.str),
  excerpt: f.nul(f.str),
  candidateIds: f.req(f.arr(f.str)),
  eventIds: f.req(f.arr(f.str)),
};

const comparisonShape: ObjectShape = {
  schemaId: f.req(f.en(STRATEGY_COMPARISON_SCHEMA_ID)),
  packageId: f.req(f.str),
  questionPaths: f.req(f.arr(f.obj(questionPathShape))),
  sharedEvidence: f.req(
    f.arr(
      f.obj({
        evidenceRef: f.req(f.str),
        candidateIds: f.req(f.arr(f.str)),
        firstSequence: f.req(
          f.arr(f.obj({ candidateId: f.req(f.str), sequence: f.req(f.u64) })),
        ),
      }),
    ),
  ),
  uniqueEvidence: f.req(
    f.arr(f.obj({ candidateId: f.req(f.str), evidenceRefs: f.req(f.arr(f.str)) })),
  ),
  discoveryOrder: f.req(
    f.arr(
      f.obj({
        evidenceRef: f.req(f.str),
        candidateId: f.req(f.str),
        sequence: f.req(f.u64),
      }),
    ),
  ),
  roleConflicts: f.req(
    f.arr(
      f.obj({
        evidenceRef: f.req(f.str),
        assignments: f.req(f.arr(f.obj({ candidateId: f.req(f.str), role: f.req(f.str) }))),
      }),
    ),
  ),
  convergence: f.req(
    f.arr(
      f.obj({
        evidenceRef: f.req(f.str),
        candidateIds: f.req(f.arr(f.str)),
        inGold: f.req(f.bool),
      }),
    ),
  ),
  divergence: f.req(
    f.arr(
      f.obj({
        kind: f.req(f.en("evidence", "role", "hypothesis", "question")),
        summary: f.req(f.str),
        candidateIds: f.req(f.arr(f.str)),
      }),
    ),
  ),
  efficiency: f.req(
    f.arr(f.obj({ candidateId: f.req(f.str), efficiency: f.req(f.obj(efficiencyShape)) })),
  ),
  gold: f.req(
    f.obj({
      status: f.req(f.en("present", "unknown", "absent")),
      version: f.nul(f.u64),
      acceptedDecisionId: f.nul(f.str),
    }),
  ),
  helpfulness: f.req(
    f.arr(f.obj({ candidateId: f.req(f.str), state: f.req(f.en("unreviewed", "observed")) })),
  ),
  notes: f.req(f.arr(f.str)),
};

export function parseStrategyComparison(raw: unknown): StrategyComparisonV1 {
  checkObject("$", comparisonShape, raw);
  const row = raw as StrategyComparisonV1;
  for (const note of [
    AGREEMENT_NOT_CORRECTNESS,
    GOLD_ALIGNMENT_NOT_CORRECTNESS,
    TRACE_UNKNOWN_STAYS_UNKNOWN,
    TEXTUAL_SIMILARITY_NOT_WINNER,
  ]) {
    if (!row.notes.includes(note)) {
      throw new ContractViolation("$.notes", `must include ${note}`);
    }
  }
  return row;
}

export function parseLabExport(raw: unknown): ExperimentLabExportV1 {
  const record = requireKeys("$", raw, [
    "schemaId",
    "privacyClass",
    "review",
    "traces",
    "comparison",
  ]);
  if (record.schemaId !== LAB_EXPORT_SCHEMA_ID) {
    throw new ContractViolation("$.schemaId", `expected ${LAB_EXPORT_SCHEMA_ID}`);
  }
  if (record.privacyClass !== "share_safe") {
    throw new ContractViolation("$.privacyClass", "must be share_safe");
  }
  if (!Array.isArray(record.traces)) {
    throw new ContractViolation("$.traces", "expected array");
  }
  const traces = record.traces.map((item) => parseInteractionTrace(item));
  return {
    schemaId: LAB_EXPORT_SCHEMA_ID,
    privacyClass: "share_safe",
    review: parseExperimentReviewExport(record.review),
    traces,
    comparison: parseStrategyComparison(record.comparison),
  };
}
