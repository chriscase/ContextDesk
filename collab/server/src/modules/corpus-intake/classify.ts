import { createHash } from "node:crypto";
import type {
  ArtifactKind,
  CorpusAllowedMedia,
  CorpusIntakeLimitsV1,
  CorpusRejectionReason,
  CorpusTextEncodingStatus,
  PrivacyClass,
} from "@cd-collab/contracts";
import { classifyStream } from "./classify-stream.js";

export interface ClassifiedFile {
  relativePath: string;
  mediaType: CorpusAllowedMedia;
  artifactKind: ArtifactKind;
  bytes: Uint8Array;
  digest: string;
  encodingStatus: CorpusTextEncodingStatus;
}

export interface ClassifiedRejection {
  relativePath: string;
  reason: CorpusRejectionReason;
  detail: string;
}

export function digestOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Classify one already-resident member.
 *
 * The inline lane holds a bounded selection in memory, so it can hand the whole
 * buffer over; the decision itself runs through the same streaming classifier
 * the large-corpus lane uses, so the two lanes cannot drift on what counts as
 * text, as JSON Lines, or as share-safe.
 */
export async function classifyBytes(
  relativePath: string,
  bytes: Uint8Array,
  claimedMedia: string | undefined,
  privacyClass: PrivacyClass,
  limits?: CorpusIntakeLimitsV1,
): Promise<ClassifiedFile | ClassifiedRejection> {
  const result = await classifyStream({
    relativePath,
    claimedMedia,
    privacyClass,
    ...(limits ? { limits } : {}),
    bytes: (async function* () {
      yield bytes;
    })(),
  });
  if (!result.ok) {
    return {
      relativePath: result.relativePath,
      reason: result.reason,
      detail: result.detail,
    };
  }
  return {
    relativePath: result.relativePath,
    mediaType: result.mediaType,
    artifactKind: result.artifactKind,
    bytes,
    digest: result.digest,
    encodingStatus: result.encodingStatus,
  };
}
