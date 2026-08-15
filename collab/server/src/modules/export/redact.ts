import type { PrivacyClass } from "@cd-collab/contracts";
import type { ExportPrivacyConfig } from "./config.js";

export function shareSafeLabel(
  raw: string,
  config: ExportPrivacyConfig,
  variant: PrivacyClass,
): string {
  if (variant === "owner_only") return raw;
  return config.identityRedactions[raw] ?? "participant";
}

export function containsRedactionMap(text: string, config: ExportPrivacyConfig): boolean {
  if (text.includes("identityRedactions") || text.includes("redactionMap")) return true;
  return Object.keys(config.identityRedactions).some((key) => key.includes("=") && text.includes(key));
}
