import { useCallback, useEffect, useMemo, useState } from "react";
import {
  hostApproveMemoryCandidate,
  hostBatchApproveMemoryCandidates,
  hostDiscardMemoryCandidate,
  hostEditMemoryCandidate,
  hostListMemoryCandidates,
  hostPurgeMemoryGdpr,
  type MemoryCandidateDto,
} from "../../lib/host";

export type MemoryDoc = {
  path: string;
  title: string;
  body: string;
  /** Durable store id when reading from MemoryStore (Phase 1). */
  id?: string;
  /** Kind taxonomy string (fact, decision, …). */
  kind?: string;
  /** personal | workspace */
  scope?: string;
  /** status: active | superseded | retracted | … */
  status?: string;
  /** Accept preview: redaction classes applied before persist. */
  redactionPreview?: string[];
};

type Props = {
  docs: MemoryDoc[];
  activePath: string | null;
  onSelect: (path: string) => void;
  onSave: (path: string, body: string) => void;
  /** Optional: start a new note from empty state. */
  onCreateHint?: () => void;
  /** Request include_superseded listing from host (durable store). */
  onFilterChange?: (opts: {
    kind: string | null;
    includeSuperseded: boolean;
  }) => void;
  /** Open selected memory in Composition pane (#293). */
  onCompose?: (doc: MemoryDoc) => void;
};

const KIND_OPTIONS = [
  { value: "", label: "All kinds" },
  { value: "fact", label: "Fact" },
  { value: "decision", label: "Decision" },
  { value: "bookmark", label: "Bookmark" },
  { value: "preference", label: "Preference" },
  { value: "project_note", label: "Project note" },
  { value: "contact", label: "Contact" },
  { value: "term", label: "Term" },
  { value: "task", label: "Task" },
];

function kindLabel(kind: string): string {
  return KIND_OPTIONS.find((o) => o.value === kind)?.label ?? kind;
}

