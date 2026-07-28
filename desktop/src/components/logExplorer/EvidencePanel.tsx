import { useEffect, useId, useRef, type ReactNode } from "react";
import type { ExplorerEventDto, LogBookmarkEventRefDto } from "../../lib/host";
import { IconChevronRight } from "../icons";

export type InvestigationRailMode = "evidence" | "chat";

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

export function InvestigationModeControl({
  mode,
  evidenceCount,
  chatCount,
  onChange,
}: {
  mode: InvestigationRailMode;
  evidenceCount: number;
  chatCount: number;
  onChange: (mode: InvestigationRailMode) => void;
}) {
  const labelId = useId();
  return (
    <div className="log-explorer__investigation-mode-picker">
      <span id={labelId} className="log-explorer__investigation-mode-label">
        Investigation
      </span>
      <div
        className="log-explorer__investigation-mode-options"
        role="group"
        aria-labelledby={labelId}
      >
        <button
          type="button"
          className={`log-explorer__investigation-mode-option${
            mode === "evidence"
              ? " log-explorer__investigation-mode-option--active"
              : ""
          }`}
          aria-pressed={mode === "evidence"}
          onClick={() => onChange("evidence")}
        >
          Evidence
          <span aria-label={`${evidenceCount} saved evidence items`}>
            {evidenceCount}
          </span>
        </button>
        <button
          type="button"
          className={`log-explorer__investigation-mode-option${
            mode === "chat"
              ? " log-explorer__investigation-mode-option--active"
              : ""
          }`}
          aria-pressed={mode === "chat"}
          onClick={() => onChange("chat")}
        >
          Chat
          <span aria-label={`${chatCount} linked chats`}>{chatCount}</span>
        </button>
      </div>
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

export function EvidencePanel({
  modeControl,
  items,
  preview,
  busy,
  error,
  compactLayout = false,
  collapsed = false,
  desktopGridColumn,
  onPreview,
  onReveal,
  onClearPreview,
  onToggleCollapsed,
  onRequestClose,
}: {
  modeControl: ReactNode;
  items: EvidenceItemView[];
  preview: EvidencePreviewView | null;
  busy: boolean;
  error: string | null;
  compactLayout?: boolean;
  collapsed?: boolean;
  desktopGridColumn?: number;
  onPreview: (item: EvidenceItemView) => void;
  onReveal: (item: EvidenceItemView) => void;
  onClearPreview: () => void;
  onToggleCollapsed?: () => void;
  onRequestClose?: () => void;
}) {
  const collapseToggleRef = useRef<HTMLButtonElement>(null);
  const reopenRef = useRef<HTMLButtonElement>(null);
  const previousCollapsedRef = useRef(collapsed);
  const activePreviewItem = preview
    ? (items.find((item) => item.id === preview.evidenceId) ?? null)
    : null;

  useEffect(() => {
    const previous = previousCollapsedRef.current;
    previousCollapsedRef.current = collapsed;
    if (compactLayout || previous === collapsed) return;
    queueMicrotask(() => {
      if (collapsed) reopenRef.current?.focus();
      else collapseToggleRef.current?.focus();
    });
  }, [collapsed, compactLayout]);

  if (collapsed && !compactLayout) {
    return (
      <aside
        id="log-explorer-investigation-panel"
        className="log-explorer__evidence log-explorer__chat log-explorer__chat--rail log-explorer__chat--collapsed"
        data-testid="log-explorer-evidence"
        data-collapsed="true"
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
          aria-label={`Expand Investigation rail, ${items.length} evidence item${
            items.length === 1 ? "" : "s"
          }`}
          onClick={onToggleCollapsed}
        >
          <span aria-hidden="true">Investigate</span>
          {items.length > 0 ? (
            <span
              className="log-explorer__chat-reopen-count"
              aria-hidden="true"
            >
              {items.length}
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
      }`}
      data-testid="log-explorer-evidence"
      style={
        desktopGridColumn == null
          ? undefined
          : { gridColumn: desktopGridColumn }
      }
      role={compactLayout ? "dialog" : undefined}
      aria-label={compactLayout ? "Investigation drawer" : "Saved evidence"}
    >
      <div className="log-explorer__investigation-mode-control">
        {modeControl}
      </div>
      <header className="log-explorer__evidence-header">
        <div>
          <div className="log-explorer__chat-header-title">Saved evidence</div>
          <div className="log-explorer__chat-header-meta">
            Durable · corpus linked · payload free
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
              type="button"
              className="log-explorer__btn"
              onClick={onClearPreview}
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
      ) : (
        <div className="log-explorer__evidence-list">
          {items.length === 0 ? (
            <div className="log-explorer__evidence-empty">
              <div className="log-explorer__evidence-empty-title">
                No evidence saved yet
              </div>
              <p>
                Select one or more log rows, then choose <b>Save evidence</b>.
                Exact event identities are retained without copying raw
                payloads.
              </p>
            </div>
          ) : (
            items.map((item) => (
              <article
                key={item.id}
                className="log-explorer__evidence-card"
                data-testid={`evidence-item-${item.id}`}
              >
                <div className="log-explorer__evidence-card-heading">
                  <div>
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
                    onClick={() => onPreview(item)}
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
            ))
          )}
        </div>
      )}
    </aside>
  );
}
