/**
 * Browser-safe evidence annotation contract entry point.
 *
 * Keep this leaf separate from the server-facing contract barrel: the latter
 * intentionally includes Node-only helpers, while Runtime consumers need
 * only the versioned annotation DTOs and parsers.
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
} from "./artifact-annotation.js";
export type {
  ArtifactAnnotationBulkItemV1,
  ArtifactAnnotationBulkOutcome,
  ArtifactAnnotationBulkRequestV1,
  ArtifactAnnotationBulkResultV1,
  ArtifactAnnotationListV1,
  ArtifactAnnotationV1,
} from "./artifact-annotation.js";
