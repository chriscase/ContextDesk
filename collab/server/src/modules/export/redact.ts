import type { PrivacyClass } from "@cd-collab/contracts";
import type { ExportPrivacyConfig } from "./config.js";

export type ShareSafeField = "identity" | "source" | "target";

function isUuid(raw: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw);
}

function isDirectoryDn(raw: string): boolean {
  return /(?:^|,)\s*(?:uid|cn|ou|dc|o|c)=[^,]+/i.test(raw) && raw.includes(",");
}

export function shareSafeLabel(
  raw: string,
  config: ExportPrivacyConfig,
  variant: PrivacyClass,
  field: ShareSafeField = "identity",
): string {
  if (variant === "owner_only") return raw;
  const mapped = config.identityRedactions[raw];
  if (mapped) return mapped;
  if (field === "source") return isDirectoryDn(raw) ? "participant" : raw;
  if (field === "target" && isUuid(raw)) return raw;
  return "participant";
}

export function containsRedactionMap(text: string, config: ExportPrivacyConfig): boolean {
  if (text.includes("identityRedactions") || text.includes("redactionMap")) return true;
  return Object.keys(config.identityRedactions).some((key) => text.includes(key));
}
