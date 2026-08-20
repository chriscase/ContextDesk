export const MAX_UPLOAD_BYTES = 1_000_000;

export const ALLOWED_MEDIA = new Set([
  "text/plain",
  "text/x-log",
  "message/rfc822",
  "application/octet-stream",
]);

export function assertUploadAllowed(mediaType: string, byteLength: number): void {
  if (byteLength > MAX_UPLOAD_BYTES) {
    throw new Error("upload exceeds size cap");
  }
  if (!ALLOWED_MEDIA.has(mediaType)) {
    throw new Error(`media type not allowlisted: ${mediaType}`);
  }
}

/** Reject path traversal and absolute names; bytes are content-addressed. */
export function assertSafeFilename(filename: string | undefined): void {
  if (filename === undefined) return;
  if (!filename.trim() || filename !== filename.trim()) {
    throw new Error("filename is empty or padded");
  }
  if (
    filename.includes("\0") ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes("..") ||
    /^[a-zA-Z]:/.test(filename)
  ) {
    throw new Error("filename must be a single path segment");
  }
}
