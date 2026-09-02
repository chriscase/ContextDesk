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
  parseArtifactAnnotation,
  parseArtifactAnnotationList,
} from "@cd-collab/contracts/evidence-annotations";
export type {
  ArtifactAnnotationListV1,
  ArtifactAnnotationV1,
} from "@cd-collab/contracts/evidence-annotations";
