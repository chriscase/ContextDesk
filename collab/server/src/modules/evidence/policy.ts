export const MAX_UPLOAD_BYTES = 1_000_000;
export const MAX_JSON_EVIDENCE_BYTES = MAX_UPLOAD_BYTES;

export const STREAM_ARTIFACT_KINDS = ["log", "email", "attachment"] as const;
export type StreamArtifactKind = (typeof STREAM_ARTIFACT_KINDS)[number];

export const ALLOWED_MEDIA = new Set([
  "text/plain",
  "text/x-log",
  "message/rfc822",
  "application/octet-stream",
]);

export function isStreamArtifactKind(kind: string): kind is StreamArtifactKind {
  return (STREAM_ARTIFACT_KINDS as readonly string[]).includes(kind);
}

export function assertFilenameAllowed(filename: string): void {
  if (filename.length === 0 || filename.includes("\0")) {
    throw new Error("filename is invalid");
  }
  if (filename.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(filename)) {
    throw new Error("filename must be relative");
  }
  const segments = filename.split(/[\\/]/u);
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("filename contains an invalid path segment");
  }
}

export function assertMediaTypeAllowed(mediaType: string): void {
  if (!ALLOWED_MEDIA.has(mediaType)) {
    throw new Error(`media type not allowlisted: ${mediaType}`);
  }
}

export function assertUploadAllowed(mediaType: string, byteLength: number): void {
  if (byteLength > MAX_UPLOAD_BYTES) {
    throw new Error("upload exceeds size cap");
  }
  assertMediaTypeAllowed(mediaType);
}

export function assertJsonBytesAllowed(byteLength: number): void {
  if (byteLength > MAX_JSON_EVIDENCE_BYTES) {
    throw new Error("too_large_for_json_bytes");
  }
}
