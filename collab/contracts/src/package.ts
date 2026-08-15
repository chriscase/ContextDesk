import { checkObject, f, type ObjectShape } from "./parse.js";
import { PRIVACY_CLASSES } from "./case.js";

export const PACKAGE_SCHEMA_ID = "cd-collab.prompt_package.v1" as const;
export const PACKAGE_MANIFEST_SCHEMA_ID = "cd-collab.package_manifest.v1" as const;
export const PACKAGE_ITEM_KINDS = ["artifact", "contribution"] as const;
export type PackageItemKind = (typeof PACKAGE_ITEM_KINDS)[number];
export const PACKAGE_DEFAULT_EXCLUSIONS = ["corroboration", "resolution"] as const;

export interface PackageManifestItemV1 {
  kind: PackageItemKind;
  id: string;
  contentHash: string;
  privacyClass: (typeof PRIVACY_CLASSES)[number];
}

export interface PackageManifestV1 {
  schemaId: typeof PACKAGE_MANIFEST_SCHEMA_ID;
  caseId: string;
  variant: (typeof PRIVACY_CLASSES)[number];
  items: PackageManifestItemV1[];
  promptScaffoldHash: string | null;
  excludedByDefault: string[];
}

export interface PackageExcerptV1 {
  kind: PackageItemKind;
  id: string;
  contentHash: string;
  sourceLabel: string;
  privacyClass: (typeof PRIVACY_CLASSES)[number];
  content: string | null;
  bodyIncluded: boolean;
}

export interface PromptPackageV1 {
  schemaId: typeof PACKAGE_SCHEMA_ID;
  privacyClass: (typeof PRIVACY_CLASSES)[number];
  caseId: string;
  snapshotIdentity: string;
  manifest: PackageManifestV1;
  excerpts: PackageExcerptV1[];
  promptScaffold: string | null;
}

const itemShape: ObjectShape = {
  kind: f.req(f.en(...PACKAGE_ITEM_KINDS)),
  id: f.req(f.str),
  contentHash: f.req(f.str),
  privacyClass: f.req(f.en(...PRIVACY_CLASSES)),
};

export const packageManifestShape: ObjectShape = {
  schemaId: f.req(f.en(PACKAGE_MANIFEST_SCHEMA_ID)),
  caseId: f.req(f.str),
  variant: f.req(f.en(...PRIVACY_CLASSES)),
  items: f.req(f.arr(f.obj(itemShape))),
  promptScaffoldHash: f.nul(f.str),
  excludedByDefault: f.req(f.arr(f.str)),
};

const excerptShape: ObjectShape = {
  kind: f.req(f.en(...PACKAGE_ITEM_KINDS)),
  id: f.req(f.str),
  contentHash: f.req(f.str),
  sourceLabel: f.req(f.str),
  privacyClass: f.req(f.en(...PRIVACY_CLASSES)),
  content: f.nul(f.str),
  bodyIncluded: f.req(f.bool),
};

export const promptPackageShape: ObjectShape = {
  schemaId: f.req(f.en(PACKAGE_SCHEMA_ID)),
  privacyClass: f.req(f.en(...PRIVACY_CLASSES)),
  caseId: f.req(f.str),
  snapshotIdentity: f.req(f.str),
  manifest: f.req(f.obj(packageManifestShape)),
  excerpts: f.req(f.arr(f.obj(excerptShape))),
  promptScaffold: f.nul(f.str),
};

export function parsePackageManifest(raw: unknown): PackageManifestV1 {
  checkObject("$", packageManifestShape, raw);
  return raw as PackageManifestV1;
}

export function parsePromptPackage(raw: unknown): PromptPackageV1 {
  checkObject("$", promptPackageShape, raw);
  return raw as PromptPackageV1;
}
