import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useDismissibleLayer } from "../../hooks/useDismissibleLayer";
import type {
  ExplorerEventDto,
  InvestigationViewRecipeDto,
  LogBookmarkEventRefDto,
} from "../../lib/host";
import type {
  LogInvestigationReportPreviewDto,
  ReportSectionKindDto,
} from "../../lib/engine/investigationReports";
import {
  InvestigationReportSurface,
  ProposedReportSectionCard,
  type ProposedReportSectionAcceptInput,
  type ProposedReportSectionView,
} from "./InvestigationReport";
import { IconChevronDown, IconChevronRight } from "../icons";

export type InvestigationRailMode = "investigation" | "chat" | "activity";

export type EvidenceItemView = {
  id: string;
  title: string;
  eventRefs: LogBookmarkEventRefDto[];
  evidenceStatus: "verified" | "missing" | "stale";
  createdAt: number;
  provenanceLabel: string;
};

export type EvidencePreviewView = {
  evidenceId: string;
  events: ExplorerEventDto[];
  missingCount: number;
  staleCount: number;
};

export type FindingItemView = {
  id: string;
  kind: "observation" | "inference" | "hypothesis";
  lifecycle: "accepted" | "resolved";
  title: string;
  whyItMatters: string;
  evidenceIds: string[];
  viewRecipe: InvestigationViewRecipeDto | null;
  provenanceLabel: string;
  /** Host-authored current-vs-durable policy comparison (#819). */
  policyStatus?:
    | "unbound_legacy"
    | "current"
    | "made_under_different_policy"
    | "made_under_different_lens"
    | "current_lens_unknown"
    | null;
  policyStatusLabel?: string | null;
};

export type FindingViewPreviewView = {
  findingId: string;
  recipe: InvestigationViewRecipeDto;
  changes: string[];
  missingCount: number;
  staleCount: number;
  policyStatus?:
    | "unbound_legacy"
    | "current"
    | "made_under_different_policy"
    | "made_under_different_lens"
    | "current_lens_unknown"
    | null;
  policyStatusLabel?: string | null;
  /** True when Apply is blocked for policy mismatch. */
  policyBlocksApply?: boolean;
};

export type NoteItemView = {
  id: string;
  title: string;
  body: string;
  evidenceIds: string[];
  findingIds: string[];
  provenanceLabel: string;
};

export type BookmarkItemView = {
  id: string;
  label: string;
  note: string | null;
  seqFrom: number;
  seqTo: number;
  eventRefs: LogBookmarkEventRefDto[];
  evidenceStatus: "legacy_range" | "verified" | "missing" | "stale";
};

type MaterialFilter =
  | "all"
  | "findings"
  | "evidence"
  | "notes"
  | "bookmarks"
  | "report";
type MaterialDetail =
  | { type: "finding"; id: string }
  | { type: "note"; id: string }
  | { type: "bookmark"; id: string }
  | { type: "report" };

