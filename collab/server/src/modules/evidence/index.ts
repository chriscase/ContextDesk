/** Case evidence artifacts over the EvidenceStore interface. */
export const MODULE_ID = "evidence" as const;

export {
  ALLOWED_MEDIA,
  MAX_UPLOAD_BYTES,
  assertFilenameAllowed,
  assertUploadAllowed,
} from "./policy.js";
