/** Per-lane composite keyset helpers for multi-lane page-to-end (#505). */

import type { EventQueryDto } from "../host";
import type { ExplorerFilters, LaneConfig } from "./types";

export type LaneCursor = {
  afterSeq: number | null;
  afterTs: number | null;
};

export function laneHasMore(c: LaneCursor | undefined): boolean {
  return c != null && c.afterSeq != null;
}

export function filtersToLaneQuery(
  f: ExplorerFilters,
  lane: LaneConfig,
  cursor: LaneCursor | undefined,
  limit = 100,
): EventQueryDto {
  const sources =
    lane.sources.length > 0
      ? lane.sources
      : f.sources.length > 0
        ? f.sources
        : undefined;
  return {
    timeFrom: f.timeFrom,
    timeTo: f.timeTo,
    seqFrom: f.seqFrom,
    seqTo: f.seqTo,
    levels: f.levels,
    sources,
    services: f.services,
    hosts: f.hosts,
    templateId: f.templateId,
    traceId: f.traceId,
    keyword: f.keyword,
    limit,
    sortByTime: true,
    afterSeq: cursor?.afterSeq ?? null,
    afterTs: cursor?.afterTs ?? null,
  };
}

/** Advance cursor from a page response. */
export function cursorFromPage(page: {
  nextCursor: number | null;
  nextTs?: number | null;
}): LaneCursor {
  return {
    afterSeq: page.nextCursor,
    afterTs: page.nextTs ?? null,
  };
}