export function InvestigationModeControl({
  mode,
  investigationCount,
  chatCount,
  activityCount = 0,
  onChange,
}: {
  mode: InvestigationRailMode;
  investigationCount: number;
  chatCount: number;
  /** ContextDesk activity entries in this Explorer view. */
  activityCount?: number;
  onChange: (mode: InvestigationRailMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const layerId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const options: {
    mode: InvestigationRailMode;
    label: string;
    count: number;
    description: string;
  }[] = [
    {
      mode: "investigation",
      label: "Investigation",
      count: investigationCount,
      description: "Findings, evidence, notes, and bookmarks",
    },
    {
      mode: "chat",
      label: "Chat",
      count: chatCount,
      description: "Corpus-linked governed conversations",
    },
    {
      mode: "activity",
      label: "Activity",
      count: activityCount,
      description: "ContextDesk's own actions — separate from customer evidence",
    },
  ];
  const current = options.find((option) => option.mode === mode)!;
  const dismiss = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) queueMicrotask(() => triggerRef.current?.focus());
  }, []);

  useDismissibleLayer({
    open,
    layerId,
    peerGroup: "investigation-rail-menu",
    rootRef,
    onDismiss: dismiss,
  });

  useEffect(() => {
    if (!open) return;
    queueMicrotask(() =>
      rootRef.current
        ?.querySelector<HTMLButtonElement>(
          '.log-explorer__investigation-mode-option[aria-checked="true"]',
        )
        ?.focus(),
    );
  }, [open]);

  return (
    <div ref={rootRef} className="log-explorer__investigation-mode-picker">
      <span className="log-explorer__investigation-mode-label">
        Investigation
      </span>
      <button
        ref={triggerRef}
        type="button"
        className="log-explorer__investigation-mode-trigger"
        aria-label={`Investigation workspace view: ${current.label}, ${current.count} items`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{current.label}</span>
        <span
          className="log-explorer__investigation-mode-count"
          aria-label={`${current.count} ${current.label.toLowerCase()} items`}
        >
          {current.count}
        </span>
        <IconChevronDown />
      </button>
      {open ? (
        <div
          className="log-explorer__investigation-mode-menu"
          role="menu"
          aria-label="Investigation view"
        >
          {options.map((option) => (
            <button
              key={option.mode}
              type="button"
              role="menuitemradio"
              aria-checked={option.mode === mode}
              className={`log-explorer__investigation-mode-option${
                option.mode === mode
                  ? " log-explorer__investigation-mode-option--active"
                  : ""
              }`}
              onKeyDown={(event) => {
                if (
                  !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
                ) {
                  return;
                }
                event.preventDefault();
                const choices = [
                  ...rootRef.current!.querySelectorAll<HTMLButtonElement>(
                    ".log-explorer__investigation-mode-option",
                  ),
                ];
                const index = choices.indexOf(event.currentTarget);
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? choices.length - 1
                      : (index +
                          (event.key === "ArrowDown" ? 1 : -1) +
                          choices.length) %
                        choices.length;
                choices[next]?.focus();
              }}
              onClick={() => {
                onChange(option.mode);
                setOpen(false);
                queueMicrotask(() => triggerRef.current?.focus());
              }}
            >
              <span className="log-explorer__investigation-mode-option-copy">
                <span>{option.label}</span>
                <span>{option.description}</span>
              </span>
              <span
                className="log-explorer__investigation-mode-count"
                aria-label={`${option.count} ${option.label.toLowerCase()} items`}
              >
                {option.count}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function evidenceSummary(item: EvidenceItemView): string {
  const sources = new Set(item.eventRefs.map((event) => event.source)).size;
  return `${item.eventRefs.length} event${
    item.eventRefs.length === 1 ? "" : "s"
  } · ${sources} source${sources === 1 ? "" : "s"}`;
}

function statusLabel(status: EvidenceItemView["evidenceStatus"]): string {
  if (status === "verified") return "Verified";
  if (status === "missing") return "Missing";
  return "Changed";
}

function findingKindLabel(kind: FindingItemView["kind"]): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

export type ProposedFindingItemView = {
  id: string;
  kind: FindingItemView["kind"];
  title: string;
  whyItMatters: string;
  status: "proposed" | "accepted" | "dismissed" | "superseded";
  dismissReason?: string | null;
  caveats?: string | null;
  /** Supporting + contradicting exact evidence count. */
  evidenceCount: number;
  supportingCount: number;
  contradictingCount: number;
  /** Optional payload-free view recipe for non-mutating Preview. */
  viewRecipe?: InvestigationViewRecipeDto | null;
};

export type ProposedFindingAcceptInput = {
  proposalId: string;
  edited: boolean;
  title?: string;
  whyItMatters?: string;
  kind?: FindingItemView["kind"];
};

export function EvidencePanel({
  modeControl,
  items,
  findings = [],
  proposedFindings = [],
  proposedReportSections = [],
  notes = [],
  bookmarks = [],
  preview,
  viewPreview,
  proposalPreview = null,
  reportPreview = null,
  reportBusy = false,
  reportError = null,
  busy,
  error,
  visible = true,
  compactLayout = false,
  collapsed = false,
  desktopGridColumn,
  onPreview,
  onReveal,
  onPreviewFindingView,
  onApplyFindingView,
  onRecomputeFindingView,
  onEditFinding,
  onEditNote,
  onActivateBookmark,
  onAcceptProposedFinding,
  onDismissProposedFinding,
  onPreviewProposedFinding,
  onAcceptProposedReportSection,
  onDismissProposedReportSection,
  onOpenReport,
  reportUnavailableReason = null,
  onEditReportSection,
  onExportReport,
  onReloadInvestigation,
  onClearPreview,
  onClearViewPreview,
  onClearReport,
  onToggleCollapsed,
  onRequestClose,
}: {
  modeControl: ReactNode;
  proposedFindings?: ProposedFindingItemView[];
  /** Agent/detector-proposed report sections awaiting review (#532). */
  proposedReportSections?: ProposedReportSectionView[];
  items: EvidenceItemView[];
  findings?: FindingItemView[];
  notes?: NoteItemView[];
  bookmarks?: BookmarkItemView[];
  preview: EvidencePreviewView | null;
  viewPreview?: FindingViewPreviewView | null;
  /** Non-mutating proposal preview (never mutates Explorer filters/selection). */
  proposalPreview?: {
    proposalId: string;
    changes: string[];
  } | null;
  /** Lazily host-assembled report projection; null until Report opens. */
  reportPreview?: LogInvestigationReportPreviewDto | null;
  reportBusy?: boolean;
  reportError?: string | null;
  busy: boolean;
  error: string | null;
  visible?: boolean;
  compactLayout?: boolean;
  collapsed?: boolean;
  desktopGridColumn?: number;
  onPreview: (item: EvidenceItemView) => void;
  onReveal: (item: EvidenceItemView) => void;
  onPreviewFindingView?: (item: FindingItemView) => void;
  onApplyFindingView?: (preview: FindingViewPreviewView) => void;
  /** Explicit recompute under current Explorer recipe + policy/lens (#819). */
  onRecomputeFindingView?: (item: FindingItemView) => void;
  onEditFinding?: (item: FindingItemView, trigger: HTMLButtonElement) => void;
  onEditNote?: (item: NoteItemView, trigger: HTMLButtonElement) => void;
  onActivateBookmark?: (item: BookmarkItemView) => void;
  onAcceptProposedFinding?: (input: ProposedFindingAcceptInput) => void;
  onDismissProposedFinding?: (id: string) => void;
  onPreviewProposedFinding?: (item: ProposedFindingItemView) => void;
  onAcceptProposedReportSection?: (
    input: ProposedReportSectionAcceptInput,
  ) => void;
  onDismissProposedReportSection?: (proposalId: string, reason: string) => void;
  /** Assemble-on-demand trigger; fired when the Report detail opens. */
  onOpenReport?: () => void;
  /** Disabled-with-cause copy when a report cannot be assembled yet. */
  reportUnavailableReason?: string | null;
  onEditReportSection?: (
    kind: ReportSectionKindDto,
    trigger: HTMLButtonElement,
  ) => void;
  onExportReport?: (trigger: HTMLButtonElement) => void;
  /** Renders a Reload affordance inside the error alert (stale revisions). */
  onReloadInvestigation?: () => void;
  onClearPreview: () => void;
  onClearViewPreview?: () => void;
  /** Close the report lifecycle and release its retained export artifact. */
  onClearReport?: () => void;
  onToggleCollapsed?: () => void;
  onRequestClose?: () => void;
}) {
  const [filter, setFilter] = useState<MaterialFilter>("all");
  const [detail, setDetail] = useState<MaterialDetail | null>(null);
  const [proposalEditId, setProposalEditId] = useState<string | null>(null);
  const [proposalEditTitle, setProposalEditTitle] = useState("");
  const [proposalEditWhy, setProposalEditWhy] = useState("");
  const collapseToggleRef = useRef<HTMLButtonElement>(null);
  const reopenRef = useRef<HTMLButtonElement>(null);
  const detailBackRef = useRef<HTMLButtonElement>(null);
  const detailOriginSelectorRef = useRef<string | null>(null);
  const previewReturnDetailRef = useRef<MaterialDetail | null>(null);
  const previousCollapsedRef = useRef(collapsed);
  const activePreviewItem = preview
    ? (items.find((item) => item.id === preview.evidenceId) ?? null)
    : null;
  const activeFinding =
    detail?.type === "finding"
      ? (findings.find((item) => item.id === detail.id) ?? null)
      : null;
  const activeNote =
    detail?.type === "note"
      ? (notes.find((item) => item.id === detail.id) ?? null)
      : null;
  const activeBookmark =
    detail?.type === "bookmark"
      ? (bookmarks.find((item) => item.id === detail.id) ?? null)
      : null;
  const reportDetailOpen = detail?.type === "report";
  const openProposedCount = proposedFindings.filter(
    (item) => item.status === "proposed",
  ).length;
  const openProposedReportSections = proposedReportSections.filter(
    (item) => item.status === "proposed",
  );
  // Include open Proposed items so agent-propose-only investigations are not
  // treated as an empty rail (Accept/Dismiss must remain reachable).
  const materialCount =
    items.length +
    findings.length +
    openProposedCount +
    openProposedReportSections.length +
    notes.length +
    bookmarks.length;
  const findingsFilterCount = findings.length + openProposedCount;
  const visibleMaterialCount =
    filter === "all"
      ? materialCount
      : filter === "findings"
        ? findingsFilterCount
        : filter === "evidence"
          ? items.length
          : filter === "notes"
            ? notes.length
            : filter === "report"
              ? openProposedReportSections.length
              : bookmarks.length;

  const openDetail = (next: MaterialDetail) => {
    detailOriginSelectorRef.current =
      next.type === "finding"
        ? `[data-testid="finding-item-${next.id}"]`
        : next.type === "note"
          ? `[data-testid="note-item-${next.id}"]`
          : next.type === "bookmark"
            ? `[data-testid="investigation-bookmark-${next.id}"]`
            : `[data-testid="open-report"]`;
    setDetail(next);
  };

  const closeDetail = () => {
    if (detail?.type === "report") onClearReport?.();
    setDetail(null);
    onClearViewPreview?.();
    queueMicrotask(() => {
      if (!detailOriginSelectorRef.current) return;
      document
        .querySelector<HTMLElement>(detailOriginSelectorRef.current)
        ?.focus();
    });
  };

  useEffect(() => {
    const previous = previousCollapsedRef.current;
    previousCollapsedRef.current = collapsed;
    if (!visible || compactLayout || previous === collapsed) return;
    queueMicrotask(() => {
      if (collapsed) reopenRef.current?.focus();
      else collapseToggleRef.current?.focus();
    });
  }, [collapsed, compactLayout, visible]);

  useEffect(() => {
    if (!visible || (!detail && !activePreviewItem)) return;
    queueMicrotask(() => detailBackRef.current?.focus());
  }, [activePreviewItem, detail, visible]);

  if (collapsed && !compactLayout) {
    return (
      <aside
        id="log-explorer-investigation-panel"
        className={`log-explorer__evidence log-explorer__chat log-explorer__chat--rail log-explorer__chat--collapsed${
          visible ? "" : " log-explorer__chat--mode-hidden"
        }`}
        data-testid="log-explorer-evidence"
        data-collapsed="true"
        hidden={!visible}
        aria-label="Investigation rail collapsed"
        style={
          desktopGridColumn == null
            ? undefined
            : { gridColumn: desktopGridColumn }
        }
      >
        <button
          ref={reopenRef}
          type="button"
          className="log-explorer__chat-reopen"
          data-testid="expand-investigation-rail"
          aria-label={`Expand Investigation rail, ${materialCount} saved item${
            materialCount === 1 ? "" : "s"
          }`}
          onClick={onToggleCollapsed}
        >
          <span aria-hidden="true">Investigate</span>
          {materialCount > 0 ? (
            <span
              className="log-explorer__chat-reopen-count"
              aria-hidden="true"
            >
              {materialCount}
            </span>
          ) : null}
        </button>
      </aside>
    );
  }

  return (
    <aside
      id="log-explorer-investigation-panel"
      className={`log-explorer__evidence log-explorer__chat log-explorer__chat--rail${
        compactLayout ? " log-explorer__chat--compact-layout" : ""
      }${visible ? "" : " log-explorer__chat--mode-hidden"}`}
      data-testid="log-explorer-evidence"
      hidden={!visible}
      style={
        desktopGridColumn == null
          ? undefined
          : { gridColumn: desktopGridColumn }
      }
      role={compactLayout ? "dialog" : undefined}
      aria-label={compactLayout ? "Investigation drawer" : "Investigation"}
    >
      <div
        className="log-explorer__investigation-mode-control"
        style={compactLayout ? undefined : { paddingLeft: "1.65rem" }}
      >
        {modeControl}
      </div>
      <header className="log-explorer__evidence-header">
        <div>
          <div className="log-explorer__chat-header-title">
            Investigation record
          </div>
          <div className="log-explorer__chat-header-meta">
            Durable · human authored · corpus linked
          </div>
        </div>
        <div className="log-explorer__chat-header-actions">
          {onOpenReport ? (
            <button
              type="button"
              className={`log-explorer__btn${
                reportDetailOpen ? " log-explorer__btn--active" : ""
              }`}
              data-testid="open-report"
              disabled={reportUnavailableReason != null}
              title={
                reportUnavailableReason ??
                "Open the assembled investigation report"
              }
              aria-pressed={reportDetailOpen}
              onClick={() => {
                if (reportDetailOpen) {
                  closeDetail();
                  return;
                }
                onClearPreview();
                onClearViewPreview?.();
                openDetail({ type: "report" });
                onOpenReport();
              }}
            >
              Report
            </button>
          ) : null}
          {!compactLayout && onToggleCollapsed ? (
            <button
              ref={collapseToggleRef}
              type="button"
              className="log-explorer__rail-collapse log-explorer__rail-collapse--chat"
              aria-label="Collapse Investigation rail"
              title="Collapse Investigation"
              onClick={onToggleCollapsed}
            >
              <IconChevronRight />
            </button>
          ) : null}
          {compactLayout && onRequestClose ? (
            <button
              type="button"
              className="log-explorer__btn"
              aria-label="Close Investigation drawer"
              onClick={onRequestClose}
            >
              Close
            </button>
          ) : null}
        </div>
      </header>

      {error ? (
        <div className="log-explorer__evidence-error" role="alert">
          {error}
          {onReloadInvestigation ? (
            <button
              type="button"
              className="log-explorer__btn"
              data-testid="reload-investigation"
              disabled={busy}
              onClick={onReloadInvestigation}
            >
              Reload investigation
            </button>
          ) : null}
        </div>
      ) : null}

      {!activePreviewItem &&
      !activeFinding &&
      !activeNote &&
      !activeBookmark &&
      !reportDetailOpen ? (
        <label className="log-explorer__material-filter">
          <span className="sr-only">Show investigation material</span>
          <select
            value={filter}
            onChange={(event) =>
              setFilter(event.target.value as MaterialFilter)
            }
          >
            <option value="all">All material · {materialCount}</option>
            <option value="findings">Findings · {findingsFilterCount}</option>
            <option value="evidence">Evidence · {items.length}</option>
            <option value="notes">Notes · {notes.length}</option>
            <option value="bookmarks">Bookmarks · {bookmarks.length}</option>
            <option value="report">
              Report sections · {openProposedReportSections.length}
            </option>
          </select>
          <IconChevronDown />
        </label>
      ) : null}

      {activePreviewItem && preview ? (
        <section
          className="log-explorer__evidence-preview"
          aria-label={`Preview ${activePreviewItem.title}`}
          data-testid="evidence-preview"
        >
          <div className="log-explorer__evidence-preview-header">
            <div>
              <div className="log-explorer__evidence-card-title">
                {activePreviewItem.title}
              </div>
              <div className="log-explorer__chat-header-meta">
                Authoritative bounded preview · current view unchanged
              </div>
            </div>
            <button
              ref={detailBackRef}
              type="button"
              className="log-explorer__btn"
              onClick={() => {
                onClearPreview();
                if (previewReturnDetailRef.current) {
                  // Route through openDetail so the origin selector is
                  // re-stamped and a later detail Back still restores focus.
                  openDetail(previewReturnDetailRef.current);
                  previewReturnDetailRef.current = null;
                  return;
                }
                queueMicrotask(() => {
                  if (!detailOriginSelectorRef.current) return;
                  document
                    .querySelector<HTMLElement>(
                      detailOriginSelectorRef.current,
                    )
                    ?.focus();
                });
              }}
            >
              Back
            </button>
          </div>
          {preview.missingCount > 0 || preview.staleCount > 0 ? (
            <div className="log-explorer__evidence-warning">
              {preview.missingCount > 0
                ? `${preview.missingCount} missing`
                : ""}
              {preview.missingCount > 0 && preview.staleCount > 0 ? " · " : ""}
              {preview.staleCount > 0 ? `${preview.staleCount} changed` : ""}
              {" · Reveal is unavailable until every identity is verified."}
            </div>
          ) : null}
          <div className="log-explorer__evidence-preview-list">
            {preview.events.map((event) => (
              <article
                key={`${event.source}:${event.seq}`}
                className="log-explorer__evidence-event"
              >
                <div className="log-explorer__evidence-event-meta">
                  <span>seq {event.seq}</span>
                  <span>{event.level.toUpperCase()}</span>
                  <span title={event.source}>{event.source}</span>
                </div>
                <div className="log-explorer__evidence-event-message">
                  {event.message}
                </div>
              </article>
            ))}
          </div>
          <button
            type="button"
            className="log-explorer__btn log-explorer__btn--active"
            disabled={
              busy ||
              preview.missingCount > 0 ||
              preview.staleCount > 0 ||
              preview.events.length === 0
            }
            onClick={() => onReveal(activePreviewItem)}
          >
            Reveal in Explorer
          </button>
        </section>
      ) : reportDetailOpen ? (
        <section
          className="log-explorer__evidence-preview log-explorer__report-detail"
          aria-label="Investigation report"
          data-testid="report-detail"
        >
          <div className="log-explorer__evidence-preview-header">
            <div>
              <div className="log-explorer__material-kicker">
                Assembled report
              </div>
              <div className="log-explorer__evidence-card-title">
                Investigation report
              </div>
              <div className="log-explorer__chat-header-meta">
                Accepted state only · preview never mutates the record
              </div>
            </div>
            <button
              ref={detailBackRef}
              type="button"
              className="log-explorer__btn"
              onClick={closeDetail}
            >
              Back
            </button>
          </div>
          <InvestigationReportSurface
            preview={reportPreview}
            busy={reportBusy || busy}
            error={reportError}
            onPreviewEvidence={(evidenceId) => {
              const cited = items.find((item) => item.id === evidenceId);
              if (!cited) return;
              detailOriginSelectorRef.current = null;
              previewReturnDetailRef.current = detail;
              setDetail(null);
              onPreview(cited);
            }}
            onEditSection={onEditReportSection}
            onExport={onExportReport}
          />
        </section>
      ) : activeFinding ? (
        <section
          className="log-explorer__evidence-preview"
          aria-label={`Finding ${activeFinding.title}`}
          data-testid={`finding-detail-${activeFinding.id}`}
        >
          <div className="log-explorer__evidence-preview-header">
            <div>
              <div className="log-explorer__material-kicker">
                {findingKindLabel(activeFinding.kind)} ·{" "}
                {activeFinding.lifecycle}
              </div>
              <div className="log-explorer__evidence-card-title">
                {activeFinding.title}
              </div>
            </div>
            <button
              ref={detailBackRef}
              type="button"
              className="log-explorer__btn"
              onClick={closeDetail}
            >
              Back
            </button>
          </div>
          <div>
            <div className="log-explorer__material-section-label">
              Why it matters
            </div>
            <p className="log-explorer__material-body">
              {activeFinding.whyItMatters}
            </p>
          </div>
          <div>
            <div className="log-explorer__material-section-label">
              Supporting evidence
            </div>
            <div className="log-explorer__citation-list">
              {activeFinding.evidenceIds.map((evidenceId) => {
                const cited = items.find((item) => item.id === evidenceId);
                return cited ? (
                  <button
                    key={evidenceId}
                    type="button"
                    className="log-explorer__citation"
                    disabled={busy}
                    onClick={() => {
                      detailOriginSelectorRef.current = null;
                      previewReturnDetailRef.current = detail;
                      setDetail(null);
                      onPreview(cited);
                    }}
                  >
                    <span>{cited.title}</span>
                    <span>{evidenceSummary(cited)}</span>
                  </button>
                ) : (
                  <span
                    key={evidenceId}
                    className="log-explorer__citation log-explorer__citation--missing"
                  >
                    Unavailable evidence
                  </span>
                );
              })}
            </div>
          </div>
          <div className="log-explorer__evidence-provenance">
            {activeFinding.provenanceLabel}
          </div>
          {activeFinding.policyStatusLabel ? (
            <div
              className="log-explorer__finding-policy"
              data-testid={`finding-policy-${activeFinding.id}`}
              data-policy-status={activeFinding.policyStatus ?? "unknown"}
            >
              {activeFinding.policyStatusLabel}
            </div>
          ) : null}
          {activeFinding.viewRecipe && onPreviewFindingView ? (
            <div className="log-explorer__finding-view">
              <div className="log-explorer__material-section-label">
                Saved Explorer view
              </div>
              {viewPreview?.findingId === activeFinding.id ? (
                <div
                  className="log-explorer__finding-view-preview"
                  data-testid={`finding-view-preview-${activeFinding.id}`}
                >
                  <div className="log-explorer__chat-header-meta">
                    Preview only · current Explorer unchanged
                  </div>
                  {viewPreview.policyStatusLabel ? (
                    <div
                      className="log-explorer__finding-policy"
                      data-testid={`finding-view-policy-${activeFinding.id}`}
                      data-policy-status={
                        viewPreview.policyStatus ?? "unknown"
                      }
                    >
                      {viewPreview.policyStatusLabel}
                    </div>
                  ) : null}
                  <ul>
                    {viewPreview.changes.map((change) => (
                      <li key={change}>{change}</li>
                    ))}
                  </ul>
                  {viewPreview.missingCount > 0 ||
                  viewPreview.staleCount > 0 ||
                  viewPreview.policyBlocksApply ? (
                    <div
                      className="log-explorer__evidence-warning"
                      role="status"
                    >
                      Apply blocked
                      {viewPreview.policyBlocksApply
                        ? " · review under current noise policy first"
                        : null}
                      {viewPreview.missingCount > 0
                        ? ` · ${viewPreview.missingCount} missing reference${
                            viewPreview.missingCount === 1 ? "" : "s"
                          }`
                        : null}
                      {viewPreview.staleCount > 0
                        ? ` · ${viewPreview.staleCount} changed reference${
                            viewPreview.staleCount === 1 ? "" : "s"
                          }`
                        : null}
                    </div>
                  ) : null}
                  <div className="log-explorer__evidence-card-actions">
                    <button
                      type="button"
                      className="log-explorer__btn log-explorer__btn--active"
                      disabled={
                        busy ||
                        viewPreview.missingCount > 0 ||
                        viewPreview.staleCount > 0 ||
                        Boolean(viewPreview.policyBlocksApply)
                      }
                      onClick={() => onApplyFindingView?.(viewPreview)}
                    >
                      Apply saved view
                    </button>
                    {onRecomputeFindingView ? (
                      <button
                        type="button"
                        className="log-explorer__btn"
                        data-testid={`finding-recompute-${activeFinding.id}`}
                        disabled={busy}
                        onClick={() => onRecomputeFindingView(activeFinding)}
                      >
                        Recompute from current view
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="log-explorer__btn"
                      onClick={onClearViewPreview}
                    >
                      Dismiss preview
                    </button>
                  </div>
                </div>
              ) : (
                <div className="log-explorer__evidence-card-actions">
                  <button
                    type="button"
                    className="log-explorer__btn"
                    disabled={busy}
                    onClick={() => onPreviewFindingView(activeFinding)}
                  >
                    Preview saved view
                  </button>
                  {onRecomputeFindingView ? (
                    <button
                      type="button"
                      className="log-explorer__btn"
                      data-testid={`finding-recompute-${activeFinding.id}`}
                      disabled={busy}
                      onClick={() => onRecomputeFindingView(activeFinding)}
                    >
                      Recompute from current view
                    </button>
                  ) : null}
                </div>
              )}
            </div>
          ) : null}
          {onEditFinding ? (
            <button
              type="button"
              className="log-explorer__btn"
              disabled={busy}
              onClick={(event) =>
                onEditFinding(activeFinding, event.currentTarget)
              }
            >
              Edit finding
            </button>
          ) : null}
        </section>
      ) : activeNote ? (
        <section
          className="log-explorer__evidence-preview"
          aria-label={`Note ${activeNote.title}`}
          data-testid={`note-detail-${activeNote.id}`}
        >
          <div className="log-explorer__evidence-preview-header">
            <div>
              <div className="log-explorer__material-kicker">Cited note</div>
              <div className="log-explorer__evidence-card-title">
                {activeNote.title}
              </div>
            </div>
            <button
              ref={detailBackRef}
              type="button"
              className="log-explorer__btn"
              onClick={closeDetail}
            >
              Back
            </button>
          </div>
          <p className="log-explorer__material-body">{activeNote.body}</p>
          <div>
            <div className="log-explorer__material-section-label">
              Citations
            </div>
            <div className="log-explorer__citation-list">
              {activeNote.evidenceIds.map((evidenceId) => {
                const cited = items.find((item) => item.id === evidenceId);
                return cited ? (
                  <button
                    key={evidenceId}
                    type="button"
                    className="log-explorer__citation"
                    disabled={busy}
                    onClick={() => {
                      detailOriginSelectorRef.current = null;
                      previewReturnDetailRef.current = detail;
                      setDetail(null);
                      onPreview(cited);
                    }}
                  >
                    <span>{cited.title}</span>
                    <span>{evidenceSummary(cited)}</span>
                  </button>
                ) : (
                  <span
                    key={evidenceId}
                    className="log-explorer__citation log-explorer__citation--missing"
                  >
                    Unavailable evidence
                  </span>
                );
              })}
            </div>
          </div>
          <div className="log-explorer__evidence-provenance">
            {activeNote.provenanceLabel}
          </div>
          {onEditNote ? (
            <button
              type="button"
              className="log-explorer__btn"
              disabled={busy}
              onClick={(event) => onEditNote(activeNote, event.currentTarget)}
            >
              Edit note
            </button>
          ) : null}
        </section>
      ) : activeBookmark ? (
        <section
          className="log-explorer__evidence-preview"
          aria-label={`Bookmark ${activeBookmark.label}`}
          data-testid={`bookmark-detail-${activeBookmark.id}`}
        >
          <div className="log-explorer__evidence-preview-header">
            <div>
              <div className="log-explorer__material-kicker">
                {activeBookmark.evidenceStatus === "legacy_range"
                  ? "Legacy range bookmark"
                  : "Exact bookmark"}
              </div>
              <div className="log-explorer__evidence-card-title">
                {activeBookmark.label}
              </div>
            </div>
            <button
              ref={detailBackRef}
              type="button"
              className="log-explorer__btn"
              onClick={closeDetail}
            >
              Back
            </button>
          </div>
          <div className="log-explorer__material-body">
            {activeBookmark.eventRefs.length > 0
              ? `${activeBookmark.eventRefs.length} exact event ${
                  activeBookmark.eventRefs.length === 1
                    ? "identity"
                    : "identities"
                }`
              : `Legacy seq range ${activeBookmark.seqFrom}–${activeBookmark.seqTo}`}
          </div>
          {activeBookmark.note ? (
            <div className="log-explorer__bookmark-legacy-note">
              <div className="log-explorer__material-section-label">
                Legacy bookmark annotation
              </div>
              <p className="log-explorer__material-body">
                {activeBookmark.note}
              </p>
              <div className="log-explorer__chat-header-meta">
                Shown for reference only · not imported as a trusted
                Investigation note
              </div>
            </div>
          ) : null}
          {onActivateBookmark ? (
            <button
              type="button"
              className="log-explorer__btn log-explorer__btn--active"
              disabled={
                busy ||
                activeBookmark.evidenceStatus === "missing" ||
                activeBookmark.evidenceStatus === "stale"
              }
              onClick={() => onActivateBookmark(activeBookmark)}
            >
              Reveal bookmark
            </button>
          ) : null}
        </section>
      ) : (
        <div className="log-explorer__evidence-list">
          {materialCount === 0 ? (
            <div className="log-explorer__evidence-empty">
              <div className="log-explorer__evidence-empty-title">
                Your investigation record is empty
              </div>
              <p>
                Select log rows to save exact evidence, record a finding, or
                write a cited note. Saved material stays linked to this corpus.
              </p>
            </div>
          ) : visibleMaterialCount === 0 ? (
            <div className="log-explorer__evidence-empty">
              <div className="log-explorer__evidence-empty-title">
                No {filter === "report" ? "proposed report sections" : filter}{" "}
                saved yet
              </div>
              <p>
                Choose All material to browse the rest of this investigation
                record.
              </p>
            </div>
          ) : (
            <>
              {(filter === "all" || filter === "report") &&
                openProposedReportSections.map((item) => (
                  <ProposedReportSectionCard
                    key={item.id}
                    item={item}
                    busy={busy}
                    onAccept={onAcceptProposedReportSection}
                    onDismiss={onDismissProposedReportSection}
                  />
                ))}
              {(filter === "all" || filter === "findings") &&
                proposedFindings
                  .filter((p) => p.status === "proposed")
                  .map((item) => {
                    const isEditing = proposalEditId === item.id;
                    const isPreviewing =
                      proposalPreview?.proposalId === item.id;
                    return (
                      <div
                        key={item.id}
                        className="log-explorer__evidence-card log-explorer__material-card"
                        data-testid={`proposed-finding-${item.id}`}
                      >
                        <div className="log-explorer__evidence-card-heading">
                          <div>
                            <div className="log-explorer__material-kicker">
                              Proposed · {findingKindLabel(item.kind)}
                            </div>
                            <div className="log-explorer__evidence-card-title">
                              {item.title}
                            </div>
                          </div>
                          <span className="log-explorer__evidence-status">
                            proposed
                          </span>
                        </div>
                        <p className="log-explorer__chat-header-meta">
                          {item.whyItMatters}
                        </p>
                        <p className="log-explorer__chat-header-meta">
                          {item.supportingCount} supporting ·{" "}
                          {item.contradictingCount} contradicting ·{" "}
                          {item.evidenceCount} exact ref
                          {item.evidenceCount === 1 ? "" : "s"}
                        </p>
                        {isPreviewing ? (
                          <div
                            className="log-explorer__finding-view-preview"
                            data-testid={`proposed-finding-preview-${item.id}`}
                            role="status"
                          >
                            <div className="log-explorer__chat-header-meta">
                              Preview only · current Explorer unchanged · not
                              accepted
                            </div>
                            {item.caveats ? (
                              <p className="log-explorer__chat-header-meta">
                                Caveats: {item.caveats}
                              </p>
                            ) : null}
                            {proposalPreview.changes.length > 0 ? (
                              <ul>
                                {proposalPreview.changes.map((change) => (
                                  <li key={change}>{change}</li>
                                ))}
                              </ul>
                            ) : (
                              <p className="log-explorer__chat-header-meta">
                                No Explorer view change listed for this proposal
                                (or recipe matches current view).
                              </p>
                            )}
                            <button
                              type="button"
                              className="log-explorer__btn"
                              onClick={() => onClearViewPreview?.()}
                            >
                              Dismiss preview
                            </button>
                          </div>
                        ) : null}
                        {isEditing ? (
                          <div
                            className="log-explorer__finding-view-preview"
                            data-testid={`proposed-finding-edit-${item.id}`}
                          >
                            <label className="log-explorer__field">
                              <span className="sr-only">Edited title</span>
                              <input
                                type="text"
                                value={proposalEditTitle}
                                onChange={(event) =>
                                  setProposalEditTitle(event.target.value)
                                }
                                aria-label="Edited proposal title"
                                data-testid={`proposed-edit-title-${item.id}`}
                              />
                            </label>
                            <label className="log-explorer__field">
                              <span className="sr-only">Edited why it matters</span>
                              <textarea
                                value={proposalEditWhy}
                                onChange={(event) =>
                                  setProposalEditWhy(event.target.value)
                                }
                                aria-label="Edited proposal why it matters"
                                data-testid={`proposed-edit-why-${item.id}`}
                                rows={3}
                              />
                            </label>
                            <div className="log-explorer__evidence-card-actions">
                              <button
                                type="button"
                                className="log-explorer__btn log-explorer__btn--active"
                                disabled={busy || !proposalEditTitle.trim()}
                                data-testid={`confirm-edit-accept-${item.id}`}
                                onClick={() => {
                                  onAcceptProposedFinding?.({
                                    proposalId: item.id,
                                    edited: true,
                                    title: proposalEditTitle.trim(),
                                    whyItMatters: proposalEditWhy.trim(),
                                  });
                                  setProposalEditId(null);
                                }}
                              >
                                Save edits and accept
                              </button>
                              <button
                                type="button"
                                className="log-explorer__btn"
                                disabled={busy}
                                onClick={() => setProposalEditId(null)}
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="log-explorer__evidence-card-actions">
                            <button
                              type="button"
                              className="log-explorer__btn"
                              disabled={busy}
                              data-testid={`preview-proposed-${item.id}`}
                              onClick={() => onPreviewProposedFinding?.(item)}
                            >
                              Preview
                            </button>
                            <button
                              type="button"
                              className="log-explorer__btn log-explorer__btn--active"
                              disabled={busy}
                              data-testid={`accept-proposed-${item.id}`}
                              onClick={() =>
                                onAcceptProposedFinding?.({
                                  proposalId: item.id,
                                  edited: false,
                                })
                              }
                            >
                              Accept
                            </button>
                            <button
                              type="button"
                              className="log-explorer__btn"
                              disabled={busy}
                              data-testid={`edit-accept-proposed-${item.id}`}
                              onClick={() => {
                                setProposalEditId(item.id);
                                setProposalEditTitle(item.title);
                                setProposalEditWhy(item.whyItMatters);
                              }}
                            >
                              Edit and accept
                            </button>
                            <button
                              type="button"
                              className="log-explorer__btn"
                              disabled={busy}
                              data-testid={`dismiss-proposed-${item.id}`}
                              onClick={() =>
                                onDismissProposedFinding?.(item.id)
                              }
                            >
                              Dismiss
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
              {(filter === "all" || filter === "findings") &&
                findings.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="log-explorer__evidence-card log-explorer__material-card"
                    data-testid={`finding-item-${item.id}`}
                    onClick={() =>
                      openDetail({ type: "finding", id: item.id })
                    }
                  >
                    <div className="log-explorer__evidence-card-heading">
                      <div>
                        <div className="log-explorer__material-kicker">
                          {findingKindLabel(item.kind)}
                        </div>
                        <div className="log-explorer__evidence-card-title">
                          {item.title}
                        </div>
                      </div>
                      <span
                        className={`log-explorer__evidence-status log-explorer__finding-status--${item.lifecycle}`}
                      >
                        {item.lifecycle}
                      </span>
                    </div>
                    <div className="log-explorer__chat-header-meta">
                      {item.evidenceIds.length} evidence{" "}
                      {item.evidenceIds.length === 1 ? "citation" : "citations"}
                      {item.viewRecipe ? " · saved view" : ""}
                    </div>
                    <div className="log-explorer__material-card-excerpt">
                      {item.whyItMatters}
                    </div>
                  </button>
                ))}
              {(filter === "all" || filter === "evidence") &&
                items.map((item) => (
                  <article
                    key={item.id}
                    className="log-explorer__evidence-card"
                    data-testid={`evidence-item-${item.id}`}
                  >
                    <div className="log-explorer__evidence-card-heading">
                      <div>
                        <div className="log-explorer__material-kicker">
                          Evidence
                        </div>
                        <div className="log-explorer__evidence-card-title">
                          {item.title}
                        </div>
                        <div className="log-explorer__chat-header-meta">
                          {evidenceSummary(item)}
                        </div>
                      </div>
                      <span
                        className={`log-explorer__evidence-status log-explorer__evidence-status--${item.evidenceStatus}`}
                      >
                        {statusLabel(item.evidenceStatus)}
                      </span>
                    </div>
                    <div className="log-explorer__evidence-provenance">
                      {item.provenanceLabel}
                    </div>
                    <div className="log-explorer__evidence-card-actions">
                      <button
                        type="button"
                        className="log-explorer__btn"
                        disabled={busy}
                        onClick={() => {
                          detailOriginSelectorRef.current = `[data-testid="evidence-item-${item.id}"] button`;
                          previewReturnDetailRef.current = null;
                          onPreview(item);
                        }}
                      >
                        Preview
                      </button>
                      <button
                        type="button"
                        className="log-explorer__btn"
                        disabled={busy || item.evidenceStatus !== "verified"}
                        title={
                          item.evidenceStatus === "verified"
                            ? "Reveal this evidence in the Explorer"
                            : "Reveal requires verified event identities"
                        }
                        onClick={() => onReveal(item)}
                      >
                        Reveal
                      </button>
                    </div>
                  </article>
                ))}
              {(filter === "all" || filter === "notes") &&
                notes.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="log-explorer__evidence-card log-explorer__material-card"
                    data-testid={`note-item-${item.id}`}
                    onClick={() => openDetail({ type: "note", id: item.id })}
                  >
                    <div className="log-explorer__material-kicker">
                      Cited note
                    </div>
                    <div className="log-explorer__evidence-card-title">
                      {item.title}
                    </div>
                    <div className="log-explorer__material-card-excerpt">
                      {item.body}
                    </div>
                    <div className="log-explorer__chat-header-meta">
                      {item.evidenceIds.length} evidence{" "}
                      {item.evidenceIds.length === 1 ? "citation" : "citations"}
                    </div>
                  </button>
                ))}
              {(filter === "all" || filter === "bookmarks") &&
                bookmarks.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="log-explorer__evidence-card log-explorer__material-card"
                    data-testid={`investigation-bookmark-${item.id}`}
                    onClick={() =>
                      openDetail({ type: "bookmark", id: item.id })
                    }
                  >
                    <div className="log-explorer__evidence-card-heading">
                      <div>
                        <div className="log-explorer__material-kicker">
                          {item.evidenceStatus === "legacy_range"
                            ? "Legacy bookmark"
                            : "Bookmark"}
                        </div>
                        <div className="log-explorer__evidence-card-title">
                          {item.label}
                        </div>
                      </div>
                      <span
                        className={`log-explorer__evidence-status log-explorer__evidence-status--${item.evidenceStatus}`}
                      >
                        {item.evidenceStatus === "legacy_range"
                          ? "Range"
                          : statusLabel(
                              item.evidenceStatus as EvidenceItemView["evidenceStatus"],
                            )}
                      </span>
                    </div>
                    <div className="log-explorer__chat-header-meta">
                      {item.eventRefs.length > 0
                        ? `${item.eventRefs.length} exact ${
                            item.eventRefs.length === 1 ? "event" : "events"
                          }`
                        : `seq ${item.seqFrom}–${item.seqTo}`}
                    </div>
                  </button>
                ))}
            </>
          )}
        </div>
      )}
    </aside>
  );
}
