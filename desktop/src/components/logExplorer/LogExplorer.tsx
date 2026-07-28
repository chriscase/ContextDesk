/**
 * Multi-window Log Investigation Workspace (#480–#487).
 * Filters | 1–4 evidence lanes | chat rail · bookmarks · log_nav chips.
 */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import {
  createLogSearchRequestId,
  hostCancelLogSearch,
  hostGetLogCorpus,
  hostLogAddBookmark,
  hostLogAddInvestigationEvidence,
  hostLogAddInvestigationFinding,
  hostLogAddInvestigationNote,
  hostLogDeleteBookmark,
  hostLogEditInvestigationFinding,
  hostLogEditInvestigationNote,
  hostLogFacets,
  hostLogLoadActiveInvestigation,
  hostLogListBookmarks,
  hostLogPreviewInvestigationEvidence,
  hostLogPreviewInvestigationFindingView,
  hostLogQueryEventOriginal,
  hostLogQueryEventNeighborhood,
  hostLogQueryEvents,
  hostLogSearchEventsAdvanced,
  hostSetActiveLogCorpus,
  type EventPageDto,
  type EventOriginalRepresentationDto,
  type SearchMatchMode,
  type EventQueryDto,
  type ExplorerEventDto,
  type LogBookmarkDto,
  type LogBookmarkEventRefDto,
  type LogCorpusSummaryDto,
  type LogFacetsDto,
  type InvestigationViewRecipeDto,
  type ResolvedInvestigationDocumentDto,
  type TimeQuality,
} from "../../lib/host";
import { applyLogNav, type LogNavAction } from "../../lib/logExplorer/logNav";
import {
  clampLaneCount,
  computeGaps,
  scrubLinked,
  type GapRegion,
  type LaneEventRef,
} from "../../lib/logExplorer/lanes";
import {
  classifyBreakpoint,
  emptyFilters,
  formatCanonicalUtc,
  leastReliableTimeQuality,
  timeQualityLabel,
  type Breakpoint,
  type Density,
  type ExplorerFilters,
  type LaneConfig,
  type LaneTimeState,
} from "../../lib/logExplorer/types";
import {
  appendNewer,
  DEFAULT_MAX_RESIDENT,
  prependOlder,
  seedFromPage,
} from "../../lib/logExplorer/residentWindow";
import {
  autoFitColWidths,
  DEFAULT_COL_WIDTHS,
  loadColWidths,
  resizeCol,
  saveColWidths,
  type ColWidths,
} from "../../lib/logExplorer/columnWidths";
import {
  composeLaneSources,
  defaultLanes,
  loadLanes,
  loadLinkMode,
  resizeLaneList,
  saveLanes,
  saveLinkMode,
  toggleLaneSource,
  type TimeLinkMode,
} from "../../lib/logExplorer/laneCompose";
import { buildAlignedLaneRows } from "../../lib/logExplorer/alignment";
import { HelpTip } from "../HelpTip";
import { IconChevronDown, IconChevronLeft, IconLogExplorer } from "../icons";
import {
  HELP_COUNTS,
  HELP_FIND_VS_FILTER,
  HELP_LANE_COMPOSE,
  HELP_LONG_LINES,
  HELP_TIME_LINK,
} from "../../lib/helpContent";
import { LinkedChatRail } from "./LinkedChatRail";
import {
  EvidencePanel,
  InvestigationModeControl,
  type BookmarkItemView,
  type EvidenceItemView,
  type EvidencePreviewView,
  type FindingItemView,
  type FindingViewPreviewView,
  type InvestigationRailMode,
  type NoteItemView,
} from "./EvidencePanel";
import {
  CreateInvestigationItemDialog,
  type InvestigationItemDraft,
} from "./CreateInvestigationItemDialog";
import { InvestigationAddMenu } from "./InvestigationAddMenu";
import { SaveEvidenceDialog } from "./SaveEvidenceDialog";
import { TimelineNavigator } from "./TimelineNavigator";
import {
  centeredLiteralExcerpt,
  eventRowHeight,
  VirtualizedEventList,
  type LineMode,
  type RowFieldEmphasis,
  type RowMetadataPresentation,
} from "./VirtualizedEventList";
import {
  captureInvestigationView,
  describeInvestigationViewDiff,
  eventRef as investigationEventRef,
} from "../../lib/logExplorer/investigationView";
import {
  applyThemeToDocument,
  subscribeThemeChanges,
  THEME_STORAGE_KEY,
} from "../../lib/themeBridge";
import "../../styles/components/log-explorer.css";

type Props = {
  corpusId: string;
};

const FIND_PAGE_SIZE = 50;
// Time + level + source + a useful message excerpt fit without reducing a
// lane to timestamp/severity slivers. Availability is based on the central
// evidence grid, after the live Filters/Chat rail widths and splitters.
const MIN_EVIDENCE_LANE_WIDTH_PX = 420;
const SPLITTER_WIDTH_PX = 6;
const COLLAPSED_FILTER_WIDTH_PX = 42;
const COLLAPSED_CHAT_WIDTH_PX = 42;
const EVENT_COLUMNS = [
  { label: "Time", index: 0 as const },
  { label: "Lvl", index: 1 as const },
  { label: "Source", index: 2 as const },
  { label: "Message", index: 3 as const },
] as const;

type FindCursor = {
  seq: number;
  ts: number;
};

type FindPageHistory = {
  start: FindCursor | null;
  base: number;
};

type ToolbarPickerOption<T extends string> = {
  value: T;
  label: string;
  description: string;
  disabled?: boolean;
  disabledReason?: string;
  visual?: ReactNode;
};

function ToolbarPicker<T extends string>({
  label,
  value,
  valueLabel,
  options,
  onChange,
  testId,
  footer,
}: {
  label: string;
  value: T;
  valueLabel?: string;
  options: ToolbarPickerOption<T>[];
  onChange: (value: T) => void;
  testId: string;
  footer?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selected = options.find((option) => option.value === value);

  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) {
      queueMicrotask(() => triggerRef.current?.focus());
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && !rootRef.current?.contains(target)) close(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKeyDown);
    queueMicrotask(() => {
      rootRef.current
        ?.querySelector<HTMLElement>(
          '[role="menuitemradio"][aria-checked="true"]:not(:disabled)',
        )
        ?.focus();
    });
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [close, open]);

  const moveOptionFocus = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (
      event.key !== "ArrowDown" &&
      event.key !== "ArrowUp" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }
    event.preventDefault();
    const buttons = Array.from(
      rootRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitemradio"]:not(:disabled)',
      ) ?? [],
    );
    if (buttons.length === 0) return;
    const current = buttons.indexOf(event.currentTarget);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
            buttons.length;
    buttons[next]?.focus();
  };

  return (
    <div className="log-explorer__toolbar-picker" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`log-explorer__picker-trigger ${open ? "log-explorer__picker-trigger--open" : ""}`}
        data-testid={testId}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="log-explorer__picker-label">{label}</span>
        <span className="log-explorer__picker-value">
          {valueLabel ?? selected?.label ?? value}
        </span>
        <IconChevronDown />
      </button>
      {open ? (
        <div
          id={id}
          className="log-explorer__picker-menu"
          role="menu"
          aria-label={`${label} options`}
        >
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              className="log-explorer__picker-option"
              role="menuitemradio"
              aria-checked={option.value === value}
              disabled={option.disabled}
              title={option.disabledReason}
              data-value={option.value}
              onKeyDown={moveOptionFocus}
              onClick={() => {
                onChange(option.value);
                close();
              }}
            >
              {option.visual ? (
                <span className="log-explorer__picker-visual">
                  {option.visual}
                </span>
              ) : null}
              <span className="log-explorer__picker-copy">
                <span className="log-explorer__picker-option-title">
                  {option.label}
                  {option.value === value ? (
                    <span aria-hidden="true"> ✓</span>
                  ) : null}
                </span>
                <span className="log-explorer__picker-description">
                  {option.disabledReason ?? option.description}
                </span>
              </span>
            </button>
          ))}
          {footer ? (
            <div className="log-explorer__picker-footer">{footer}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ToolbarActionMenu({
  label,
  testId,
  actions,
}: {
  label: string;
  testId: string;
  actions: {
    id: string;
    label: string;
    description: string;
    testId?: string;
    run: () => void;
  }[];
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) queueMicrotask(() => triggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && !rootRef.current?.contains(target)) close(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKeyDown);
    queueMicrotask(() =>
      rootRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus(),
    );
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [close, open]);

  const moveFocus = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (
      event.key !== "ArrowDown" &&
      event.key !== "ArrowUp" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }
    event.preventDefault();
    const items = Array.from(
      rootRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]',
      ) ?? [],
    );
    if (items.length === 0) return;
    const current = items.indexOf(event.currentTarget);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
            items.length;
    items[next]?.focus();
  };

  return (
    <div className="log-explorer__toolbar-picker" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`log-explorer__picker-trigger ${open ? "log-explorer__picker-trigger--open" : ""}`}
        data-testid={testId}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="log-explorer__picker-value">{label}</span>
        <IconChevronDown />
      </button>
      {open ? (
        <div
          id={id}
          className="log-explorer__picker-menu log-explorer__picker-menu--actions"
          role="menu"
          aria-label={`${label} actions`}
        >
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              className="log-explorer__picker-option"
              role="menuitem"
              data-testid={action.testId}
              onKeyDown={moveFocus}
              onClick={() => {
                action.run();
                close();
              }}
            >
              <span className="log-explorer__picker-copy">
                <span className="log-explorer__picker-option-title">
                  {action.label}
                </span>
                <span className="log-explorer__picker-description">
                  {action.description}
                </span>
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TimeLinkVisual({ mode }: { mode: TimeLinkMode }) {
  return (
    <svg
      viewBox="0 0 76 32"
      aria-hidden="true"
      className={`log-explorer__time-link-visual log-explorer__time-link-visual--${mode}`}
    >
      <path d="M4 9h68M4 23h68" />
      {mode === "independent" ? (
        <>
          <circle cx="18" cy="9" r="2.5" />
          <circle cx="51" cy="9" r="2.5" />
          <circle cx="31" cy="23" r="2.5" />
          <circle cx="65" cy="23" r="2.5" />
        </>
      ) : null}
      {mode === "follow_cursor" ? (
        <>
          <path d="M39 3v26" className="log-explorer__time-link-cursor" />
          <circle cx="34" cy="9" r="2.5" />
          <circle cx="43" cy="23" r="2.5" />
          <path d="m34 14 5 4 4-4" />
        </>
      ) : null}
      {mode === "align_time" ? (
        <>
          <path
            d="M23 4v23M54 4v23"
            className="log-explorer__time-link-cursor"
          />
          <circle cx="23" cy="9" r="2.5" />
          <circle cx="23" cy="23" r="2.5" />
          <circle cx="54" cy="9" r="2.5" />
          <path d="M48 19h12v8H48z" className="log-explorer__time-link-gap" />
        </>
      ) : null}
    </svg>
  );
}

function filtersToQuery(
  f: ExplorerFilters,
  extra?: Partial<EventQueryDto>,
): EventQueryDto {
  return {
    timeFrom: f.timeFrom,
    timeTo: f.timeTo,
    seqFrom: f.seqFrom,
    seqTo: f.seqTo,
    levels: f.levels,
    sources: f.sources,
    services: f.services,
    hosts: f.hosts,
    templateId: f.templateId,
    traceId: f.traceId,
    keyword: f.keyword,
    limit: 200,
    sortByTime: true,
    ...extra,
  };
}

function emptyEventPage(timeQuality: TimeQuality = "order_only"): EventPageDto {
  return {
    events: [],
    nextCursor: null,
    nextTs: null,
    prevCursor: null,
    prevTs: null,
    totalMatched: 0,
    timeQuality,
  };
}

/**
 * Empty results do not erase the backend's known corpus/view time quality.
 * Failed or still-loading lanes remain fail-closed because they provide no
 * trustworthy quality claim at all.
 */
function aggregateViewTimeQuality(
  laneIds: string[],
  states: Record<string, LaneTimeState>,
): TimeQuality {
  if (laneIds.length === 0) return "order_only";
  const qualities: TimeQuality[] = [];
  for (const laneId of laneIds) {
    const state = states[laneId];
    if (
      !state ||
      state.status === "unloaded" ||
      state.status === "error" ||
      state.quality == null
    ) {
      return "order_only";
    }
    qualities.push(state.quality);
  }
  return leastReliableTimeQuality(qualities);
}

function effectiveLaneSources(
  lane: LaneConfig | undefined,
  filters: ExplorerFilters,
): string[] | undefined {
  return composeLaneSources(lane?.sources ?? [], filters.sources);
}

/**
 * The primary Navigator can only summarize sources that at least one visible
 * lane can actually reveal. Otherwise a valid bucket can choose an event that
 * the fail-closed seek contract must reject as outside the visible lanes.
 */
function visibleLaneSourceScope(
  lanes: LaneConfig[],
  laneCount: number,
  filters: ExplorerFilters,
): string[] | undefined {
  const ordered = new Set<string>();
  for (const lane of lanes.slice(0, laneCount)) {
    const sources = effectiveLaneSources(lane, filters);
    if (sources == null) return undefined;
    for (const source of sources) ordered.add(source);
  }
  return [...ordered];
}

function levelClass(level: string): string {
  const l = level.toLowerCase();
  return `log-explorer__level log-explorer__level--${l}`;
}

function parseWholeNumber(value: string, label: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${label} must be a non-negative whole number`);
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${label} is outside the supported range`);
  }
  return parsed;
}

function parseUtcSeconds(value: string, label: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(trimmed)) {
    throw new Error(`${label} must include Z or an explicit UTC offset`);
  }
  const milliseconds = Date.parse(trimmed);
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`${label} is not a valid ISO timestamp`);
  }
  if (milliseconds % 1000 !== 0) {
    throw new Error(`${label} must use whole seconds`);
  }
  return milliseconds / 1000;
}

function utcDraft(value: number | null): string {
  if (value == null) return "";
  return new Date(value * 1000).toISOString();
}

function investigationEvidenceViews(
  resolved: ResolvedInvestigationDocumentDto | null,
): EvidenceItemView[] {
  if (!resolved) return [];
  return resolved.evidence.map(({ item, references }) => {
    const evidenceStatus = references.some(
      (reference) => reference.status === "missing",
    )
      ? "missing"
      : references.some((reference) => reference.status === "stale")
        ? "stale"
        : "verified";
    return {
      id: item.id,
      title: item.title,
      eventRefs: item.eventRefs,
      evidenceStatus,
      createdAt: item.createdAt,
      provenanceLabel:
        item.provenance === "human" ? "Saved manually" : "Saved evidence",
    };
  });
}

function investigationFindingViews(
  resolved: ResolvedInvestigationDocumentDto | null,
): FindingItemView[] {
  return (resolved?.document.findings ?? []).map((item) => ({
    id: item.id,
    kind: item.kind,
    lifecycle: item.lifecycle,
    title: item.title,
    whyItMatters: item.whyItMatters,
    evidenceIds: item.evidenceIds,
    viewRecipe: item.viewRecipe ?? null,
    provenanceLabel: "Authored manually",
  }));
}

function investigationNoteViews(
  resolved: ResolvedInvestigationDocumentDto | null,
): NoteItemView[] {
  return (resolved?.document.notes ?? []).map((item) => ({
    id: item.id,
    title: item.title,
    body: item.body,
    evidenceIds: item.evidenceIds,
    findingIds: item.findingIds ?? [],
    provenanceLabel: "Authored manually",
  }));
}

function investigationBookmarkViews(
  bookmarks: LogBookmarkDto[],
): BookmarkItemView[] {
  return bookmarks.map((bookmark) => ({
    id: bookmark.id,
    label: bookmark.label,
    note: bookmark.note ?? null,
    seqFrom: bookmark.seqFrom,
    seqTo: bookmark.seqTo,
    eventRefs: bookmark.eventRefs ?? [],
    evidenceStatus:
      bookmark.evidenceStatus ??
      (bookmark.eventRefs?.length ? "verified" : "legacy_range"),
  }));
}

