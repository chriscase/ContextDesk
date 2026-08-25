import { checkObject, f, type ObjectShape } from "./parse.js";

export const ADMIN_AUDIT_LIST_SCHEMA_ID = "cd-collab.admin_audit_list.v1" as const;
export const ADMIN_AUDIT_MAX_RESULTS = 100;

export interface AdminAuditEventV1 {
  at: string;
  identity: string | null;
  action: string;
  target: string | null;
  outcome: "success" | "denied" | "failure";
}

export interface AdminAuditListV1 {
  schemaId: typeof ADMIN_AUDIT_LIST_SCHEMA_ID;
  events: AdminAuditEventV1[];
  limit: number;
  truncated: boolean;
}

const eventShape: ObjectShape = {
  at: f.req(f.nstr),
  identity: f.nul(f.str),
  action: f.req(f.nstr),
  target: f.nul(f.str),
  outcome: f.req(f.en("success", "denied", "failure")),
};

const listShape: ObjectShape = {
  schemaId: f.req(f.en(ADMIN_AUDIT_LIST_SCHEMA_ID)),
  events: f.req(f.arr(f.obj(eventShape))),
  limit: f.req(f.u64),
  truncated: f.req(f.bool),
};

export function parseAdminAuditList(raw: unknown): AdminAuditListV1 {
  checkObject("$", listShape, raw);
  return raw as AdminAuditListV1;
}
