/**
 * Log analysis surface: Memory-style list | detail + package import/export.
 */
import { useCallback, useEffect, useState } from "react";
import {
  hostDiscardLogCorpus,
  hostExportLogCorpusPackage,
  hostImportLogCorpusPackagePath,
  hostIngestLogPath,
  hostListLogCorpora,
  hostListLogTemplates,
  hostListenProcessProgress,
  hostLogClusterProblems,
  hostLogSearch,
  hostLogTimeline,
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
  formatTimelineBucketStart,
  levelEntries,
  statsBlurb,
  TIMELINE_PURPOSE,
} from "../../lib/logStats";
import { ProcessProgressPanel } from "../wizards/ProcessProgressPanel";
import type { ProcessProgressDto as WizardProgressDto } from "../wizards/types";

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
  /** Seed chat + switch to chat pane (large corpora use tools, not full paste). */
  onChatAboutCorpus?: (composerSeed: string) => void;
};

export function LogPane({ pickDirectory, onOpenHelp, onChatAboutCorpus }: Props) {
  const [corpora, setCorpora] = useState<LogCorpusSummaryDto[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailTab>("overview");
  const [busy, setBusy] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [clusters, setClusters] = useState<LogClusterDto[]>([]);
  const [timeline, setTimeline] = useState<LogTimelineBucketDto[]>([]);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<LogSearchHitDto[]>([]);
  const [templates, setTemplates] = useState<LogTemplateRowDto[]>([]);
  const [exemplar, setExemplar] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProcessProgressDto | null>(null);

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

  async function runCorpusIngest(path: string) {
    const ok = await dialogConfirm(
      "SoftWrite: ingest into a disposable analysis corpus (parse → template → DuckDB). " +
        "Folder and .zip dumps are supported; there is no 200-file chat-pack limit. Continue?",
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
      if (r.lines === 0) {
        setNote(
          `${statsBlurb(r)} — 0 lines parsed; open Debug if available, or try a different path.`,
        );
      }
      await refresh();
      await selectCorpus(r.corpusId);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      setIngesting(false);
    }
  }

  /** Folder dump → same corpus pipeline as a single file/zip. */
  async function onImportFolder() {
    const picker =
      pickDirectory ?? (() => openDirectoryDialog("Choose log directory"));
    const dir = await picker();
    if (!dir) return;
    await runCorpusIngest(dir);
  }

  /** Single log file or .zip of logs → corpus pipeline. */
  async function onImportFileOrZip() {
    const path = await openFileDialog("Choose log file or zip", [
      { name: "Logs / zip", extensions: ["log", "txt", "json", "jsonl", "zip"] },
    ]);
    if (!path) return;
    await runCorpusIngest(path);
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

  return (
    <div className="log-pane pane--fill" data-testid="log-pane">
      <header className="pane-chrome">
        <h2 className="pane-chrome__title">Logs</h2>
        <div className="pane-chrome__actions">
          <button
            type="button"
            className="btn btn--ghost"
            disabled={busy}
            onClick={() => void onImportFolder()}
          >
            Import folder…
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            disabled={busy}
            onClick={() => void onImportFileOrZip()}
          >
            Import file / zip…
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
          {onOpenHelp ? (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => onOpenHelp("log-analysis-pipeline")}
            >
              Learn more
            </button>
          ) : null}
        </div>
      </header>

      {ingesting || progress ? (
        <ProcessProgressPanel
          progress={progress ? hostProgressToWizard(progress) : null}
          kind="log_ingest"
          error={ingesting ? error : null}
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
              <button type="button" onClick={() => void onImportFolder()}>
                Import folder…
              </button>
              <button type="button" onClick={() => void onImportFileOrZip()}>
                Import file / zip…
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
                {onChatAboutCorpus ? (
                  <button
                    type="button"
                    className="btn btn--primary btn--sm"
                    onClick={() => {
                      const seed =
                        `I have analysis corpus \`${active.id}\` active (name: ${active.name}). ` +
                        (active.stats
                          ? `Ingest summary: ${statsBlurb(active.stats)}. `
                          : "") +
                        `Use log tools (cluster_problems, timeline, search_logs, etc.) with this corpus — do not ask me for a corpus id. ` +
                        `Cluster main problems, outline timeline around ERROR spikes, and hypothesize root cause with template citations.`;
                      onChatAboutCorpus(seed);
                    }}
                  >
                    Chat about this corpus
                  </button>
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
                      </dl>
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
                    <div className="log-timeline" data-testid="log-timeline">
                      <h4>Volume timeline</h4>
                      <p className="muted log-timeline__purpose">{TIMELINE_PURPOSE}</p>
                      <ul className="log-timeline-bars">
                        {timeline.map((b) => {
                          const label = formatTimelineBucketStart(
                            b.start,
                            b.width || 60,
                          );
                          const levels = b.byLevel
                            ? levelEntries(b.byLevel)
                                .slice(0, 3)
                                .map((x) => `${x.level}:${x.count}`)
                                .join(" · ")
                            : "";
                          return (
                            <li
                              key={b.start}
                              title={`${label} · ${b.count} events${levels ? ` · ${levels}` : ""}`}
                            >
                              <span className="log-timeline-bars__when">{label}</span>
                              <span
                                className="log-timeline-bars__fill"
                                style={{
                                  width: `${Math.max(4, (100 * b.count) / maxTl)}%`,
                                }}
                              />
                              <span className="log-timeline-bars__n">
                                {b.count.toLocaleString()}
                                {levels ? (
                                  <span className="muted"> {levels}</span>
                                ) : null}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {tab === "search" ? (
                <div className="log-detail__body" data-testid="log-search">
                  <div className="pane__toolbar">
                    <input
                      className="field__control"
                      type="search"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="paraphrase an error…"
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
