/**
 * Log analysis surface: Memory-style list | detail + package import/export.
 */
import { useCallback, useEffect, useState } from "react";
import {
  hostDiscardLogCorpus,
  hostExportLogCorpusPackage,
  hostImportLogCorpusPackagePath,
  hostCancelLogIngest,
  hostCancelLogReanalysis,
  hostIngestLogPath,
  hostListLogCorpora,
  hostListLogTemplates,
  hostListenProcessProgress,
  hostLogClusterProblems,
  hostLogSearch,
  hostLogTimeline,
  hostOpenLogExplorer,
  hostReanalyzeLogCorpus,
  hostSetActiveLogCorpus,
  type LogClusterDto,
  type LogCorpusSummaryDto,
  type LogSearchHitDto,
  type LogTemplateRowDto,
  type LogTimelineBucketDto,
  type ProcessProgressDto,
} from "../../lib/host";
import {
  dialogConfirm,
  openDirectoryDialog,
  openFileDialog,
  saveFileDialog,
} from "../../lib/dialogs";
import {
  formatBytes,
  formatReduction,
  levelEntries,
  statsBlurb,
} from "../../lib/logStats";
import { ProcessProgressPanel } from "../wizards/ProcessProgressPanel";
import type { ProcessProgressDto as WizardProgressDto } from "../wizards/types";
import { LogExplorer } from "../logExplorer/LogExplorer";

function hostProgressToWizard(p: ProcessProgressDto): WizardProgressDto {
  return {
    kind: p.kind,
    phase: p.phase as WizardProgressDto["phase"],
    message: p.message,
    fraction: p.fraction,
    lines_processed: p.lines_processed,
    files_processed: p.files_processed,
    bytes_processed: p.bytes_processed,
    templates: p.templates,
    cancellable: p.cancellable,
  };
}

type DetailTab = "overview" | "search" | "templates" | "analysis";

type Props = {
  pickDirectory?: () => Promise<string | null>;
  onOpenHelp?: (pageId: string) => void;
};

