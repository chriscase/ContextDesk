/**
 * Evidence · N control + set panel for grounded assistant answers.
 * Membership is host-attached citations only — never prose-scraped IDs.
 */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  applyLaneAssignment,
  assignEvidenceToLanes,
  buildEvidenceSetFromHostCitations,
  cancelInvestigationAdd,
  confirmInvestigationAdd,
  enrichWithHostEvents,
  evidenceControlLabel,
  idleInvestigationAdd,
  laneEligibleItems,
  markInvestigationApplied,
  planShowInExplorer,
  previewInvestigationAdd,
  selectAllLaneEligible,
  selectionFromKeys,
  toggleEvidenceSelection,
  undoInvestigationAdd,
  type EvidenceItem,
  type HostEvidenceCitation,
  type InvestigationAddState,
  type LaneAssignmentMode,
  type ShowInExplorerPlan,
  type TimeQualityHint,
} from "../lib/evidenceLaneBridge";
import type { LaneConfig } from "../lib/logExplorer/laneCompose";
import { loadLanes, saveLanes, saveLinkMode } from "../lib/logExplorer/laneCompose";

export type HostEventResolution = {
  corpusId: string;
  seq: number;
  source: string;
  ts: number;
  timeQuality: TimeQualityHint;
  service?: string | null;
};

export type EvidenceSetPanelProps = {
  /** Host-attached citations for this answer only. */
  citations: HostEvidenceCitation[];
  /** Single-citation fail-closed open (existing path). */
  onOpenCitation: (sourceId: string, corpusId?: string) => void;
  /** Open workspace/file citation on existing source surface. */
  onOpenWorkspace?: (sourceId: string) => void;
  /**
   * Host open/focus corpus + optional exact-nav. Must not reimport or
   * duplicate the corpus.
   */
  onShowInExplorer?: (plan: {
    corpusId: string;
    lanes: LaneConfig[];
    visibleLaneCount: number;
    linkMode: "independent" | "follow_cursor" | "align_time";
    highlightSeqs: number[];
    navTarget: { kind: "event" | "template"; id: string } | null;
  }) => Promise<void> | void;
  /**
   * Host investigation write — only invoked after explicit confirm.
   * Return to mark applied; throw to keep confirmed for retry.
   */
  onAddToInvestigation?: (state: InvestigationAddState) => Promise<void> | void;
  /**
   * Resolve host-verified source/service/time for selected log events.
   * Never invent identity — return only host facts.
   */
  resolveHostEvents?: (
    items: EvidenceItem[],
  ) => Promise<HostEventResolution[]>;
  /** Optional known corpus inventory for fail-closed stale checks. */
  availableCorpusIds?: readonly string[];
  /** Compact layout for linked-chat rail / narrow windows. */
  compact?: boolean;
  className?: string;
};

const MODES: { id: LaneAssignmentMode; label: string; hint: string }[] = [
  {
    id: "one_lane",
    label: "One lane",
    hint: "All selected log events in a single customer-evidence lane.",
  },
  {
    id: "group_related",
    label: "Group related",
    hint: "Bucket by host-verified service, then source, then corpus.",
  },
  {
    id: "one_source_per_lane",
    label: "One source per lane",
    hint: "One host-verified source per lane (max 4).",
  },
];

