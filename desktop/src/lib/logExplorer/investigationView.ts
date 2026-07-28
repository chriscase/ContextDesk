import type {
  ExplorerEventDto,
  InvestigationViewRecipeDto,
  LogBookmarkEventRefDto,
} from "../host";
import type { ExplorerFilters, LaneConfig } from "./types";
import type { TimeLinkMode } from "./laneCompose";

export type FindViewState = {
  query: string;
  matchMode: "literal" | "regex";
  caseSensitive: boolean;
  semantic: boolean;
} | null;

export function eventRef(
  corpusId: string,
  event: ExplorerEventDto,
): LogBookmarkEventRefDto {
  return {
    corpusId,
    seq: event.seq,
    source: event.source,
    timestampHint: event.ts,
    timeQualityHint: event.timeQuality,
  };
}

export function captureInvestigationView(args: {
  filters: ExplorerFilters;
  lanes: LaneConfig[];
  visibleLaneCount: number;
  linkMode: TimeLinkMode;
  focusedLaneId: string | null;
  focusedEvent: LogBookmarkEventRefDto | null;
  selection: LogBookmarkEventRefDto[];
  highlights: LogBookmarkEventRefDto[];
  find: FindViewState;
  viewportAnchors: Record<string, LogBookmarkEventRefDto>;
}): InvestigationViewRecipeDto {
  return {
    filters: {
      levels: [...args.filters.levels],
      sources: [...args.filters.sources],
      services: [...args.filters.services],
      hosts: [...args.filters.hosts],
      timeFrom: args.filters.timeFrom,
      timeTo: args.filters.timeTo,
      seqFrom: args.filters.seqFrom,
      seqTo: args.filters.seqTo,
      templateId: args.filters.templateId,
      traceId: args.filters.traceId,
      keyword: args.filters.keyword,
    },
    lanes: args.lanes.slice(0, 4).map((lane) => ({
      id: lane.id,
      label: lane.label,
      sources: [...lane.sources],
    })),
    visibleLaneCount: args.visibleLaneCount,
    linkMode: args.linkMode,
    focusedLaneId: args.focusedLaneId,
    focusedEvent: args.focusedEvent ? { ...args.focusedEvent } : null,
    selection: args.selection.map((ref) => ({ ...ref })),
    highlights: args.highlights.map((ref) => ({ ...ref })),
    find: args.find ? { ...args.find } : null,
    viewportAnchors: Object.entries(args.viewportAnchors)
      .filter(([laneId]) => args.lanes.some((lane) => lane.id === laneId))
      .map(([laneId, anchor]) => ({
        laneId,
        eventRef: { ...anchor },
      })),
  };
}

function listSummary(values: string[]): string {
  return values.length === 0 ? "all" : values.join(", ");
}

function filterSummary(filters: InvestigationViewRecipeDto["filters"]): string {
  const scopes = [
    filters.levels.length ? `levels ${listSummary(filters.levels)}` : null,
    filters.sources.length ? `sources ${listSummary(filters.sources)}` : null,
    filters.services.length
      ? `services ${listSummary(filters.services)}`
      : null,
    filters.hosts.length ? `hosts ${listSummary(filters.hosts)}` : null,
    filters.keyword ? `Filter “${filters.keyword}”` : null,
    filters.traceId ? `trace ${filters.traceId}` : null,
    filters.templateId != null ? `template ${filters.templateId}` : null,
    filters.timeFrom != null || filters.timeTo != null ? "bounded time" : null,
    filters.seqFrom != null || filters.seqTo != null
      ? "bounded sequence"
      : null,
  ].filter(Boolean);
  return scopes.length === 0 ? "All logs" : scopes.join(" · ");
}

function laneSummary(
  recipe: Pick<InvestigationViewRecipeDto, "lanes" | "visibleLaneCount">,
): string {
  const visible = recipe.lanes.slice(0, recipe.visibleLaneCount);
  return visible
    .map((lane) =>
      lane.sources.length === 0
        ? `${lane.label}: all sources`
        : `${lane.label}: ${lane.sources.length} source${
            lane.sources.length === 1 ? "" : "s"
          }`,
    )
    .join(" · ");
}

function findSummary(find: InvestigationViewRecipeDto["find"]): string {
  if (!find) return "Off";
  const modifiers = [
    find.matchMode,
    find.caseSensitive ? "case-sensitive" : null,
    find.semantic ? "semantic assist" : null,
  ]
    .filter(Boolean)
    .join(", ");
  return `“${find.query}” (${modifiers})`;
}

export function describeInvestigationViewDiff(
  current: InvestigationViewRecipeDto,
  proposed: InvestigationViewRecipeDto,
): string[] {
  const lines: string[] = [];
  const compare = (
    label: string,
    currentValue: unknown,
    proposedValue: unknown,
    summarize: (value: never) => string,
  ) => {
    if (JSON.stringify(currentValue) === JSON.stringify(proposedValue)) return;
    lines.push(
      `${label}: ${summarize(currentValue as never)} → ${summarize(
        proposedValue as never,
      )}`,
    );
  };

  compare("Filters", current.filters, proposed.filters, filterSummary);
  compare(
    "Lanes",
    {
      lanes: current.lanes,
      visibleLaneCount: current.visibleLaneCount,
    },
    {
      lanes: proposed.lanes,
      visibleLaneCount: proposed.visibleLaneCount,
    },
    laneSummary,
  );
  compare("Time linking", current.linkMode, proposed.linkMode, (value) =>
    String(value).replaceAll("_", " "),
  );
  compare("Find", current.find, proposed.find, findSummary);
  compare(
    "Selection",
    current.selection.length,
    proposed.selection.length,
    (value) => `${String(value)} event${value === 1 ? "" : "s"}`,
  );
  compare(
    "Highlights",
    current.highlights.length,
    proposed.highlights.length,
    (value) => `${String(value)} event${value === 1 ? "" : "s"}`,
  );
  compare(
    "Position",
    {
      focusedLaneId: current.focusedLaneId,
      focusedEvent: current.focusedEvent?.seq ?? null,
      viewportAnchors: current.viewportAnchors.map((anchor) => [
        anchor.laneId,
        anchor.eventRef.seq,
      ]),
    },
    {
      focusedLaneId: proposed.focusedLaneId,
      focusedEvent: proposed.focusedEvent?.seq ?? null,
      viewportAnchors: proposed.viewportAnchors.map((anchor) => [
        anchor.laneId,
        anchor.eventRef.seq,
      ]),
    },
    (value) => {
      const position = value as {
        focusedLaneId: string | null;
        focusedEvent: number | null;
        viewportAnchors: [string, number][];
      };
      if (position.focusedEvent != null) {
        return `${position.focusedLaneId ?? "lane"} · seq ${position.focusedEvent}`;
      }
      return `${position.viewportAnchors.length} lane anchor${
        position.viewportAnchors.length === 1 ? "" : "s"
      }`;
    },
  );

  return lines.length === 0
    ? ["This saved view already matches the Explorer."]
    : lines;
}
