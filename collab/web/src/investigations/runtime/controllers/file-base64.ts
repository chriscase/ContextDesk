import type { ArtifactKind, PrivacyClass } from "@cd-collab/contracts/investigation-runtime";
import type { UploadEvidenceInput } from "../gateway.js";
import {
  MAX_EVIDENCE_UPLOAD_BYTES,
  type CommandOutcome,
} from "../types.js";

export interface PrepareEvidenceUploadOptions {
  readonly kind?: ArtifactKind;
  readonly privacyClass?: PrivacyClass;
  readonly clientTime?: string;
  readonly sourceId?: string;
}

function failed(
  field: "file" | "summary",
  reason: "required" | "too_large" | "unreadable",
): CommandOutcome<UploadEvidenceInput> {
  return { status: "failed", error: { kind: "input", field, reason } };
}

function filenameOf(blob: Blob): string | undefined {
  const candidate: unknown = (blob as { readonly name?: unknown }).name;
  if (typeof candidate !== "string") return undefined;
  const filename = candidate.trim();
  return filename.length > 0 ? filename : undefined;
}

function encodeBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function readWithFileReader(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result);
      else reject();
    }, { once: true });
    reader.addEventListener("error", () => reject(), { once: true });
    reader.addEventListener("abort", () => reject(), { once: true });
    reader.readAsArrayBuffer(blob);
  });
}

function readBlob(blob: Blob): Promise<ArrayBuffer> {
  const modernReader: unknown = (blob as { readonly arrayBuffer?: unknown }).arrayBuffer;
  return typeof modernReader === "function"
    ? blob.arrayBuffer()
    : readWithFileReader(blob);
}

/**
 * Validate and read a browser file without accepting a route or case identity.
 * The returned value is ready for the typed runtime gateway.
 */
export async function prepareEvidenceUpload(
  file: Blob | null | undefined,
  summary: string,
  options: PrepareEvidenceUploadOptions = {},
): Promise<CommandOutcome<UploadEvidenceInput>> {
  if (file === null || file === undefined) return failed("file", "required");

  const trimmedSummary = summary.trim();
  if (trimmedSummary.length === 0) return failed("summary", "required");
  if (file.size > MAX_EVIDENCE_UPLOAD_BYTES) return failed("file", "too_large");

  let contentBase64: string;
  try {
    contentBase64 = encodeBase64(await readBlob(file));
  } catch {
    return failed("file", "unreadable");
  }

  const filename = filenameOf(file);
  const value: UploadEvidenceInput = {
    kind: options.kind ?? "attachment",
    summary: trimmedSummary,
    mediaType: file.type.trim() || "application/octet-stream",
    contentBase64,
    ...(filename === undefined ? {} : { filename }),
    ...(options.privacyClass === undefined
      ? {}
      : { privacyClass: options.privacyClass }),
    ...(options.clientTime === undefined ? {} : { clientTime: options.clientTime }),
    ...(options.sourceId === undefined ? {} : { sourceId: options.sourceId }),
  };
  return { status: "succeeded", value };
}