export function LogExplorer({ corpusId }: Props) {
  const [summary, setSummary] = useState<LogCorpusSummaryDto | null>(null);
  const [filters, setFilters] = useState<ExplorerFilters>(emptyFilters);
  const [facets, setFacets] = useState<LogFacetsDto | null>(null);
  const [laneSourceCatalog, setLaneSourceCatalog] = useState<string[]>([]);
  const [laneSourceCatalogUnavailable, setLaneSourceCatalogUnavailable] =
    useState(false);
  const [timeQuality, setTimeQuality] = useState<TimeQuality>("order_only");
  const [totalMatched, setTotalMatched] = useState(0);
  /** Unfiltered corpus event total for truthful count labeling (#534). */
  const [corpusTotal, setCorpusTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  /** Per-lane composite cursors for bidirectional paging (#505/#538). */
  const [laneCursors, setLaneCursors] = useState<
    Record<
      string,
      {
        afterSeq: number | null;
        afterTs: number | null;
        beforeSeq: number | null;
        beforeTs: number | null;
        hasOlder: boolean;
        hasNewer: boolean;
      }
    >
  >({});
  const pagingInflight = useRef<Record<string, "older" | "newer" | null>>({});
  const [lanePaging, setLanePaging] = useState<
    Record<
      string,
      {
        loading: "older" | "newer" | null;
        error: string | null;
        failedDirection: "older" | "newer" | null;
      }
    >
  >({});
  const [focusLaneId, setFocusLaneId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [highlight, setHighlight] = useState<Set<number>>(new Set());
  const [detail, setDetail] = useState<ExplorerEventDto | null>(null);
  const [detailRepresentation, setDetailRepresentation] = useState<
    "formatted" | "original"
  >("formatted");
  const [detailOriginal, setDetailOriginal] = useState<
    | { status: "idle" }
    | { status: "loading" }
    | { status: "loaded"; result: EventOriginalRepresentationDto }
    | { status: "error"; message: string }
  >({ status: "idle" });
  const detailOriginalRequestRef = useRef(0);
  const detailSeqRef = useRef<number | null>(null);
  const detailRepresentationRef = useRef<"formatted" | "original">("formatted");
  const showDetail = useCallback((event: ExplorerEventDto) => {
    detailOriginalRequestRef.current += 1;
    detailSeqRef.current = event.seq;
    detailRepresentationRef.current = "formatted";
    setDetailRepresentation("formatted");
    setDetailOriginal({ status: "idle" });
    setDetail(event);
  }, []);
  const clearDetail = useCallback(() => {
    detailOriginalRequestRef.current += 1;
    detailSeqRef.current = null;
    detailRepresentationRef.current = "formatted";
    setDetailRepresentation("formatted");
    setDetailOriginal({ status: "idle" });
    setDetail(null);
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [density, setDensity] = useState<Density>("comfortable");
  const [breakpoint, setBreakpoint] = useState<Breakpoint>("normal");
  const [explorerWidth, setExplorerWidth] = useState(() => window.innerWidth);
  const [linkMode, setLinkMode] = useState<TimeLinkMode>(() =>
    loadLinkMode(corpusId),
  );
  const [laneCount, setLaneCount] = useState(1);
  const [preferredLaneCount, setPreferredLaneCount] = useState(1);
  const [lanes, setLanes] = useState<LaneConfig[]>(() => {
    const saved = loadLanes(corpusId);
    return saved && saved.length > 0 ? saved : defaultLanes(1);
  });
  const [laneEditorOpen, setLaneEditorOpen] = useState(false);
  const [laneEvents, setLaneEvents] = useState<
    Record<string, ExplorerEventDto[]>
  >({});
  /** Exact matched count for each lane query; null means unavailable/failed. */
  const [laneMatched, setLaneMatched] = useState<Record<string, number | null>>(
    {},
  );
  const [laneTimeStates, setLaneTimeStates] = useState<
    Record<string, LaneTimeState>
  >({});
  /** Per-lane scroll target seq from linked scrub. */
  const [laneScrollSeq, setLaneScrollSeq] = useState<
    Record<string, number | null>
  >({});
  const [laneScrollLeft, setLaneScrollLeft] = useState<Record<string, number>>(
    {},
  );
  const [bookmarkFocusTarget, setBookmarkFocusTarget] = useState<{
    laneId: string;
    seq: number;
  } | null>(null);
  const [alignedScrollTop, setAlignedScrollTop] = useState(0);
  const [gaps, setGaps] = useState<GapRegion[]>([]);
  const [bookmarks, setBookmarks] = useState<LogBookmarkDto[]>([]);
  const [investigation, setInvestigation] =
    useState<ResolvedInvestigationDocumentDto | null>(null);
  const [investigationMode, setInvestigationMode] =
    useState<InvestigationRailMode>("chat");
  const [investigationBusy, setInvestigationBusy] = useState(false);
  const [investigationError, setInvestigationError] = useState<string | null>(
    null,
  );
  const [evidencePreview, setEvidencePreview] =
    useState<EvidencePreviewView | null>(null);
  const [findingViewPreview, setFindingViewPreview] =
    useState<FindingViewPreviewView | null>(null);
  const [saveEvidenceOpen, setSaveEvidenceOpen] = useState(false);
  const [investigationAddMenuOpen, setInvestigationAddMenuOpen] =
    useState(false);
  const [createInvestigationItem, setCreateInvestigationItem] = useState<
    "finding" | "note" | null
  >(null);
  const [editInvestigationItem, setEditInvestigationItem] = useState<
    | { type: "finding"; item: FindingItemView }
    | { type: "note"; item: NoteItemView }
    | null
  >(null);
  const [chatDraftRequest, setChatDraftRequest] = useState<{
    id: number;
    text: string;
  } | null>(null);
  const [findDraft, setFindDraft] = useState("");
  const [findMatchMode, setFindMatchMode] =
    useState<SearchMatchMode>("literal");
  const [findCaseSensitive, setFindCaseSensitive] = useState(false);
  const [findUseSemantic, setFindUseSemantic] = useState(false);
  const [findPartial, setFindPartial] = useState(false);
  const [findSearching, setFindSearching] = useState(false);
  const [findCancelling, setFindCancelling] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [filterDraft, setFilterDraft] = useState("");
  const [traceDraft, setTraceDraft] = useState("");
  const [templateDraft, setTemplateDraft] = useState("");
  const [timeFromDraft, setTimeFromDraft] = useState("");
  const [timeToDraft, setTimeToDraft] = useState("");
  const [seqFromDraft, setSeqFromDraft] = useState("");
  const [seqToDraft, setSeqToDraft] = useState("");
  /** Find matches (ordered seqs) — does not reduce the table (#523). */
  const [findMatches, setFindMatches] = useState<number[]>([]);
  const [findMatchSources, setFindMatchSources] = useState<
    Record<number, string>
  >({});
  const [findMatchRefs, setFindMatchRefs] = useState<
    Record<number, LogBookmarkEventRefDto>
  >({});
  const [findExcerpts, setFindExcerpts] = useState<Record<number, string>>({});
  const [findIndex, setFindIndex] = useState(0);
  const [findTotal, setFindTotal] = useState(0);
  const [findTotalExact, setFindTotalExact] = useState(false);
  const [findBase, setFindBase] = useState(0);
  const [findNextCursor, setFindNextCursor] = useState<FindCursor | null>(null);
  const [findPageStart, setFindPageStart] = useState<FindCursor | null>(null);
  const [findHistory, setFindHistory] = useState<FindPageHistory[]>([]);
  const [findActiveQuery, setFindActiveQuery] = useState<string | null>(null);
  /** Complete prior logical state while a temporary reveal is active (#531/#656). */
  const [revealRestore, setRevealRestore] =
    useState<InvestigationViewRecipeDto | null>(null);
  const [laneViewportAnchors, setLaneViewportAnchors] = useState<
    Record<string, LogBookmarkEventRefDto>
  >({});
  const [pendingViewApply, setPendingViewApply] = useState<{
    recipe: InvestigationViewRecipeDto;
    status: string;
  } | null>(null);
  const [bookmarkRevealState, setBookmarkRevealState] = useState<
    "idle" | "visible" | "revealed" | "missing"
  >("idle");
  const [lineMode, setLineMode] = useState<LineMode>(() => {
    try {
      const v = localStorage.getItem("contextdesk.logExplorer.lineMode.v1");
      if (v === "compact" || v === "wrap" || v === "full") return v;
    } catch {
      /* ignore */
    }
    return "compact";
  });
  const [metadataPresentation, setMetadataPresentation] =
    useState<RowMetadataPresentation>(() => {
      try {
        const value = localStorage.getItem(
          "contextdesk.logExplorer.metadataPresentation.v1",
        );
        if (value === "standard" || value === "compact") return value;
      } catch {
        /* ignore */
      }
      return "compact";
    });
  const [fieldEmphasis, setFieldEmphasis] = useState<RowFieldEmphasis>(() => {
    try {
      const value = localStorage.getItem(
        "contextdesk.logExplorer.fieldEmphasis.v1",
      );
      if (value === "balanced" || value === "payload" || value === "metadata") {
        return value;
      }
    } catch {
      /* ignore */
    }
    return "payload";
  });
  const [previewLines, setPreviewLines] = useState(() => {
    try {
      const value = Number(
        localStorage.getItem("contextdesk.logExplorer.previewLines.v1"),
      );
      if ([2, 4, 8, 12].includes(value)) return value;
    } catch {
      /* ignore */
    }
    return 4;
  });
  const [expandedSeqs, setExpandedSeqs] = useState<Set<number>>(new Set());
  const [colWidths, setColWidths] = useState<ColWidths>(() => loadColWidths());
  const [narrowFiltersOpen, setNarrowFiltersOpen] = useState(false);
  const [narrowChatOpen, setNarrowChatOpen] = useState(false);
  const [filtersCollapsed, setFiltersCollapsed] = useState(false);
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [chatSummary, setChatSummary] = useState({
    chatCount: 0,
    hasActiveChat: false,
    busy: false,
  });
  const [detailH, setDetailH] = useState(() => {
    try {
      const n = Number(
        localStorage.getItem("contextdesk.logExplorer.detailH.v1"),
      );
      if (Number.isFinite(n) && n >= 120 && n <= 640) return n;
    } catch {
      /* ignore */
    }
    return 180;
  });
  const detailDragRef = useRef<{ startY: number; startH: number } | null>(null);
  const colDragRef = useRef<{
    index: 0 | 1 | 2 | 3;
    startX: number;
    startW: number;
  } | null>(null);
  const [status, setStatus] = useState("Ready");
  // Resizable columns (px)
  const [filterW, setFilterW] = useState(220);
  const [chatW, setChatW] = useState(300);
  const rootRef = useRef<HTMLDivElement>(null);
  const laneEditorRef = useRef<HTMLDivElement>(null);
  const laneEditorToggleRef = useRef<HTMLButtonElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const narrowFiltersToggleRef = useRef<HTMLButtonElement>(null);
  const narrowChatToggleRef = useRef<HTMLButtonElement>(null);
  const filtersCollapseRef = useRef<HTMLButtonElement>(null);
  const filtersReopenRef = useRef<HTMLButtonElement>(null);
  const saveEvidenceTriggerRef = useRef<HTMLButtonElement>(null);
  const investigationAddTriggerRef = useRef<HTMLButtonElement>(null);
  const investigationEditTriggerRef = useRef<HTMLButtonElement>(null);
  const chatDraftRequestIdRef = useRef(0);
  const previousFiltersCollapsedRef = useRef(filtersCollapsed);
  const dragRef = useRef<"filters" | "chat" | null>(null);
  const facetRequestRef = useRef(0);
  const laneSourceRequestRef = useRef(0);
  const eventsRequestRef = useRef(0);
  const investigationLoadRequestRef = useRef(0);
  const findRequestRef = useRef(0);
  const activeFindRequestRef = useRef<string | null>(null);
  const findActiveRef = useRef(false);
  const autoStatusLockRef = useRef<
    "bookmark-reveal" | "bookmark-restore" | null
  >(null);
  const suppressSelectionClearStatusRef = useRef(false);
  const findRefreshRef = useRef<(nextFilters: ExplorerFilters) => void>(
    () => {},
  );
  const suppressNextFindRefreshRef = useRef(false);
  const semanticAvailable =
    (summary?.embedding?.embeddedTemplates ?? summary?.stats?.embedded ?? 0) >
    0;

  const setAutoStatus = useCallback((nextStatus: string) => {
    if (autoStatusLockRef.current === "bookmark-restore") {
      autoStatusLockRef.current = null;
      return;
    }
    if (autoStatusLockRef.current === "bookmark-reveal") return;
    setStatus(nextStatus);
  }, []);
  const activeFilterCount =
    filters.levels.length +
    filters.sources.length +
    filters.services.length +
    filters.hosts.length +
    (filters.keyword ? 1 : 0) +
    (filters.timeFrom != null || filters.timeTo != null ? 1 : 0) +
    (filters.seqFrom != null || filters.seqTo != null ? 1 : 0) +
    (filters.templateId != null ? 1 : 0) +
    (filters.traceId ? 1 : 0);
  const laneEditorSources = useMemo(
    () =>
      [
        ...new Set([
          ...laneSourceCatalog,
          ...Object.keys(facets?.sources ?? {}),
          ...lanes.flatMap((lane) => lane.sources),
        ]),
      ].sort(),
    [facets, laneSourceCatalog, lanes],
  );
  const closeLaneEditor = useCallback(() => {
    setLaneEditorOpen(false);
    // Return focus after the activating or dismissal click has completed.
    window.setTimeout(() => laneEditorToggleRef.current?.focus(), 0);
  }, []);
  const handleRailSummary = useCallback((next: typeof chatSummary) => {
    setChatSummary((previous) =>
      previous.chatCount === next.chatCount &&
      previous.hasActiveChat === next.hasActiveChat &&
      previous.busy === next.busy
        ? previous
        : next,
    );
  }, []);

  useEffect(() => {
    try {
      applyThemeToDocument(localStorage.getItem(THEME_STORAGE_KEY));
    } catch {
      // theme-init already supplied the safe default.
    }
    return subscribeThemeChanges((theme) => {
      applyThemeToDocument(theme);
    });
  }, []);

  useEffect(() => {
    saveColWidths(colWidths);
  }, [colWidths]);

  useEffect(() => {
    setTraceDraft(filters.traceId ?? "");
    setTemplateDraft(
      filters.templateId == null ? "" : String(filters.templateId),
    );
    setTimeFromDraft(utcDraft(filters.timeFrom));
    setTimeToDraft(utcDraft(filters.timeTo));
    setSeqFromDraft(filters.seqFrom == null ? "" : String(filters.seqFrom));
    setSeqToDraft(filters.seqTo == null ? "" : String(filters.seqTo));
  }, [
    filters.seqFrom,
    filters.seqTo,
    filters.templateId,
    filters.timeFrom,
    filters.timeTo,
    filters.traceId,
  ]);

  useEffect(
    () => () => {
      findRequestRef.current += 1;
      findActiveRef.current = false;
      const requestId = activeFindRequestRef.current;
      activeFindRequestRef.current = null;
      if (requestId) void hostCancelLogSearch(requestId);
    },
    [],
  );

  useEffect(() => {
    try {
      localStorage.setItem("contextdesk.logExplorer.lineMode.v1", lineMode);
    } catch {
      /* ignore */
    }
  }, [lineMode]);

  useEffect(() => {
    try {
      localStorage.setItem(
        "contextdesk.logExplorer.metadataPresentation.v1",
        metadataPresentation,
      );
    } catch {
      /* ignore */
    }
  }, [metadataPresentation]);

  useEffect(() => {
    try {
      localStorage.setItem(
        "contextdesk.logExplorer.fieldEmphasis.v1",
        fieldEmphasis,
      );
    } catch {
      /* ignore */
    }
  }, [fieldEmphasis]);

  useEffect(() => {
    try {
      localStorage.setItem(
        "contextdesk.logExplorer.previewLines.v1",
        String(previewLines),
      );
    } catch {
      /* ignore */
    }
  }, [previewLines]);

  useEffect(() => {
    if (!laneEditorOpen) return;
    queueMicrotask(() => {
      laneEditorRef.current
        ?.querySelector<HTMLElement>('[data-testid="lane-editor-close"]')
        ?.focus();
    });
  }, [laneEditorOpen]);

  useEffect(() => {
    if (!laneEditorOpen) return;
    const onClick = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (
        target &&
        !laneEditorRef.current?.contains(target) &&
        !laneEditorToggleRef.current?.contains(target)
      ) {
        closeLaneEditor();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeLaneEditor();
      }
    };
    // Wait for click rather than closing on mousedown. Native controls can move
    // focus after mousedown, so closing there races the promised trigger-focus
    // restoration in the packaged app.
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [closeLaneEditor, laneEditorOpen]);

  useEffect(() => {
    if (breakpoint !== "narrow") return;
    if (narrowFiltersOpen) {
      queueMicrotask(() => findInputRef.current?.focus());
    } else if (narrowChatOpen) {
      queueMicrotask(() => {
        const root = rootRef.current;
        (investigationMode === "investigation"
          ? root?.querySelector<HTMLElement>(
              '[aria-label="Close Investigation drawer"]',
            )
          : root?.querySelector<HTMLElement>('[data-testid="new-linked-chat"]')
        )?.focus();
      });
    }
  }, [breakpoint, investigationMode, narrowChatOpen, narrowFiltersOpen]);

  useEffect(() => {
    const previous = previousFiltersCollapsedRef.current;
    previousFiltersCollapsedRef.current = filtersCollapsed;
    if (breakpoint === "narrow" || previous === filtersCollapsed) return;
    queueMicrotask(() => {
      if (filtersCollapsed) filtersReopenRef.current?.focus();
      else filtersCollapseRef.current?.focus();
    });
  }, [breakpoint, filtersCollapsed]);

  useEffect(() => {
    try {
      localStorage.setItem(
        "contextdesk.logExplorer.detailH.v1",
        String(detailH),
      );
    } catch {
      /* ignore */
    }
  }, [detailH]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (colDragRef.current) {
        const { index, startX, startW } = colDragRef.current;
        const deltaRem = (e.clientX - startX) / 16;
        setColWidths((w) => {
          const next = [...w] as ColWidths;
          next[index] = startW + deltaRem;
          return resizeCol(next, index, 0);
        });
      }
      if (detailDragRef.current) {
        const dy = detailDragRef.current.startY - e.clientY;
        setDetailH(
          Math.min(640, Math.max(120, detailDragRef.current.startH + dy)),
        );
      }
    };
    const onUp = () => {
      colDragRef.current = null;
      detailDragRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  // Breakpoint observer
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const applyWidth = (width: number) => {
      setExplorerWidth(width);
      const bp = classifyBreakpoint(width);
      setBreakpoint(bp);
      // #536: narrow is a drawer-based, independent-time workspace.
      if (bp === "narrow") {
        setTimeLinkMode("independent");
      }
    };
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? window.innerWidth;
      applyWidth(w);
    });
    const onWindowResize = () =>
      applyWidth(el.clientWidth || window.innerWidth);
    ro.observe(el);
    applyWidth(el.clientWidth || window.innerWidth);
    window.addEventListener("resize", onWindowResize);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onWindowResize);
    };
  }, []);

  const usableEvidenceWidth =
    breakpoint === "narrow"
      ? explorerWidth
      : Math.max(
          0,
          explorerWidth -
            (filtersCollapsed
              ? COLLAPSED_FILTER_WIDTH_PX
              : filterW + SPLITTER_WIDTH_PX) -
            (chatCollapsed
              ? COLLAPSED_CHAT_WIDTH_PX
              : SPLITTER_WIDTH_PX + chatW),
        );
  const maxLaneCount =
    breakpoint === "narrow"
      ? 1
      : Math.max(
          1,
          Math.min(
            4,
            Math.floor(usableEvidenceWidth / MIN_EVIDENCE_LANE_WIDTH_PX),
          ),
        );

  useEffect(() => {
    const visibleCount = Math.min(preferredLaneCount, maxLaneCount);
    setLaneCount((current) =>
      current === visibleCount ? current : visibleCount,
    );
    if (visibleCount === 1) setLaneScrollSeq({});
  }, [maxLaneCount, preferredLaneCount]);

  // Drag splitters
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current || !rootRef.current) return;
      const rect = rootRef.current.getBoundingClientRect();
      if (dragRef.current === "filters") {
        setFilterW(Math.min(420, Math.max(140, e.clientX - rect.left)));
      } else if (dragRef.current === "chat") {
        setChatW(Math.min(520, Math.max(200, rect.right - e.clientX)));
      }
    };
    const onUp = () => {
      dragRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const startDrag = (which: "filters" | "chat") => (e: ReactMouseEvent) => {
    e.preventDefault();
    dragRef.current = which;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const refreshMeta = useCallback(async () => {
    const investigationRequest = ++investigationLoadRequestRef.current;
    try {
      const s = await hostGetLogCorpus(corpusId);
      setSummary(s);
      if (s) setCorpusTotal(s.eventCount ?? 0);
      await hostSetActiveLogCorpus(corpusId);
      const bms = await hostLogListBookmarks(corpusId);
      setBookmarks(bms ?? []);
      try {
        const activeInvestigation =
          await hostLogLoadActiveInvestigation(corpusId);
        if (investigationRequest !== investigationLoadRequestRef.current) {
          return;
        }
        setInvestigation(activeInvestigation);
        setInvestigationError(null);
      } catch (investigationLoadError) {
        setInvestigationError(String(investigationLoadError));
      }
    } catch (e) {
      setError(String(e));
    }
  }, [corpusId]);

  const loadFacets = useCallback(async () => {
    const requestId = ++facetRequestRef.current;
    try {
      const f = await hostLogFacets(
        corpusId,
        filtersToQuery(filters, { keyword: null }),
      );
      if (requestId !== facetRequestRef.current) return;
      setFacets(f);
    } catch (e) {
      if (requestId !== facetRequestRef.current) return;
      setError(String(e));
    }
  }, [corpusId, filters]);

  const loadLaneSourceCatalog = useCallback(async () => {
    const requestId = ++laneSourceRequestRef.current;
    setLaneSourceCatalog([]);
    setLaneSourceCatalogUnavailable(false);
    try {
      const sourceFacets = await hostLogFacets(
        corpusId,
        filtersToQuery(emptyFilters(), { keyword: null }),
      );
      if (requestId !== laneSourceRequestRef.current) return;
      setLaneSourceCatalog(Object.keys(sourceFacets.sources ?? {}).sort());
    } catch {
      if (requestId !== laneSourceRequestRef.current) return;
      setLaneSourceCatalogUnavailable(true);
    }
  }, [corpusId]);

  const loadEvents = useCallback(async () => {
    const requestId = ++eventsRequestRef.current;
    const visibleLanes = lanes.slice(0, laneCount);
    const unloaded = Object.fromEntries(
      visibleLanes.map((lane) => [
        lane.id,
        { status: "unloaded", quality: null } satisfies LaneTimeState,
      ]),
    );
    setBusy(true);
    setError(null);
    setLanePaging({});
    setLaneTimeStates(unloaded);
    setLaneMatched(
      Object.fromEntries(visibleLanes.map((lane) => [lane.id, null])),
    );
    setGaps([]);
    try {
      if (laneCount <= 1) {
        const sourceFilter = effectiveLaneSources(visibleLanes[0], filters);
        const page =
          sourceFilter?.length === 0
            ? emptyEventPage()
            : await hostLogQueryEvents(
                corpusId,
                filtersToQuery(filters, { sources: sourceFilter }),
              );
        if (requestId !== eventsRequestRef.current) return;
        const laneState: LaneTimeState =
          page.events.length > 0
            ? { status: "loaded", quality: page.timeQuality }
            : { status: "empty", quality: page.timeQuality };
        const states = { "lane-0": laneState };
        setTotalMatched(page.totalMatched);
        setLaneMatched({ "lane-0": page.totalMatched });
        setNextCursor(page.nextCursor);
        setLaneTimeStates(states);
        setTimeQuality(aggregateViewTimeQuality(["lane-0"], states));
        const seeded = seedFromPage(page);
        setLaneEvents({ "lane-0": seeded.events });
        setLaneCursors({
          "lane-0": {
            afterSeq: seeded.afterSeq,
            afterTs: seeded.afterTs,
            beforeSeq: seeded.beforeSeq,
            beforeTs: seeded.beforeTs,
            hasOlder: page.prevCursor != null,
            hasNewer: page.nextCursor != null,
          },
        });
        setAutoStatus(
          `${page.totalMatched} matched · ${seeded.events.length} resident (bounded)`,
        );
      } else {
        const byLane: Record<string, ExplorerEventDto[]> = {};
        const cursors: Record<
          string,
          {
            afterSeq: number | null;
            afterTs: number | null;
            beforeSeq: number | null;
            beforeTs: number | null;
            hasOlder: boolean;
            hasNewer: boolean;
          }
        > = {};
        const states: Record<string, LaneTimeState> = {};
        const matchedByLane: Record<string, number | null> = {};
        let maxLaneMatched = 0;
        let shown = 0;
        const requests = visibleLanes.map(async (lane) => {
          const sourceFilter = effectiveLaneSources(lane, filters);
          if (sourceFilter?.length === 0) {
            return { lane, page: emptyEventPage() };
          }
          const q = filtersToQuery(filters, {
            sources: sourceFilter,
            limit: 100,
            sortByTime: true,
          });
          const page = await hostLogQueryEvents(corpusId, q);
          return { lane, page };
        });
        const results = await Promise.allSettled(requests);
        if (requestId !== eventsRequestRef.current) return;
        let failed = 0;
        for (const [index, result] of results.entries()) {
          const lane = visibleLanes[index]!;
          if (result.status === "rejected") {
            failed += 1;
            byLane[lane.id] = [];
            cursors[lane.id] = {
              afterSeq: null,
              afterTs: null,
              beforeSeq: null,
              beforeTs: null,
              hasOlder: false,
              hasNewer: false,
            };
            states[lane.id] = { status: "error", quality: null };
            matchedByLane[lane.id] = null;
            continue;
          }
          const { page } = result.value;
          const seeded = seedFromPage(page);
          byLane[lane.id] = seeded.events;
          cursors[lane.id] = {
            afterSeq: seeded.afterSeq,
            afterTs: seeded.afterTs,
            beforeSeq: seeded.beforeSeq,
            beforeTs: seeded.beforeTs,
            hasOlder: page.prevCursor != null,
            hasNewer: page.nextCursor != null,
          };
          matchedByLane[lane.id] = page.totalMatched;
          maxLaneMatched = Math.max(maxLaneMatched, page.totalMatched);
          shown += page.events.length;
          states[lane.id] =
            page.events.length > 0
              ? { status: "loaded", quality: page.timeQuality }
              : { status: "empty", quality: page.timeQuality };
        }
        setLaneEvents(byLane);
        setLaneMatched(matchedByLane);
        setLaneCursors(cursors);
        setLaneTimeStates(states);
        // No global unique matched total is derivable from overlapping lanes.
        setTotalMatched(0);
        setTimeQuality(
          aggregateViewTimeQuality(
            visibleLanes.map((lane) => lane.id),
            states,
          ),
        );
        setNextCursor(null);
        if (failed > 0) {
          setError(
            `${failed} evidence lane${failed === 1 ? "" : "s"} failed to load; time linking remains off`,
          );
        }
        setAutoStatus(
          `${laneCount} lanes · ${shown} resident rows · largest lane match ${maxLaneMatched}`,
        );
      }
    } catch (e) {
      if (requestId !== eventsRequestRef.current) return;
      setError(String(e));
    } finally {
      if (requestId === eventsRequestRef.current) setBusy(false);
    }
  }, [corpusId, filters, laneCount, lanes, setAutoStatus]);

  useEffect(() => {
    void refreshMeta();
  }, [refreshMeta]);

  useEffect(() => {
    void loadFacets();
    return () => {
      facetRequestRef.current += 1;
    };
  }, [loadFacets]);

  useEffect(() => {
    void loadLaneSourceCatalog();
    return () => {
      laneSourceRequestRef.current += 1;
    };
  }, [loadLaneSourceCatalog]);

  useEffect(() => {
    void loadEvents();
    return () => {
      eventsRequestRef.current += 1;
    };
  }, [loadEvents]);

  // Push view context to host for agent turns (optimized, not dump paste)
  const viewBrief = useMemo(() => {
    const parts = [
      `corpusId=${corpusId}`,
      `timeQuality=${timeQuality}`,
      filters.timeFrom != null ? `timeFrom=${filters.timeFrom}` : null,
      filters.timeTo != null ? `timeTo=${filters.timeTo}` : null,
      filters.seqFrom != null ? `seqFrom=${filters.seqFrom}` : null,
      filters.seqTo != null ? `seqTo=${filters.seqTo}` : null,
      filters.levels.length ? `levels=${filters.levels.join(",")}` : null,
      filters.sources.length ? `sources=${filters.sources.join(",")}` : null,
      filters.services.length ? `services=${filters.services.join(",")}` : null,
      filters.hosts.length ? `hosts=${filters.hosts.join(",")}` : null,
      filters.templateId != null ? `templateId=${filters.templateId}` : null,
      filters.traceId ? `traceId=${filters.traceId}` : null,
      filters.keyword ? `keyword=${filters.keyword}` : null,
      `linkMode=${linkMode}`,
      `lanes=${lanes
        .slice(0, laneCount)
        .map((l) => `${l.id}:[${l.sources.join(",")}]`)
        .join("|")}`,
      selected.size
        ? `selectedSeqs=[${[...selected].slice(0, 32).join(",")}]`
        : null,
      bookmarks.length
        ? `bookmarks=${bookmarks
            .slice(0, 12)
            .map((b) => b.label)
            .join(",")}`
        : null,
    ].filter(Boolean);
    return parts.join("; ");
  }, [
    corpusId,
    timeQuality,
    filters,
    linkMode,
    lanes,
    laneCount,
    selected,
    bookmarks,
  ]);

  // Gap summaries are claims about shared time and belong only to true Align.
  useEffect(() => {
    if (linkMode !== "align_time" || laneCount < 2) {
      setGaps([]);
      return;
    }
    const packed = lanes.slice(0, laneCount).map((l) => ({
      id: l.id,
      events: (laneEvents[l.id] ?? []).map((e): LaneEventRef => ({
        seq: e.seq,
        ts: e.ts,
      })),
    }));
    const allTs = packed.flatMap((l) => l.events.map((e) => e.ts));
    if (allTs.length === 0) {
      setGaps([]);
      return;
    }
    const from = Math.min(...allTs);
    const to = Math.max(...allTs) + 1;
    const width = Math.max(1, Math.floor((to - from) / 20));
    const g = computeGaps(packed, from, to, width, timeQuality);
    if (Array.isArray(g)) setGaps(g);
    else setGaps([]);
  }, [linkMode, laneCount, lanes, laneEvents, timeQuality]);

  useEffect(() => {
    const visibleLaneIds = lanes.slice(0, laneCount).map((lane) => lane.id);
    const settled = visibleLaneIds.every((laneId) => {
      const state = laneTimeStates[laneId];
      return (
        state?.status === "loaded" ||
        state?.status === "empty" ||
        state?.status === "error"
      );
    });
    if (!settled) return;
    const everyLaneHasEvents = visibleLaneIds.every(
      (laneId) => laneTimeStates[laneId]?.status === "loaded",
    );
    const invalid =
      (linkMode !== "independent" && !everyLaneHasEvents) ||
      (linkMode === "align_time" && timeQuality !== "wall") ||
      (linkMode === "follow_cursor" && timeQuality === "order_only");
    if (invalid) {
      setLinkMode("independent");
      saveLinkMode(corpusId, "independent");
      setGaps([]);
      setStatus(
        "Time link disabled: current lane time quality cannot support that mode",
      );
    }
  }, [corpusId, laneCount, laneTimeStates, lanes, linkMode, timeQuality]);

  const toggleLevel = (level: string) => {
    setFilters((f) => {
      const has = f.levels.includes(level);
      return {
        ...f,
        levels: has
          ? f.levels.filter((x) => x !== level)
          : [...f.levels, level],
      };
    });
  };

  const toggleSource = (source: string) => {
    setFilters((f) => {
      const has = f.sources.includes(source);
      return {
        ...f,
        sources: has
          ? f.sources.filter((x) => x !== source)
          : [...f.sources, source],
      };
    });
  };

  const toggleService = (service: string) => {
    setFilters((f) => ({
      ...f,
      services: f.services.includes(service)
        ? f.services.filter((value) => value !== service)
        : [...f.services, service],
    }));
  };

  const toggleHost = (host: string) => {
    setFilters((f) => ({
      ...f,
      hosts: f.hosts.includes(host)
        ? f.hosts.filter((value) => value !== host)
        : [...f.hosts, host],
    }));
  };

  /** Apply a neighborhood page into one lane's residency + cursors. */
  const applyNeighborhoodToLane = (
    nb: Awaited<ReturnType<typeof hostLogQueryEventNeighborhood>>,
    laneId = "lane-0",
  ) => {
    if (nb.events.length === 0) return;
    const seeded = seedFromPage({
      events: nb.events,
      nextCursor: nb.nextCursor ?? null,
      nextTs: nb.nextTs ?? null,
      prevCursor: nb.prevCursor ?? null,
      prevTs: nb.prevTs ?? null,
      totalMatched: nb.totalMatched,
    });
    setLaneEvents((prev) => ({ ...prev, [laneId]: seeded.events }));
    setLaneCursors((prev) => ({
      ...prev,
      [laneId]: {
        afterSeq: seeded.afterSeq,
        afterTs: seeded.afterTs,
        beforeSeq: seeded.beforeSeq,
        beforeTs: seeded.beforeTs,
        hasOlder: nb.prevCursor != null,
        hasNewer: nb.nextCursor != null,
      },
    }));
    if (nb.corpusTotal > 0) setCorpusTotal(nb.corpusTotal);
    setLaneMatched((m) => ({ ...m, [laneId]: nb.totalMatched }));
    if (laneCount === 1) setTotalMatched(nb.totalMatched);
  };

  /** Seek a stable event into the resident window via neighborhood API. */
  const seekToSeq = async (
    seq: number,
    opts?: {
      clearFilters?: boolean;
      laneId?: string;
      sources?: string[];
      focusRow?: boolean;
      viewFilters?: ExplorerFilters;
      selectTarget?: boolean;
    },
  ): Promise<"found" | "hidden_by_filter" | "missing"> => {
    const base =
      opts?.viewFilters ?? (opts?.clearFilters ? emptyFilters() : filters);
    const sourceFilter =
      opts?.sources != null
        ? composeLaneSources(opts.sources, base.sources)
        : base.sources.length > 0
          ? base.sources
          : undefined;
    if (sourceFilter?.length === 0) {
      return "hidden_by_filter";
    }
    const filter = filtersToQuery(base, {
      keyword: base.keyword,
      sources: sourceFilter,
    });
    const nb = await hostLogQueryEventNeighborhood(corpusId, {
      targetSeq: seq,
      before: 50,
      after: 50,
      filter,
      sortByTime: true,
    });
    if (nb.status === "found") {
      const laneId = opts?.laneId ?? "lane-0";
      applyNeighborhoodToLane(nb, laneId);
      setFocusLaneId(laneId);
      setLaneScrollSeq((m) => ({ ...m, [laneId]: seq }));
      if (opts?.focusRow) {
        setBookmarkFocusTarget({ laneId, seq });
      }
      if (nb.target && opts?.selectTarget !== false) {
        showDetail(nb.target);
        setSelected(new Set([seq]));
      }
    }
    return nb.status;
  };

  const visibleLaneForSource = (source: string | null | undefined) => {
    const visibleLanes = lanes.slice(0, laneCount);
    if (!source) return null;
    return (
      visibleLanes.find((lane) => {
        const sourceFilter = effectiveLaneSources(lane, filters);
        if (sourceFilter?.length === 0) return false;
        return sourceFilter == null || sourceFilter.includes(source);
      }) ?? null
    );
  };

  const visibleLaneWithResidentSeq = (seq: number) =>
    lanes
      .slice(0, laneCount)
      .find((lane) => (laneEvents[lane.id] ?? []).some((e) => e.seq === seq)) ??
    null;

  const focusFindMatch = async (match: {
    seq: number;
    source?: string | null;
  }): Promise<
    "focused" | "outside_visible_lanes" | "hidden_by_filter" | "missing"
  > => {
    const targetLane =
      visibleLaneForSource(match.source) ??
      visibleLaneWithResidentSeq(match.seq);
    if (!targetLane) {
      return "outside_visible_lanes";
    }
    const residentTarget = (laneEvents[targetLane.id] ?? []).find(
      (e) => e.seq === match.seq,
    );
    if (residentTarget) {
      setFocusLaneId(targetLane.id);
      setLaneScrollSeq((m) => ({ ...m, [targetLane.id]: match.seq }));
      return "focused";
    }
    const status = await seekToSeq(match.seq, {
      laneId: targetLane.id,
      sources: targetLane.sources,
    });
    return status === "found" ? "focused" : status;
  };

  /**
   * Find: highlight matches in full investigation context (#523).
   * Does NOT replace the resident table with only hits.
   * Uses direct neighborhood seek for non-resident matches (no 40-page scan).
   */
  const clearFindResults = (message?: string) => {
    findRequestRef.current += 1;
    const backendRequestId = activeFindRequestRef.current;
    activeFindRequestRef.current = null;
    if (backendRequestId) void hostCancelLogSearch(backendRequestId);
    findActiveRef.current = false;
    setFindSearching(false);
    setFindCancelling(false);
    setFindActiveQuery(null);
    setFindMatches([]);
    setFindMatchSources({});
    setFindMatchRefs({});
    setFindExcerpts({});
    setFindIndex(0);
    setFindTotal(0);
    setFindTotalExact(false);
    setFindBase(0);
    setFindNextCursor(null);
    setFindPageStart(null);
    setFindHistory([]);
    setFindPartial(false);
    setHighlight(new Set());
    if (message) setStatus(message);
  };

  const requestFindPage = async (
    start: FindCursor | null,
    base: number,
    history: FindPageHistory[],
    target: "first" | "last",
    scopedFilters: ExplorerFilters,
    definition?: {
      query: string;
      matchMode: SearchMatchMode;
      caseSensitive: boolean;
      semantic: boolean;
    },
  ) => {
    const q = (definition?.query ?? findDraft).trim();
    const matchMode = definition?.matchMode ?? findMatchMode;
    const caseSensitive = definition?.caseSensitive ?? findCaseSensitive;
    const semantic = definition?.semantic ?? findUseSemantic;
    if (!q) {
      clearFindResults("Find cleared");
      return;
    }
    const previousBackendRequestId = activeFindRequestRef.current;
    if (previousBackendRequestId) {
      void hostCancelLogSearch(previousBackendRequestId);
    }
    const requestId = ++findRequestRef.current;
    const backendRequestId = createLogSearchRequestId();
    activeFindRequestRef.current = backendRequestId;
    findActiveRef.current = true;
    setFindActiveQuery(q);
    setFindSearching(true);
    setFindCancelling(false);
    setBusy(true);
    setError(null);
    try {
      const result = await hostLogSearchEventsAdvanced(corpusId, {
        requestId: backendRequestId,
        query: q,
        semantic: semantic && matchMode === "literal",
        matchMode,
        caseSensitive,
        // Only one bounded result page is retained in the webview.
        k: FIND_PAGE_SIZE,
        // Compose Find with every active Filter predicate, including keyword.
        filter: filtersToQuery(scopedFilters, {
          afterSeq: start?.seq ?? null,
          afterTs: start?.ts ?? null,
          beforeSeq: null,
          beforeTs: null,
        }),
      });
      if (requestId !== findRequestRef.current) return;
      if (result.cancelled) {
        setStatus("Find cancelled · previous visible results preserved");
        return;
      }
      const hits = result.hits;
      const seqs = hits.map((h) => h.event.seq);
      setFindMatchSources(
        Object.fromEntries(
          hits.map((hit) => [hit.event.seq, hit.event.source]),
        ),
      );
      setFindMatchRefs(
        Object.fromEntries(
          hits.map((hit) => [
            hit.event.seq,
            investigationEventRef(corpusId, hit.event),
          ]),
        ),
      );
      setFindExcerpts(
        Object.fromEntries(
          hits
            .filter((hit) => hit.excerpt)
            .map((hit) => [hit.event.seq, hit.excerpt!]),
        ),
      );
      const index = target === "last" ? Math.max(0, seqs.length - 1) : 0;
      setFindMatches(seqs);
      setFindTotal(result.totalMatched ?? base + seqs.length);
      setFindTotalExact(result.totalMatched != null);
      setFindBase(base);
      setFindIndex(index);
      setFindPartial(result.partial);
      setFindPageStart(start);
      setFindHistory(history);
      setFindNextCursor(
        result.nextCursor != null && result.nextTs != null
          ? { seq: result.nextCursor, ts: result.nextTs }
          : null,
      );
      setHighlight(new Set(seqs));
      let findContextStatus: Awaited<ReturnType<typeof focusFindMatch>> | null =
        null;
      if (seqs.length > 0) {
        findContextStatus = await focusFindMatch(hits[index]!.event);
      }
      const modeLabel = matchMode === "regex" ? "regex" : "literal";
      const extra = [
        result.partial && result.nextCursor == null ? "partial/capped" : null,
        result.diagnostic,
      ]
        .filter(Boolean)
        .join(" · ");
      const ordinal = base + index + 1;
      const totalLabel =
        result.totalMatched != null
          ? String(result.totalMatched)
          : result.nextCursor != null
            ? `${base + seqs.length}+`
            : String(base + seqs.length);
      setStatus(
        seqs.length
          ? `Find (${modeLabel}): match ${ordinal} of ${totalLabel} for “${q}”${
              extra ? ` (${extra})` : ""
            } (${
              findContextStatus === "outside_visible_lanes"
                ? "target outside visible lanes; context not broadened"
                : "context preserved"
            }; ${seqs.length} result identities resident)`
          : `Find (${modeLabel}): no matches for “${q}”${
              result.diagnostic ? ` — ${result.diagnostic}` : ""
            }`,
      );
    } catch (e) {
      if (requestId !== findRequestRef.current) return;
      setError(String(e));
    } finally {
      if (requestId === findRequestRef.current) {
        if (activeFindRequestRef.current === backendRequestId) {
          activeFindRequestRef.current = null;
        }
        setFindSearching(false);
        setFindCancelling(false);
        setBusy(false);
      }
    }
  };

  const cancelFind = async () => {
    const requestId = activeFindRequestRef.current;
    if (!requestId || findCancelling) return;
    setFindCancelling(true);
    setStatus("Cancelling Find…");
    try {
      const signalled = await hostCancelLogSearch(requestId);
      if (!signalled && activeFindRequestRef.current === requestId) {
        setFindCancelling(false);
        setStatus("Find is still running · try Cancel again");
      }
    } catch (cancelError) {
      if (activeFindRequestRef.current !== requestId) return;
      setFindCancelling(false);
      setError(`Unable to cancel Find: ${String(cancelError)}`);
    }
  };

  const runFind = async () => {
    await requestFindPage(null, 0, [], "first", filters);
  };

  findRefreshRef.current = (nextFilters) => {
    if (!findActiveRef.current) return;
    void requestFindPage(null, 0, [], "first", nextFilters);
  };

  useEffect(() => {
    if (suppressNextFindRefreshRef.current) {
      suppressNextFindRefreshRef.current = false;
      return;
    }
    findRefreshRef.current(filters);
  }, [filters]);

  const findStep = async (dir: 1 | -1) => {
    if (findMatches.length === 0) {
      if (dir === 1 && findNextCursor) {
        await requestFindPage(
          findNextCursor,
          findBase,
          [...findHistory, { start: findPageStart, base: findBase }],
          "first",
          filters,
        );
      } else if (dir === -1) {
        const previous = findHistory.at(-1);
        if (previous) {
          await requestFindPage(
            previous.start,
            previous.base,
            findHistory.slice(0, -1),
            "last",
            filters,
          );
        }
      }
      return;
    }
    if (dir === 1 && findIndex === findMatches.length - 1) {
      if (!findNextCursor) {
        setStatus("Find: end of results");
        return;
      }
      await requestFindPage(
        findNextCursor,
        findBase + findMatches.length,
        [...findHistory, { start: findPageStart, base: findBase }],
        "first",
        filters,
      );
      return;
    }
    if (dir === -1 && findIndex === 0) {
      const previous = findHistory.at(-1);
      if (!previous) {
        setStatus("Find: beginning of results");
        return;
      }
      await requestFindPage(
        previous.start,
        previous.base,
        findHistory.slice(0, -1),
        "last",
        filters,
      );
      return;
    }
    const next = findIndex + dir;
    setFindIndex(next);
    const seq = findMatches[next]!;
    const findContextStatus = await focusFindMatch({
      seq,
      source: findMatchSources[seq],
    });
    setStatus(
      `Find: match ${findBase + next + 1} of ${
        findTotalExact
          ? findTotal
          : `${Math.max(findTotal, findBase + findMatches.length)}+`
      }${
        findContextStatus === "outside_visible_lanes"
          ? " · target outside visible lanes; context not broadened"
          : ""
      }`,
    );
  };

  /** Filter: reduce visible events by keyword ∩ facets (#523). */
  const applyFilterKeyword = () => {
    const kw = filterDraft.trim() || null;
    setFilters((f) => ({ ...f, keyword: kw }));
    setStatus(
      kw
        ? `Filter: keyword “${kw}” (intersects levels/sources/time)`
        : "Filter: keyword cleared",
    );
  };

  const applyStructuredFilters = () => {
    try {
      const templateId = parseWholeNumber(templateDraft, "Template ID");
      const seqFrom = parseWholeNumber(seqFromDraft, "Sequence start");
      const seqTo = parseWholeNumber(seqToDraft, "Sequence end");
      const timeFrom = parseUtcSeconds(timeFromDraft, "UTC start");
      const timeTo = parseUtcSeconds(timeToDraft, "UTC end");
      if (seqFrom != null && seqTo != null && seqFrom > seqTo) {
        throw new Error("Sequence start must be less than or equal to end");
      }
      if (timeFrom != null && timeTo != null && timeFrom >= timeTo) {
        throw new Error("UTC start must be earlier than the exclusive end");
      }
      if (
        (timeFrom != null || timeTo != null) &&
        (facets?.timeQuality ?? timeQuality) !== "wall"
      ) {
        throw new Error(
          "Exact UTC filtering requires wall-clock data; use sequence range for mixed or order-only logs",
        );
      }
      const traceId = traceDraft.trim() || null;
      setFilters((current) => ({
        ...current,
        templateId,
        traceId,
        timeFrom,
        timeTo,
        seqFrom,
        seqTo,
      }));
      setStatus(
        templateId == null &&
          traceId == null &&
          timeFrom == null &&
          timeTo == null &&
          seqFrom == null &&
          seqTo == null
          ? "Structured filters cleared"
          : "Structured filters applied (AND with Find, Filter, and facets)",
      );
    } catch (applyError) {
      setStatus(`Structured filters not applied: ${String(applyError)}`);
    }
  };

  const clearAllFilters = () => {
    setFilterDraft("");
    setFilters(emptyFilters());
    setStatus("All event filters cleared");
  };

  const onRowClick = (e: ExplorerEventDto, multi: boolean) => {
    showDetail(e);
    setSelected((prev) => {
      const next = new Set(multi ? prev : []);
      if (next.has(e.seq)) next.delete(e.seq);
      else next.add(e.seq);
      return next;
    });
    if (linkMode !== "independent" && laneCount > 1) {
      const packed = lanes.slice(0, laneCount).map((l) => ({
        id: l.id,
        events: (laneEvents[l.id] ?? []).map((x): LaneEventRef => ({
          seq: x.seq,
          ts: x.ts,
        })),
      }));
      const scrub = scrubLinked(e.ts, packed, timeQuality);
      if (scrub.linked) {
        const scrollMap: Record<string, number | null> = {};
        const hl = new Set<number>();
        for (const p of scrub.peerPositions) {
          scrollMap[p.laneId] = p.seq;
          if (p.seq != null) hl.add(p.seq);
        }
        if (linkMode === "follow_cursor") {
          setLaneScrollSeq(scrollMap);
        }
        setHighlight(hl);
        setStatus(
          linkMode === "align_time"
            ? `Aligned wall-clock row ts=${e.ts} · empty cells are explicit missing evidence`
            : `Follow cursor ts=${e.ts} · ${scrub.peerPositions
                .map((p) => `${p.laneId}→${p.seq ?? "—"}`)
                .join(" · ")}`,
        );
      } else if (scrub.refuseReason) {
        setStatus(scrub.refuseReason);
      }
    }
  };

  const selectedEvidenceRefs = (): {
    seqs: number[];
    eventRefs: LogBookmarkEventRefDto[];
  } | null => {
    const seqs = [...selected].sort((a, b) => a - b);
    if (seqs.length === 0 && detail) seqs.push(detail.seq);
    if (seqs.length === 0) {
      return null;
    }
    const residentBySeq = new Map(
      Object.values(laneEvents)
        .flat()
        .map((event) => [event.seq, event] as const),
    );
    const selectedEvents = seqs.map((seq) => residentBySeq.get(seq));
    if (selectedEvents.some((event) => !event)) {
      return null;
    }
    const eventRefs: LogBookmarkEventRefDto[] = selectedEvents.map((event) => ({
      corpusId,
      seq: event!.seq,
      source: event!.source,
      timestampHint: event!.ts,
      timeQualityHint: event!.timeQuality,
    }));
    return { seqs, eventRefs };
  };

  const captureCurrentInvestigationView =
    (): InvestigationViewRecipeDto | null => {
      const refsBySeq = new Map<number, LogBookmarkEventRefDto>();
      for (const event of Object.values(laneEvents).flat()) {
        refsBySeq.set(event.seq, investigationEventRef(corpusId, event));
      }
      for (const eventRef of Object.values(findMatchRefs)) {
        refsBySeq.set(eventRef.seq, eventRef);
      }
      for (const eventRef of [
        ...(investigation?.document.evidence ?? []).flatMap(
          (item) => item.eventRefs,
        ),
        ...bookmarks.flatMap((item) => item.eventRefs ?? []),
      ]) {
        refsBySeq.set(eventRef.seq, eventRef);
      }
      const exactRefs = (seqs: Iterable<number>) => {
        const ordered = [...seqs].sort((a, b) => a - b);
        const refs = ordered.flatMap((seq) => {
          const eventRef = refsBySeq.get(seq);
          return eventRef ? [{ ...eventRef }] : [];
        });
        return refs.length === ordered.length ? refs : null;
      };
      const selectionRefs = exactRefs(selected);
      const highlightRefs = exactRefs(highlight);
      if (!selectionRefs || !highlightRefs) return null;
      const focusedEvent = detail
        ? investigationEventRef(corpusId, detail)
        : null;
      return captureInvestigationView({
        filters,
        lanes,
        visibleLaneCount: laneCount,
        linkMode,
        focusedLaneId: focusLaneId,
        focusedEvent,
        selection: selectionRefs,
        highlights: highlightRefs,
        find: findActiveQuery
          ? {
              query: findActiveQuery,
              matchMode: findMatchMode,
              caseSensitive: findCaseSensitive,
              semantic: findUseSemantic,
            }
          : null,
        viewportAnchors: laneViewportAnchors,
      });
    };

  const bookmarkSelection = async () => {
    const selection = selectedEvidenceRefs();
    if (!selection) {
      setStatus(
        selected.size === 0 && !detail
          ? "Select a row (or focus detail) then press B to bookmark"
          : "Selection changed before it could be bookmarked — reselect the evidence",
      );
      return;
    }
    const { seqs, eventRefs } = selection;
    const from = seqs[0]!;
    const to = seqs[seqs.length - 1]!;
    const contiguous = seqs.every(
      (seq, index) => index === 0 || seq === seqs[index - 1]! + 1,
    );
    const oneSource =
      new Set(eventRefs.map((event) => event.source)).size === 1;
    const exactKey = (refs: typeof eventRefs) =>
      refs
        .map(
          (event) =>
            `${event.corpusId}\u0000${event.seq}\u0000${event.source}\u0000${event.timestampHint}\u0000${event.timeQualityHint}`,
        )
        .sort()
        .join("\u0001");
    const selectedKey = exactKey(eventRefs);
    const existing = bookmarks.find((bookmark) => {
      if (bookmark.eventRefs?.length) {
        return exactKey(bookmark.eventRefs) === selectedKey;
      }
      return (
        contiguous &&
        oneSource &&
        bookmark.seqFrom === from &&
        bookmark.seqTo === to
      );
    });
    if (existing) {
      setStatus(`Already bookmarked: ${existing.label}`);
      return;
    }
    try {
      const bm = await hostLogAddBookmark(corpusId, {
        seqFrom: from,
        seqTo: to,
        eventRefs,
        label:
          from === to
            ? `seq ${from}`
            : contiguous
              ? `seq ${from}–${to}`
              : `${seqs.length} selected events`,
      });
      setBookmarks((current) =>
        current.some((bookmark) => bookmark.id === bm.id)
          ? current
          : [...current, bm],
      );
      setStatus(
        bookmarks.some((bookmark) => bookmark.id === bm.id)
          ? `Already bookmarked: ${bm.label}`
          : `Bookmarked ${bm.label}`,
      );
    } catch (e) {
      setError(String(e));
    }
  };

  const openSaveEvidence = () => {
    const selection = selectedEvidenceRefs();
    if (!selection) {
      setStatus(
        selected.size === 0 && !detail
          ? "Select one or more visible rows before saving evidence"
          : "Selection changed before it could be saved — reselect the evidence",
      );
      return;
    }
    setInvestigationError(null);
    setSaveEvidenceOpen(true);
  };

  const saveSelectedEvidence = async (title: string) => {
    const selection = selectedEvidenceRefs();
    if (!selection) {
      setSaveEvidenceOpen(false);
      return;
    }
    const priorEvidenceCount = investigation?.document.evidence.length ?? 0;
    // A slower metadata request must not replace the revision returned here.
    investigationLoadRequestRef.current += 1;
    setInvestigationBusy(true);
    setInvestigationError(null);
    try {
      const updated = await hostLogAddInvestigationEvidence(corpusId, {
        investigationId: investigation?.document.id ?? null,
        expectedRevision: investigation?.document.revision ?? null,
        title,
        eventRefs: selection.eventRefs,
      });
      setInvestigation(updated);
      setEvidencePreview(null);
      setSaveEvidenceOpen(false);
      setInvestigationMode("investigation");
      setChatCollapsed(false);
      if (breakpoint === "narrow") {
        setNarrowFiltersOpen(false);
        setNarrowChatOpen(true);
      }
      const nextEvidenceCount = updated.document.evidence.length;
      setStatus(
        nextEvidenceCount === priorEvidenceCount
          ? "That exact evidence set is already saved"
          : `Saved ${selection.eventRefs.length} exact event ${
              selection.eventRefs.length === 1 ? "identity" : "identities"
            } to Investigation`,
      );
    } catch (saveError) {
      const message = String(saveError);
      setInvestigationError(message);
      if (message.toLowerCase().includes("stale investigation revision")) {
        try {
          setInvestigation(await hostLogLoadActiveInvestigation(corpusId));
        } catch {
          // Keep the original optimistic-concurrency error visible.
        }
      }
    } finally {
      setInvestigationBusy(false);
    }
  };

  const dismissInvestigationAddMenu = useCallback(
    () => setInvestigationAddMenuOpen(false),
    [],
  );

  const openCreateInvestigationItem = (type: "finding" | "note") => {
    const selection = selectedEvidenceRefs();
    if (!selection) {
      setInvestigationAddMenuOpen(false);
      setStatus(
        selected.size === 0 && !detail
          ? "Select one or more visible rows before adding investigation material"
          : "Selection changed before it could be cited — reselect the evidence",
      );
      return;
    }
    setInvestigationError(null);
    setInvestigationAddMenuOpen(false);
    setCreateInvestigationItem(type);
  };

  const saveInvestigationItem = async (draft: InvestigationItemDraft) => {
    const selection = selectedEvidenceRefs();
    if (!selection) {
      setCreateInvestigationItem(null);
      return;
    }
    const viewRecipe =
      draft.type === "finding" ? captureCurrentInvestigationView() : null;
    if (draft.type === "finding" && !viewRecipe) {
      setInvestigationError(
        "This view includes an identity that is no longer authoritative. Rerun Find or reselect the visible evidence before saving the finding.",
      );
      return;
    }
    const priorFindingCount = investigation?.document.findings?.length ?? 0;
    const priorNoteCount = investigation?.document.notes?.length ?? 0;
    investigationLoadRequestRef.current += 1;
    setInvestigationBusy(true);
    setInvestigationError(null);
    try {
      const common = {
        investigationId: investigation?.document.id ?? null,
        expectedRevision: investigation?.document.revision ?? null,
        title: draft.title,
        eventRefs: selection.eventRefs,
      };
      const updated =
        draft.type === "finding"
          ? await hostLogAddInvestigationFinding(corpusId, {
              ...common,
              kind: draft.kind,
              whyItMatters: draft.body,
              viewRecipe,
            })
          : await hostLogAddInvestigationNote(corpusId, {
              ...common,
              body: draft.body,
            });
      setInvestigation(updated);
      setEvidencePreview(null);
      setCreateInvestigationItem(null);
      setInvestigationMode("investigation");
      setChatCollapsed(false);
      if (breakpoint === "narrow") {
        setNarrowFiltersOpen(false);
        setNarrowChatOpen(true);
      }
      const wasDuplicate =
        draft.type === "finding"
          ? (updated.document.findings?.length ?? 0) === priorFindingCount
          : (updated.document.notes?.length ?? 0) === priorNoteCount;
      setStatus(
        wasDuplicate
          ? `That exact ${draft.type} is already saved`
          : `Saved human-authored ${draft.type} with ${selection.eventRefs.length} exact evidence ${
              selection.eventRefs.length === 1 ? "citation" : "citations"
            }`,
      );
    } catch (saveError) {
      const message = String(saveError);
      setInvestigationError(message);
      if (message.toLowerCase().includes("stale investigation revision")) {
        try {
          setInvestigation(await hostLogLoadActiveInvestigation(corpusId));
        } catch {
          // Keep the original optimistic-concurrency error visible.
        }
      }
    } finally {
      setInvestigationBusy(false);
    }
  };

  const openEditFinding = (
    item: FindingItemView,
    trigger: HTMLButtonElement,
  ) => {
    investigationEditTriggerRef.current = trigger;
    setInvestigationError(null);
    setEditInvestigationItem({ type: "finding", item });
  };

  const openEditNote = (item: NoteItemView, trigger: HTMLButtonElement) => {
    investigationEditTriggerRef.current = trigger;
    setInvestigationError(null);
    setEditInvestigationItem({ type: "note", item });
  };

  const saveEditedInvestigationItem = async (draft: InvestigationItemDraft) => {
    if (!investigation || !editInvestigationItem) return;
    investigationLoadRequestRef.current += 1;
    setInvestigationBusy(true);
    setInvestigationError(null);
    try {
      const updated =
        draft.type === "finding" && editInvestigationItem.type === "finding"
          ? await hostLogEditInvestigationFinding(corpusId, {
              investigationId: investigation.document.id,
              expectedRevision: investigation.document.revision,
              findingId: editInvestigationItem.item.id,
              kind: draft.kind,
              lifecycle: draft.lifecycle,
              title: draft.title,
              whyItMatters: draft.body,
            })
          : draft.type === "note" && editInvestigationItem.type === "note"
            ? await hostLogEditInvestigationNote(corpusId, {
                investigationId: investigation.document.id,
                expectedRevision: investigation.document.revision,
                noteId: editInvestigationItem.item.id,
                title: draft.title,
                body: draft.body,
                evidenceIds: editInvestigationItem.item.evidenceIds,
                findingIds: editInvestigationItem.item.findingIds,
              })
            : null;
      if (!updated) {
        throw new Error("Investigation editor type changed unexpectedly");
      }
      setInvestigation(updated);
      setEditInvestigationItem(null);
      setStatus(`Updated ${draft.type}`);
    } catch (saveError) {
      const message = String(saveError);
      setInvestigationError(message);
      if (message.toLowerCase().includes("stale investigation revision")) {
        try {
          setInvestigation(await hostLogLoadActiveInvestigation(corpusId));
        } catch {
          // Keep the original optimistic-concurrency error visible.
        }
      }
    } finally {
      setInvestigationBusy(false);
    }
  };

  const askAboutSelection = () => {
    const selection = selectedEvidenceRefs();
    if (!selection) {
      setStatus(
        selected.size === 0 && !detail
          ? "Select one or more visible rows before asking about them"
          : "Selection changed before it could be investigated — reselect the evidence",
      );
      return;
    }
    const promptRefs = selection.eventRefs.slice(0, 32);
    const identities = promptRefs
      .map((eventRef) => `seq ${eventRef.seq} (${eventRef.source})`)
      .join(", ");
    const boundedNotice =
      promptRefs.length < selection.eventRefs.length
        ? ` This prompt names the first ${promptRefs.length} of ${selection.eventRefs.length} selected identities to keep context bounded; ask me to narrow the selection before claiming anything about the remainder.`
        : "";
    chatDraftRequestIdRef.current += 1;
    setChatDraftRequest({
      id: chatDraftRequestIdRef.current,
      text:
        `Investigate these selected log event identities: ${identities}. ` +
        "Retrieve the authoritative events with governed log tools, explain the strongest supported relationship or anomaly, and cite exact seq, source, and timestamp evidence. Do not infer beyond retrieved evidence." +
        boundedNotice,
    });
    setInvestigationMode("chat");
    setChatCollapsed(false);
    if (breakpoint === "narrow") {
      setNarrowFiltersOpen(false);
      setNarrowChatOpen(true);
    }
    setStatus(
      `Prepared a governed chat question for ${selection.eventRefs.length} selected ${
        selection.eventRefs.length === 1 ? "event" : "events"
      }`,
    );
  };

  const onKeyDown = (ev: ReactKeyboardEvent) => {
    if (
      ev.key === "Escape" &&
      !ev.defaultPrevented &&
      breakpoint === "narrow"
    ) {
      if (narrowFiltersOpen) {
        ev.preventDefault();
        setNarrowFiltersOpen(false);
        queueMicrotask(() => narrowFiltersToggleRef.current?.focus());
        return;
      }
      if (narrowChatOpen) {
        ev.preventDefault();
        setNarrowChatOpen(false);
        queueMicrotask(() => narrowChatToggleRef.current?.focus());
        return;
      }
    }
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "f") {
      ev.preventDefault();
      setNarrowFiltersOpen(true);
      setNarrowChatOpen(false);
      findInputRef.current?.focus();
      return;
    }
    if (ev.key === "b" || ev.key === "B") {
      if (
        (ev.target as HTMLElement)?.tagName === "INPUT" ||
        (ev.target as HTMLElement)?.tagName === "TEXTAREA"
      ) {
        return;
      }
      ev.preventDefault();
      void bookmarkSelection();
    }
  };

  /** #533: drop selection/detail that is no longer in any resident lane. */
  useEffect(() => {
    const resident = new Set(
      Object.values(laneEvents)
        .flat()
        .map((e) => e.seq),
    );
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set([...prev].filter((s) => resident.has(s)));
      if (next.size === prev.size) return prev;
      if (next.size === 0) {
        if (suppressSelectionClearStatusRef.current) {
          suppressSelectionClearStatusRef.current = false;
        } else {
          setStatus(
            "Selection cleared — event no longer visible under filters/lanes",
          );
        }
      }
      return next;
    });
    if (detail && !resident.has(detail.seq)) clearDetail();
  }, [clearDetail, detail, laneEvents]);

  /** #531: activate bookmark — direct neighborhood seek (no multi-page scan). */
  const activateBookmark = async (b: LogBookmarkDto) => {
    if (b.evidenceStatus === "missing" || b.evidenceStatus === "stale") {
      setBookmarkRevealState("missing");
      setStatus(
        b.evidenceStatus === "missing"
          ? `Bookmark evidence is missing from this corpus: ${b.label}`
          : `Bookmark evidence identity no longer matches this corpus: ${b.label}`,
      );
      return;
    }
    const exactRefs = b.eventRefs ?? [];
    const targetRef = exactRefs[0];
    const seq = targetRef?.seq ?? b.seqFrom;
    setHighlight(
      new Set(
        exactRefs.length > 0
          ? exactRefs.map((eventRef) => eventRef.seq)
          : Array.from(
              { length: Math.max(1, b.seqTo - b.seqFrom + 1) },
              (_, i) => b.seqFrom + i,
            ),
      ),
    );

    setBusy(true);
    setError(null);
    try {
      // Resolve the stable target under current global filters. Hidden results
      // still return the target identity so the correct source lane can be
      // selected or temporarily composed.
      const resolved = await hostLogQueryEventNeighborhood(corpusId, {
        targetSeq: seq,
        before: 0,
        after: 0,
        filter: filtersToQuery(filters),
        sortByTime: true,
      });
      if (resolved.status === "missing" || !resolved.target) {
        setBookmarkRevealState("missing");
        setStatus(
          `Bookmark target seq ${seq} not found in corpus (source may have changed)`,
        );
        return;
      }
      if (
        targetRef &&
        (resolved.target.source !== targetRef.source ||
          resolved.target.ts !== targetRef.timestampHint ||
          resolved.target.timeQuality !== targetRef.timeQualityHint)
      ) {
        setBookmarkRevealState("missing");
        setStatus(
          `Bookmark evidence identity no longer matches this corpus: ${b.label}`,
        );
        return;
      }

      const visibleLanes = lanes.slice(0, laneCount);
      const matchingLane =
        visibleLanes.find(
          (lane) =>
            lane.sources.length > 0 &&
            lane.sources.includes(resolved.target!.source),
        ) ?? visibleLanes.find((lane) => lane.sources.length === 0);

      if (resolved.status === "found" && matchingLane) {
        const residentTarget = (laneEvents[matchingLane.id] ?? []).find(
          (event) => event.seq === seq,
        );
        if (residentTarget) {
          setFocusLaneId(matchingLane.id);
          setLaneScrollSeq((m) => ({ ...m, [matchingLane.id]: seq }));
          setBookmarkFocusTarget({ laneId: matchingLane.id, seq });
          showDetail(residentTarget);
          setSelected(new Set([seq]));
          setBookmarkRevealState("visible");
          setStatus(`Bookmark visible: ${b.label}`);
          return;
        }
        const status = await seekToSeq(seq, {
          laneId: matchingLane.id,
          sources:
            matchingLane.sources.length > 0
              ? matchingLane.sources
              : filters.sources,
          focusRow: true,
        });
        if (status !== "found") {
          throw new Error(
            "Bookmark target changed while it was being revealed",
          );
        }
        setBookmarkRevealState("visible");
        setStatus(`Bookmark visible under current filters: ${b.label}`);
        return;
      }

      // Hidden by filters or absent from current lane composition: preserve
      // the complete prior view and explicitly create a temporary reveal.
      if (!revealRestore) {
        const priorView = captureCurrentInvestigationView();
        if (!priorView) {
          setBookmarkRevealState("missing");
          setStatus(
            "The current view contains an identity that can no longer be restored exactly. Rerun Find or clear the stale highlight before revealing this bookmark.",
          );
          return;
        }
        setRevealRestore(priorView);
      }
      const openFilters = emptyFilters();
      let revealLanes = lanes;
      let revealLane = matchingLane;
      autoStatusLockRef.current = "bookmark-reveal";
      if (!revealLane) {
        const first = lanes[0] ?? defaultLanes(1)[0]!;
        revealLane = {
          ...first,
          label: `Bookmark · ${resolved.target.source}`,
          sources: [resolved.target.source],
        };
        revealLanes = [revealLane, ...lanes.slice(1)];
        setLanes(revealLanes);
      }
      // Preserve the active Find definition for Restore prior view, but do not
      // let either an in-flight request or the filter-change refresh race this
      // explicit bookmark seek.
      findRequestRef.current += 1;
      const activeFindRequest = activeFindRequestRef.current;
      activeFindRequestRef.current = null;
      if (activeFindRequest) void hostCancelLogSearch(activeFindRequest);
      setFindSearching(false);
      setFindCancelling(false);
      suppressNextFindRefreshRef.current = true;
      setFilters(openFilters);
      setFilterDraft("");
      const status = await seekToSeq(seq, {
        clearFilters: true,
        laneId: revealLane.id,
        sources: [resolved.target.source],
        focusRow: true,
      });
      if (status === "found") {
        setBookmarkRevealState("revealed");
        setStatus(
          `Bookmark temporarily revealed: ${b.label} — filters cleared; restore prior view when done`,
        );
      } else if (status === "missing") {
        setBookmarkRevealState("missing");
        setStatus(
          `Bookmark target seq ${seq} not found in corpus (source may have changed)`,
        );
      } else {
        setBookmarkRevealState("missing");
        setStatus(`Bookmark target still not visible: ${b.label}`);
      }
    } catch (e) {
      setError(String(e));
      setBookmarkRevealState("missing");
    } finally {
      setBusy(false);
    }
  };

  const recipeFilters = (
    recipe: InvestigationViewRecipeDto,
  ): ExplorerFilters => ({
    levels: [...recipe.filters.levels],
    sources: [...recipe.filters.sources],
    services: [...recipe.filters.services],
    hosts: [...recipe.filters.hosts],
    timeFrom: recipe.filters.timeFrom,
    timeTo: recipe.filters.timeTo,
    seqFrom: recipe.filters.seqFrom,
    seqTo: recipe.filters.seqTo,
    templateId: recipe.filters.templateId,
    traceId: recipe.filters.traceId,
    keyword: recipe.filters.keyword,
  });

  const scheduleInvestigationViewApply = (
    recipe: InvestigationViewRecipeDto,
    status: string,
  ) => {
    const nextFilters = recipeFilters(recipe);
    findRequestRef.current += 1;
    findActiveRef.current = false;
    const activeFindRequest = activeFindRequestRef.current;
    activeFindRequestRef.current = null;
    if (activeFindRequest) void hostCancelLogSearch(activeFindRequest);
    setFindSearching(false);
    setFindCancelling(false);
    suppressNextFindRefreshRef.current = true;
    setFindActiveQuery(null);
    setFindMatches([]);
    setFindMatchSources({});
    setFindMatchRefs({});
    setFindExcerpts({});
    setFindIndex(0);
    setFindTotal(0);
    setFindTotalExact(false);
    setFindBase(0);
    setFindNextCursor(null);
    setFindPageStart(null);
    setFindHistory([]);
    setFindPartial(false);
    setSelected(new Set());
    setHighlight(new Set());
    clearDetail();
    setFilters(nextFilters);
    setFilterDraft(nextFilters.keyword ?? "");
    setLanes(
      recipe.lanes.map((lane) => ({
        id: lane.id,
        label: lane.label,
        sources: [...lane.sources],
      })),
    );
    setPreferredLaneCount(recipe.visibleLaneCount);
    setLaneCount(Math.min(recipe.visibleLaneCount, maxLaneCount));
    setLinkMode(recipe.linkMode);
    saveLinkMode(corpusId, recipe.linkMode);
    setFocusLaneId(recipe.focusedLaneId);
    setLaneEvents({});
    setLaneTimeStates({});
    setLaneViewportAnchors(
      Object.fromEntries(
        recipe.viewportAnchors.map((anchor) => [
          anchor.laneId,
          { ...anchor.eventRef },
        ]),
      ),
    );
    setFindDraft(recipe.find?.query ?? "");
    setFindMatchMode(recipe.find?.matchMode ?? "literal");
    setFindCaseSensitive(recipe.find?.caseSensitive ?? false);
    setFindUseSemantic(recipe.find?.semantic ?? false);
    setPendingViewApply({ recipe, status });
    setStatus(`${status} · positioning…`);
  };

  useEffect(() => {
    if (!pendingViewApply || busy) return;
    const visibleLanes = pendingViewApply.recipe.lanes.slice(
      0,
      Math.min(pendingViewApply.recipe.visibleLaneCount, maxLaneCount),
    );
    if (
      visibleLanes.some((lane) => {
        const state = laneTimeStates[lane.id];
        return (
          !state ||
          (state.status !== "loaded" &&
            state.status !== "empty" &&
            state.status !== "error")
        );
      })
    ) {
      return;
    }
    let cancelled = false;
    const applyPosition = async () => {
      const { recipe, status } = pendingViewApply;
      const nextFilters = recipeFilters(recipe);
      for (const anchor of recipe.viewportAnchors) {
        const lane = visibleLanes.find(
          (candidate) => candidate.id === anchor.laneId,
        );
        if (!lane) continue;
        await seekToSeq(anchor.eventRef.seq, {
          laneId: lane.id,
          sources: lane.sources,
          viewFilters: nextFilters,
          selectTarget: false,
        });
        if (cancelled) return;
      }
      if (recipe.find) {
        await requestFindPage(null, 0, [], "first", nextFilters, {
          query: recipe.find.query,
          matchMode: recipe.find.matchMode,
          caseSensitive: recipe.find.caseSensitive,
          semantic: recipe.find.semantic,
        });
        if (cancelled) return;
      }
      if (recipe.focusedEvent) {
        const lane =
          visibleLanes.find(
            (candidate) => candidate.id === recipe.focusedLaneId,
          ) ?? visibleLanes[0];
        if (lane) {
          await seekToSeq(recipe.focusedEvent.seq, {
            laneId: lane.id,
            sources: lane.sources,
            viewFilters: nextFilters,
            focusRow: true,
          });
          if (cancelled) return;
        }
      }
      const anchorScroll = Object.fromEntries(
        recipe.viewportAnchors.flatMap((anchor) =>
          visibleLanes.some((lane) => lane.id === anchor.laneId)
            ? [[anchor.laneId, anchor.eventRef.seq]]
            : [],
        ),
      );
      setLaneScrollSeq((current) => ({ ...current, ...anchorScroll }));
      if (recipe.focusedEvent && recipe.focusedLaneId) {
        setLaneScrollSeq((current) => ({
          ...current,
          [recipe.focusedLaneId!]: recipe.focusedEvent!.seq,
        }));
      }
      setSelected(new Set(recipe.selection.map((eventRef) => eventRef.seq)));
      setHighlight(new Set(recipe.highlights.map((eventRef) => eventRef.seq)));
      setFocusLaneId(recipe.focusedLaneId);
      setPendingViewApply(null);
      setStatus(status);
    };
    void applyPosition().catch((applyError) => {
      if (cancelled) return;
      setPendingViewApply(null);
      setInvestigationError(
        `Saved view could not be applied: ${String(applyError)}`,
      );
    });
    return () => {
      cancelled = true;
    };
    // Positioning helpers intentionally use the state snapshot that scheduled
    // this apply; function identity changes must not restart host navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, laneTimeStates, maxLaneCount, pendingViewApply]);

  const restorePriorView = () => {
    if (revealRestore) {
      autoStatusLockRef.current = "bookmark-restore";
      suppressSelectionClearStatusRef.current = true;
      scheduleInvestigationViewApply(
        revealRestore,
        "Restored prior Explorer view",
      );
      setRevealRestore(null);
      setBookmarkRevealState("idle");
    }
  };

  const previewInvestigationFindingView = async (item: FindingItemView) => {
    if (!investigation || !item.viewRecipe) return;
    const current = captureCurrentInvestigationView();
    if (!current) {
      setInvestigationError(
        "The current Explorer view includes an identity that cannot be compared exactly. Rerun Find or clear the stale highlight first.",
      );
      return;
    }
    setInvestigationBusy(true);
    setInvestigationError(null);
    try {
      const preview = await hostLogPreviewInvestigationFindingView(
        corpusId,
        investigation.document.id,
        item.id,
      );
      setFindingViewPreview({
        findingId: item.id,
        recipe: preview.recipe,
        changes: describeInvestigationViewDiff(current, preview.recipe),
        missingCount: preview.missingCount,
        staleCount: preview.staleCount,
      });
      setStatus("Previewed saved Explorer view · current view unchanged");
    } catch (previewError) {
      setInvestigationError(String(previewError));
    } finally {
      setInvestigationBusy(false);
    }
  };

  const applyInvestigationFindingView = async (
    preview: FindingViewPreviewView,
  ) => {
    if (!investigation) return;
    const priorView = captureCurrentInvestigationView();
    if (!priorView) {
      setInvestigationError(
        "The current Explorer view cannot be restored exactly. Rerun Find or clear the stale highlight before applying this saved view.",
      );
      return;
    }
    setInvestigationBusy(true);
    setInvestigationError(null);
    try {
      const fresh = await hostLogPreviewInvestigationFindingView(
        corpusId,
        investigation.document.id,
        preview.findingId,
      );
      if (fresh.missingCount > 0 || fresh.staleCount > 0) {
        setFindingViewPreview({
          findingId: preview.findingId,
          recipe: fresh.recipe,
          changes: preview.changes,
          missingCount: fresh.missingCount,
          staleCount: fresh.staleCount,
        });
        setInvestigationError(
          "Apply blocked because the saved view no longer resolves to exact authoritative event identities.",
        );
        return;
      }
      setRevealRestore(priorView);
      setFindingViewPreview(null);
      scheduleInvestigationViewApply(
        fresh.recipe,
        "Applied saved Explorer view · Restore prior view is available",
      );
    } catch (applyError) {
      setInvestigationError(String(applyError));
    } finally {
      setInvestigationBusy(false);
    }
  };

  const previewInvestigationEvidence = async (item: EvidenceItemView) => {
    if (!investigation) return;
    setInvestigationBusy(true);
    setInvestigationError(null);
    try {
      const preview = await hostLogPreviewInvestigationEvidence(
        corpusId,
        investigation.document.id,
        item.id,
      );
      const events = preview.references.flatMap((reference) =>
        reference.event ? [reference.event] : [],
      );
      setEvidencePreview({
        evidenceId: item.id,
        events,
        missingCount: preview.references.filter(
          (reference) => reference.status === "missing",
        ).length,
        staleCount: preview.references.filter(
          (reference) => reference.status === "stale",
        ).length,
      });
      setStatus(
        `Previewed ${events.length} authoritative event${
          events.length === 1 ? "" : "s"
        } without changing the Explorer view`,
      );
    } catch (previewError) {
      setInvestigationError(String(previewError));
    } finally {
      setInvestigationBusy(false);
    }
  };

  const revealInvestigationEvidence = async (item: EvidenceItemView) => {
    if (
      !investigation ||
      item.evidenceStatus !== "verified" ||
      item.eventRefs.length === 0
    ) {
      setInvestigationError(
        "Evidence must have fully verified event identities before it can change the Explorer view",
      );
      return;
    }
    setInvestigationBusy(true);
    setInvestigationError(null);
    try {
      // Apply is a fresh trust-boundary check, not a promise based on the
      // status observed when the rail first loaded.
      const current = await hostLogPreviewInvestigationEvidence(
        corpusId,
        investigation.document.id,
        item.id,
      );
      const missingCount = current.references.filter(
        (reference) => reference.status === "missing",
      ).length;
      const staleCount = current.references.filter(
        (reference) => reference.status === "stale",
      ).length;
      if (missingCount > 0 || staleCount > 0) {
        setEvidencePreview({
          evidenceId: item.id,
          events: current.references.flatMap((reference) =>
            reference.event ? [reference.event] : [],
          ),
          missingCount,
          staleCount,
        });
        setInvestigationError(
          "Reveal was blocked because the authoritative evidence changed after the rail loaded",
        );
        setInvestigation(await hostLogLoadActiveInvestigation(corpusId));
        return;
      }
      const eventRefs = current.item.eventRefs;
      if (eventRefs.length === 0) {
        throw new Error(
          "Authoritative evidence preview returned no identities",
        );
      }
      const seqs = eventRefs.map((eventRef) => eventRef.seq);
      await activateBookmark({
        id: item.id,
        label: item.title,
        seqFrom: Math.min(...seqs),
        seqTo: Math.max(...seqs),
        eventRefs,
        evidenceStatus: "verified",
        createdAt: item.createdAt,
        updatedAt: item.createdAt,
      });
    } catch (revealError) {
      setInvestigationError(String(revealError));
    } finally {
      setInvestigationBusy(false);
    }
  };

  const applyNav = (action: LogNavAction) => {
    const result = applyLogNav(filters, action, corpusId);
    if (!result.corpusMatch) {
      setStatus("log_nav corpus mismatch — ignored (fail closed)");
      return;
    }
    setFilters(result.filters);
    setHighlight(new Set(result.highlightSeq));
    if (result.focusLane) {
      setFocusLaneId(result.focusLane);
      // Ensure multi-lane view if agent targets a non-default lane.
      if (laneCount < 2 && result.focusLane !== "lane-0") {
        configureLanes(Math.min(4, Math.max(2, lanes.length || 2)));
      }
      setStatus(
        result.label
          ? `Applied nav: ${result.label} · focus ${result.focusLane}`
          : `Applied log_nav · focus ${result.focusLane}`,
      );
    } else {
      setStatus(
        result.label
          ? `Applied nav: ${result.label}`
          : "Applied log_nav filters",
      );
    }
  };

  const agentContext = useMemo(
    () => ({
      corpusId,
      timeQuality,
      // Agent snapshot keeps a boolean "linked" flag; mode name is in brief.
      linkMode: linkMode !== "independent",
      lanes: lanes
        .slice(0, laneCount)
        .map((l) => `${l.label || l.id}:[${l.sources.join(",") || "*"}]`),
      levels: filters.levels,
      sources: filters.sources,
      keyword: filters.keyword,
      selectedCount: selected.size,
      bookmarkCount: bookmarks.length,
      brief: `${viewBrief}; timeLink=${linkMode}`,
    }),
    [
      corpusId,
      timeQuality,
      linkMode,
      lanes,
      laneCount,
      filters.levels,
      filters.sources,
      filters.keyword,
      selected.size,
      bookmarks.length,
      viewBrief,
    ],
  );

  const laneSourceFilter = (laneId: string) => {
    const lane = lanes.find((l) => l.id === laneId);
    return effectiveLaneSources(lane, filters);
  };

  const loadMoreLane = async (laneId: string) => {
    const cur = laneCursors[laneId];
    if (!cur?.hasNewer || cur.afterSeq == null || cur.afterTs == null) return;
    if (pagingInflight.current[laneId]) return;
    const sourceFilter = laneSourceFilter(laneId);
    if (sourceFilter?.length === 0) return;
    pagingInflight.current[laneId] = "newer";
    const requestId = eventsRequestRef.current;
    setLanePaging((previous) => ({
      ...previous,
      [laneId]: {
        loading: "newer",
        error: null,
        failedDirection: null,
      },
    }));
    try {
      const page = await hostLogQueryEvents(
        corpusId,
        filtersToQuery(filters, {
          sources: sourceFilter,
          afterSeq: cur.afterSeq,
          afterTs: cur.afterTs,
          sortByTime: true,
          limit: 100,
        }),
      );
      if (requestId !== eventsRequestRef.current) return;
      const resident = {
        events: laneEvents[laneId] ?? [],
        afterSeq: cur.afterSeq,
        afterTs: cur.afterTs,
        beforeSeq: cur.beforeSeq,
        beforeTs: cur.beforeTs,
        totalMatched: totalMatched,
      };
      const { window, droppedFromHead } = appendNewer(
        resident,
        page,
        DEFAULT_MAX_RESIDENT,
      );
      setLaneEvents((prev) => ({ ...prev, [laneId]: window.events }));
      setLaneMatched((prev) => ({ ...prev, [laneId]: page.totalMatched }));
      setLaneCursors((prev) => ({
        ...prev,
        [laneId]: {
          afterSeq: window.afterSeq,
          afterTs: window.afterTs,
          beforeSeq: window.beforeSeq,
          beforeTs: window.beforeTs,
          hasOlder: cur.hasOlder || droppedFromHead > 0,
          hasNewer: page.nextCursor != null,
        },
      }));
      if (laneId === "lane-0") setNextCursor(page.nextCursor);
      if (page.events.length > 0) {
        setLaneTimeStates((previous) => {
          const prior = previous[laneId];
          const quality =
            prior?.status === "loaded" && prior.quality != null
              ? leastReliableTimeQuality([prior.quality, page.timeQuality])
              : page.timeQuality;
          const next = {
            ...previous,
            [laneId]: {
              status: "loaded",
              quality,
            } satisfies LaneTimeState,
          };
          setTimeQuality(
            aggregateViewTimeQuality(
              lanes.slice(0, laneCount).map((visible) => visible.id),
              next,
            ),
          );
          return next;
        });
      }
      setLanePaging((previous) => ({
        ...previous,
        [laneId]: {
          loading: null,
          error: null,
          failedDirection: null,
        },
      }));
      setStatus(
        `Lane ${laneId}: +${page.events.length} newer · ${window.events.length} resident`,
      );
    } catch (e) {
      if (requestId !== eventsRequestRef.current) return;
      setLanePaging((previous) => ({
        ...previous,
        [laneId]: {
          loading: null,
          error: String(e),
          failedDirection: "newer",
        },
      }));
    } finally {
      pagingInflight.current[laneId] = null;
    }
  };

  const loadOlderLane = async (laneId: string) => {
    const cur = laneCursors[laneId];
    if (!cur?.hasOlder || cur.beforeSeq == null || cur.beforeTs == null) return;
    if (pagingInflight.current[laneId]) return;
    const sourceFilter = laneSourceFilter(laneId);
    if (sourceFilter?.length === 0) return;
    pagingInflight.current[laneId] = "older";
    const requestId = eventsRequestRef.current;
    setLanePaging((previous) => ({
      ...previous,
      [laneId]: {
        loading: "older",
        error: null,
        failedDirection: null,
      },
    }));
    try {
      const page = await hostLogQueryEvents(
        corpusId,
        filtersToQuery(filters, {
          sources: sourceFilter,
          beforeSeq: cur.beforeSeq,
          beforeTs: cur.beforeTs,
          sortByTime: true,
          limit: 100,
        }),
      );
      if (requestId !== eventsRequestRef.current) return;
      const resident = {
        events: laneEvents[laneId] ?? [],
        afterSeq: cur.afterSeq,
        afterTs: cur.afterTs,
        beforeSeq: cur.beforeSeq,
        beforeTs: cur.beforeTs,
        totalMatched: totalMatched,
      };
      const { window, droppedFromTail } = prependOlder(
        resident,
        page,
        DEFAULT_MAX_RESIDENT,
      );
      setLaneEvents((prev) => ({ ...prev, [laneId]: window.events }));
      setLaneMatched((prev) => ({ ...prev, [laneId]: page.totalMatched }));
      setLaneCursors((prev) => ({
        ...prev,
        [laneId]: {
          afterSeq: window.afterSeq,
          afterTs: window.afterTs,
          beforeSeq: window.beforeSeq,
          beforeTs: window.beforeTs,
          hasOlder: page.prevCursor != null,
          hasNewer: cur.hasNewer || droppedFromTail > 0,
        },
      }));
      setLanePaging((previous) => ({
        ...previous,
        [laneId]: {
          loading: null,
          error: null,
          failedDirection: null,
        },
      }));
      setStatus(
        `Lane ${laneId}: +${page.events.length} older · ${window.events.length} resident`,
      );
    } catch (e) {
      if (requestId !== eventsRequestRef.current) return;
      setLanePaging((previous) => ({
        ...previous,
        [laneId]: {
          loading: null,
          error: String(e),
          failedDirection: "older",
        },
      }));
    } finally {
      pagingInflight.current[laneId] = null;
    }
  };

  const loadMore = async () => {
    if (laneCount <= 1) {
      await loadMoreLane("lane-0");
      return;
    }
    for (const lane of lanes.slice(0, laneCount)) {
      if (laneCursors[lane.id]?.hasNewer) {
        await loadMoreLane(lane.id);
      }
    }
  };

  /** User-composed lanes: change count without inventing first-N source assignment (#486). */
  const configureLanes = (n: number) => {
    const count = clampLaneCount(n);
    setPreferredLaneCount(count);
    setLaneCount(Math.min(count, maxLaneCount));
    setLanes((prev) => {
      const next = resizeLaneList(prev, count);
      saveLanes(corpusId, next);
      return next;
    });
    if (count === 1) setLaneScrollSeq({});
  };

  const updateLaneSources = (laneId: string, source: string) => {
    setLanes((prev) => {
      const next = prev.map((l) =>
        l.id === laneId ? toggleLaneSource(l, source) : l,
      );
      saveLanes(corpusId, next);
      return next;
    });
  };

  const setTimeLinkMode = (mode: TimeLinkMode) => {
    if (mode === "align_time") setAlignedScrollTop(0);
    setLinkMode(mode);
    saveLinkMode(corpusId, mode);
  };

  const alignedRowsByLane = useMemo(() => {
    if (linkMode !== "align_time" || timeQuality !== "wall" || laneCount < 2) {
      return {};
    }
    const baseRowH = density === "compact" ? 22 : 28;
    const boundedPreview = Math.min(12, Math.max(2, previewLines));
    return buildAlignedLaneRows(
      lanes.slice(0, laneCount).map((lane) => ({
        id: lane.id,
        events: laneEvents[lane.id] ?? [],
      })),
      (event) =>
        eventRowHeight(
          event,
          lineMode,
          expandedSeqs.has(event.seq),
          baseRowH,
          boundedPreview,
          findExcerpts[event.seq] ??
            (filters.keyword
              ? centeredLiteralExcerpt(event.message, filters.keyword)
              : event.message),
        ),
      baseRowH,
    );
  }, [
    density,
    expandedSeqs,
    filters.keyword,
    findExcerpts,
    laneCount,
    laneEvents,
    lanes,
    lineMode,
    linkMode,
    previewLines,
    timeQuality,
  ]);
  const alignedSlotCount =
    linkMode === "align_time"
      ? (alignedRowsByLane[lanes[0]?.id ?? ""]?.length ?? 0)
      : 0;
  const visibleLanesHaveEvents = lanes
    .slice(0, laneCount)
    .every((lane) => laneTimeStates[lane.id]?.status === "loaded");

  const densityClass = density === "compact" ? "log-explorer--compact" : "";
  const bpClass = `log-explorer--${breakpoint}`;
  const narrowClass = [
    narrowFiltersOpen ? "log-explorer--filters-open" : "",
    narrowChatOpen ? "log-explorer--chat-open" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const corpusLabel = summary?.name ?? corpusId.slice(0, 8);
  const bodyStyle =
    breakpoint === "narrow"
      ? undefined
      : ({
          gridTemplateColumns: `${
            filtersCollapsed
              ? `${COLLAPSED_FILTER_WIDTH_PX}px 0px`
              : `${filterW}px ${SPLITTER_WIDTH_PX}px`
          } 1fr ${
            chatCollapsed
              ? `0px ${COLLAPSED_CHAT_WIDTH_PX}px`
              : `${SPLITTER_WIDTH_PX}px ${chatW}px`
          }`,
        } as React.CSSProperties);

  const toggleExpand = (seq: number) => {
    setExpandedSeqs((prev) => {
      const next = new Set(prev);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });
  };

  const closeDetail = () => {
    const seq = detail?.seq;
    clearDetail();
    if (seq != null) {
      queueMicrotask(() => {
        const row = rootRef.current?.querySelector<HTMLElement>(
          `[data-seq="${seq}"]`,
        );
        row?.focus();
      });
    }
  };

  const selectDetailRepresentation = async (
    representation: "formatted" | "original",
  ) => {
    if (!detail) return;
    detailRepresentationRef.current = representation;
    setDetailRepresentation(representation);
    if (representation === "formatted") {
      if (detailOriginal.status === "loading") {
        detailOriginalRequestRef.current += 1;
        setDetailOriginal({ status: "idle" });
      }
      return;
    }
    if (
      detailOriginal.status === "loaded" ||
      detailOriginal.status === "loading"
    ) {
      return;
    }

    const seq = detail.seq;
    const request = detailOriginalRequestRef.current + 1;
    detailOriginalRequestRef.current = request;
    setDetailOriginal({ status: "loading" });
    try {
      const result = await hostLogQueryEventOriginal(corpusId, seq);
      if (
        detailOriginalRequestRef.current !== request ||
        detailSeqRef.current !== seq ||
        detailRepresentationRef.current !== "original"
      ) {
        return;
      }
      setDetailOriginal({ status: "loaded", result });
    } catch (originalError) {
      if (
        detailOriginalRequestRef.current !== request ||
        detailSeqRef.current !== seq ||
        detailRepresentationRef.current !== "original"
      ) {
        return;
      }
      setDetailOriginal({
        status: "error",
        message:
          originalError instanceof Error
            ? originalError.message
            : String(originalError),
      });
    }
  };

  const copyDetailRepresentation = async () => {
    if (!detail || !navigator.clipboard?.writeText) {
      setStatus("Clipboard unavailable");
      return;
    }
    const original =
      detailOriginal.status === "loaded" ? detailOriginal.result : null;
    const text =
      detailRepresentation === "original"
        ? original?.state === "available"
          ? original.text
          : null
        : `${detail.seq}\t${formatCanonicalUtc(detail.ts)}\t${detail.level}\t${detail.source}\t${detail.message}`;
    if (text == null) return;
    try {
      await navigator.clipboard.writeText(text);
      setStatus(
        detailRepresentation === "original"
          ? "Copied stored Original (redacted) record"
          : "Copied complete formatted event",
      );
    } catch (copyError) {
      setStatus(
        `Could not copy event: ${
          copyError instanceof Error ? copyError.message : String(copyError)
        }`,
      );
    }
  };

  // Per-lane truthful counts (#534).
  const laneMatchedHint = (laneId: string) => {
    const n = (laneEvents[laneId] ?? []).length;
    const cur = laneCursors[laneId];
    const matched = laneMatched[laneId];
    const more = cur?.hasNewer || cur?.hasOlder ? "+" : "";
    return `${matched == null ? "matched unavailable" : `${matched} matched`} · ${n}${more} resident`;
  };
  const navigatorSourceScope = visibleLaneSourceScope(
    lanes,
    laneCount,
    filters,
  );
  const columnGridTemplate = `${colWidths[0]}rem ${colWidths[1]}rem minmax(${colWidths[2]}rem, ${colWidths[2] + 2}rem) minmax(${colWidths[3]}rem, 1fr)`;
  const evidenceItems = investigationEvidenceViews(investigation);
  const findingItems = investigationFindingViews(investigation);
  const noteItems = investigationNoteViews(investigation);
  const bookmarkItems = investigationBookmarkViews(bookmarks);
  const investigationMaterialCount =
    evidenceItems.length +
    findingItems.length +
    noteItems.length +
    bookmarkItems.length;
  const editEvidenceRefs = editInvestigationItem
    ? editInvestigationItem.item.evidenceIds.flatMap(
        (evidenceId) =>
          evidenceItems.find((item) => item.id === evidenceId)?.eventRefs ?? [],
      )
    : [];
  const chooseInvestigationMode = (mode: InvestigationRailMode) => {
    setInvestigationMode(mode);
    setInvestigationError(null);
  };
  const investigationModeControl = (
    <InvestigationModeControl
      mode={investigationMode}
      investigationCount={investigationMaterialCount}
      chatCount={chatSummary.chatCount}
      onChange={chooseInvestigationMode}
    />
  );

  return (
    <div
      ref={rootRef}
      className={["log-explorer", bpClass, densityClass, narrowClass]
        .filter(Boolean)
        .join(" ")}
      data-testid="log-explorer"
      data-breakpoint={breakpoint}
      data-density={density}
      data-line-mode={lineMode}
      data-metadata-presentation={metadataPresentation}
      data-field-emphasis={fieldEmphasis}
      data-lane-count={laneCount}
      data-max-lane-count={maxLaneCount}
      data-usable-evidence-width={Math.floor(usableEvidenceWidth)}
      data-link-mode={linkMode}
      data-aligned-slots={alignedSlotCount}
      data-time-quality={timeQuality}
      data-filters-collapsed={filtersCollapsed ? "true" : "false"}
      data-chat-collapsed={chatCollapsed ? "true" : "false"}
      data-resizable="true"
      onKeyDown={onKeyDown}
    >
      <header className="log-explorer__titlebar">
        <div
          className="log-explorer__identity"
          data-testid="log-explorer-identity"
          aria-label={`Log Explorer for ${corpusLabel}`}
        >
          <span className="log-explorer__mark" aria-hidden="true">
            <IconLogExplorer />
          </span>
          <span className="log-explorer__title">Log Explorer</span>
          <span className="log-explorer__identity-separator" aria-hidden="true">
            /
          </span>
          <span className="log-explorer__corpus" title={corpusLabel}>
            {corpusLabel}
          </span>
        </div>
        <div
          className="log-explorer__meta"
          data-testid="log-explorer-global-counts"
        >
          <span
            className={
              timeQuality === "order_only"
                ? "log-explorer__badge log-explorer__badge--warn"
                : "log-explorer__badge"
            }
            title={timeQualityLabel(timeQuality)}
          >
            {timeQualityLabel(timeQuality)}
          </span>
          <span className="log-explorer__badge">
            {corpusTotal.toLocaleString()} corpus events
          </span>
          {laneCount === 1 && (
            <span className="log-explorer__badge">
              {totalMatched.toLocaleString()} matched
            </span>
          )}
          {laneCount > 1 && (
            <span className="log-explorer__badge">
              {laneCount} lane queries
            </span>
          )}
        </div>
        <div className="log-explorer__toolbar">
          <ToolbarPicker
            label="Time"
            value={linkMode}
            testId="time-link-picker"
            options={[
              {
                value: "independent",
                label: "Independent",
                description: "Each lane pages and scrolls on its own.",
                visual: <TimeLinkVisual mode="independent" />,
              },
              {
                value: "follow_cursor",
                label: "Follow selection",
                description:
                  "Selecting an event seeks each lane to its nearest time.",
                disabled:
                  !visibleLanesHaveEvents || timeQuality === "order_only",
                disabledReason: !visibleLanesHaveEvents
                  ? "Every visible lane needs matching events."
                  : timeQuality === "order_only"
                    ? "Order-only events cannot support time seeking."
                    : undefined,
                visual: <TimeLinkVisual mode="follow_cursor" />,
              },
              {
                value: "align_time",
                label: "Align exact time",
                description:
                  "Share a vertical wall-clock axis and show explicit gaps.",
                disabled: !visibleLanesHaveEvents || timeQuality !== "wall",
                disabledReason: !visibleLanesHaveEvents
                  ? "Every visible lane needs matching events."
                  : timeQuality !== "wall"
                    ? `${timeQualityLabel(timeQuality)} time is not a reliable shared wall clock.`
                    : undefined,
                visual: <TimeLinkVisual mode="align_time" />,
              },
            ]}
            onChange={(mode) => {
              if (mode === "follow_cursor" && timeQuality === "mixed") {
                setStatus(
                  "Follow uses mixed time quality only for approximate peer seeking; Align remains unavailable",
                );
              }
              setTimeLinkMode(mode);
            }}
            footer={
              <HelpTip
                label="Time-link modes"
                title="Time-link modes"
                content={HELP_TIME_LINK}
              />
            }
          />
          <button
            ref={laneEditorToggleRef}
            type="button"
            className={`log-explorer__btn ${laneEditorOpen ? "log-explorer__btn--active" : ""}`}
            data-testid="lane-editor-toggle"
            aria-expanded={laneEditorOpen}
            aria-controls="lane-editor"
            onClick={() =>
              laneEditorOpen ? closeLaneEditor() : setLaneEditorOpen(true)
            }
            title="Compose which sources belong to each lane"
          >
            Lanes…
          </button>
          {breakpoint !== "narrow" ? (
            <ToolbarPicker
              label="Lanes"
              value={String(laneCount)}
              testId="lane-count-picker"
              options={[1, 2, 3, 4].map((count) => {
                const unavailable = count > maxLaneCount;
                const requiredWidth = count * MIN_EVIDENCE_LANE_WIDTH_PX;
                return {
                  value: String(count),
                  label: `${count} ${count === 1 ? "lane" : "lanes"}`,
                  description:
                    count === 1
                      ? "Use the full evidence canvas for one stream."
                      : `Compare ${count} evidence streams side by side.`,
                  disabled: unavailable,
                  disabledReason: unavailable
                    ? `Needs ${requiredWidth}px of usable evidence width; ${Math.floor(usableEvidenceWidth)}px available.`
                    : undefined,
                };
              })}
              onChange={(count) => configureLanes(Number(count))}
            />
          ) : null}
          <ToolbarPicker
            label="Rows"
            value={lineMode}
            valueLabel={`${
              lineMode === "compact"
                ? "Single line"
                : lineMode === "wrap"
                  ? "Preview"
                  : "Deep"
            } · ${
              fieldEmphasis === "payload"
                ? "Payload"
                : fieldEmphasis === "metadata"
                  ? "Metadata"
                  : "Balanced"
            }`}
            testId="row-mode-picker"
            options={[
              {
                value: "compact",
                label: "Single line",
                description:
                  "Maximum scan density; expand individual events as needed.",
              },
              {
                value: "wrap",
                label: "Preview",
                description: `Show up to ${previewLines} lines in each row.`,
              },
              {
                value: "full",
                label: "Deep",
                description: `Show up to ${Math.min(24, previewLines * 2)} lines; the inspector remains complete.`,
              },
            ]}
            onChange={setLineMode}
            footer={
              <>
                <label className="log-explorer__picker-setting">
                  Metadata
                  <select
                    value={metadataPresentation}
                    aria-label="Row metadata presentation"
                    data-testid="row-metadata-presentation"
                    onChange={(event) =>
                      setMetadataPresentation(
                        event.target.value as RowMetadataPresentation,
                      )
                    }
                  >
                    <option value="standard">Full labels</option>
                    <option value="compact">Compact tokens</option>
                  </select>
                </label>
                <label className="log-explorer__picker-setting">
                  Focus
                  <select
                    value={fieldEmphasis}
                    aria-label="Row field emphasis"
                    data-testid="row-field-emphasis"
                    onChange={(event) =>
                      setFieldEmphasis(event.target.value as RowFieldEmphasis)
                    }
                  >
                    <option value="balanced">Balanced</option>
                    <option value="payload">Payload</option>
                    <option value="metadata">Metadata</option>
                  </select>
                </label>
                <p className="log-explorer__picker-note">
                  Tokens change presentation only. Focus a token for its
                  complete level and provenance.
                </p>
                <label className="log-explorer__picker-setting">
                  Preview depth
                  <select
                    value={previewLines}
                    aria-label="Preview lines per event"
                    data-testid="preview-lines"
                    onChange={(event) =>
                      setPreviewLines(Number(event.target.value))
                    }
                  >
                    {[2, 4, 8, 12].map((lines) => (
                      <option key={lines} value={lines}>
                        {lines} lines
                      </option>
                    ))}
                  </select>
                </label>
                <HelpTip
                  label="Long-line reading help"
                  title="Reading long events"
                  content={HELP_LONG_LINES}
                />
              </>
            }
          />
          <ToolbarPicker
            label="Density"
            value={density}
            testId="density-picker"
            options={[
              {
                value: "comfortable",
                label: "Comfortable",
                description: "More breathing room for focused reading.",
              },
              {
                value: "compact",
                label: "Compact",
                description: "Fit more evidence on screen for rapid scanning.",
              },
            ]}
            onChange={setDensity}
          />
          <ToolbarActionMenu
            label="Columns"
            testId="columns-menu"
            actions={[
              {
                id: "auto-fit",
                label: "Auto-fit columns",
                description:
                  "Fit source and message widths to the resident evidence.",
                testId: "col-autofit",
                run: () => {
                  const sources = Object.keys(facets?.sources ?? {});
                  const messages = Object.values(laneEvents)
                    .flat()
                    .slice(0, 200)
                    .map((event) => event.message);
                  setColWidths(autoFitColWidths(sources, messages));
                  setStatus("Columns auto-fitted");
                },
              },
              {
                id: "reset",
                label: "Reset columns",
                description: "Restore the payload-first default column widths.",
                testId: "col-reset",
                run: () => {
                  setColWidths([...DEFAULT_COL_WIDTHS]);
                  setStatus("Column widths reset");
                },
              },
            ]}
          />
          <button
            type="button"
            className="log-explorer__btn"
            onClick={() => void bookmarkSelection()}
          >
            Bookmark (B)
          </button>
        </div>
      </header>

      {laneEditorOpen && (
        <div
          ref={laneEditorRef}
          className="log-explorer__lane-editor"
          data-testid="lane-editor"
          data-lane-editor-mode={breakpoint === "narrow" ? "sheet" : "popover"}
          role="dialog"
          aria-modal="false"
          aria-labelledby="lane-editor-title"
          aria-label="Lane source composition"
        >
          <div className="log-explorer__lane-editor-header">
            <div>
              <div
                className="log-explorer__section-title"
                id="lane-editor-title"
              >
                Compose lanes
              </div>
              <div className="log-explorer__lane-editor-summary">
                {laneCount} visible lane{laneCount === 1 ? "" : "s"} ·{" "}
                {laneEditorSources.length} available source
                {laneEditorSources.length === 1 ? "" : "s"}
              </div>
            </div>
            <div className="log-explorer__lane-editor-actions">
              <HelpTip
                label="Lane composition"
                title="Lane composition"
                content={HELP_LANE_COMPOSE}
              />
              <button
                type="button"
                className="log-explorer__btn"
                data-testid="lane-editor-close"
                onClick={closeLaneEditor}
              >
                Done
              </button>
            </div>
          </div>
          <div
            className="log-explorer__lane-editor-content"
            style={{
              paddingInlineEnd: "0.25rem",
              scrollbarGutter: "stable",
            }}
          >
            <p className="log-explorer__lane-editor-help">
              Empty membership means all sources. A source can belong to more
              than one lane.
            </p>
            {laneSourceCatalogUnavailable && (
              <p className="log-explorer__lane-editor-help" role="status">
                Full source catalog unavailable; showing known lane and filter
                sources.
              </p>
            )}
            {lanes.slice(0, laneCount).map((lane) => (
              <fieldset
                key={lane.id}
                className="log-explorer__lane-editor-row"
                aria-label={`${lane.label} source membership`}
              >
                <legend>{lane.label}</legend>
                <div className="log-explorer__facet">
                  {laneEditorSources.slice(0, 40).map((src) => (
                    <label key={src} className="log-explorer__facet-row">
                      <input
                        type="checkbox"
                        checked={lane.sources.includes(src)}
                        onChange={() => updateLaneSources(lane.id, src)}
                      />
                      <span title={src}>{src}</span>
                    </label>
                  ))}
                </div>
                <div
                  className="log-explorer__chat-preview"
                  data-testid={`lane-editor-summary-${lane.id}`}
                >
                  {lane.sources.length === 0
                    ? "All sources"
                    : `${lane.sources.length} source${lane.sources.length === 1 ? "" : "s"}`}
                </div>
              </fieldset>
            ))}
          </div>
        </div>
      )}

      {breakpoint === "narrow" && (
        <div
          className="log-explorer__narrow-tabs"
          data-testid="log-explorer-narrow-tabs"
        >
          <button
            ref={narrowFiltersToggleRef}
            type="button"
            className={`log-explorer__btn ${narrowFiltersOpen ? "log-explorer__btn--active" : ""}`}
            data-testid="narrow-filters-toggle"
            aria-expanded={narrowFiltersOpen}
            aria-controls="log-explorer-filter-panel"
            onClick={() => {
              setNarrowFiltersOpen((o) => !o);
              setNarrowChatOpen(false);
            }}
          >
            Filters
            {activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
          </button>
          <button
            ref={narrowChatToggleRef}
            type="button"
            className={`log-explorer__btn ${narrowChatOpen ? "log-explorer__btn--active" : ""}`}
            data-testid="narrow-chat-toggle"
            aria-expanded={narrowChatOpen}
            aria-controls="log-explorer-investigation-panel"
            onClick={() => {
              setNarrowChatOpen((o) => !o);
              setNarrowFiltersOpen(false);
            }}
          >
            Investigation ·{" "}
            {investigationMode === "investigation" ? "Workspace" : "Chat"}
            {investigationMode === "investigation" &&
            investigationMaterialCount > 0
              ? ` (${investigationMaterialCount})`
              : investigationMode === "chat" && chatSummary.chatCount > 0
                ? ` (${chatSummary.chatCount})`
                : ""}
            {investigationMode === "chat" && chatSummary.hasActiveChat
              ? " · active"
              : ""}
            {chatSummary.busy ? " · working" : ""}
          </button>
        </div>
      )}

      <div
        className="log-explorer__body"
        style={bodyStyle}
        data-testid="log-explorer-body"
      >
        <aside
          id="log-explorer-filter-panel"
          className={`log-explorer__filters${
            breakpoint !== "narrow" && filtersCollapsed
              ? " log-explorer__filters--collapsed"
              : ""
          }`}
          data-testid="log-explorer-filters"
          data-collapsed={
            breakpoint !== "narrow" && filtersCollapsed ? "true" : "false"
          }
          style={
            breakpoint === "narrow"
              ? ({ flexDirection: "column" } as React.CSSProperties)
              : ({ gridColumn: 1 } as React.CSSProperties)
          }
          role={breakpoint === "narrow" ? "dialog" : undefined}
          aria-label={
            breakpoint === "narrow"
              ? "Log filters drawer"
              : filtersCollapsed
                ? "Log filters collapsed"
                : "Log filters panel"
          }
        >
          {breakpoint !== "narrow" && filtersCollapsed ? (
            <button
              ref={filtersReopenRef}
              type="button"
              className="log-explorer__filters-reopen"
              data-testid="expand-log-filters"
              aria-label={`Expand log filters${activeFilterCount > 0 ? `, ${activeFilterCount} active` : ""}`}
              onClick={() => setFiltersCollapsed(false)}
            >
              <span aria-hidden="true">Filters</span>
              {activeFilterCount > 0 ? (
                <span
                  className="log-explorer__filters-reopen-count"
                  aria-hidden="true"
                >
                  {activeFilterCount}
                </span>
              ) : null}
            </button>
          ) : (
            <>
              {breakpoint === "narrow" ? (
                <button
                  type="button"
                  className="log-explorer__btn log-explorer__drawer-close"
                  data-testid="close-filters-drawer"
                  onClick={() => {
                    setNarrowFiltersOpen(false);
                    queueMicrotask(() =>
                      narrowFiltersToggleRef.current?.focus(),
                    );
                  }}
                >
                  Close filters
                </button>
              ) : (
                <header className="log-explorer__filters-header">
                  <div>
                    <strong>Filters</strong>
                    <span>
                      {activeFilterCount > 0
                        ? `${activeFilterCount} active`
                        : "All logs"}
                    </span>
                  </div>
                  <button
                    ref={filtersCollapseRef}
                    type="button"
                    className="log-explorer__rail-collapse log-explorer__rail-collapse--filters"
                    data-testid="collapse-log-filters"
                    aria-label="Collapse log filters panel"
                    title="Collapse filters"
                    onClick={() => setFiltersCollapsed(true)}
                  >
                    <IconChevronLeft />
                  </button>
                </header>
              )}
              <div className="log-explorer__section-title">
                Find{" "}
                <HelpTip
                  label="Find vs Filter"
                  title="Find vs Filter"
                  content={HELP_FIND_VS_FILTER}
                />
              </div>
              <input
                ref={findInputRef}
                className="log-explorer__search"
                placeholder={
                  findMatchMode === "regex"
                    ? "Regex (linear-time, bounded)…"
                    : "Find in corpus (keeps surrounding rows)…"
                }
                value={findDraft}
                onChange={(e) => {
                  const next = e.target.value;
                  setFindDraft(next);
                  if (
                    findActiveQuery != null &&
                    next.trim() !== findActiveQuery
                  ) {
                    clearFindResults("Find term changed — press Find to apply");
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void runFind();
                }}
                aria-label="Find in logs"
                data-testid="log-explorer-find"
              />
              <div className="log-explorer__find-actions">
                <button
                  type="button"
                  className="log-explorer__btn"
                  data-testid="log-explorer-find-run"
                  onClick={() => void runFind()}
                >
                  Find
                </button>
                {findSearching ? (
                  <button
                    type="button"
                    className="log-explorer__btn"
                    data-testid="log-explorer-find-cancel"
                    disabled={findCancelling}
                    onClick={() => void cancelFind()}
                  >
                    {findCancelling ? "Cancelling…" : "Cancel"}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="log-explorer__btn"
                  data-testid="log-explorer-find-prev"
                  disabled={
                    findHistory.length === 0 &&
                    (findMatches.length === 0 || findIndex === 0)
                  }
                  onClick={() => void findStep(-1)}
                >
                  Prev
                </button>
                <button
                  type="button"
                  className="log-explorer__btn"
                  data-testid="log-explorer-find-next"
                  disabled={
                    !findNextCursor &&
                    (findMatches.length === 0 ||
                      findIndex === findMatches.length - 1)
                  }
                  onClick={() => void findStep(1)}
                >
                  Next
                </button>
                <button
                  type="button"
                  className={`log-explorer__btn ${advancedOpen ? "log-explorer__btn--active" : ""}`}
                  data-testid="log-explorer-advanced-toggle"
                  aria-expanded={advancedOpen}
                  onClick={() => setAdvancedOpen((o) => !o)}
                >
                  Advanced
                </button>
              </div>
              {advancedOpen ? (
                <div
                  className="log-explorer__advanced-search"
                  data-testid="log-explorer-advanced-search"
                  role="group"
                  aria-label="Advanced search options"
                >
                  <p className="log-explorer__chat-preview">
                    Explicit controls — no hidden query grammar. Regex uses a
                    linear-time engine with pattern-length, result, and scan
                    caps.
                  </p>
                  <label className="log-explorer__facet-row">
                    <input
                      type="radio"
                      name="find-mode"
                      checked={findMatchMode === "literal"}
                      onChange={() => {
                        setFindMatchMode("literal");
                        if (findActiveRef.current) {
                          clearFindResults(
                            "Find mode changed — press Find to apply",
                          );
                        }
                      }}
                      data-testid="find-mode-literal"
                    />
                    Literal text
                  </label>
                  <label className="log-explorer__facet-row">
                    <input
                      type="radio"
                      name="find-mode"
                      checked={findMatchMode === "regex"}
                      onChange={() => {
                        setFindMatchMode("regex");
                        if (findActiveRef.current) {
                          clearFindResults(
                            "Find mode changed — press Find to apply",
                          );
                        }
                      }}
                      data-testid="find-mode-regex"
                    />
                    Regex (bounded)
                  </label>
                  <label className="log-explorer__facet-row">
                    <input
                      type="checkbox"
                      checked={findCaseSensitive}
                      onChange={(e) => {
                        setFindCaseSensitive(e.target.checked);
                        if (findActiveRef.current) {
                          clearFindResults(
                            "Case option changed — press Find to apply",
                          );
                        }
                      }}
                      data-testid="find-case-sensitive"
                    />
                    Case sensitive
                  </label>
                  <label className="log-explorer__facet-row">
                    <input
                      type="checkbox"
                      checked={findUseSemantic}
                      disabled={!semanticAvailable || findMatchMode === "regex"}
                      onChange={(e) => {
                        setFindUseSemantic(e.target.checked);
                        if (findActiveRef.current) {
                          clearFindResults(
                            "Semantic option changed — press Find to apply",
                          );
                        }
                      }}
                      data-testid="find-semantic"
                    />
                    Template semantic
                    {!semanticAvailable ? " (unavailable)" : ""}
                  </label>
                  <div className="log-explorer__structured-grid">
                    <label>
                      Trace ID (exact)
                      <input
                        className="log-explorer__search"
                        value={traceDraft}
                        onChange={(event) => setTraceDraft(event.target.value)}
                        aria-label="Trace ID filter"
                        placeholder="trace-…"
                      />
                    </label>
                    <label>
                      Template ID
                      <input
                        className="log-explorer__search"
                        value={templateDraft}
                        inputMode="numeric"
                        onChange={(event) =>
                          setTemplateDraft(event.target.value)
                        }
                        aria-label="Template ID filter"
                        placeholder="42"
                      />
                    </label>
                    <label>
                      UTC start (inclusive)
                      <input
                        className="log-explorer__search"
                        value={timeFromDraft}
                        disabled={
                          (facets?.timeQuality ?? timeQuality) !== "wall"
                        }
                        onChange={(event) =>
                          setTimeFromDraft(event.target.value)
                        }
                        aria-label="UTC start filter"
                        placeholder="2026-07-27T12:00:00Z"
                      />
                    </label>
                    <label>
                      UTC end (exclusive)
                      <input
                        className="log-explorer__search"
                        value={timeToDraft}
                        disabled={
                          (facets?.timeQuality ?? timeQuality) !== "wall"
                        }
                        onChange={(event) => setTimeToDraft(event.target.value)}
                        aria-label="UTC end filter"
                        placeholder="2026-07-27T13:00:00Z"
                      />
                    </label>
                    <label>
                      Sequence start
                      <input
                        className="log-explorer__search"
                        value={seqFromDraft}
                        inputMode="numeric"
                        onChange={(event) =>
                          setSeqFromDraft(event.target.value)
                        }
                        aria-label="Sequence start filter"
                        placeholder="0"
                      />
                    </label>
                    <label>
                      Sequence end
                      <input
                        className="log-explorer__search"
                        value={seqToDraft}
                        inputMode="numeric"
                        onChange={(event) => setSeqToDraft(event.target.value)}
                        aria-label="Sequence end filter"
                        placeholder="999"
                      />
                    </label>
                  </div>
                  {(facets?.timeQuality ?? timeQuality) !== "wall" ? (
                    <p className="log-explorer__chat-preview" role="note">
                      Exact UTC range is unavailable for mixed or order-only
                      data. Use the stable sequence range instead.
                    </p>
                  ) : null}
                  <button
                    type="button"
                    className="log-explorer__btn"
                    data-testid="apply-structured-filters"
                    onClick={applyStructuredFilters}
                  >
                    Apply structured filters
                  </button>
                  <p className="log-explorer__chat-preview">
                    All fields combine with AND. Multiple values within Level,
                    Source, Service, or Host combine with OR. Every active scope
                    intersects both Find and Filter.
                  </p>
                </div>
              ) : null}
              {findTotal > 0 ? (
                <div
                  className="log-explorer__chat-preview"
                  data-testid="log-explorer-find-count"
                >
                  Match {findBase + findIndex + 1} of{" "}
                  {findTotalExact ? findTotal : `${findTotal}+`}
                  {findPartial && !findNextCursor ? " (partial)" : ""}
                  {" · "}
                  {findMatches.length} result identities resident
                </div>
              ) : null}

              <div className="log-explorer__section-title">Filter</div>
              <input
                className="log-explorer__search"
                placeholder="Filter keyword (reduces rows)…"
                value={filterDraft}
                onChange={(e) => setFilterDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") applyFilterKeyword();
                }}
                aria-label="Filter logs"
                data-testid="log-explorer-filter"
              />
              <button
                type="button"
                className="log-explorer__btn"
                data-testid="log-explorer-filter-apply"
                onClick={() => applyFilterKeyword()}
              >
                Apply filter
              </button>
              {activeFilterCount > 0 && (
                <div
                  className="log-explorer__active-facets"
                  data-testid="log-explorer-active-facets"
                >
                  {filters.keyword ? (
                    <button
                      type="button"
                      className="log-explorer__nav-chip"
                      onClick={() => {
                        setFilterDraft("");
                        setFilters((f) => ({ ...f, keyword: null }));
                      }}
                    >
                      keyword:{filters.keyword} ×
                    </button>
                  ) : null}
                  {filters.levels.map((lvl) => (
                    <button
                      key={lvl}
                      type="button"
                      className="log-explorer__nav-chip"
                      onClick={() => toggleLevel(lvl)}
                    >
                      level:{lvl} ×
                    </button>
                  ))}
                  {filters.sources.map((src) => (
                    <button
                      key={src}
                      type="button"
                      className="log-explorer__nav-chip"
                      onClick={() => toggleSource(src)}
                    >
                      source:{src} ×
                    </button>
                  ))}
                  {filters.services.map((service) => (
                    <button
                      key={service}
                      type="button"
                      className="log-explorer__nav-chip"
                      onClick={() => toggleService(service)}
                    >
                      service:{service} ×
                    </button>
                  ))}
                  {filters.hosts.map((host) => (
                    <button
                      key={host}
                      type="button"
                      className="log-explorer__nav-chip"
                      onClick={() => toggleHost(host)}
                    >
                      host:{host} ×
                    </button>
                  ))}
                  {filters.templateId != null ? (
                    <button
                      type="button"
                      className="log-explorer__nav-chip"
                      onClick={() =>
                        setFilters((current) => ({
                          ...current,
                          templateId: null,
                        }))
                      }
                    >
                      template:{filters.templateId} ×
                    </button>
                  ) : null}
                  {filters.traceId ? (
                    <button
                      type="button"
                      className="log-explorer__nav-chip"
                      onClick={() =>
                        setFilters((current) => ({ ...current, traceId: null }))
                      }
                    >
                      trace:{filters.traceId} ×
                    </button>
                  ) : null}
                  {filters.timeFrom != null || filters.timeTo != null ? (
                    <button
                      type="button"
                      className="log-explorer__nav-chip"
                      onClick={() =>
                        setFilters((current) => ({
                          ...current,
                          timeFrom: null,
                          timeTo: null,
                        }))
                      }
                    >
                      UTC range ×
                    </button>
                  ) : null}
                  {filters.seqFrom != null || filters.seqTo != null ? (
                    <button
                      type="button"
                      className="log-explorer__nav-chip"
                      onClick={() =>
                        setFilters((current) => ({
                          ...current,
                          seqFrom: null,
                          seqTo: null,
                        }))
                      }
                    >
                      seq:{filters.seqFrom ?? "start"}–{filters.seqTo ?? "end"}{" "}
                      ×
                    </button>
                  ) : null}
                </div>
              )}
              {activeFilterCount > 0 ? (
                <button
                  type="button"
                  className="log-explorer__btn"
                  data-testid="clear-all-filters"
                  onClick={clearAllFilters}
                >
                  Clear all filters
                </button>
              ) : null}
              <p className="log-explorer__chat-preview" role="note">
                Find highlights without removing rows. Filter reduces the table
                and intersects every active structured scope.
                {semanticAvailable
                  ? " Template-semantic ranking is available for advanced search."
                  : " Keyword-only corpus · re-analyze for semantic."}
              </p>
              <div
                className="log-explorer__chat-preview"
                data-testid="log-explorer-count-truth"
              >
                {/* #534: label totals separately — never use max-per-lane as global. */}
                <HelpTip
                  label="Corpus, matched, and resident counts"
                  title="Corpus, matched, and resident counts"
                  content={HELP_COUNTS}
                />{" "}
                Corpus{" "}
                {(corpusTotal || summary?.eventCount || 0).toLocaleString()} ·{" "}
                {laneCount === 1
                  ? `matched ${totalMatched.toLocaleString()} · `
                  : "matched per lane below · "}
                resident rows{" "}
                {Object.values(laneEvents).reduce((n, e) => n + e.length, 0)}
                {laneCount > 1
                  ? ` · ${laneCount} lanes (per-lane counts in headers)`
                  : ""}
              </div>

              <div className="log-explorer__section-title">Levels</div>
              <div className="log-explorer__facet">
                {Object.entries(facets?.levels ?? {})
                  .sort((a, b) => b[1] - a[1])
                  .map(([lvl, count]) => (
                    <label key={lvl} className="log-explorer__facet-row">
                      <input
                        type="checkbox"
                        checked={filters.levels.includes(lvl)}
                        onChange={() => toggleLevel(lvl)}
                      />
                      <span className={levelClass(lvl)}>{lvl}</span>
                      <span className="count">{count}</span>
                    </label>
                  ))}
              </div>

              <div className="log-explorer__section-title">Sources</div>
              <div className="log-explorer__facet">
                {Object.entries(facets?.sources ?? {})
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 40)
                  .map(([src, count]) => (
                    <label key={src} className="log-explorer__facet-row">
                      <input
                        type="checkbox"
                        checked={filters.sources.includes(src)}
                        onChange={() => toggleSource(src)}
                      />
                      <span title={src}>{src}</span>
                      <span className="count">{count}</span>
                    </label>
                  ))}
              </div>

              {Object.keys(facets?.services ?? {}).length > 0 ? (
                <>
                  <div className="log-explorer__section-title">Services</div>
                  <div className="log-explorer__facet">
                    {Object.entries(facets?.services ?? {})
                      .sort((a, b) => b[1] - a[1])
                      .slice(0, 40)
                      .map(([service, count]) => (
                        <label
                          key={service}
                          className="log-explorer__facet-row"
                        >
                          <input
                            type="checkbox"
                            checked={filters.services.includes(service)}
                            onChange={() => toggleService(service)}
                          />
                          <span title={service}>{service}</span>
                          <span className="count">{count}</span>
                        </label>
                      ))}
                  </div>
                </>
              ) : null}

              {Object.keys(facets?.hosts ?? {}).length > 0 ? (
                <>
                  <div className="log-explorer__section-title">Hosts</div>
                  <div className="log-explorer__facet">
                    {Object.entries(facets?.hosts ?? {})
                      .sort((a, b) => b[1] - a[1])
                      .slice(0, 40)
                      .map(([host, count]) => (
                        <label key={host} className="log-explorer__facet-row">
                          <input
                            type="checkbox"
                            checked={filters.hosts.includes(host)}
                            onChange={() => toggleHost(host)}
                          />
                          <span title={host}>{host}</span>
                          <span className="count">{count}</span>
                        </label>
                      ))}
                  </div>
                </>
              ) : null}

              <div className="log-explorer__section-title">Bookmarks</div>
              <div
                className="log-explorer__bookmarks"
                data-testid="log-explorer-bookmarks"
              >
                {revealRestore ? (
                  <button
                    type="button"
                    className="log-explorer__btn log-explorer__btn--active"
                    data-testid="bookmark-restore-view"
                    onClick={restorePriorView}
                  >
                    Restore prior view
                    {bookmarkRevealState === "revealed" ? " (temp reveal)" : ""}
                  </button>
                ) : null}
                {bookmarkRevealState === "missing" ? (
                  <div
                    className="log-explorer__chat-preview"
                    data-testid="bookmark-missing"
                  >
                    Bookmark target missing or unavailable
                  </div>
                ) : null}
                {bookmarks.length === 0 ? (
                  <div className="log-explorer__chat-preview">
                    None yet — select rows + B
                  </div>
                ) : (
                  bookmarks.map((b) => (
                    <div key={b.id} className="log-explorer__bm-item">
                      <button
                        type="button"
                        className="log-explorer__btn"
                        data-testid={`bookmark-activate-${b.id}`}
                        onClick={() => void activateBookmark(b)}
                      >
                        {b.label}
                      </button>
                      {b.evidenceStatus === "missing" ||
                      b.evidenceStatus === "stale" ? (
                        <span
                          className="log-explorer__chat-preview"
                          data-testid={`bookmark-evidence-status-${b.id}`}
                        >
                          {b.evidenceStatus === "missing" ? "Missing" : "Stale"}
                        </span>
                      ) : null}
                      <button
                        type="button"
                        className="log-explorer__btn"
                        aria-label={`Delete bookmark ${b.label}`}
                        onClick={() =>
                          void hostLogDeleteBookmark(corpusId, b.id).then(() =>
                            setBookmarks((all) =>
                              all.filter((x) => x.id !== b.id),
                            ),
                          )
                        }
                      >
                        ×
                      </button>
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </aside>

        {breakpoint !== "narrow" && !filtersCollapsed && (
          <div
            className="log-explorer__splitter"
            data-testid="splitter-filters"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize filters"
            style={{ gridColumn: 2 }}
            onMouseDown={startDrag("filters")}
          />
        )}

        <main
          className="log-explorer__lanes"
          data-testid="log-explorer-lanes"
          style={breakpoint === "narrow" ? undefined : { gridColumn: 3 }}
        >
          {selected.size > 0 ? (
            <div
              className="log-explorer__selection-strip"
              data-testid="selection-action-strip"
              aria-label={`${selected.size} selected log ${
                selected.size === 1 ? "event" : "events"
              }`}
            >
              <div className="log-explorer__selection-summary">
                <span className="log-explorer__selection-count">
                  {selected.size}
                </span>
                selected
              </div>
              <div className="log-explorer__selection-actions">
                <button
                  type="button"
                  className="log-explorer__btn"
                  onClick={askAboutSelection}
                >
                  Ask about selection
                </button>
                <button
                  ref={saveEvidenceTriggerRef}
                  type="button"
                  className="log-explorer__btn log-explorer__btn--active"
                  onClick={openSaveEvidence}
                >
                  Save evidence
                </button>
                <div className="log-explorer__selection-add">
                  <button
                    ref={investigationAddTriggerRef}
                    type="button"
                    className="log-explorer__btn"
                    aria-haspopup="menu"
                    aria-expanded={investigationAddMenuOpen}
                    onClick={() => setInvestigationAddMenuOpen((open) => !open)}
                  >
                    Add…
                  </button>
                  {investigationAddMenuOpen ? (
                    <InvestigationAddMenu
                      triggerRef={investigationAddTriggerRef}
                      onChoose={openCreateInvestigationItem}
                      onDismiss={dismissInvestigationAddMenu}
                    />
                  ) : null}
                </div>
              </div>
            </div>
          ) : null}
          <div className="log-explorer__lane-strip">
            <TimelineNavigator
              corpusId={corpusId}
              filter={filtersToQuery(filters, {
                afterSeq: null,
                afterTs: null,
                beforeSeq: null,
                beforeTs: null,
                sources: navigatorSourceScope,
              })}
              emptySourceScope={navigatorSourceScope?.length === 0}
              residentEvents={Object.values(laneEvents).flat()}
              lanes={lanes.slice(0, laneCount).map((lane) => {
                const sources = effectiveLaneSources(lane, filters);
                return {
                  id: lane.id,
                  label: lane.label,
                  sources: sources ?? [],
                  emptySourceScope: sources?.length === 0,
                };
              })}
              onSeekSeq={async (seq, target) => {
                const targetLane =
                  visibleLaneForSource(target?.source) ??
                  visibleLaneWithResidentSeq(seq);
                if (!targetLane) {
                  throw new Error(
                    "Timeline target is outside visible lanes; context not broadened",
                  );
                }
                const result = await seekToSeq(seq, {
                  laneId: targetLane.id,
                  sources: targetLane.sources,
                });
                if (result !== "found") {
                  throw new Error(
                    result === "hidden_by_filter"
                      ? "Timeline target is hidden by current filters"
                      : "Timeline target is no longer present",
                  );
                }
              }}
            />
            {linkMode === "align_time" ? (
              <span
                className="log-explorer__badge"
                data-testid="aligned-time-axis"
              >
                Shared exact-time rows · {alignedSlotCount} resident slots ·
                blank cells mean no event at that timestamp
              </span>
            ) : null}
            {linkMode === "align_time" && gaps.length > 0 && (
              <span className="log-explorer__badge log-explorer__badge--warn">
                {gaps.length} coarse gap region{gaps.length === 1 ? "" : "s"}
              </span>
            )}
          </div>
          <div
            className={`log-explorer__lane-grid log-explorer__lane-grid--${laneCount}`}
          >
            {lanes.slice(0, laneCount).map((lane) => {
              const laneTime = laneTimeStates[lane.id] ?? {
                status: "unloaded",
                quality: null,
              };
              const laneTimeLabel =
                laneTime.status === "loaded" && laneTime.quality != null
                  ? timeQualityLabel(laneTime.quality)
                  : laneTime.status === "empty"
                    ? "time unavailable · no matching events"
                    : laneTime.status === "error"
                      ? "time unavailable · load failed"
                      : "time unavailable · loading";
              const cursor = laneCursors[lane.id];
              const paging = lanePaging[lane.id];
              const matched = laneMatched[lane.id];
              const boundaryLabel =
                cursor == null || laneTime.status === "unloaded"
                  ? null
                  : laneTime.status === "error"
                    ? "Paging unavailable"
                    : !cursor.hasOlder && !cursor.hasNewer
                      ? matched === 0
                        ? "No matching logs"
                        : "All matched logs loaded"
                      : !cursor.hasOlder
                        ? "Start of matched logs"
                        : !cursor.hasNewer
                          ? "End of matched logs"
                          : null;
              const boundaryTitle =
                boundaryLabel === "Start of matched logs"
                  ? "This lane is at the first event matching its sources and active filters."
                  : boundaryLabel === "End of matched logs"
                    ? "This lane is at the last event matching its sources and active filters."
                    : boundaryLabel === "All matched logs loaded"
                      ? matched == null
                        ? "All matching events for this lane are in the resident window."
                        : `All ${matched} events matching this lane are in the resident window.`
                      : boundaryLabel === "No matching logs"
                        ? "No events match this lane's sources and active filters."
                        : boundaryLabel === "Paging unavailable"
                          ? "This lane did not load, so its paging boundaries are unknown."
                          : undefined;
              return (
                <section
                  key={lane.id}
                  className={[
                    "log-explorer__lane",
                    focusLaneId === lane.id ? "log-explorer__lane--focus" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  data-lane-id={lane.id}
                  data-focused={focusLaneId === lane.id ? "true" : "false"}
                  data-time-status={laneTime.status}
                  data-time-quality={laneTime.quality ?? "unavailable"}
                >
                  <div className="log-explorer__lane-header">
                    <strong>{lane.label}</strong>
                    <span
                      className={`log-explorer__badge ${
                        laneTime.quality === "order_only" ||
                        laneTime.quality == null
                          ? "log-explorer__badge--warn"
                          : ""
                      }`}
                    >
                      {laneTimeLabel}
                    </span>
                    <span
                      className="log-explorer__chat-preview"
                      data-testid={`lane-count-${lane.id}`}
                    >
                      {laneMatchedHint(lane.id)}
                      {focusLaneId === lane.id ? " · focused" : ""}
                    </span>
                  </div>
                  <div
                    className="log-explorer__col-header-viewport"
                    data-testid={`log-explorer-col-header-viewport-${lane.id}`}
                  >
                    <div
                      className="log-explorer__col-headers"
                      data-testid={`log-explorer-col-headers-${lane.id}`}
                      role="row"
                      aria-label={`${lane.label} column headings`}
                      style={{
                        gridTemplateColumns: columnGridTemplate,
                        transform: `translateX(-${laneScrollLeft[lane.id] ?? 0}px)`,
                      }}
                    >
                      {EVENT_COLUMNS.map((col) => (
                        <div
                          key={col.label}
                          className="log-explorer__col-header"
                          role="columnheader"
                        >
                          <span>{col.label}</span>
                          <button
                            type="button"
                            className="log-explorer__col-resizer"
                            data-testid={`col-resize-${lane.id}-${col.index}`}
                            aria-label={`Resize ${col.label} column for ${lane.label}`}
                            title="Drag or use ← → to resize every visible lane"
                            onMouseDown={(e) => {
                              e.preventDefault();
                              colDragRef.current = {
                                index: col.index,
                                startX: e.clientX,
                                startW: colWidths[col.index],
                              };
                              document.body.style.cursor = "col-resize";
                              document.body.style.userSelect = "none";
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "ArrowLeft") {
                                e.preventDefault();
                                setColWidths((w) =>
                                  resizeCol(w, col.index, -0.5),
                                );
                              } else if (e.key === "ArrowRight") {
                                e.preventDefault();
                                setColWidths((w) =>
                                  resizeCol(w, col.index, 0.5),
                                );
                              }
                            }}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                  <VirtualizedEventList
                    events={laneEvents[lane.id] ?? []}
                    alignedRows={
                      linkMode === "align_time"
                        ? alignedRowsByLane[lane.id]
                        : undefined
                    }
                    linkedScrollTop={
                      linkMode === "align_time" ? alignedScrollTop : undefined
                    }
                    onLinkedScrollTop={
                      linkMode === "align_time"
                        ? setAlignedScrollTop
                        : undefined
                    }
                    onHorizontalScroll={(scrollLeft) =>
                      setLaneScrollLeft((current) =>
                        current[lane.id] === scrollLeft
                          ? current
                          : { ...current, [lane.id]: scrollLeft },
                      )
                    }
                    timeQuality={timeQuality}
                    selected={selected}
                    highlight={highlight}
                    matchExcerpts={findExcerpts}
                    filterKeyword={filters.keyword}
                    density={density}
                    lineMode={lineMode}
                    metadataPresentation={metadataPresentation}
                    fieldEmphasis={fieldEmphasis}
                    previewLines={previewLines}
                    colWidths={colWidths}
                    expandedSeqs={expandedSeqs}
                    onToggleExpand={toggleExpand}
                    scrollToSeq={laneScrollSeq[lane.id] ?? null}
                    focusToSeq={
                      bookmarkFocusTarget?.laneId === lane.id
                        ? bookmarkFocusTarget.seq
                        : null
                    }
                    onFocusToSeq={(seq) =>
                      setBookmarkFocusTarget((pending) =>
                        pending?.laneId === lane.id && pending.seq === seq
                          ? null
                          : pending,
                      )
                    }
                    onRowClick={onRowClick}
                    onViewportAnchor={(event) => {
                      const anchor = investigationEventRef(corpusId, event);
                      setLaneViewportAnchors((current) => {
                        const previous = current[lane.id];
                        return previous &&
                          previous.seq === anchor.seq &&
                          previous.source === anchor.source &&
                          previous.timestampHint === anchor.timestampHint &&
                          previous.timeQualityHint === anchor.timeQualityHint
                          ? current
                          : { ...current, [lane.id]: anchor };
                      });
                    }}
                    onNearTop={() => void loadOlderLane(lane.id)}
                    onNearBottom={() => void loadMoreLane(lane.id)}
                  />
                  {paging?.error ? (
                    <div
                      className="log-explorer__lane-page-error"
                      role="alert"
                      data-testid={`lane-page-error-${lane.id}`}
                    >
                      <span>
                        Could not load {paging.failedDirection ?? "adjacent"}{" "}
                        events: {paging.error}
                      </span>
                      <button
                        type="button"
                        className="log-explorer__btn"
                        onClick={() =>
                          paging.failedDirection === "older"
                            ? void loadOlderLane(lane.id)
                            : void loadMoreLane(lane.id)
                        }
                      >
                        Retry
                      </button>
                    </div>
                  ) : null}
                  {paging?.loading || boundaryLabel ? (
                    <div
                      className="log-explorer__lane-paging"
                      data-testid={`lane-paging-${lane.id}`}
                      aria-live="polite"
                      aria-label={`${lane.label} paging status`}
                    >
                      {boundaryLabel ? (
                        <span
                          className="log-explorer__paging-boundary"
                          title={boundaryTitle}
                        >
                          {boundaryLabel}
                        </span>
                      ) : null}
                      {paging?.loading ? (
                        <span className="log-explorer__paging-loading">
                          Loading {paging.loading}…
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </section>
              );
            })}
          </div>
          {detail && (
            <div
              className="log-explorer__detail"
              data-testid="log-explorer-detail"
              style={{ height: detailH, maxHeight: detailH }}
              role="region"
              aria-label={`Complete event inspector for sequence ${detail.seq}`}
            >
              <div
                className="log-explorer__detail-resize"
                data-testid="detail-resize-handle"
                role="separator"
                aria-orientation="horizontal"
                aria-label="Resize event inspector"
                tabIndex={0}
                onMouseDown={(e) => {
                  e.preventDefault();
                  detailDragRef.current = {
                    startY: e.clientY,
                    startH: detailH,
                  };
                  document.body.style.cursor = "row-resize";
                  document.body.style.userSelect = "none";
                }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setDetailH((h) => Math.min(640, h + 20));
                  } else if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setDetailH((h) => Math.max(120, h - 20));
                  }
                }}
              />
              <div className="log-explorer__detail-toolbar">
                <strong>Event inspector · seq {detail.seq}</strong>
                <div
                  className="log-explorer__detail-representations"
                  role="group"
                  aria-label={`Event ${detail.seq} representation`}
                >
                  <button
                    type="button"
                    className="log-explorer__detail-representation"
                    aria-pressed={detailRepresentation === "formatted"}
                    onClick={() => void selectDetailRepresentation("formatted")}
                  >
                    Formatted
                  </button>
                  <button
                    type="button"
                    className="log-explorer__detail-representation"
                    aria-pressed={detailRepresentation === "original"}
                    onClick={() => void selectDetailRepresentation("original")}
                  >
                    Original (redacted)
                  </button>
                </div>
                <button
                  type="button"
                  className="log-explorer__btn"
                  data-testid="detail-copy"
                  aria-label={
                    detailRepresentation === "original"
                      ? `Copy stored Original (redacted) record ${detail.seq}`
                      : `Copy complete formatted event ${detail.seq}`
                  }
                  disabled={
                    detailRepresentation === "original" &&
                    !(
                      detailOriginal.status === "loaded" &&
                      detailOriginal.result.state === "available"
                    )
                  }
                  onClick={() => void copyDetailRepresentation()}
                >
                  Copy
                </button>
                <button
                  type="button"
                  className="log-explorer__btn"
                  data-testid="detail-close"
                  onClick={closeDetail}
                >
                  Close inspector
                </button>
              </div>
              {detailRepresentation === "formatted" ? (
                <>
                  <dl
                    className="log-explorer__detail-metadata"
                    data-testid="detail-metadata"
                  >
                    <div>
                      <dt>Event</dt>
                      <dd>seq {detail.seq}</dd>
                    </div>
                    <div>
                      <dt>Time</dt>
                      <dd>
                        {formatCanonicalUtc(detail.ts)} ·{" "}
                        {timeQualityLabel(detail.timeQuality)} · UTC
                      </dd>
                    </div>
                    <div>
                      <dt>Source</dt>
                      <dd>{detail.source}</dd>
                    </div>
                    <div>
                      <dt>Level</dt>
                      <dd className={levelClass(detail.level)}>
                        {detail.level}
                      </dd>
                    </div>
                    <div>
                      <dt>Service</dt>
                      <dd>{detail.service ?? "—"}</dd>
                    </div>
                    <div>
                      <dt>Host</dt>
                      <dd>{detail.host ?? "—"}</dd>
                    </div>
                    <div>
                      <dt>Template</dt>
                      <dd>{detail.templateId}</dd>
                    </div>
                    <div>
                      <dt>Trace</dt>
                      <dd>{detail.traceId ?? "—"}</dd>
                    </div>
                  </dl>
                  <pre
                    className="log-explorer__detail-message"
                    data-testid="detail-message"
                    tabIndex={0}
                    aria-label={`Complete redacted message for event ${detail.seq}`}
                  >
                    {detail.message}
                  </pre>
                </>
              ) : (
                <div
                  className="log-explorer__detail-original"
                  data-testid="detail-original"
                  aria-live="polite"
                >
                  {detailOriginal.status === "loading" ? (
                    <p className="log-explorer__detail-state" role="status">
                      Loading Original (redacted)…
                    </p>
                  ) : detailOriginal.status === "error" ? (
                    <div
                      className="log-explorer__detail-state log-explorer__detail-state--error"
                      role="alert"
                    >
                      <span>
                        Could not load Original (redacted):{" "}
                        {detailOriginal.message}
                      </span>
                      <button
                        type="button"
                        className="log-explorer__btn"
                        onClick={() =>
                          void selectDetailRepresentation("original")
                        }
                      >
                        Retry
                      </button>
                    </div>
                  ) : detailOriginal.status === "loaded" &&
                    detailOriginal.result.state === "unavailable" ? (
                    <p
                      className="log-explorer__detail-state"
                      data-testid="detail-original-unavailable"
                    >
                      {detailOriginal.result.reason}
                    </p>
                  ) : detailOriginal.status === "loaded" &&
                    detailOriginal.result.state === "available" ? (
                    <>
                      <div
                        className="log-explorer__detail-notices"
                        data-testid="detail-original-notices"
                      >
                        <p>
                          This is the stored source record after secret
                          redaction and documented encoding or line-ending
                          normalization. Unredacted source bytes are not shown.
                        </p>
                        <p>
                          {detailOriginal.result.storedCharCount.toLocaleString()}{" "}
                          stored characters from{" "}
                          {detailOriginal.result.redactedCharCount.toLocaleString()}{" "}
                          redacted characters ·{" "}
                          {detailOriginal.result.sourceByteCount.toLocaleString()}{" "}
                          source bytes.
                        </p>
                        {detailOriginal.result.redactionApplied ? (
                          <p role="note">
                            Sensitive value patterns were replaced during
                            ingest.
                          </p>
                        ) : null}
                        {detailOriginal.result.truncated ? (
                          <p role="note">
                            This record exceeded the storage bound; its suffix
                            is unavailable.
                          </p>
                        ) : null}
                        {detailOriginal.result.encodingNormalized ? (
                          <p role="note">
                            Invalid UTF-8 was normalized with replacement
                            characters during ingest.
                          </p>
                        ) : null}
                      </div>
                      <pre
                        className="log-explorer__detail-message log-explorer__detail-message--original"
                        data-testid="detail-original-message"
                        tabIndex={0}
                        aria-label={`Stored Original (redacted) record for event ${detail.seq}`}
                      >
                        {detailOriginal.result.text}
                      </pre>
                    </>
                  ) : null}
                </div>
              )}
              {(nextCursor != null ||
                Object.values(laneCursors).some((c) => c.afterSeq != null)) && (
                <button
                  type="button"
                  className="log-explorer__btn"
                  data-testid="load-more-all-lanes"
                  onClick={() => void loadMore()}
                >
                  Load more{laneCount > 1 ? " (all lanes)" : ""}
                </button>
              )}
            </div>
          )}
        </main>

        {breakpoint !== "narrow" && !chatCollapsed && (
          <div
            className="log-explorer__splitter"
            data-testid="splitter-chat"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize chat"
            style={{ gridColumn: 4 }}
            onMouseDown={startDrag("chat")}
          />
        )}

        <LinkedChatRail
          corpusId={corpusId}
          corpusName={summary?.name ?? corpusId.slice(0, 8)}
          agentContext={agentContext}
          onApplyNav={applyNav}
          visible={investigationMode === "chat"}
          modeControl={investigationModeControl}
          externalDraftRequest={chatDraftRequest}
          compactLayout={breakpoint === "narrow"}
          collapsed={breakpoint !== "narrow" && chatCollapsed}
          desktopGridColumn={breakpoint === "narrow" ? undefined : 5}
          developerMode={import.meta.env.MODE === "development"}
          onRailSummary={handleRailSummary}
          onToggleCollapsed={() => setChatCollapsed((collapsed) => !collapsed)}
          onRequestClose={() => {
            setNarrowChatOpen(false);
            queueMicrotask(() => narrowChatToggleRef.current?.focus());
          }}
        />
        <EvidencePanel
          visible={investigationMode === "investigation"}
          modeControl={investigationModeControl}
          items={evidenceItems}
          findings={findingItems}
          notes={noteItems}
          bookmarks={bookmarkItems}
          preview={evidencePreview}
          viewPreview={findingViewPreview}
          busy={investigationBusy}
          error={investigationError}
          compactLayout={breakpoint === "narrow"}
          collapsed={breakpoint !== "narrow" && chatCollapsed}
          desktopGridColumn={breakpoint === "narrow" ? undefined : 5}
          onPreview={(item) => void previewInvestigationEvidence(item)}
          onReveal={(item) => void revealInvestigationEvidence(item)}
          onPreviewFindingView={(item) =>
            void previewInvestigationFindingView(item)
          }
          onApplyFindingView={(preview) =>
            void applyInvestigationFindingView(preview)
          }
          onEditFinding={openEditFinding}
          onEditNote={openEditNote}
          onActivateBookmark={(item) => {
            const bookmark = bookmarks.find(
              (candidate) => candidate.id === item.id,
            );
            if (bookmark) void activateBookmark(bookmark);
          }}
          onClearPreview={() => setEvidencePreview(null)}
          onClearViewPreview={() => setFindingViewPreview(null)}
          onToggleCollapsed={() => setChatCollapsed((collapsed) => !collapsed)}
          onRequestClose={() => {
            setNarrowChatOpen(false);
            queueMicrotask(() => narrowChatToggleRef.current?.focus());
          }}
        />
      </div>

      {saveEvidenceOpen ? (
        <SaveEvidenceDialog
          eventCount={selectedEvidenceRefs()?.eventRefs.length ?? 0}
          sourceCount={
            new Set(
              (selectedEvidenceRefs()?.eventRefs ?? []).map(
                (eventRef) => eventRef.source,
              ),
            ).size
          }
          defaultTitle={
            selected.size === 1
              ? `Evidence · seq ${[...selected][0]}`
              : `Evidence · ${selected.size} selected events`
          }
          busy={investigationBusy}
          error={investigationError}
          triggerRef={saveEvidenceTriggerRef}
          onSave={(title) => void saveSelectedEvidence(title)}
          onDismiss={() => setSaveEvidenceOpen(false)}
        />
      ) : null}

      {createInvestigationItem ? (
        <CreateInvestigationItemDialog
          type={createInvestigationItem}
          eventCount={selectedEvidenceRefs()?.eventRefs.length ?? 0}
          sourceCount={
            new Set(
              (selectedEvidenceRefs()?.eventRefs ?? []).map(
                (eventRef) => eventRef.source,
              ),
            ).size
          }
          busy={investigationBusy}
          error={investigationError}
          triggerRef={investigationAddTriggerRef}
          onSave={(draft) => void saveInvestigationItem(draft)}
          onDismiss={() => setCreateInvestigationItem(null)}
        />
      ) : null}

      {editInvestigationItem ? (
        <CreateInvestigationItemDialog
          type={editInvestigationItem.type}
          initialDraft={
            editInvestigationItem.type === "finding"
              ? {
                  type: "finding",
                  kind: editInvestigationItem.item.kind,
                  lifecycle: editInvestigationItem.item.lifecycle,
                  title: editInvestigationItem.item.title,
                  body: editInvestigationItem.item.whyItMatters,
                }
              : {
                  type: "note",
                  title: editInvestigationItem.item.title,
                  body: editInvestigationItem.item.body,
                }
          }
          eventCount={editEvidenceRefs.length}
          sourceCount={
            new Set(editEvidenceRefs.map((eventRef) => eventRef.source)).size
          }
          busy={investigationBusy}
          error={investigationError}
          triggerRef={investigationEditTriggerRef}
          onSave={(draft) => void saveEditedInvestigationItem(draft)}
          onDismiss={() => setEditInvestigationItem(null)}
        />
      ) : null}

      <div className="log-explorer__status" role="status">
        {error ? `Error: ${error}` : status}
        {busy ? " · busy" : ""}
      </div>
    </div>
  );
}
