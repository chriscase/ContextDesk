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
  applyLaneEdits,
  assignEvidenceToLanes,
  bindPreparedInvestigationTarget,
  buildEvidenceSetFromHostCitations,
  cancelInvestigationAdd,
  confirmInvestigationAdd,
  enrichWithHostEvents,
  evidenceControlLabel,
  finalizeShowAssignment,
  idleInvestigationAdd,
  laneEligibleItems,
  markInvestigationApplied,
  previewInvestigationAdd,
  selectAllLaneEligible,
  selectionFromKeys,
  toggleEvidenceSelection,
  undoInvestigationAdd,
  type EvidenceItem,
  type HostEvidenceCitation,
  type InvestigationAddState,
  type LaneAssignmentMode,
  type LaneEdit,
  type ShowInExplorerPlan,
  type TimeQualityHint,
} from "../lib/evidenceLaneBridge";
import type { LaneConfig } from "../lib/logExplorer/laneCompose";
import {
  evidenceLayoutFingerprint,
  loadLanes,
} from "../lib/logExplorer/laneCompose";
import { applyEvidenceLanesToExplorer } from "../lib/logExplorer/evidenceLaneApplyBridge";

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
  /** Host prepares one exact, one-shot payload + investigation target token. */
  onPrepareInvestigation?: (
    state: InvestigationAddState,
  ) => Promise<{
    commitToken: string;
    investigationId: string | null;
    expectedRevision: number | null;
    createsDraft: boolean;
  }>;
  /** Host consumes the prepared token exactly once after explicit confirm. */
  onCommitInvestigation?: (commitToken: string) => Promise<void> | void;
  /** Best-effort retirement when the user cancels before commit. */
  onCancelPreparedInvestigation?: (commitToken: string) => Promise<void> | void;
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
  onPrepareInvestigation,
  onCommitInvestigation,
  onCancelPreparedInvestigation,
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
  const [occupiedPreview, setOccupiedPreview] = useState<{
    plan: ShowInExplorerPlan;
    baseFingerprint: string;
  } | null>(null);
  const [invState, setInvState] = useState<InvestigationAddState>(() =>
    idleInvestigationAdd(),
  );
  const [busy, setBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  /**
   * Pin/remove/reorder as an edit log applied *after* assignment from current
   * (or host-resolved) items — never a full pre-resolve LaneConfig[] snapshot.
   */
  const [laneEdits, setLaneEdits] = useState<LaneEdit[]>([]);
  const panelRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const occupiedDialogRef = useRef<HTMLDivElement>(null);
  const investigationDialogRef = useRef<HTMLDivElement>(null);
  const showTriggerRef = useRef<HTMLButtonElement>(null);
  const investigationTriggerRef = useRef<HTMLButtonElement>(null);
  const showOperationRef = useRef(0);
  const investigationOperationRef = useRef(0);
  const investigationSubmittingRef = useRef(false);
  const preparedTokenRef = useRef<string | null>(null);
  const cancelPreparedRef = useRef(onCancelPreparedInvestigation);
  cancelPreparedRef.current = onCancelPreparedInvestigation;
  const titleId = useId();

  // Reset selection when the host citation set identity changes.
  const citationSig = useMemo(
    () => baseItems.map((i) => i.key).join("|"),
    [baseItems],
  );
  const baseItemsRef = useRef(baseItems);
  baseItemsRef.current = baseItems;
  const retirePreparedToken = useCallback(() => {
    const token = preparedTokenRef.current;
    preparedTokenRef.current = null;
    if (token) {
      void Promise.resolve(cancelPreparedRef.current?.(token)).catch(() => {
        // Bounded host token expires/evicts even if best-effort retirement fails.
      });
    }
  }, []);
  useEffect(() => {
    // Depend on semantic identity, not the parent's freshly mapped array.
    // Linked-chat composer rerenders must not erase an in-progress selection.
    setSelectedKeys(selectAllLaneEligible(baseItemsRef.current));
    setOccupiedPreview(null);
    setInvState(idleInvestigationAdd());
    setStatusMsg(null);
    setBusy(false);
    setResolvedOverlay([]);
    setLaneEdits([]);
    showOperationRef.current += 1;
    investigationOperationRef.current += 1;
    retirePreparedToken();
  }, [citationSig, retirePreparedToken]);

  useEffect(() => () => retirePreparedToken(), [retirePreparedToken]);

  const selected = useMemo(
    () => selectionFromKeys(items, selectedKeys),
    [items, selectedKeys],
  );
  const logSelected = useMemo(() => laneEligibleItems(selected), [selected]);

  // Clear edit log when mode or selection identity changes (not on enrich).
  const selectionEditKey = useMemo(
    () => `${mode}|${[...selectedKeys].sort().join(",")}`,
    [mode, selectedKeys],
  );
  useEffect(() => {
    setLaneEdits([]);
    setOccupiedPreview(null);
    showOperationRef.current += 1;
    investigationOperationRef.current += 1;
    retirePreparedToken();
    setInvState(idleInvestigationAdd());
  }, [selectionEditKey, retirePreparedToken]);

  /** Display draft: assign from current items, then apply edit log. */
  const displayLanes = useMemo((): LaneConfig[] => {
    if (logSelected.length === 0) return [];
    const existing =
      logSelected[0]?.corpusId != null
        ? loadLanes(logSelected[0].corpusId) ?? []
        : [];
    const base = assignEvidenceToLanes(logSelected, mode, existing);
    return applyLaneEdits(base.lanes, laneEdits);
  }, [logSelected, mode, laneEdits]);
  const displayVisibleCount = Math.max(1, Math.min(4, displayLanes.length || 1));

  const ensureResolved = useCallback(async (
    selectedSnapshot: EvidenceItem[],
  ): Promise<EvidenceItem[]> => {
    if (!resolveHostEvents) return selectedSnapshot;
    const need = selectedSnapshot.filter(
      (i) => !i.source || i.timestamp == null || !i.timeQuality,
    );
    if (need.length === 0) return selectedSnapshot;
    const resolved = await resolveHostEvents(need);
    setResolvedOverlay((prev) => {
      const map = new Map(
        [...prev, ...resolved].map(
          (e) => [`${e.corpusId}\u0000${e.seq}`, e] as const,
        ),
      );
      return [...map.values()];
    });
    const enriched = enrichWithHostEvents(selectedSnapshot, resolved);
    const unresolved = enriched.find(
      (item) => !item.source?.trim() || item.timestamp == null || !item.timeQuality,
    );
    if (unresolved) {
      throw new Error(
        `Host did not resolve exact source/time identity for ${unresolved.id}.`,
      );
    }
    return enriched;
  }, [resolveHostEvents]);

  const close = useCallback(() => {
    retirePreparedToken();
    setOpen(false);
    setOccupiedPreview(null);
    setInvState(idleInvestigationAdd());
    queueMicrotask(() => toggleRef.current?.focus());
  }, [retirePreparedToken]);

  useEffect(() => {
    const dialog = occupiedPreview
      ? occupiedDialogRef.current
      : invState.status === "preview" || invState.status === "confirmed"
        ? investigationDialogRef.current
        : null;
    if (!dialog) return;
    queueMicrotask(() => {
      const first = dialog.querySelector<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), [tabindex='0']",
      );
      (first ?? dialog).focus();
    });
  }, [occupiedPreview, invState.status]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (occupiedPreview) {
          setOccupiedPreview(null);
          queueMicrotask(() => showTriggerRef.current?.focus());
          return;
        }
        if (invState.status === "preview" || invState.status === "confirmed") {
          retirePreparedToken();
          setInvState(cancelInvestigationAdd(invState));
          queueMicrotask(() => investigationTriggerRef.current?.focus());
          return;
        }
        close();
        return;
      }
      if (e.key === "Tab") {
        const dialog = occupiedPreview
          ? occupiedDialogRef.current
          : invState.status === "preview" || invState.status === "confirmed"
            ? investigationDialogRef.current
            : null;
        if (!dialog) return;
        const focusable = [...dialog.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), [tabindex='0']",
        )];
        if (focusable.length === 0) {
          e.preventDefault();
          dialog.focus();
          return;
        }
        const first = focusable[0]!;
        const last = focusable.at(-1)!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, occupiedPreview, invState, close, retirePreparedToken]);

  if (count === 0) return null;

  const modalActive =
    occupiedPreview != null ||
    invState.status === "preview" ||
    invState.status === "confirmed";

  const onToggleKey = (e: ReactKeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (open) close();
      else setOpen(true);
    }
  };

  const commitShowPlan = async (pending: {
    plan: ShowInExplorerPlan;
    baseFingerprint: string;
  }) => {
    const { plan, baseFingerprint } = pending;
    if (!onShowInExplorer) {
      throw new Error("Explorer host open is not wired in this surface.");
    }
    if (evidenceLayoutFingerprint(plan.corpusId) !== baseFingerprint) {
      throw new Error(
        "Explorer layout changed after preview; review the current lanes and try again.",
      );
    }
    const applied = applyLaneAssignment(
      plan.occupiedPreview.current,
      plan.assignment,
      true,
    );
    if (!applied.applied) {
      throw new Error("Occupied-lane replacement was not confirmed.");
    }
    // Opening is read-only. Commit durable placement only after it succeeds.
    const first = plan.navTargets[0] ?? null;
    await onShowInExplorer({
      corpusId: plan.corpusId,
      lanes: applied.lanes,
      visibleLaneCount: applied.visibleLaneCount,
      linkMode: plan.assignment.linkMode,
      highlightSeqs: plan.highlightSeqs,
      navTarget: first,
    });
    const persisted = applyEvidenceLanesToExplorer(
      {
        corpusId: plan.corpusId,
        lanes: applied.lanes,
        visibleLaneCount: applied.visibleLaneCount,
        linkMode: plan.assignment.linkMode,
        highlightSeqs: plan.highlightSeqs,
      },
      baseFingerprint,
    );
    setOccupiedPreview(null);
    setStatusMsg(
      plan.assignment.alignmentRefuseReason
        ? `Opened Explorer · ${plan.assignment.alignmentRefuseReason}`
        : `Opened Explorer with ${persisted.visibleLaneCount} customer-evidence lane${
            persisted.visibleLaneCount === 1 ? "" : "s"
          }.`,
    );
  };

  const runShowInExplorer = async () => {
    setStatusMsg(null);
    setBusy(true);
    const operation = ++showOperationRef.current;
    const selectedSnapshot = logSelected.map((item) => ({ ...item }));
    const modeSnapshot = mode;
    const editSnapshot = [...laneEdits];
    const corpusId = selectedSnapshot[0]?.corpusId;
    const existing = corpusId ? loadLanes(corpusId) ?? [] : [];
    const baseFingerprint = corpusId
      ? evidenceLayoutFingerprint(corpusId)
      : "";
    try {
      // Host-resolve first, then finalize from *resolved* items only.
      const resolvedSelected = await ensureResolved(selectedSnapshot);
      if (operation !== showOperationRef.current) return;
      const plan = finalizeShowAssignment({
        resolved: resolvedSelected,
        mode: modeSnapshot,
        existing,
        laneEdits: editSnapshot,
        availableCorpusIds,
      });
      if ("error" in plan) {
        setStatusMsg(plan.error);
        return;
      }
      if (plan.assignment.overflowKeys.length > 0) {
        setStatusMsg(
          `Not opened: ${plan.assignment.overflowKeys.length} selected event${
            plan.assignment.overflowKeys.length === 1 ? "" : "s"
          } would be omitted by the four-lane limit. Choose “One lane” or select fewer sources. No lane was changed.`,
        );
        return;
      }
      const pending = { plan, baseFingerprint };
      if (plan.occupiedPreview.needsConfirm) {
        setOccupiedPreview(pending);
        return;
      }
      await commitShowPlan(pending);
    } catch (err) {
      setStatusMsg(
        err instanceof Error ? err.message : "Show in Explorer failed.",
      );
    } finally {
      if (operation === showOperationRef.current) setBusy(false);
    }
  };

  const confirmOccupiedShow = async () => {
    const pending = occupiedPreview;
    if (!pending) return;
    setBusy(true);
    try {
      await commitShowPlan(pending);
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : "Show in Explorer failed.");
    } finally {
      setBusy(false);
    }
  };

  const beginInvestigation = async () => {
    setStatusMsg(null);
    setBusy(true);
    retirePreparedToken();
    const operation = ++investigationOperationRef.current;
    const selectedSnapshot = logSelected.map((item) => ({ ...item }));
    try {
      const resolvedSelected = await ensureResolved(selectedSnapshot);
      if (operation !== investigationOperationRef.current) return;
      let preview = previewInvestigationAdd(resolvedSelected, {
        availableCorpusIds,
      });
      if (preview.failReason) {
        setInvState(preview);
        return;
      }
      if (!onPrepareInvestigation) {
        setStatusMsg(
          "Investigation host preparation is not wired in this surface.",
        );
        return;
      }
      const prepared = await onPrepareInvestigation(preview);
      if (operation !== investigationOperationRef.current) {
        void Promise.resolve(
          onCancelPreparedInvestigation?.(prepared.commitToken),
        ).catch(() => {});
        return;
      }
      preview = bindPreparedInvestigationTarget(preview, prepared);
      if (preview.failReason) {
        void Promise.resolve(
          onCancelPreparedInvestigation?.(prepared.commitToken),
        ).catch(() => {});
      }
      preparedTokenRef.current = preview.failReason
        ? null
        : preview.commitToken;
      setInvState(preview);
    } catch (err) {
      setStatusMsg(
        err instanceof Error
          ? err.message
          : "Could not resolve host evidence for investigation.",
      );
    } finally {
      if (operation === investigationOperationRef.current) setBusy(false);
    }
  };

  /** Confirm only — host write is a separate explicit step so Undo is reachable. */
  const doConfirmInvestigation = () => {
    const confirmed = confirmInvestigationAdd(invState);
    setInvState(confirmed);
    if (confirmed.status !== "confirmed" || confirmed.failReason) {
      setStatusMsg(confirmed.failReason ?? "Confirm failed.");
      return;
    }
    setStatusMsg(
      "Confirmed — review, Undo, or Write to investigation (host write only after Write).",
    );
  };

  const doApplyInvestigation = async () => {
    if (invState.status !== "confirmed" || invState.failReason) {
      setStatusMsg("Confirm the investigation preview before writing.");
      return;
    }
    if (!onCommitInvestigation || !invState.commitToken) {
      setStatusMsg(
        "Investigation host commit is not wired in this surface — preview only.",
      );
      return;
    }
    if (investigationSubmittingRef.current) return;
    investigationSubmittingRef.current = true;
    setBusy(true);
    try {
      await onCommitInvestigation(invState.commitToken);
      preparedTokenRef.current = null;
      setInvState(markInvestigationApplied(invState));
      setStatusMsg(
        invState.createsDraft
          ? "Draft investigation created with selected evidence."
          : "Evidence added to investigation.",
      );
    } catch (err) {
      preparedTokenRef.current = null;
      setInvState(idleInvestigationAdd());
      setStatusMsg(
        `${err instanceof Error ? err.message : "Add to investigation failed."} Review and prepare the evidence again before retrying.`,
      );
    } finally {
      investigationSubmittingRef.current = false;
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
        disabled={modalActive}
        aria-controls={open ? titleId : undefined}
        onClick={() => (open ? close() : setOpen(true))}
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
                disabled={busy || modalActive}
                onClick={() => setSelectedKeys(selectAllLaneEligible(items))}
              >
                Select all log
              </button>
              <button
                type="button"
                className="evidence-set__btn evidence-set__btn--ghost"
                data-testid="evidence-select-none"
                disabled={busy || modalActive}
                onClick={() => setSelectedKeys(new Set())}
              >
                Clear
              </button>
            </div>
          </div>

          <ul className="evidence-set__list" aria-label="Evidence citations">
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
                        disabled={busy || modalActive}
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
                    disabled={busy || modalActive}
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
                    disabled={busy || modalActive}
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

          {displayLanes.length > 0 ? (
            <div
              className="evidence-set__lane-editor"
              data-testid="evidence-lane-editor"
            >
              <div className="evidence-set__lane-editor-head">
                Proposed customer-evidence lanes ({displayVisibleCount} visible)
                {logSelected.some((i) => !i.source) ? (
                  <span className="evidence-set__mode-hint">
                    {" "}
                    · sources fill after host resolve on Show in Explorer
                  </span>
                ) : null}
              </div>
              <ol className="evidence-set__lane-list">
                {displayLanes.map((lane, index) => (
                  <li
                    key={lane.id}
                    className="evidence-set__lane-row"
                    data-testid={`evidence-lane-row-${lane.id}`}
                  >
                    <span className="evidence-set__lane-label">
                      {lane.label}
                      {lane.sources.length > 0
                        ? ` · ${lane.sources.join(", ")}`
                        : " · open membership"}
                    </span>
                    <span className="evidence-set__lane-tools">
                      <button
                        type="button"
                        className="evidence-set__btn evidence-set__btn--ghost"
                        data-testid={`evidence-lane-pin-${lane.id}`}
                        title="Pin to first lane"
                        disabled={busy || modalActive || index === 0}
                        onClick={() =>
                          setLaneEdits((prev) => [
                            ...prev,
                            { type: "pin", laneId: lane.id },
                          ])
                        }
                      >
                        Pin
                      </button>
                      <button
                        type="button"
                        className="evidence-set__btn evidence-set__btn--ghost"
                        data-testid={`evidence-lane-up-${lane.id}`}
                        title="Move up"
                        disabled={busy || modalActive || index === 0}
                        onClick={() =>
                          setLaneEdits((prev) => [
                            ...prev,
                            {
                              type: "reorder",
                              fromIndex: index,
                              toIndex: index - 1,
                            },
                          ])
                        }
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="evidence-set__btn evidence-set__btn--ghost"
                        data-testid={`evidence-lane-down-${lane.id}`}
                        title="Move down"
                        disabled={busy || modalActive || index >= displayLanes.length - 1}
                        onClick={() =>
                          setLaneEdits((prev) => [
                            ...prev,
                            {
                              type: "reorder",
                              fromIndex: index,
                              toIndex: index + 1,
                            },
                          ])
                        }
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className="evidence-set__btn evidence-set__btn--ghost"
                        data-testid={`evidence-lane-remove-${lane.id}`}
                        title="Remove lane"
                        disabled={busy || modalActive || displayLanes.length <= 1}
                        onClick={() =>
                          setLaneEdits((prev) => [
                            ...prev,
                            { type: "remove", laneId: lane.id },
                          ])
                        }
                      >
                        Remove
                      </button>
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}

          {occupiedPreview ? (
            <div
              ref={occupiedDialogRef}
              className="evidence-set__preview"
              data-testid="evidence-occupied-preview"
              role="dialog"
              aria-modal="true"
              aria-label="Occupied lane preview"
              tabIndex={-1}
            >
              <strong>Occupied lanes would change</strong>
              <ul>
                {occupiedPreview.plan.occupiedPreview.explanation.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <div className="evidence-set__actions">
                <button
                  type="button"
                  className="evidence-set__btn"
                  data-testid="evidence-occupied-confirm"
                  disabled={busy}
                  onClick={() => void confirmOccupiedShow()}
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
                    queueMicrotask(() => showTriggerRef.current?.focus());
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}

          {invState.status === "preview" || invState.status === "confirmed" ? (
            <div
              ref={investigationDialogRef}
              className="evidence-set__preview"
              data-testid="evidence-investigation-preview"
              role="dialog"
              aria-modal="true"
              aria-label="Add to investigation preview"
              tabIndex={-1}
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
                    {invState.createsDraft
                      ? " · exact new draft target"
                      : ` · investigation ${invState.investigationId} at revision ${invState.expectedRevision}`}
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
                    onClick={doConfirmInvestigation}
                  >
                    Confirm add
                  </button>
                ) : null}
                {invState.status === "confirmed" ? (
                  <>
                    <button
                      type="button"
                      className="evidence-set__btn"
                      data-testid="evidence-investigation-write"
                      disabled={busy}
                      onClick={() => void doApplyInvestigation()}
                    >
                      Write to investigation
                    </button>
                    <button
                      type="button"
                      className="evidence-set__btn evidence-set__btn--ghost"
                      data-testid="evidence-investigation-undo"
                      disabled={busy}
                      onClick={() => {
                        retirePreparedToken();
                        setInvState(undoInvestigationAdd(invState));
                        setStatusMsg(
                          "Investigation add undone before host write.",
                        );
                      }}
                    >
                      Undo
                    </button>
                  </>
                ) : null}
                <button
                  type="button"
                  className="evidence-set__btn evidence-set__btn--ghost"
                  data-testid="evidence-investigation-cancel"
                  disabled={busy}
                  onClick={() => {
                    retirePreparedToken();
                    setInvState(cancelInvestigationAdd(invState));
                    setStatusMsg("Investigation add cancelled.");
                    queueMicrotask(() => investigationTriggerRef.current?.focus());
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
              ref={showTriggerRef}
              type="button"
              className="evidence-set__btn"
              data-testid="evidence-show-in-explorer"
              disabled={busy || modalActive || logSelected.length === 0}
              onClick={() => void runShowInExplorer()}
            >
              Show in Explorer
            </button>
            <button
              ref={investigationTriggerRef}
              type="button"
              className="evidence-set__btn"
              data-testid="evidence-add-to-investigation"
              disabled={busy || modalActive || logSelected.length === 0}
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
