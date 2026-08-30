import { useEffect, useMemo, useRef, useState } from "react";
import {
  selectEvidenceInventory,
  selectResourceView,
  useInvestigationRuntime,
  type CaseV1,
  type ResourceState,
} from "../../runtime/public.js";
import type { InvestigationStrategyShellProps } from "../contract.js";
import {
  StrategyActionRow,
  StrategyBadge,
  StrategyHero,
  StrategyPanel,
  StrategyStateNotice,
  StrategySurface,
} from "../shared/index.js";
import { KeystoneEvidenceGrid } from "./KeystoneEvidenceGrid.js";
import { KeystoneInspector } from "./KeystoneInspector.js";
import {
  filterEvidence,
  filterInvestigations,
  evidenceName,
  investigationTitle,
  reconcileWorkingSet,
  recordedText,
  type KeystoneInspectorTab,
  type KeystoneStatusFilter,
} from "./model.js";

type RuntimeFailure = Extract<ResourceState<never>, { status: "failed" }>["error"];

function readFailure(error: RuntimeFailure, subject: "collection" | "record" | "evidence" | "contributions"): string {
  if (error.kind === "auth_lost") return "Your access changed while this view was open. Sign in again to continue.";
  if (error.kind === "not_found") return subject === "record"
    ? "This investigation could not be found in the available scope."
    : "The requested investigation data is no longer available.";
  if (error.kind === "conflict") return "The investigation changed before the read completed. Refresh the recorded data.";
  const labels = {
    collection: "The investigation collection",
    record: "This investigation",
    evidence: "The evidence inventory",
    contributions: "Recorded contributions",
  } as const;
  return `${labels[subject]} could not be loaded right now.`;
}

function statusTone(status: CaseV1["status"]): "neutral" | "accent" | "success" {
  if (status === "resolved") return "success";
  if (status === "open") return "accent";
  return "neutral";
}

interface ScopedIds {
  readonly scope: string;
  readonly ids: readonly string[];
}

interface ScopedEvidenceSelection {
  readonly scope: string;
  readonly evidenceId: string | null;
}

function tabForStage(stage: InvestigationStrategyShellProps["stage"]): KeystoneInspectorTab {
  return stage === "analyze" ? "reasoning" : stage === "situation" ? "record" : "details";
}

/**
 * Keystone K1 is an evidence-dense, read-only engineer view. It consumes only
 * Runtime V1 reads and shell callbacks. `startSignal` is intentionally inert:
 * this strategy neither creates a record nor guesses which local inspector a
 * shell-level create request meant to activate.
 */
