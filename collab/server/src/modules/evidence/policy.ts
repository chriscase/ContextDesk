export const MAX_UPLOAD_BYTES = 1_000_000;

export const ALLOWED_MEDIA = new Set([
  "text/plain",
  "text/x-log",
  "message/rfc822",
  "application/octet-stream",
]);

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

export function assertUploadAllowed(mediaType: string, byteLength: number): void {
  if (byteLength > MAX_UPLOAD_BYTES) {
    throw new Error("upload exceeds size cap");
  }
  if (!ALLOWED_MEDIA.has(mediaType)) {
    throw new Error(`media type not allowlisted: ${mediaType}`);
  }
}