export function EvidenceSetPanel({
  citations,
  onOpenCitation,
  onOpenWorkspace,
  onShowInExplorer,
  onAddToInvestigation,
  resolveHostEvents,
  availableCorpusIds,
  compact = false,
  className,
}: EvidenceSetPanelProps) {
  const baseItems = useMemo(
    () => buildEvidenceSetFromHostCitations(citations),
    [citations],
  );
  const [resolvedOverlay, setResolvedOverlay] = useState<
    HostEventResolution[]
  >([]);
  const items = useMemo(
    () => enrichWithHostEvents(baseItems, resolvedOverlay),
    [baseItems, resolvedOverlay],
  );
  const count = items.length;
  const [open, setOpen] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [mode, setMode] = useState<LaneAssignmentMode>("group_related");
  const [occupiedPreview, setOccupiedPreview] = useState<ShowInExplorerPlan | null>(
    null,
  );
  const [invState, setInvState] = useState<InvestigationAddState>(() =>
    idleInvestigationAdd(),
  );
  const [busy, setBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  // Reset selection when the host citation set identity changes.
  const citationSig = useMemo(
    () => baseItems.map((i) => i.key).join("|"),
    [baseItems],
  );
  useEffect(() => {
    setSelectedKeys(selectAllLaneEligible(baseItems));
    setOccupiedPreview(null);
    setInvState(idleInvestigationAdd());
    setStatusMsg(null);
    setResolvedOverlay([]);
  }, [citationSig, baseItems]);

  const selected = useMemo(
    () => selectionFromKeys(items, selectedKeys),
    [items, selectedKeys],
  );
  const logSelected = useMemo(() => laneEligibleItems(selected), [selected]);

  const ensureResolved = useCallback(async (): Promise<EvidenceItem[]> => {
    if (!resolveHostEvents) return logSelected;
    const need = logSelected.filter(
      (i) => !i.source || i.timestamp == null || !i.timeQuality,
    );
    if (need.length === 0) return logSelected;
    const resolved = await resolveHostEvents(need);
    setResolvedOverlay((prev) => {
      const map = new Map(
        [...prev, ...resolved].map(
          (e) => [`${e.corpusId}\u0000${e.seq}`, e] as const,
        ),
      );
      return [...map.values()];
    });
    return enrichWithHostEvents(logSelected, resolved);
  }, [logSelected, resolveHostEvents]);

  const close = useCallback(() => {
    setOpen(false);
    setOccupiedPreview(null);
    setInvState(idleInvestigationAdd());
    queueMicrotask(() => toggleRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (occupiedPreview) {
          setOccupiedPreview(null);
          return;
        }
        if (invState.status === "preview" || invState.status === "confirmed") {
          setInvState(cancelInvestigationAdd(invState));
          return;
        }
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, occupiedPreview, invState, close]);

  if (count === 0) return null;

  const onToggleKey = (e: ReactKeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setOpen((v) => !v);
    }
  };

  const runShowInExplorer = async (confirmReplace: boolean) => {
    setStatusMsg(null);
    setBusy(true);
    try {
      const resolvedSelected = await ensureResolved();
      const existing =
        resolvedSelected[0]?.corpusId != null
          ? loadLanes(resolvedSelected[0].corpusId) ?? []
          : [];
      const plan = planShowInExplorer(resolvedSelected, mode, existing, {
        availableCorpusIds,
      });
      if ("error" in plan) {
        setStatusMsg(plan.error);
        return;
      }
      if (plan.occupiedPreview.needsConfirm && !confirmReplace) {
        setOccupiedPreview(plan);
        return;
      }
      const applied = applyLaneAssignment(
        existing,
        plan.assignment,
        confirmReplace || !plan.occupiedPreview.needsConfirm,
      );
      if (!applied.applied) {
        setStatusMsg("Lane change cancelled — existing layout kept.");
        setOccupiedPreview(null);
        return;
      }
      saveLanes(plan.corpusId, applied.lanes);
      if (plan.assignment.linkMode !== "independent") {
        saveLinkMode(plan.corpusId, plan.assignment.linkMode);
      } else if (plan.assignment.alignmentRefuseReason) {
        saveLinkMode(plan.corpusId, "independent");
      }
      const first = plan.navTargets[0] ?? null;
      await onShowInExplorer?.({
        corpusId: plan.corpusId,
        lanes: applied.lanes,
        visibleLaneCount: applied.visibleLaneCount,
        linkMode: plan.assignment.linkMode,
        highlightSeqs: plan.highlightSeqs,
        navTarget: first,
      });
      setOccupiedPreview(null);
      setStatusMsg(
        plan.assignment.alignmentRefuseReason
          ? `Opened Explorer · ${plan.assignment.alignmentRefuseReason}`
          : `Opened Explorer with ${applied.visibleLaneCount} customer-evidence lane${
              applied.visibleLaneCount === 1 ? "" : "s"
            }.`,
      );
    } catch (err) {
      setStatusMsg(
        err instanceof Error ? err.message : "Show in Explorer failed.",
      );
    } finally {
      setBusy(false);
    }
  };

  const beginInvestigation = async () => {
    setStatusMsg(null);
    setBusy(true);
    try {
      const resolvedSelected = await ensureResolved();
      const preview = previewInvestigationAdd(resolvedSelected, {
        availableCorpusIds,
      });
      setInvState(preview);
    } catch (err) {
      setStatusMsg(
        err instanceof Error
          ? err.message
          : "Could not resolve host evidence for investigation.",
      );
    } finally {
      setBusy(false);
    }
  };

  const doConfirmInvestigation = async () => {
    const confirmed = confirmInvestigationAdd(invState);
    setInvState(confirmed);
    if (confirmed.status !== "confirmed" || confirmed.failReason) {
      setStatusMsg(confirmed.failReason ?? "Confirm failed.");
      return;
    }
    if (!onAddToInvestigation) {
      setStatusMsg(
        "Investigation host write is not wired in this surface — preview only.",
      );
      return;
    }
    setBusy(true);
    try {
      await onAddToInvestigation(confirmed);
      setInvState(markInvestigationApplied(confirmed));
      setStatusMsg(
        confirmed.createsDraft
          ? "Draft investigation created with selected evidence."
          : "Evidence added to investigation.",
      );
    } catch (err) {
      setStatusMsg(
        err instanceof Error ? err.message : "Add to investigation failed.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={[
        "evidence-set",
        compact ? "evidence-set--compact" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-testid="evidence-set"
      data-open={open ? "true" : "false"}
      data-customer-evidence-lanes="true"
      data-activity-rail-separate="true"
    >
      <button
        ref={toggleRef}
        type="button"
        className="evidence-set__toggle"
        data-testid="evidence-set-toggle"
        aria-expanded={open}
        aria-controls={open ? titleId : undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onToggleKey}
      >
        <span className="evidence-set__label">{evidenceControlLabel(count)}</span>
        <span className="evidence-set__chev" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
      </button>

      {open ? (
        <div
          ref={panelRef}
          className="evidence-set__panel"
          data-testid="evidence-set-panel"
          role="region"
          aria-labelledby={titleId}
          id={titleId}
        >
          <div className="evidence-set__head">
            <p className="evidence-set__lead">
              Host-verified citations for this answer only. Single-click a row
              for fail-closed open; select log events for Explorer lanes or
              investigation.
            </p>
            <div className="evidence-set__select-actions">
              <button
                type="button"
                className="evidence-set__btn evidence-set__btn--ghost"
                data-testid="evidence-select-all-log"
                onClick={() => setSelectedKeys(selectAllLaneEligible(items))}
              >
                Select all log
              </button>
              <button
                type="button"
                className="evidence-set__btn evidence-set__btn--ghost"
                data-testid="evidence-select-none"
                onClick={() => setSelectedKeys(new Set())}
              >
                Clear
              </button>
            </div>
          </div>

          <ul className="evidence-set__list" role="listbox" aria-multiselectable>
            {items.map((item) => {
              const checked = selectedKeys.has(item.key);
              const isLog = item.laneEligible;
              return (
                <li
                  key={item.key}
                  className="evidence-set__item"
                  data-kind={item.kind}
                  data-lane-eligible={isLog ? "true" : "false"}
                  data-testid={`evidence-item-${item.id}`}
                >
                  {isLog ? (
                    <label className="evidence-set__check">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          setSelectedKeys((prev) =>
                            toggleEvidenceSelection(prev, item.key),
                          )
                        }
                        data-testid={`evidence-check-${item.key}`}
                      />
                      <span className="sr-only">Select {item.label}</span>
                    </label>
                  ) : (
                    <span
                      className="evidence-set__check evidence-set__check--na"
                      title="Not placed into log lanes"
                      aria-hidden
                    />
                  )}
                  <button
                    type="button"
                    className="evidence-set__open"
                    title={item.id}
                    onClick={() => {
                      if (item.laneEligible || item.kind === "log_template") {
                        onOpenCitation(item.id, item.corpusId);
                      } else if (onOpenWorkspace) {
                        onOpenWorkspace(item.id);
                      } else {
                        onOpenCitation(item.id, item.corpusId);
                      }
                    }}
                  >
                    <span className="evidence-set__title">
                      {item.title || item.label}
                    </span>
                    <span className="evidence-set__meta">
                      {item.kind}
                      {item.corpusId ? ` · corpus ${item.corpusId.slice(0, 8)}` : ""}
                      {item.source ? ` · ${item.source}` : ""}
                      {item.workspaceOnly ? " · source surface" : ""}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          <fieldset className="evidence-set__modes">
            <legend>Lane assignment</legend>
            <div className="evidence-set__mode-row">
              {MODES.map((m) => (
                <label key={m.id} className="evidence-set__mode">
                  <input
                    type="radio"
                    name="evidence-lane-mode"
                    value={m.id}
                    checked={mode === m.id}
                    onChange={() => setMode(m.id)}
                    data-testid={`evidence-mode-${m.id}`}
                  />
                  <span>{m.label}</span>
                </label>
              ))}
            </div>
            <p className="evidence-set__mode-hint">
              {MODES.find((m) => m.id === mode)?.hint}
            </p>
          </fieldset>

          {occupiedPreview ? (
            <div
              className="evidence-set__preview"
              data-testid="evidence-occupied-preview"
              role="dialog"
              aria-label="Occupied lane preview"
            >
              <strong>Occupied lanes would change</strong>
              <ul>
                {occupiedPreview.occupiedPreview.explanation.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <div className="evidence-set__actions">
                <button
                  type="button"
                  className="evidence-set__btn"
                  data-testid="evidence-occupied-confirm"
                  disabled={busy}
                  onClick={() => void runShowInExplorer(true)}
                >
                  Replace and open
                </button>
                <button
                  type="button"
                  className="evidence-set__btn evidence-set__btn--ghost"
                  data-testid="evidence-occupied-cancel"
                  disabled={busy}
                  onClick={() => {
                    setOccupiedPreview(null);
                    setStatusMsg("Lane change cancelled — existing layout kept.");
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}

          {invState.status === "preview" || invState.status === "confirmed" ? (
            <div
              className="evidence-set__preview"
              data-testid="evidence-investigation-preview"
              role="dialog"
              aria-label="Add to investigation preview"
            >
              {invState.failReason ? (
                <p className="evidence-set__error">{invState.failReason}</p>
              ) : (
                <>
                  <strong>
                    {invState.createsDraft
                      ? "Create draft investigation"
                      : "Add to existing investigation"}
                  </strong>
                  <p>
                    {invState.title} · {invState.eventRefs.length} event
                    {invState.eventRefs.length === 1 ? "" : "s"} · corpus{" "}
                    {invState.corpusId}
                  </p>
                  <ul className="evidence-set__ref-list">
                    {invState.eventRefs.map((ref) => (
                      <li key={ref.citationKey}>
                        {ref.citationId} · {ref.source} · seq {ref.seq} ·{" "}
                        {ref.timeQualityHint}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <div className="evidence-set__actions">
                {!invState.failReason && invState.status === "preview" ? (
                  <button
                    type="button"
                    className="evidence-set__btn"
                    data-testid="evidence-investigation-confirm"
                    disabled={busy}
                    onClick={() => void doConfirmInvestigation()}
                  >
                    Confirm add
                  </button>
                ) : null}
                {invState.status === "confirmed" ? (
                  <button
                    type="button"
                    className="evidence-set__btn evidence-set__btn--ghost"
                    data-testid="evidence-investigation-undo"
                    disabled={busy}
                    onClick={() => {
                      setInvState(undoInvestigationAdd(invState));
                      setStatusMsg("Investigation add undone before apply.");
                    }}
                  >
                    Undo
                  </button>
                ) : null}
                <button
                  type="button"
                  className="evidence-set__btn evidence-set__btn--ghost"
                  data-testid="evidence-investigation-cancel"
                  disabled={busy}
                  onClick={() => {
                    setInvState(cancelInvestigationAdd(invState));
                    setStatusMsg("Investigation add cancelled.");
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}

          <div
            className="evidence-set__actions"
            style={
              {
                ["--evidence-actions-wrap" as string]: compact
                  ? "wrap"
                  : "nowrap",
              } as CSSProperties
            }
          >
            <button
              type="button"
              className="evidence-set__btn"
              data-testid="evidence-show-in-explorer"
              disabled={busy || logSelected.length === 0}
              onClick={() => void runShowInExplorer(false)}
            >
              Show in Explorer
            </button>
            <button
              type="button"
              className="evidence-set__btn"
              data-testid="evidence-add-to-investigation"
              disabled={busy || logSelected.length === 0}
              onClick={() => void beginInvestigation()}
            >
              Add to investigation
            </button>
          </div>

          {statusMsg ? (
            <p
              className="evidence-set__status"
              data-testid="evidence-set-status"
              role="status"
            >
              {statusMsg}
            </p>
          ) : null}

          {/* Lane assignment explanation (deterministic, for demo honesty) */}
          {logSelected.length > 0 ? (
            <details className="evidence-set__explain">
              <summary>Assignment preview</summary>
              <ul>
                {assignEvidenceToLanes(logSelected, mode, []).explanation.map(
                  (line) => (
                    <li key={line}>{line}</li>
                  ),
                )}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
