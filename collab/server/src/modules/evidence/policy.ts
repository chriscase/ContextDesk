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
