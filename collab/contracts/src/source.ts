import { checkObject, f, type ObjectShape } from "./parse.js";

export const SOURCE_KINDS = [
  "human",
  "external-tool",
  "internal-system",
  "contextdesk",
  "unknown",
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const SOURCE_LIFECYCLES = ["active", "retired"] as const;
export type SourceLifecycle = (typeof SOURCE_LIFECYCLES)[number];

export const SOURCE_SCHEMA_ID = "cd-collab.source.v1" as const;
export const SOURCE_LIST_SCHEMA_ID = "cd-collab.source_list.v1" as const;

export const PERMANENT_UNKNOWN_SOURCE_ID = "00000000-0000-0000-0000-000000000001";

export interface SourceV1 {
  schemaId: typeof SOURCE_SCHEMA_ID;
  id: string;
  name: string;
  kind: SourceKind;
  description: string | null;
  lifecycle: SourceLifecycle;
  identityId: string | null;
  createdAt: string;
  createdBy: string;
}

const sourceShape: ObjectShape = {
  schemaId: f.req(f.en(SOURCE_SCHEMA_ID)),
  id: f.req(f.str),
  name: f.req(f.str),
  kind: f.req(f.en(...SOURCE_KINDS)),
  description: f.nul(f.str),
  lifecycle: f.req(f.en(...SOURCE_LIFECYCLES)),
  identityId: f.nul(f.str),
  createdAt: f.req(f.str),
  createdBy: f.req(f.str),
};

export function parseSource(raw: unknown): SourceV1 {
  checkObject("$", sourceShape, raw);
  return raw as SourceV1;
}

export interface SourceListV1 {
  schemaId: typeof SOURCE_LIST_SCHEMA_ID;
  sources: SourceV1[];
}

const sourceListShape: ObjectShape = {
  schemaId: f.req(f.en(SOURCE_LIST_SCHEMA_ID)),
  sources: f.req(f.arr(f.obj(sourceShape))),
};

export function parseSourceList(raw: unknown): SourceListV1 {
  checkObject("$", sourceListShape, raw);
  return raw as SourceListV1;
}
