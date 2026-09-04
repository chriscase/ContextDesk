/**
 * Browser-safe re-export of the authoritative artifact-annotation contract.
 *
 * Keeping this adapter tiny prevents strategies and the runtime gateway from
 * importing the server-oriented contracts barrel. The parser itself lives in
 * `@cd-collab/contracts/evidence-annotations`, so browser and server cannot
 * silently drift on identity or envelope validation.
 */
export {
  ARTIFACT_ANNOTATION_LIST_SCHEMA_ID,
  ARTIFACT_ANNOTATION_SCHEMA_ID,
  ARTIFACT_ANNOTATION_BULK_REQUEST_SCHEMA_ID,
  ARTIFACT_ANNOTATION_BULK_RESULT_SCHEMA_ID,
  ARTIFACT_ANNOTATION_BULK_OUTCOMES,
  MAX_ARTIFACT_ANNOTATION_BULK_IDS,
  parseArtifactAnnotation,
  parseArtifactAnnotationBulkRequest,
  parseArtifactAnnotationBulkResult,
  parseArtifactAnnotationList,
} from "@cd-collab/contracts/evidence-annotations";
export type {
  ArtifactAnnotationBulkItemV1,
  ArtifactAnnotationBulkOutcome,
  ArtifactAnnotationBulkRequestV1,
  ArtifactAnnotationBulkResultV1,
  ArtifactAnnotationListV1,
  ArtifactAnnotationV1,
} from "@cd-collab/contracts/evidence-annotations";
