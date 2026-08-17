import { checkObject, f, type ObjectShape } from "./parse.js";

export const TIMELINE_SCHEMA_ID = "cd-collab.timeline.v1" as const;

export interface TimelineEventV1 {
  seq: number;
  kind: string;
  actorId: string;
  actorUsername: string;
  targetId: string | null;
  clientTime: string | null;
  serverTime: string;
  payload: string;
}

export interface TimelineV1 {
  schemaId: typeof TIMELINE_SCHEMA_ID;
  caseId: string;
  events: TimelineEventV1[];
}

const eventShape: ObjectShape = {
  seq: f.req(f.u64),
  kind: f.req(f.str),
  actorId: f.req(f.str),
  actorUsername: f.req(f.str),
  targetId: f.nul(f.str),
  clientTime: f.nul(f.str),
  serverTime: f.req(f.str),
  payload: f.req(f.str),
};

const timelineShape: ObjectShape = {
  schemaId: f.req(f.en(TIMELINE_SCHEMA_ID)),
  caseId: f.req(f.str),
  events: f.req(f.arr(f.obj(eventShape))),
};

export function parseTimeline(raw: unknown): TimelineV1 {
  checkObject("$", timelineShape, raw);
  return raw as TimelineV1;
}
