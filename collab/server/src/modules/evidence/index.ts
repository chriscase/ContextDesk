/** Case evidence artifacts over the EvidenceStore interface. */
export const MODULE_ID = "evidence" as const;

export {
  ALLOWED_MEDIA,
  MAX_UPLOAD_BYTES,
  assertSafeFilename,
  assertUploadAllowed,
} from "./policy.js";
