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
  parseArtifactAnnotation,
  parseArtifactAnnotationList,
} from "./artifact-annotation.js";
export type {
  ArtifactAnnotationListV1,
  ArtifactAnnotationV1,
} from "./artifact-annotation.js";
