import { createHash } from "node:crypto";
import type { SourceV1 } from "@cd-collab/contracts";

function isDirectoryDn(raw: string): boolean {
  return /(?:^|,)\s*(?:uid|cn|ou|dc|o|c)=[^,]+/i.test(raw) && raw.includes(",");
}

function uidFromDn(raw: string): string | null {
  const match = /(?:^|,)\s*uid=([^,]+)/i.exec(raw);
  const value = match?.[1]?.trim();
  return value && value.length > 0 ? value : null;
}

export function directoryAttribution(raw: string): string {
  return `attr:${createHash("sha256").update(raw, "utf8").digest("hex")}`;
}

export function isDirectoryIdentity(raw: string): boolean {
  return isDirectoryDn(raw);
}

export function projectSourceForCaller(
  source: SourceV1,
  canSeeDirectoryIdentities: boolean,
): SourceV1 {
  if (canSeeDirectoryIdentities) return source;
  const identityId =
    source.identityId && isDirectoryIdentity(source.identityId) ? null : source.identityId;
  const createdBy = isDirectoryIdentity(source.createdBy)
    ? directoryAttribution(source.createdBy)
    : source.createdBy;
  const boundUid = source.identityId ? uidFromDn(source.identityId) : null;
  const nameIsDirectory =
    isDirectoryIdentity(source.name) ||
    (source.kind === "human" &&
      boundUid !== null &&
      (source.name === boundUid || source.name === source.identityId));
  return {
    ...source,
    identityId,
    createdBy,
    name: nameIsDirectory ? source.id : source.name,
  };
}
