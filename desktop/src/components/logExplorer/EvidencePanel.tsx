import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  ExplorerEventDto,
  InvestigationViewRecipeDto,
  LogBookmarkEventRefDto,
} from "../../lib/host";
import { IconChevronDown, IconChevronRight } from "../icons";

export type InvestigationRailMode = "investigation" | "chat";

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
};

export type FindingViewPreviewView = {
  findingId: string;
  recipe: InvestigationViewRecipeDto;
  changes: string[];
  missingCount: number;
  staleCount: number;
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

type MaterialFilter = "all" | "findings" | "evidence" | "notes" | "bookmarks";
type MaterialDetail =
  | { type: "finding"; id: string }
  | { type: "note"; id: string }
  | { type: "bookmark"; id: string };

export function InvestigationModeControl({
  mode,
  investigationCount,
  chatCount,
  onChange,
}: {
  mode: InvestigationRailMode;
  investigationCount: number;
  chatCount: number;
  onChange: (mode: InvestigationRailMode) => void;
}) {
  const [open, setOpen] = useState(false);
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
  ];
  const current = options.find((option) => option.mode === mode)!;

  useEffect(() => {
    if (!open) return;
    queueMicrotask(() =>
      rootRef.current
        ?.querySelector<HTMLButtonElement>(
          '.log-explorer__investigation-mode-option[aria-checked="true"]',
        )
        ?.focus(),
    );
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target)) return;
      const focusableTarget =
        target instanceof Element
          ? target.closest(
              "button, a[href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
            )
          : null;
      setOpen(false);
      if (!focusableTarget) {
        window.setTimeout(() => triggerRef.current?.focus(), 0);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      queueMicrotask(() => triggerRef.current?.focus());
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
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

export function EvidencePanel({
  modeControl,
  items,
  findings = [],
  notes = [],
  bookmarks = [],
  preview,
  viewPreview,
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
  onEditFinding,
  onEditNote,
  onActivateBookmark,
  onClearPreview,
  onClearViewPreview,
  onToggleCollapsed,
  onRequestClose,
}: {
  modeControl: ReactNode;
  items: EvidenceItemView[];
  findings?: FindingItemView[];
  notes?: NoteItemView[];
  bookmarks?: BookmarkItemView[];
  preview: EvidencePreviewView | null;
  viewPreview?: FindingViewPreviewView | null;
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
  onEditFinding?: (item: FindingItemView, trigger: HTMLButtonElement) => void;
  onEditNote?: (item: NoteItemView, trigger: HTMLButtonElement) => void;
  onActivateBookmark?: (item: BookmarkItemView) => void;
  onClearPreview: () => void;
  onClearViewPreview?: () => void;
  onToggleCollapsed?: () => void;
  onRequestClose?: () => void;
}) {
  const [filter, setFilter] = useState<MaterialFilter>("all");
  const [detail, setDetail] = useState<MaterialDetail | null>(null);
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
  const materialCount =
    items.length + findings.length + notes.length + bookmarks.length;
  const visibleMaterialCount =
    filter === "all"
      ? materialCount
      : filter === "findings"
        ? findings.length
        : filter === "evidence"
          ? items.length
          : filter === "notes"
            ? notes.length
            : bookmarks.length;

  const openDetail = (next: MaterialDetail) => {
    detailOriginSelectorRef.current =
      next.type === "finding"
        ? `[data-testid="finding-item-${next.id}"]`
        : next.type === "note"
          ? `[data-testid="note-item-${next.id}"]`
          : `[data-testid="investigation-bookmark-${next.id}"]`;
    setDetail(next);
  };

  const closeDetail = () => {
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
      <div className="log-explorer__investigation-mode-control">
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
        </div>
      ) : null}

      {!activePreviewItem &&
      !activeFinding &&
      !activeNote &&
      !activeBookmark ? (
        <label className="log-explorer__material-filter">
          <span className="sr-only">Show investigation material</span>
          <select
            value={filter}
            onChange={(event) =>
              setFilter(event.target.value as MaterialFilter)
            }
          >
            <option value="all">All material · {materialCount}</option>
            <option value="findings">Findings · {findings.length}</option>
            <option value="evidence">Evidence · {items.length}</option>
            <option value="notes">Notes · {notes.length}</option>
            <option value="bookmarks">Bookmarks · {bookmarks.length}</option>
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
                  setDetail(previewReturnDetailRef.current);
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
                  <ul>
                    {viewPreview.changes.map((change) => (
                      <li key={change}>{change}</li>
                    ))}
                  </ul>
                  {viewPreview.missingCount > 0 ||
                  viewPreview.staleCount > 0 ? (
                    <div
                      className="log-explorer__evidence-warning"
                      role="status"
                    >
                      Apply blocked ·{" "}
                      {viewPreview.missingCount > 0
                        ? `${viewPreview.missingCount} missing reference${
                            viewPreview.missingCount === 1 ? "" : "s"
                          }`
                        : null}
                      {viewPreview.missingCount > 0 &&
                      viewPreview.staleCount > 0
                        ? " · "
                        : null}
                      {viewPreview.staleCount > 0
                        ? `${viewPreview.staleCount} changed reference${
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
                        viewPreview.staleCount > 0
                      }
                      onClick={() => onApplyFindingView?.(viewPreview)}
                    >
                      Apply saved view
                    </button>
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
                <button
                  type="button"
                  className="log-explorer__btn"
                  disabled={busy}
                  onClick={() => onPreviewFindingView(activeFinding)}
                >
                  Preview saved view
                </button>
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
                No {filter} saved yet
              </div>
              <p>
                Choose All material to browse the rest of this investigation
                record.
              </p>
            </div>
          ) : (
            <>
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