export function LogPane({ pickDirectory, onOpenHelp }: Props) {
  const [corpora, setCorpora] = useState<LogCorpusSummaryDto[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailTab>("overview");
  const [busy, setBusy] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [clusters, setClusters] = useState<LogClusterDto[]>([]);
  const [timeline, setTimeline] = useState<LogTimelineBucketDto[]>([]);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<LogSearchHitDto[]>([]);
  const [templates, setTemplates] = useState<LogTemplateRowDto[]>([]);
  const [exemplar, setExemplar] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProcessProgressDto | null>(null);
  /** In-app Explorer escape hatch when multi-window fails (#503). */
  const [inAppExplorerId, setInAppExplorerId] = useState<string | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void hostListenProcessProgress((p) => {
      if (p.kind === "log_ingest") setProgress(p);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const list = await hostListLogCorpora();
      setCorpora(list ?? []);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selectCorpus = useCallback(async (id: string) => {
    setActiveId(id);
    setTab("overview");
    setHits([]);
    setExemplar(null);
    try {
      await hostSetActiveLogCorpus(id);
    } catch {
      /* non-fatal */
    }
  }, []);

  const loadAnalysis = useCallback(async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      const [cl, tl, tpls] = await Promise.all([
        hostLogClusterProblems(id, 12),
        hostLogTimeline(id, 60),
        hostListLogTemplates(id, 100),
      ]);
      setClusters(cl ?? []);
      setTimeline(tl ?? []);
      setTemplates(tpls ?? []);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (activeId) void loadAnalysis(activeId);
  }, [activeId, loadAnalysis]);

  const active = corpora.find((c) => c.id === activeId) ?? null;
  const activeEmbedding = active?.embedding ?? {
    state:
      (active?.stats?.embedded ?? 0) > 0
        ? ("partial" as const)
        : ("keyword_only" as const),
    modelId: null,
    embeddedTemplates: active?.stats?.embedded ?? 0,
    totalTemplates: active?.templateCount ?? 0,
    reason: "legacy_metadata",
    updatedAt: 0,
  };
  const semanticAvailable = activeEmbedding.embeddedTemplates > 0;

  async function onImportLogs() {
    const picker =
      pickDirectory ?? (() => openDirectoryDialog("Choose log directory"));
    const dir = await picker();
    let path = dir;
    if (!path) {
      path = await openFileDialog("Choose log file or zip", [
        { name: "Logs", extensions: ["log", "txt", "json", "jsonl", "zip"] },
      ]);
    }
    if (!path) return;
    const ok = await dialogConfirm(
      "SoftWrite: ingest into a disposable analysis corpus (secrets redacted). Continue?",
      { title: "Import logs" },
    );
    if (!ok) return;
    setBusy(true);
    setIngesting(true);
    setError(null);
    setNote(null);
    setProgress(null);
    try {
      const r = await hostIngestLogPath(path, "incident");
      setNote(statsBlurb(r));
      await refresh();
      await selectCorpus(r.corpusId);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      setIngesting(false);
    }
  }

  async function onImportPackage() {
    const path = await openFileDialog("Import log corpus package", [
      { name: "ContextDesk package", extensions: ["zip", "cdlog"] },
    ]);
    if (!path) return;
    const ok = await dialogConfirm(
      "SoftWrite: import a portable analysis package (new disposable corpus). Continue?",
      { title: "Import package" },
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const r = await hostImportLogCorpusPackagePath(path);
      setNote(`Imported package → corpus ${r.corpusId} (from ${r.originCorpusId})`);
      await refresh();
      await selectCorpus(r.corpusId);
    } catch (e) {
      // Surface version/hash errors as human-readable
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onExportPackage() {
    if (!activeId) return;
    const path = await saveFileDialog("Export log corpus package", "corpus.cdlog.zip", [
      { name: "ContextDesk package", extensions: ["zip"] },
    ]);
    if (!path) return;
    setBusy(true);
    setError(null);
    try {
      const ver = await hostExportLogCorpusPackage(activeId, path);
      setNote(`Exported package (${ver})`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onReanalyze() {
    if (!activeId) return;
    const ok = await dialogConfirm(
      "Re-analyze this corpus with the local ONNX model? Log content stays on this machine, events are not reparsed, and the current keyword corpus remains usable until the new index is complete.",
      { title: "Local template re-analysis" },
    );
    if (!ok) return;
    setBusy(true);
    setReanalyzing(true);
    setError(null);
    setNote(null);
    setProgress(null);
    try {
      const status = await hostReanalyzeLogCorpus(activeId);
      setNote(
        `Local re-analysis complete: ${status.embeddedTemplates.toLocaleString()}/${status.totalTemplates.toLocaleString()} templates embedded.`,
      );
      await refresh();
      await selectCorpus(activeId);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      setReanalyzing(false);
    }
  }

  async function onSearch() {
    if (!activeId || !query.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const h = await hostLogSearch(activeId, query.trim(), 12);
      setHits(h ?? []);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onDiscard(id: string) {
    const ok = await dialogConfirm("Discard this disposable corpus?", {
      title: "Discard corpus",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await hostDiscardLogCorpus(id);
      if (activeId === id) {
        setActiveId(null);
        setClusters([]);
        setTimeline([]);
        setHits([]);
        setTemplates([]);
      }
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const maxTl = Math.max(1, ...timeline.map((b) => b.count));

  if (inAppExplorerId) {
    return (
      <div
        className="log-pane pane--fill log-pane--explorer-embed"
        data-testid="log-pane-in-app-explorer"
        style={{ position: "relative", minHeight: "100%" }}
      >
        <button
          type="button"
          className="btn btn--ghost"
          style={{ position: "absolute", top: 8, right: 8, zIndex: 20 }}
          data-testid="close-in-app-explorer"
          onClick={() => setInAppExplorerId(null)}
        >
          Close Explorer
        </button>
        <LogExplorer corpusId={inAppExplorerId} />
      </div>
    );
  }

  return (
    <div className="log-pane pane--fill" data-testid="log-pane">
      <header className="pane-chrome">
        <h2 className="pane-chrome__title">Logs</h2>
        <div className="pane-chrome__actions">
          <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => void onImportLogs()}>
            Import logs…
          </button>
          <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => void onImportPackage()}>
            Import package…
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            disabled={busy || !activeId}
            onClick={() => void onExportPackage()}
          >
            Export package…
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            disabled={busy || !activeId || activeEmbedding.state === "complete"}
            data-testid="reanalyze-log-corpus"
            onClick={() => void onReanalyze()}
          >
            Re-analyze locally…
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy || !activeId}
            data-testid="open-log-explorer"
            onClick={() => {
              if (!activeId) return;
              void hostOpenLogExplorer(activeId)
                .then(() => setNote("Opened Log Explorer window"))
                .catch((e) => {
                  // Escape hatch: full-surface explorer inside Logs (#503)
                  setInAppExplorerId(activeId);
                  setNote(
                    `Multi-window open failed (${String(e)}); opened Explorer in-app.`,
                  );
                });
            }}
          >
            Open Explorer…
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            disabled={busy || !activeId}
            data-testid="open-log-explorer-in-app"
            title="Open Explorer inside this window (no multi-window)"
            onClick={() => {
              if (!activeId) return;
              setInAppExplorerId(activeId);
              void hostSetActiveLogCorpus(activeId);
            }}
          >
            Open in app
          </button>
          {onOpenHelp ? (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => onOpenHelp("log-explorer")}
            >
              Learn more
            </button>
          ) : null}
        </div>
      </header>

      {ingesting || reanalyzing || progress ? (
        <ProcessProgressPanel
          progress={progress ? hostProgressToWizard(progress) : null}
          kind="log_ingest"
          error={ingesting || reanalyzing ? error : null}
          cancelLabel={reanalyzing ? "Cancel re-analysis" : "Cancel ingest"}
          onCancel={
            ingesting || reanalyzing
              ? () => {
                  const cancel = reanalyzing
                    ? hostCancelLogReanalysis
                    : hostCancelLogIngest;
                  void cancel().then((ok) => {
                    if (ok) setNote("Cancel requested…");
                  });
                }
              : undefined
          }
        />
      ) : null}

      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {note ? <p className="muted log-pane__note">{note}</p> : null}

      <div className="pane__split pane__split--logs">
        <aside className="log-list" aria-label="Corpora">
          {corpora.length === 0 ? (
            <div className="pane-empty">
              <p className="muted">No corpora yet.</p>
              <button type="button" onClick={() => void onImportLogs()}>
                Import logs…
              </button>
            </div>
          ) : (
            <ul className="log-list__items">
              {corpora.map((c) => {
                const red = c.stats?.reductionRatio;
                const size = c.stats?.corpusBytes;
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      className="log-card"
                      data-active={activeId === c.id ? "true" : "false"}
                      onClick={() => void selectCorpus(c.id)}
                    >
                      <span className="log-card__name">{c.name}</span>
                      <span className="log-card__meta">
                        {c.eventCount.toLocaleString()} events ·{" "}
                        {c.templateCount.toLocaleString()} templates
                        {red != null ? ` · ${formatReduction(red)}` : ""}
                      </span>
                      {size != null ? (
                        <span className="log-card__size">{formatBytes(size)}</span>
                      ) : null}
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost log-card__discard"
                      onClick={() => void onDiscard(c.id)}
                    >
                      Discard
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        <section className="log-detail" aria-label="Corpus detail">
          {!active ? (
            <div className="pane-empty">
              <p className="muted">Select a corpus or import logs to begin.</p>
            </div>
          ) : (
            <>
              <header className="log-detail__header">
                <h3>{active.name}</h3>
                <code className="chip">{active.id.slice(0, 8)}…</code>
                {active.sourceLabel ? (
                  <span className="muted">source: {active.sourceLabel}</span>
                ) : null}
              </header>

              <div className="log-detail__tabs" role="tablist">
                {(
                  [
                    ["overview", "Overview"],
                    ["search", "Search"],
                    ["templates", "Templates"],
                    ["analysis", "Analysis"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={tab === id}
                    data-active={tab === id ? "true" : "false"}
                    onClick={() => setTab(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {tab === "overview" ? (
                <div className="log-detail__body" data-testid="log-overview">
                  {active.stats ? (
                    <>
                      <p className="log-detail__blurb">{statsBlurb(active.stats)}</p>
                      <dl className="log-stat-grid">
                        <div>
                          <dt>Lines</dt>
                          <dd>{active.stats.lines.toLocaleString()}</dd>
                        </div>
                        <div>
                          <dt>Templates</dt>
                          <dd>{active.stats.templates.toLocaleString()}</dd>
                        </div>
                        <div>
                          <dt>Reduction</dt>
                          <dd>{formatReduction(active.stats.reductionRatio)}</dd>
                        </div>
                        <div>
                          <dt>Imported files</dt>
                          <dd>{active.stats.files.toLocaleString()}</dd>
                        </div>
                        <div>
                          <dt>Discovered files</dt>
                          <dd>{active.stats.discoveredFiles.toLocaleString()}</dd>
                        </div>
                        <div>
                          <dt>Excluded</dt>
                          <dd>{active.stats.excludedFiles.toLocaleString()}</dd>
                        </div>
                        <div>
                          <dt>Failed</dt>
                          <dd>{active.stats.failedFiles.toLocaleString()}</dd>
                        </div>
                        <div>
                          <dt>Ignored</dt>
                          <dd>{active.stats.ignoredFiles.toLocaleString()}</dd>
                        </div>
                        <div>
                          <dt>Source</dt>
                          <dd>{formatBytes(active.stats.sourceBytes)}</dd>
                        </div>
                        <div>
                          <dt>Corpus</dt>
                          <dd>{formatBytes(active.stats.corpusBytes)}</dd>
                        </div>
                        <div>
                          <dt>Embedded</dt>
                          <dd>{active.stats.embedded.toLocaleString()}</dd>
                        </div>
                        <div>
                          <dt>Analysis mode</dt>
                          <dd data-testid="log-embedding-state">
                            {activeEmbedding.state === "complete"
                              ? "Semantic · complete"
                              : activeEmbedding.state === "partial"
                                ? "Semantic · partial"
                                : activeEmbedding.state === "deferred"
                                  ? "Keyword-only · deferred"
                                  : "Keyword-only"}
                          </dd>
                        </div>
                        <div>
                          <dt>Embedding model</dt>
                          <dd>{activeEmbedding.modelId ?? "None"}</dd>
                        </div>
                      </dl>
                      {active.stats.partial ? (
                        <div
                          className="log-ingest-partial"
                          role="note"
                          data-testid="log-ingest-partial"
                        >
                          <strong>Partial corpus</strong>
                          <span>
                            Some selected content was excluded, ignored, or unreadable.
                          </span>
                          {active.stats.exclusionExamples.length > 0 ? (
                            <ul aria-label="Import exclusions">
                              {active.stats.exclusionExamples.map((example, index) => (
                                <li key={`${index}-${example}`}>{example}</li>
                              ))}
                            </ul>
                          ) : null}
                        </div>
                      ) : null}
                      <div className="log-levels">
                        {levelEntries(active.stats.levelCounts).map(({ level, count }) => (
                          <span key={level} className={`chip chip--level chip--${level}`}>
                            {level} {count}
                          </span>
                        ))}
                      </div>
                    </>
                  ) : (
                    <p className="muted">
                      {active.eventCount.toLocaleString()} events /{" "}
                      {active.templateCount.toLocaleString()} templates (legacy meta —
                      re-ingest for full stats).
                    </p>
                  )}
                  {active.topTemplates?.length ? (
                    <div>
                      <h4>Top templates</h4>
                      <ul className="log-tops">
                        {active.topTemplates.slice(0, 8).map((t) => (
                          <li key={t.id}>
                            <button
                              type="button"
                              onClick={() => setExemplar(t.pattern)}
                            >
                              n={t.count} sev={t.severity} — {t.pattern}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {timeline.length > 0 ? (
                    <div>
                      <h4>Timeline</h4>
                      <ul className="log-timeline-bars">
                        {timeline.map((b) => (
                          <li key={b.start} title={`t=${b.start} n=${b.count}`}>
                            <span
                              className="log-timeline-bars__fill"
                              style={{
                                width: `${Math.max(4, (100 * b.count) / maxTl)}%`,
                              }}
                            />
                            <span className="log-timeline-bars__n">{b.count}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {tab === "search" ? (
                <div className="log-detail__body" data-testid="log-search">
                  <p className="muted" role="note">
                    {semanticAvailable
                      ? `Semantic template search is available (${activeEmbedding.embeddedTemplates}/${activeEmbedding.totalTemplates} templates).`
                      : "Keyword search only. Run local re-analysis to enable semantic template search."}
                  </p>
                  <div className="pane__toolbar">
                    <input
                      className="field__control"
                      type="search"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder={
                        semanticAvailable
                          ? "paraphrase an error…"
                          : "search exact log terms…"
                      }
                      aria-label="Log search query"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void onSearch();
                      }}
                    />
                    <button type="button" disabled={busy} onClick={() => void onSearch()}>
                      Search
                    </button>
                  </div>
                  <ul className="log-hits">
                    {hits.map((h) => (
                      <li key={h.templateId}>
                        <button
                          type="button"
                          onClick={() => setExemplar(h.exemplars[0] ?? h.pattern)}
                        >
                          t{h.templateId} score={h.score.toFixed(2)} — {h.pattern}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {tab === "templates" ? (
                <div className="log-detail__body" data-testid="log-templates">
                  <table className="log-table">
                    <thead>
                      <tr>
                        <th>ID</th>
                        <th>Count</th>
                        <th>Sev</th>
                        <th>Pattern</th>
                      </tr>
                    </thead>
                    <tbody>
                      {templates.map((t) => (
                        <tr key={t.id}>
                          <td>{t.id}</td>
                          <td>{t.count}</td>
                          <td>{t.severity}</td>
                          <td>
                            <button type="button" onClick={() => setExemplar(t.pattern)}>
                              {t.pattern}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}

              {tab === "analysis" ? (
                <div className="log-detail__body" data-testid="log-analysis">
                  <h4>Problem clusters</h4>
                  {clusters.length === 0 ? (
                    <p className="muted">No clusters.</p>
                  ) : (
                    <ul className="log-clusters">
                      {clusters.map((cl) => (
                        <li key={cl.clusterId}>
                          <button
                            type="button"
                            onClick={() =>
                              setExemplar(cl.exemplars[0] ?? cl.label)
                            }
                          >
                            sev={cl.severity} n={cl.count} score={cl.score.toFixed(1)} —{" "}
                            {cl.label}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="muted">
                    Deeper correlate / anomalies / trace are available via the
                    log-triage agent tools in chat.
                  </p>
                </div>
              ) : null}

              {exemplar ? (
                <section className="log-exemplar" aria-label="Exemplar">
                  <h4>Exemplar</h4>
                  <pre>{exemplar}</pre>
                </section>
              ) : null}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