export function KeystoneStrategy(props: InvestigationStrategyShellProps) {
  const runtime = useInvestigationRuntime();
  const investigations = selectResourceView(runtime.resources.investigations);
  const investigation = selectResourceView(runtime.resources.investigation);
  const evidenceInventory = useMemo(
    () => selectEvidenceInventory(
      runtime.resources.evidence,
      runtime.resources.contributions,
    ),
    [runtime.resources.contributions, runtime.resources.evidence],
  );
  const contributions = selectResourceView(runtime.resources.contributions);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<KeystoneStatusFilter>("all");
  const [evidenceQuery, setEvidenceQuery] = useState("");
  const [inspectorTab, setInspectorTab] = useState<KeystoneInspectorTab>(() => tabForStage(props.stage));
  const [workingSetState, setWorkingSetState] = useState<ScopedIds>({ scope: "", ids: [] });
  const [selectionState, setSelectionState] = useState<ScopedEvidenceSelection>({
    scope: "",
    evidenceId: null,
  });
  const browseHeadingRef = useRef<HTMLHeadingElement>(null);
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  const priorFocusId = useRef<string | null>(props.focusCaseId);
  const focusedArrival = useRef<string | null>(null);
  const cases = investigations.availability === "available" ? investigations.value : [];
  const filteredCases = useMemo(
    () => filterInvestigations(cases, query, status),
    [cases, query, status],
  );
  const scope = `${runtime.identity.id}\u0000${runtime.identity.username}\u0000${props.focusCaseId ?? ""}`;
  const evidenceRows = evidenceInventory.inventory.availability === "available"
    ? evidenceInventory.inventory.value
    : [];
  const evidenceIdsKey = evidenceRows.map(({ evidence }) => evidence.id).join("\u0000");
  const workingSet = workingSetState.scope === scope ? workingSetState.ids : [];
  const selectedEvidenceId = selectionState.scope === scope ? selectionState.evidenceId : null;
  const filteredEvidence = useMemo(
    () => filterEvidence(evidenceRows, evidenceQuery),
    [evidenceQuery, evidenceRows],
  );
  const selectedEvidence = evidenceRows.find(({ evidence }) => evidence.id === selectedEvidenceId) ?? null;
  const focusedTitle = props.focusCaseId !== null
    && investigation.availability === "available"
    && investigation.value.id === props.focusCaseId
      ? investigationTitle(investigation.value)
      : null;
  const detailArrival = props.focusCaseId === null
    ? null
    : !runtime.capabilities.canRead
      ? `denied:${props.focusCaseId}`
      : investigation.availability === "unavailable"
        ? `unavailable:${props.focusCaseId}`
        : investigation.availability === "available"
          && investigation.value.id === props.focusCaseId
          ? `available:${props.focusCaseId}`
          : null;

  useEffect(() => {
    setWorkingSetState((current) => current.scope === scope
      ? { scope, ids: reconcileWorkingSet(current.ids, evidenceRows) }
      : { scope, ids: [] });
    setSelectionState((current) => current.scope === scope
      ? {
          scope,
          evidenceId: evidenceRows.some(({ evidence }) => evidence.id === current.evidenceId)
            ? current.evidenceId
            : null,
        }
      : { scope, evidenceId: null });
  }, [evidenceIdsKey, scope]);

  useEffect(() => {
    setEvidenceQuery("");
    setInspectorTab(tabForStage(props.stage));
  }, [scope, props.stage]);

  useEffect(() => {
    const previous = priorFocusId.current;
    priorFocusId.current = props.focusCaseId;
    if (previous !== null && props.focusCaseId === null) browseHeadingRef.current?.focus();
  }, [props.focusCaseId]);

  useEffect(() => {
    props.onFocusedCaseTitle?.(focusedTitle);
  }, [focusedTitle, props.onFocusedCaseTitle]);

  useEffect(() => {
    if (detailArrival === null) {
      focusedArrival.current = null;
      return;
    }
    if (focusedArrival.current === detailArrival) return;
    focusedArrival.current = detailArrival;
    detailHeadingRef.current?.focus();
  }, [detailArrival]);

  function changeWorkingSet(evidenceId: string, selected: boolean) {
    setWorkingSetState((current) => {
      const ids = current.scope === scope ? current.ids : [];
      return {
        scope,
        ids: selected
          ? [...new Set([...ids, evidenceId])]
          : ids.filter((id) => id !== evidenceId),
      };
    });
  }

  function inspectEvidence(evidenceId: string) {
    setSelectionState({ scope, evidenceId });
    setInspectorTab("details");
  }

  function changeInspectorTab(tab: KeystoneInspectorTab) {
    setInspectorTab(tab);
    if (props.focusCaseId === null) return;
    props.onNavigateInvestigation({
      investigationId: props.focusCaseId,
      stage: tab === "reasoning" ? "analyze" : tab === "record" ? "situation" : "capture",
    });
  }

  function renderCollection() {
    const denied = !runtime.capabilities.canRead;
    const initialLoading = !denied
      && (investigations.availability === "idle" || investigations.availability === "loading");
    const refreshLoading = investigations.availability === "available"
      && investigations.refresh === "loading";
    return (
      <StrategySurface className="keystone-strategy" labelledBy="keystone-collection-title">
        <StrategyHero
          eyebrow="Keystone · Engineer workbench"
          title="Investigations"
          titleId="keystone-collection-title"
          headingRef={browseHeadingRef}
          headingTabIndex={-1}
          description={<p>Scan the recorded collection in server-provided order, then inspect evidence without changing the shared record.</p>}
          actions={<StrategyBadge tone="accent">Read-only K1</StrategyBadge>}
        />
        <StrategyPanel
          title="Recorded collection"
          titleId="keystone-collection-panel-title"
          description={<p>Search and status filters narrow this view only. They do not assign priority or reorder investigations.</p>}
          actions={investigations.availability === "available"
            ? <StrategyBadge>{filteredCases.length} shown · {cases.length} total</StrategyBadge>
            : null}
          busy={initialLoading || refreshLoading}
        >
          <div className="keystone-strategy__filters">
            <label>
              <span>Search investigations</span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Title, ID, product, build, or recorded context"
              />
            </label>
            <label>
              <span>Status</span>
              <select
                value={status}
                onChange={(event) => setStatus(event.target.value as KeystoneStatusFilter)}
              >
                <option value="all">All recorded statuses</option>
                <option value="open">Open</option>
                <option value="monitoring">Monitoring</option>
                <option value="resolved">Resolved</option>
                <option value="archived">Archived</option>
              </select>
            </label>
          </div>
          {denied ? (
            <StrategyStateNotice title="Investigation reading unavailable">
              Your current access does not include reading investigations. No investigation data was requested.
            </StrategyStateNotice>
          ) : null}
          {initialLoading ? <StrategyStateNotice busy>Loading investigations…</StrategyStateNotice> : null}
          {investigations.availability === "unavailable" ? (
            <StrategyStateNotice
              role="alert"
              tone="danger"
              title="Investigation collection unavailable"
              action={<button type="button" onClick={runtime.refresh.investigations}>Retry loading investigations</button>}
            >
              {readFailure(investigations.error, "collection")}
            </StrategyStateNotice>
          ) : null}
          {investigations.availability === "available" && investigations.refresh === "loading" ? (
            <StrategyStateNotice busy title="Refreshing collection">
              The last available collection remains usable while a newer read is in progress.
            </StrategyStateNotice>
          ) : null}
          {investigations.availability === "available" && investigations.refresh === "failed" ? (
            <StrategyStateNotice
              role="alert"
              tone="warning"
              title="Collection refresh incomplete"
              action={<button type="button" onClick={runtime.refresh.investigations}>Retry loading investigations</button>}
            >
              {readFailure(investigations.refreshError, "collection")} The last available collection remains visible.
            </StrategyStateNotice>
          ) : null}
          {investigations.availability === "available" && filteredCases.length === 0 ? (
            <StrategyStateNotice title={cases.length === 0 ? "No investigations recorded" : "No matching investigations"}>
              {cases.length === 0
                ? "The available collection is empty."
                : "Try a different search or recorded status."}
            </StrategyStateNotice>
          ) : null}
          {investigations.availability === "available" && filteredCases.length > 0 ? (
            <ol className="keystone-strategy__collection-list">
              {filteredCases.map((row) => (
                <li key={row.id}>
                  <button type="button" onClick={() => props.onOpenCase(row.id)}>
                    <span className="keystone-strategy__collection-title">{investigationTitle(row)}</span>
                    <span className="keystone-strategy__collection-id">{row.id}</span>
                    <span className="keystone-strategy__collection-meta">
                      <StrategyBadge tone={statusTone(row.status)}>{row.status}</StrategyBadge>
                      <StrategyBadge>{row.severity}</StrategyBadge>
                      {row.investigationContext?.productName
                        ? <span>{row.investigationContext.productName}{row.investigationContext.build ? ` · ${row.investigationContext.build}` : ""}</span>
                        : <span>Product not recorded</span>}
                    </span>
                    <span className="keystone-strategy__collection-summary">
                      {recordedText(row.problemStatement)}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          ) : null}
        </StrategyPanel>
      </StrategySurface>
    );
  }

  function renderEvidence(investigationValue: CaseV1) {
    const inventory = evidenceInventory.inventory;
    const annotations = evidenceInventory.annotations;
    const annotationState = annotations.availability === "available"
      ? "available"
      : annotations.availability === "unavailable"
        ? "unavailable"
        : "loading";
    return (
      <StrategyPanel
        title="Evidence grid"
        titleId="keystone-evidence-title"
        description={<p>Inventory order and metadata come from the shared record. Checkboxes affect only this in-memory working set.</p>}
        actions={inventory.availability === "available"
          ? <StrategyBadge>{inventory.value.length} recorded</StrategyBadge>
          : null}
        busy={inventory.availability === "idle" || inventory.availability === "loading" || (inventory.availability === "available" && inventory.refresh === "loading")}
      >
        {inventory.availability === "idle" || inventory.availability === "loading"
          ? <StrategyStateNotice busy>Loading evidence inventory…</StrategyStateNotice>
          : null}
        {inventory.availability === "unavailable" ? (
          <StrategyStateNotice
            tone="danger"
            role="alert"
            title="Evidence inventory unavailable"
            action={<button type="button" onClick={runtime.refresh.evidence}>Retry evidence inventory</button>}
          >
            {readFailure(inventory.error, "evidence")}
          </StrategyStateNotice>
        ) : null}
        {inventory.availability === "available" && inventory.refresh === "loading" ? (
          <StrategyStateNotice busy title="Refreshing evidence">
            The last available inventory remains usable during refresh.
          </StrategyStateNotice>
        ) : null}
        {inventory.availability === "available" && inventory.refresh === "failed" ? (
          <StrategyStateNotice
            tone="warning"
            role="alert"
            title="Evidence refresh incomplete"
            action={<button type="button" onClick={runtime.refresh.evidence}>Retry evidence inventory</button>}
          >
            {readFailure(inventory.refreshError, "evidence")} The last available inventory remains visible.
          </StrategyStateNotice>
        ) : null}
        {annotations.availability === "idle" || annotations.availability === "loading" ? (
          <StrategyStateNotice busy>Loading linked annotations… Evidence remains available.</StrategyStateNotice>
        ) : null}
        {annotations.availability === "unavailable" ? (
          <StrategyStateNotice
            tone="warning"
            role="alert"
            title="Linked annotations unavailable"
            action={<button type="button" onClick={runtime.refresh.contributions}>Retry recorded contributions</button>}
          >
            {readFailure(annotations.error, "contributions")} The evidence inventory remains usable.
          </StrategyStateNotice>
        ) : null}
        {annotations.availability === "available" && annotations.refresh === "loading" ? (
          <StrategyStateNotice busy title="Refreshing annotations">
            Existing annotation links remain visible during refresh.
          </StrategyStateNotice>
        ) : null}
        {annotations.availability === "available" && annotations.refresh === "failed" ? (
          <StrategyStateNotice
            tone="warning"
            role="alert"
            title="Annotation refresh incomplete"
            action={<button type="button" onClick={runtime.refresh.contributions}>Retry recorded contributions</button>}
          >
            {readFailure(annotations.refreshError, "contributions")} Existing annotation links remain visible.
          </StrategyStateNotice>
        ) : null}
        {inventory.availability === "available" && inventory.value.length === 0 ? (
          <StrategyStateNotice title="No evidence recorded">
            This investigation has no evidence in the available inventory.
          </StrategyStateNotice>
        ) : null}
        {inventory.availability === "available" && inventory.value.length > 0 ? (
          <>
            <label className="keystone-strategy__evidence-search">
              <span>Search evidence</span>
              <input
                type="search"
                value={evidenceQuery}
                onChange={(event) => setEvidenceQuery(event.target.value)}
                placeholder="Name, kind, source, verification, or annotation"
              />
            </label>
            <KeystoneEvidenceGrid
              rows={filteredEvidence}
              selectedEvidenceId={selectedEvidenceId}
              workingSet={workingSet}
              annotationState={annotationState}
              onInspect={inspectEvidence}
              onWorkingSetChange={changeWorkingSet}
            />
          </>
        ) : null}
        <div className="keystone-strategy__working-set" aria-labelledby="keystone-working-set-title">
          <div>
            <h4 id="keystone-working-set-title">Working set</h4>
            <p>Temporary for this signed-in identity and investigation. Nothing is saved or sent.</p>
          </div>
          {workingSet.length === 0 ? <span>No evidence selected</span> : (
            <>
              <ul>
                {workingSet.map((id) => {
                  const row = evidenceRows.find(({ evidence }) => evidence.id === id);
                  if (!row) return null;
                  return (
                    <li key={id}>
                      <span>{evidenceName(row.evidence)}</span>
                      <button
                        type="button"
                        aria-label={`Remove ${evidenceName(row.evidence)} from working set`}
                        onClick={() => changeWorkingSet(id, false)}
                      >Remove</button>
                    </li>
                  );
                })}
              </ul>
              <button type="button" onClick={() => setWorkingSetState({ scope, ids: [] })}>Clear working set</button>
            </>
          )}
        </div>
        <div className="keystone-strategy__workbench-grid">
          <div className="keystone-strategy__workbench-context">
            <h4>Selected investigation</h4>
            <p>{investigationTitle(investigationValue)}</p>
            <span>{investigationValue.id}</span>
          </div>
          <KeystoneInspector
            investigation={investigationValue}
            selectedEvidence={selectedEvidence}
            contributions={contributions.availability === "available" ? contributions.value : []}
            contributionsState={contributions.availability === "available"
              ? "available"
              : contributions.availability === "unavailable"
                ? "unavailable"
                : "loading"}
            tab={inspectorTab}
            onTabChange={changeInspectorTab}
          />
        </div>
      </StrategyPanel>
    );
  }

  function renderDetail() {
    if (!runtime.capabilities.canRead) {
      return (
        <StrategySurface className="keystone-strategy" labelledBy="keystone-detail-denied-title">
          <StrategyHero
            eyebrow="Keystone · Engineer workbench"
            title="Investigation reading unavailable"
            titleId="keystone-detail-denied-title"
            headingRef={detailHeadingRef}
            headingTabIndex={-1}
            description={<p>Your current access does not include reading investigations. No investigation data was requested.</p>}
            actions={<button type="button" onClick={props.onExitFocus}>Back to investigations</button>}
          />
        </StrategySurface>
      );
    }
    if (investigation.availability === "idle" || investigation.availability === "loading") {
      return (
        <StrategySurface className="keystone-strategy">
          <StrategyStateNotice busy>Opening investigation…</StrategyStateNotice>
        </StrategySurface>
      );
    }
    if (investigation.availability === "unavailable") {
      return (
        <StrategySurface className="keystone-strategy" labelledBy="keystone-detail-unavailable-title">
          <StrategyHero
            eyebrow="Keystone · Engineer workbench"
            title="Investigation unavailable"
            titleId="keystone-detail-unavailable-title"
            headingRef={detailHeadingRef}
            headingTabIndex={-1}
            actions={<button type="button" onClick={props.onExitFocus}>Back to investigations</button>}
          />
          <StrategyStateNotice
            tone="danger"
            role="alert"
            action={<button type="button" onClick={runtime.refresh.investigation}>Retry opening investigation</button>}
          >
            {readFailure(investigation.error, "record")}
          </StrategyStateNotice>
        </StrategySurface>
      );
    }
    const row = investigation.value;
    return (
      <StrategySurface className="keystone-strategy" labelledBy="keystone-detail-title">
        <StrategyHero
          eyebrow="Keystone · Engineer workbench"
          title={investigationTitle(row)}
          titleId="keystone-detail-title"
          headingRef={detailHeadingRef}
          headingTabIndex={-1}
          description={<p className="keystone-strategy__hero-id">{row.id}</p>}
          actions={(
            <StrategyActionRow>
              <StrategyBadge tone={statusTone(row.status)}>{row.status}</StrategyBadge>
              <StrategyBadge>{row.severity}</StrategyBadge>
              <button type="button" onClick={props.onExitFocus}>Back to investigations</button>
            </StrategyActionRow>
          )}
        />
        {investigation.refresh === "loading" ? (
          <StrategyStateNotice busy title="Refreshing investigation">
            The last available record remains visible during refresh.
          </StrategyStateNotice>
        ) : null}
        {investigation.refresh === "failed" ? (
          <StrategyStateNotice
            tone="warning"
            role="alert"
            title="Investigation refresh incomplete"
            action={<button type="button" onClick={runtime.refresh.investigation}>Retry opening investigation</button>}
          >
            {readFailure(investigation.refreshError, "record")} The last available record remains visible.
          </StrategyStateNotice>
        ) : null}
        {renderEvidence(row)}
      </StrategySurface>
    );
  }

  return props.focusCaseId === null ? renderCollection() : renderDetail();
}