function snippet(body: string, max = 90): string {
  const t = body.replace(/\s+/g, " ").trim();
  if (!t) return "Empty body";
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export function MemoryPane({
  docs,
  activePath,
  onSelect,
  onSave,
  onCreateHint,
  onFilterChange,
  onCompose,
}: Props) {
  const [view, setView] = useState<"store" | "inbox">("store");
  const [kindFilter, setKindFilter] = useState("");
  const [includeSuperseded, setIncludeSuperseded] = useState(false);
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<MemoryCandidateDto[]>([]);
  const [candBusy, setCandBusy] = useState(false);
  const [candError, setCandError] = useState<string | null>(null);
  const [activeCandId, setActiveCandId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  const [batchConfirm, setBatchConfirm] = useState("");
  const [purgeConfirm, setPurgeConfirm] = useState("");
  const [purgeOpen, setPurgeOpen] = useState(false);

  const refreshCandidates = useCallback(async () => {
    setCandError(null);
    try {
      const list = await hostListMemoryCandidates({ limit: 100 });
      setCandidates(list);
      if (list.length && !activeCandId) {
        setActiveCandId(list[0].id);
        setEditBody(list[0].content);
      }
    } catch (e) {
      setCandError(e instanceof Error ? e.message : String(e));
      setCandidates([]);
    }
  }, [activeCandId]);

  useEffect(() => {
    if (view === "inbox") {
      void refreshCandidates();
    }
  }, [view, refreshCandidates]);

  const filtered = useMemo(() => {
    let list = docs;
    if (kindFilter) {
      list = list.filter((d) => (d.kind ?? "") === kindFilter);
    }
    if (!includeSuperseded) {
      list = list.filter(
        (d) => !d.status || d.status === "active" || d.status === undefined,
      );
    }
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (d) =>
          d.title.toLowerCase().includes(q) ||
          d.body.toLowerCase().includes(q) ||
          (d.kind ?? "").includes(q),
      );
    }
    return list;
  }, [docs, kindFilter, includeSuperseded, query]);

  const active =
    filtered.find((d) => d.path === activePath) ??
    docs.find((d) => d.path === activePath) ??
    filtered[0] ??
    null;
  const [draft, setDraft] = useState(active?.body ?? "");
  const [dirty, setDirty] = useState(false);
  const [syncedPath, setSyncedPath] = useState<string | null>(
    active?.path ?? null,
  );

  const isDurable = Boolean(active?.id || active?.path.startsWith("memory:"));
  const hasFilters = Boolean(kindFilter || query.trim() || includeSuperseded);

  // Re-sync draft when active doc path/body changes externally, unless dirty (#157).
  useEffect(() => {
    if (!active) {
      if (!dirty) {
        setDraft("");
        setSyncedPath(null);
      }
      return;
    }
    const pathChanged = active.path !== syncedPath;
    if (pathChanged) {
      setDraft(active.body);
      setDirty(false);
      setSyncedPath(active.path);
      return;
    }
    if (!dirty && draft !== active.body) {
      setDraft(active.body);
    }
  }, [active?.path, active?.body, active, dirty, draft, syncedPath]);

  useEffect(() => {
    onFilterChange?.({
      kind: kindFilter || null,
      includeSuperseded,
    });
  }, [kindFilter, includeSuperseded, onFilterChange]);

  const canSave = Boolean(active) && dirty && !isDurable;

  const handleSave = () => {
    if (!active || isDurable) return;
    if (!dirty && !draft.trim() && active.body.trim()) {
      return;
    }
    if (!dirty) return;
    onSave(active.path, draft);
    setDirty(false);
  };

  const activeCand =
    candidates.find((c) => c.id === activeCandId) ?? candidates[0] ?? null;

  const onApprove = async (id: string) => {
    setCandBusy(true);
    setCandError(null);
    try {
      await hostApproveMemoryCandidate(id);
      await refreshCandidates();
      onCreateHint?.();
    } catch (e) {
      setCandError(e instanceof Error ? e.message : String(e));
    } finally {
      setCandBusy(false);
    }
  };

  const onDiscard = async (id: string) => {
    setCandBusy(true);
    setCandError(null);
    try {
      await hostDiscardMemoryCandidate(id);
      setActiveCandId(null);
      await refreshCandidates();
    } catch (e) {
      setCandError(e instanceof Error ? e.message : String(e));
    } finally {
      setCandBusy(false);
    }
  };

  const onSaveEdit = async () => {
    if (!activeCand) return;
    setCandBusy(true);
    setCandError(null);
    try {
      const updated = await hostEditMemoryCandidate({
        id: activeCand.id,
        content: editBody,
      });
      setCandidates((prev) =>
        prev.map((c) => (c.id === updated.id ? updated : c)),
      );
    } catch (e) {
      setCandError(e instanceof Error ? e.message : String(e));
    } finally {
      setCandBusy(false);
    }
  };

  const onBatchApprove = async () => {
    setCandBusy(true);
    setCandError(null);
    try {
      const needConfirm = candidates.length > 3;
      await hostBatchApproveMemoryCandidates({
        minConfidence: 0.55,
        minSalience: 0.4,
        typeConfirm: needConfirm ? batchConfirm || undefined : undefined,
      });
      setBatchConfirm("");
      await refreshCandidates();
      onCreateHint?.();
    } catch (e) {
      setCandError(e instanceof Error ? e.message : String(e));
    } finally {
      setCandBusy(false);
    }
  };

  const onPurge = async () => {
    if (!active?.id) return;
    setCandBusy(true);
    setCandError(null);
    try {
      await hostPurgeMemoryGdpr(active.id, purgeConfirm);
      setPurgeOpen(false);
      setPurgeConfirm("");
      onCreateHint?.();
    } catch (e) {
      setCandError(e instanceof Error ? e.message : String(e));
    } finally {
      setCandBusy(false);
    }
  };

  const emptyStore = docs.length === 0;
  const emptyFilter = !emptyStore && filtered.length === 0;

  return (
    <div className="pane pane--fill">
      <header className="pane-chrome">
        <h2 className="pane-chrome__title">Memory</h2>
        <div className="pane-chrome__meta" aria-live="polite">
          <span className="chip chip--static">
            {view === "store"
              ? `${filtered.length}${filtered.length !== docs.length ? ` / ${docs.length}` : ""} items`
              : `${candidates.length} pending`}
          </span>
          {dirty ? (
            <span className="chip" data-tone="warn">
              Unsaved
            </span>
          ) : null}
        </div>
        <div className="pane-chrome__actions">
          <div className="mem-view-toggle" role="tablist" aria-label="Memory view">
            <button
              type="button"
              role="tab"
              className="btn btn--ghost btn--sm"
              aria-selected={view === "store"}
              data-active={view === "store" ? "true" : "false"}
              onClick={() => setView("store")}
            >
              Store
            </button>
            <button
              type="button"
              role="tab"
              className="btn btn--ghost btn--sm"
              aria-selected={view === "inbox"}
              data-active={view === "inbox" ? "true" : "false"}
              onClick={() => setView("inbox")}
            >
              Review inbox
              {candidates.length > 0 ? (
                <span className="chip chip--static" data-tone="warn">
                  {candidates.length}
                </span>
              ) : null}
            </button>
          </div>
          {onCreateHint ? (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                onCreateHint();
                if (view === "inbox") void refreshCandidates();
              }}
            >
              Refresh
            </button>
          ) : null}
          {onCompose && view === "store" ? (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() =>
                onCompose({
                  path: "",
                  title: "Untitled draft",
                  body: "",
                })
              }
            >
              New draft
            </button>
          ) : null}
        </div>
      </header>

      {candError ? (
        <div className="callout callout--warn" role="alert">
          {candError}
        </div>
      ) : null}

      {view === "inbox" ? (
        <div className="pane__split pane__split--memory">
          <div className="mem-inbox">
            <p className="mem-detail__hint">
              Auto-extraction <strong>proposes</strong> only. Approve writes
              through SoftWrite (redaction + embed-on-write). Nothing is
              remembered silently.
            </p>
            {candidates.length > 3 ? (
              <div className="mem-batch">
                <label className="field">
                  <span className="field__label">
                    Batch approve (type APPROVE if &gt;3)
                  </span>
                  <input
                    className="field__control"
                    value={batchConfirm}
                    onChange={(e) => setBatchConfirm(e.target.value)}
                    placeholder="APPROVE"
                    aria-label="Type APPROVE to confirm batch"
                  />
                </label>
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  disabled={candBusy}
                  onClick={() => void onBatchApprove()}
                >
                  Batch approve high-confidence
                </button>
              </div>
            ) : candidates.length > 0 ? (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                disabled={candBusy}
                onClick={() => void onBatchApprove()}
              >
                Approve all above floor
              </button>
            ) : null}
            <ul className="mem-list" aria-label="Candidate inbox">
              {candidates.length === 0 ? (
                <li className="mem-list__empty">
                  <div className="empty-state__title">Inbox empty</div>
                  <p className="empty-state__body">
                    After a chat turn that mentions facts, decisions, or
                    preferences, proposals land here for review.
                  </p>
                </li>
              ) : (
                candidates.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      className="mem-list__item"
                      data-active={
                        c.id === (activeCand?.id ?? "") ? "true" : "false"
                      }
                      onClick={() => {
                        setActiveCandId(c.id);
                        setEditBody(c.content);
                      }}
                    >
                      <span className="mem-list__title">
                        {c.title || c.kind}
                      </span>
                      <span className="mem-list__snippet">
                        {snippet(c.content)}
                      </span>
                      <span className="mem-list__meta">
                        <span className="chip chip--kind chip--static">
                          {kindLabel(c.kind)}
                        </span>
                        <span className="chip chip--static" title="Salience">
                          S {pct(c.salience)}
                        </span>
                        <span className="chip chip--static" title="Confidence">
                          C {pct(c.confidence)}
                        </span>
                        {c.proposeSupersedeOf ? (
                          <span className="chip chip--static" data-tone="warn">
                            supersede?
                          </span>
                        ) : null}
                      </span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>
          {activeCand ? (
            <div className="mem-detail">
              <div className="mem-detail__head">
                <h3 className="mem-detail__title">
                  {activeCand.title || activeCand.kind}
                </h3>
                <span className="chip chip--static">{activeCand.cue}</span>
                <span className="chip chip--static">
                  S {pct(activeCand.salience)} · C {pct(activeCand.confidence)}
                </span>
              </div>
              {activeCand.proposeSupersedeOf ? (
                <div className="callout callout--warn" role="status">
                  Near-duplicate detected — approve will{" "}
                  <strong>supersede</strong>{" "}
                  {activeCand.proposeSupersedeOf.slice(0, 8)}… (not silent).
                </div>
              ) : null}
              {activeCand.sourceExcerpt ? (
                <p className="mem-detail__hint">
                  From conversation: “{snippet(activeCand.sourceExcerpt, 160)}”
                </p>
              ) : null}
              <label className="sr-only" htmlFor="candidate-body">
                Candidate content
              </label>
              <textarea
                id="candidate-body"
                className="mem-detail__body"
                value={editBody}
                onChange={(e) => setEditBody(e.target.value)}
              />
              <footer className="mem-detail__footer">
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={candBusy || editBody === activeCand.content}
                  onClick={() => void onSaveEdit()}
                >
                  Save edit
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={candBusy}
                  onClick={() => void onDiscard(activeCand.id)}
                >
                  Discard
                </button>
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={candBusy}
                  onClick={() => void onApprove(activeCand.id)}
                >
                  Approve → store
                </button>
              </footer>
            </div>
          ) : (
            <div className="pane-empty">
              <h3 className="pane-empty__title">No candidate selected</h3>
              <p className="pane-empty__lead">
                Chat cues fill this inbox; you approve every durable write.
              </p>
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="pane__toolbar">
            <input
              className="field__control"
              placeholder="Search memories…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search memories"
            />
            <select
              className="field__control field__control--select"
              value={kindFilter}
              onChange={(e) => setKindFilter(e.target.value)}
              aria-label="Filter by kind"
            >
              {KIND_OPTIONS.map((o) => (
                <option key={o.value || "all"} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <label className="pane__toolbar-toggle">
              <input
                type="checkbox"
                checked={includeSuperseded}
                onChange={(e) => setIncludeSuperseded(e.target.checked)}
              />
              Superseded
            </label>
          </div>

          {emptyStore ? (
            <div className="pane-empty">
              <div
                className="pane-empty__glyph pane-empty__glyph--memory"
                aria-hidden
              />
              <h3 className="pane-empty__title">No memories yet</h3>
              <p className="pane-empty__lead">
                The second brain fills from conversation proposals you approve
                in the Review inbox, Accept on agent SoftWrite, or Compose.
              </p>
              <div className="pane-empty__actions">
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => setView("inbox")}
                >
                  Open review inbox
                </button>
                {onCompose ? (
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() =>
                      onCompose({
                        path: "",
                        title: "Untitled draft",
                        body: "",
                      })
                    }
                  >
                    Open Compose
                  </button>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="pane__split pane__split--memory">
              <ul className="mem-list" aria-label="Memory list">
                {emptyFilter ? (
                  <li className="mem-list__empty">
                    <div className="empty-state__title">No matches</div>
                    <p className="empty-state__body">
                      {hasFilters
                        ? "Try clearing search or filters."
                        : "Nothing to show."}
                    </p>
                  </li>
                ) : (
                  filtered.map((d) => (
                    <li key={d.path}>
                      <button
                        type="button"
                        className="mem-list__item"
                        data-active={
                          d.path === (active?.path ?? "") ? "true" : "false"
                        }
                        onClick={() => {
                          onSelect(d.path);
                          setDraft(d.body);
                          setDirty(false);
                          setSyncedPath(d.path);
                          setPurgeOpen(false);
                        }}
                      >
                        <span className="mem-list__title">
                          {d.title || d.kind || "Memory"}
                        </span>
                        <span className="mem-list__snippet">
                          {snippet(d.body)}
                        </span>
                        <span className="mem-list__meta">
                          {d.kind ? (
                            <span className="chip chip--kind chip--static">
                              {kindLabel(d.kind)}
                            </span>
                          ) : null}
                          {d.scope ? (
                            <span className="chip chip--static">{d.scope}</span>
                          ) : null}
                          {d.status && d.status !== "active" ? (
                            <span
                              className="chip chip--static"
                              data-tone="warn"
                            >
                              {d.status}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    </li>
                  ))
                )}
              </ul>

              {active ? (
                <div className="mem-detail">
                  <div className="mem-detail__head">
                    <h3 className="mem-detail__title">
                      {active.title || active.kind || "Memory"}
                    </h3>
                    {active.kind ? (
                      <span className="chip chip--kind chip--static">
                        {kindLabel(active.kind)}
                      </span>
                    ) : null}
                    {active.scope ? (
                      <span className="chip chip--static">{active.scope}</span>
                    ) : null}
                    {active.id ? (
                      <span
                        className="chip chip--mono chip--static"
                        title={active.id}
                      >
                        {active.id.slice(0, 8)}…
                      </span>
                    ) : (
                      <span
                        className="chip chip--mono chip--static"
                        title={active.path}
                      >
                        file
                      </span>
                    )}
                    {active.status && active.status !== "active" ? (
                      <span className="chip chip--static" data-tone="warn">
                        {active.status}
                      </span>
                    ) : null}
                    {dirty ? (
                      <span className="chip" data-tone="warn">
                        Unsaved
                      </span>
                    ) : null}
                  </div>
                  {active.status === "retracted" ? (
                    <div className="callout callout--warn" role="status">
                      Retracted (soft tombstone) — hidden from default recall;
                      reversible. Permanent GDPR purge is type-to-confirm
                      PURGE.
                    </div>
                  ) : null}
                  {active.redactionPreview &&
                  active.redactionPreview.length > 0 ? (
                    <div className="callout callout--warn" role="status">
                      Secrets redacted before save:{" "}
                      {active.redactionPreview.join(", ")}
                    </div>
                  ) : null}
                  <label className="sr-only" htmlFor="memory-body">
                    Memory body
                  </label>
                  <textarea
                    id="memory-body"
                    className="mem-detail__body"
                    value={draft}
                    readOnly={isDurable}
                    onChange={(e) => {
                      if (isDurable) return;
                      setDraft(e.target.value);
                      setDirty(true);
                    }}
                  />
                  <footer className="mem-detail__footer">
                    {isDurable ? (
                      <>
                        <p className="mem-detail__hint">
                          Store-backed — hand-edit in Compose, or ask the agent
                          to supersede / retract.
                        </p>
                        {onCompose ? (
                          <button
                            type="button"
                            className="btn btn--primary"
                            onClick={() => onCompose(active)}
                          >
                            Compose / edit
                          </button>
                        ) : null}
                        {active.id ? (
                          <button
                            type="button"
                            className="btn btn--ghost"
                            data-tone="danger"
                            onClick={() => setPurgeOpen((v) => !v)}
                          >
                            GDPR purge…
                          </button>
                        ) : null}
                      </>
                    ) : (
                      <>
                        <p className="mem-detail__hint">
                          Workspace file note — Save writes the markdown file.
                        </p>
                        <button
                          type="button"
                          className="btn btn--primary"
                          disabled={!canSave}
                          onClick={handleSave}
                        >
                          Save note
                        </button>
                      </>
                    )}
                  </footer>
                  {purgeOpen && active.id ? (
                    <div className="mem-purge callout callout--warn">
                      <p>
                        Hard-delete content and keep a tombstone. This is{" "}
                        <strong>not</strong> reversible retract. Type{" "}
                        <code>PURGE</code> to confirm.
                      </p>
                      <input
                        className="field__control"
                        value={purgeConfirm}
                        onChange={(e) => setPurgeConfirm(e.target.value)}
                        placeholder="PURGE"
                        aria-label="Type PURGE to confirm"
                      />
                      <button
                        type="button"
                        className="btn btn--primary"
                        disabled={candBusy || purgeConfirm !== "PURGE"}
                        onClick={() => void onPurge()}
                      >
                        Permanently purge
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="pane-empty">
                  <div
                    className="pane-empty__glyph pane-empty__glyph--memory"
                    aria-hidden
                  />
                  <h3 className="pane-empty__title">Nothing selected</h3>
                  <p className="pane-empty__lead">
                    Pick a memory from the list to inspect, or open Compose to
                    draft a new one.
                  </p>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
