import { ContractViolation, checkObject, f, type ObjectShape } from "./parse.js";
import { hasDangerousUnicode } from "./user-profile.js";
import type { ArtifactAnnotationV1 } from "./artifact-annotation.js";

export const MAX_EVIDENCE_LABEL_LENGTH = 120;
/** Separate public/protected allocations prevent hidden capacity from changing public outcomes. */
export const MAX_EVIDENCE_LABEL_EVENTS_PER_CASE = 25_000;
export interface EvidenceLabelMutationV1 { label: string; operation: "add" | "remove" }
export interface EvidenceLabelEventV1 extends EvidenceLabelMutationV1 {
  /** Artifact/privacy-lane order, serialized under the case lock; exposes no hidden-event count. */
  sequence: number;
  intentKey: string;
}
export interface EvidenceLabelStateV1 { artifactId: string; label: string }
export const evidenceLabelMutationShape: ObjectShape = {
  label: f.req(f.nstr), operation: f.req(f.en("add", "remove")),
};
export const evidenceLabelEventShape: ObjectShape = {
  ...evidenceLabelMutationShape, sequence: f.req(f.u64), intentKey: f.req(f.nstr),
};
/** Exact wire text: trim at the editor, reject drift rather than silently folding. */
export function parseEvidenceLabel(value: unknown, path = "$.label"): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_EVIDENCE_LABEL_LENGTH
    || value !== value.trim() || hasDangerousUnicode(value) || /[\u2028\u2029]/.test(value)) {
    throw new ContractViolation(path, "expected 1..120 trimmed safe single-line characters");
  }
  return value;
}
export function parseEvidenceLabelMutation(raw: unknown): EvidenceLabelMutationV1 {
  checkObject("$.labelMutation", evidenceLabelMutationShape, raw);
  const mutation = raw as EvidenceLabelMutationV1;
  parseEvidenceLabel(mutation.label);
  return mutation;
}
export function parseEvidenceLabelEvent(raw: unknown): EvidenceLabelEventV1 {
  checkObject("$.labelEvent", evidenceLabelEventShape, raw);
  const event = raw as EvidenceLabelEventV1;
  parseEvidenceLabel(event.label);
  if (event.sequence < 1 || event.sequence > MAX_EVIDENCE_LABEL_EVENTS_PER_CASE
    || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/.test(event.intentKey)) {
    throw new ContractViolation("$.labelEvent", "invalid bounded sequence or intent identity");
  }
  return event;
}
/** Filter history for caller privacy BEFORE projection. Privacy lanes never cancel each other. */
export function projectEvidenceLabels(history: readonly Pick<ArtifactAnnotationV1, "artifactId" | "privacyClass" | "labelEvent">[]): EvidenceLabelStateV1[] {
  const active = new Map<string, EvidenceLabelStateV1>();
  for (const row of [...history].filter(row => row.labelEvent !== undefined)
    .sort((a, b) => a.labelEvent!.sequence - b.labelEvent!.sequence)) {
    const event = row.labelEvent!;
    const key = JSON.stringify([row.artifactId, event.label, row.privacyClass]);
    if (event.operation === "add") active.set(key, { artifactId: row.artifactId, label: event.label });
    else active.delete(key);
  }
  const visible = new Map([...active.values()].map(row => [JSON.stringify([row.artifactId, row.label]), row]));
  return [...visible.values()].sort((a,b) => a.artifactId < b.artifactId ? -1 : a.artifactId > b.artifactId ? 1 : a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
}
