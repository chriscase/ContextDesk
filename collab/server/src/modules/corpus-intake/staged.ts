import type {
  ArtifactKind,
  CorpusIntakeOrigin,
  CorpusRejectedFileV1,
  CorpusTextEncodingStatus,
  PrivacyClass,
} from "@cd-collab/contracts";

export interface StagedCorpusEntry {
  relativePath: string;
  mediaType: string;
  artifactKind: ArtifactKind;
  digest: string;
  byteLength: number;
  encodingStatus: CorpusTextEncodingStatus;
}

/**
 * One resolved intake, ready to persist.
 *
 * `loadBytes` is deliberately a callback rather than a byte array: the streamed
 * lane reads one staged member from the spool at a time, so the persistence
 * path never holds more than a single member however large the corpus is.
 */
export interface StagedCorpusIntake {
  origin: CorpusIntakeOrigin;
  sourceLabel: string;
  privacyClass: PrivacyClass;
  idempotencyKey: string;
  requestDigest: string;
  entries: StagedCorpusEntry[];
  rejected: CorpusRejectedFileV1[];
  loadBytes: (digest: string) => Promise<Uint8Array>;
}
