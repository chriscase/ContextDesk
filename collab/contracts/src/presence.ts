import { checkObject, f, type ObjectShape } from "./parse.js";

export const PRESENCE_SCHEMA_ID = "cd-collab.case_presence.v1" as const;
export const PRESENCE_SURFACES = ["case_board", "experiment_lab", "triage_runs"] as const;
export type PresenceSurface = (typeof PRESENCE_SURFACES)[number];

export interface PresenceMemberV1 {
  identityId: string;
  username: string;
  surface: PresenceSurface;
  lastSeenAt: string;
}

export interface CasePresenceV1 {
  schemaId: typeof PRESENCE_SCHEMA_ID;
  caseId: string;
  ttlSeconds: number;
  members: PresenceMemberV1[];
}

const memberShape: ObjectShape = {
  identityId: f.req(f.str),
  username: f.req(f.str),
  surface: f.req(f.en(...PRESENCE_SURFACES)),
  lastSeenAt: f.req(f.str),
};

const presenceShape: ObjectShape = {
  schemaId: f.req(f.en(PRESENCE_SCHEMA_ID)),
  caseId: f.req(f.str),
  ttlSeconds: f.req(f.u64),
  members: f.req(f.arr(f.obj(memberShape))),
};

export function parseCasePresence(raw: unknown): CasePresenceV1 {
  checkObject("$", presenceShape, raw);
  return raw as CasePresenceV1;
}
