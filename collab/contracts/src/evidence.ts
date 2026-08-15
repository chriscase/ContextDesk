import { checkObject, f, type ObjectShape } from "./parse.js";

/** Content-addressed blob digest: lowercase hex SHA-256. */
export type ContentHash = string;

export type VerificationStatus = "verified" | "unverified" | "unreachable";

export const FILE_SERVER_REF_SCHEMA_ID = "cd-collab.file_server_ref.v1" as const;

/**
 * Controlled file-server reference. Bytes stay at the URI; the store never
 * silently fetches or caches remote content. Verification is an explicit,
 * recorded operation against `expectedHash` when known.
 *
 * A reference whose target was never hashed has `expectedHash: null` and must
 * remain `verificationStatus: "unverified"` — it is representable and visibly
 * unverifiable, never silently treated as verified.
 */
export interface FileServerReferenceV1 {
  schemaId: typeof FILE_SERVER_REF_SCHEMA_ID;
  id: string;
  uri: string;
  /** Null when the remote target has never been hashed. */
  expectedHash: ContentHash | null;
  verificationStatus: VerificationStatus;
}

const fileServerRefShape: ObjectShape = {
  schemaId: f.req(f.en(FILE_SERVER_REF_SCHEMA_ID)),
  id: f.req(f.str),
  uri: f.req(f.str),
  expectedHash: f.nul(f.str),
  verificationStatus: f.req(f.en("verified", "unverified", "unreachable")),
};

export function parseFileServerReference(raw: unknown): FileServerReferenceV1 {
  checkObject("$", fileServerRefShape, raw);
  const ref = raw as FileServerReferenceV1;
  if (ref.verificationStatus === "verified" && ref.expectedHash === null) {
    throw new Error(
      "$.verificationStatus: verified requires a non-null expectedHash",
    );
  }
  return ref;
}

export interface BlobMetaV1 {
  hash: ContentHash;
  byteLength: number;
  contentType: string | null;
}
