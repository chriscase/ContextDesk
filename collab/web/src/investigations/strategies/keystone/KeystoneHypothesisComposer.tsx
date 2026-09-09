import {
  EvidenceHypothesisComposer,
  type EvidenceHypothesisComposerProps,
  type EvidenceHypothesisEvidence,
} from "../shared/index.js";

export type KeystoneHypothesisEvidence = EvidenceHypothesisEvidence;
export type KeystoneHypothesisComposerProps = Omit<
  EvidenceHypothesisComposerProps,
  "idempotencyKeyPrefix"
>;

/** Compatibility surface for Keystone; shared behavior lives in the presentation kit. */
export function KeystoneHypothesisComposer(props: KeystoneHypothesisComposerProps) {
  return <EvidenceHypothesisComposer {...props} idempotencyKeyPrefix="keystone-hypothesis-" />;
}
