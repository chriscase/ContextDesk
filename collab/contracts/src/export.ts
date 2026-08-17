import { checkObject, checkValue, ContractViolation, f, type ObjectShape } from "./parse.js";
import { PRIVACY_CLASSES } from "./case.js";
import { parseBrief, type BriefV1 } from "./brief.js";
import { parsePromptPackage, type PromptPackageV1 } from "./package.js";

export const EXPORT_ENVELOPE_SCHEMA_ID = "cd-collab.export_envelope.v1" as const;
export const EXPORT_INVENTORY_SCHEMA_ID = "cd-collab.export_inventory.v1" as const;
export const EXPORT_KINDS = ["brief", "package"] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

export interface ExportEnvelopeV1 {
  schemaId: typeof EXPORT_ENVELOPE_SCHEMA_ID;
  kind: ExportKind;
  privacyClass: (typeof PRIVACY_CLASSES)[number];
  exportedAt: string;
  payload: BriefV1 | PromptPackageV1;
  markdown: string;
}

export interface ExportInventoryItemV1 {
  kind: "artifact" | "contribution";
  id: string;
  label: string;
  privacyClass: (typeof PRIVACY_CLASSES)[number];
  contentHash: string | null;
  excludedByDefault: boolean;
}

export interface ExportInventoryV1 {
  schemaId: typeof EXPORT_INVENTORY_SCHEMA_ID;
  caseId: string;
  items: ExportInventoryItemV1[];
}

const ENVELOPE_KEYS = [
  "schemaId",
  "kind",
  "privacyClass",
  "exportedAt",
  "payload",
  "markdown",
] as const;

export function parseExportEnvelope(raw: unknown): ExportEnvelopeV1 {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ContractViolation("$", "expected object");
  }
  const rec = raw as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (!(ENVELOPE_KEYS as readonly string[]).includes(key)) {
      throw new ContractViolation(`$.${key}`, "unknown key (contract drift)");
    }
  }
  for (const key of ENVELOPE_KEYS) {
    if (!(key in rec)) {
      throw new ContractViolation(`$.${key}`, "missing required key");
    }
  }
  checkValue("$.schemaId", f.en(EXPORT_ENVELOPE_SCHEMA_ID), rec.schemaId);
  checkValue("$.kind", f.en(...EXPORT_KINDS), rec.kind);
  checkValue("$.privacyClass", f.en(...PRIVACY_CLASSES), rec.privacyClass);
  checkValue("$.exportedAt", f.str, rec.exportedAt);
  checkValue("$.markdown", f.str, rec.markdown);
  const kind = rec.kind as ExportKind;
  const payload =
    kind === "brief" ? parseBrief(rec.payload) : parsePromptPackage(rec.payload);
  return {
    schemaId: EXPORT_ENVELOPE_SCHEMA_ID,
    kind,
    privacyClass: rec.privacyClass as ExportEnvelopeV1["privacyClass"],
    exportedAt: rec.exportedAt as string,
    payload,
    markdown: rec.markdown as string,
  };
}

const inventoryItemShape: ObjectShape = {
  kind: f.req(f.en("artifact", "contribution")),
  id: f.req(f.str),
  label: f.req(f.str),
  privacyClass: f.req(f.en(...PRIVACY_CLASSES)),
  contentHash: f.nul(f.str),
  excludedByDefault: f.req(f.bool),
};

const inventoryShape: ObjectShape = {
  schemaId: f.req(f.en(EXPORT_INVENTORY_SCHEMA_ID)),
  caseId: f.req(f.str),
  items: f.req(f.arr(f.obj(inventoryItemShape))),
};

export function parseExportInventory(raw: unknown): ExportInventoryV1 {
  checkObject("$", inventoryShape, raw);
  return raw as ExportInventoryV1;
}
