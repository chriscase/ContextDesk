/**
 * Log analysis surface (#362): pick a dir → ingest → clusters + timeline + search.
 * No secrets over IPC — only paths and analysis results.
 */
import { useCallback, useEffect, useState } from "react";
import {
  hostDiscardLogCorpus,
  hostIngestLogPath,
  hostListLogCorpora,
  hostLogClusterProblems,
  hostLogSearch,
  hostLogTimeline,
  type LogClusterDto,
  type LogCorpusSummaryDto,
  type LogSearchHitDto,
  type LogTimelineBucketDto,
} from "../../lib/host";

type Props = {
  /** Optional initial path from file dialog (host-supplied). */
  pickDirectory?: () => Promise<string | null>;
};

export function LogPane({ pickDirectory }: Props) {
  const [corpora, setCorpora] = useState<LogCorpusSummaryDto[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [name, setName] = useState("incident");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [clusters, setClusters] = useState<LogClusterDto[]>([]);
  const [timeline, setTimeline] = useState<LogTimelineBucketDto[]>([]);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<LogSearchHitDto[]>([]);
  const [exemplar, setExemplar] = useState<string | null>(null);

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

  const loadAnalysis = useCallback(async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      const [cl, tl] = await Promise.all([
        hostLogClusterProblems(id, 12),
        hostLogTimeline(id, 60),
      ]);
      setClusters(cl ?? []);
      setTimeline(tl ?? []);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (activeId) void loadAnalysis(activeId);
  }, [activeId, loadAnalysis]);

  async function onPick() {
    if (!pickDirectory) return;
    const p = await pickDirectory();
    if (p) setPath(p);
  }

  async function onIngest() {
    if (!path.trim()) {
      setError("Choose a log file or directory first.");
      return;
    }
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const r = await hostIngestLogPath(path.trim(), name.trim() || "incident");
      setNote(
        `Ingested ${r.lines} lines → ${r.templates} templates (${r.reductionRatio.toFixed(1)}× reduction), engine DuckDB when reopened.`,
      );
      setActiveId(r.corpusId);
      await refresh();
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
      const h = await hostLogSearch(activeId, query.trim(), 10);
      setHits(h ?? []);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onDiscard(id: string) {
    setBusy(true);
    try {
      await hostDiscardLogCorpus(id);
      if (activeId === id) {
        setActiveId(null);
        setClusters([]);
        setTimeline([]);
        setHits([]);
      }
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="log-pane" data-testid="log-pane">
      <header className="log-pane__header">
        <h2>Log analysis</h2>
        <p className="muted">
          Point at a log dump — parse, template, cluster problems, timeline, and
          paraphrase search. Corpora stay in app cache (disposable).
        </p>
      </header>

      <section className="log-pane__ingest" aria-label="Ingest logs">
        <label>
          Path
          <input
            type="text"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/path/to/logs"
            aria-label="Log path"
          />
        </label>
        {pickDirectory ? (
          <button type="button" onClick={() => void onPick()} disabled={busy}>
            Browse…
          </button>
        ) : null}
        <label>
          Name
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Corpus name"
          />
        </label>
        <button type="button" onClick={() => void onIngest()} disabled={busy}>
          {busy ? "Working…" : "Ingest"}
        </button>
      </section>

      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {note ? <p className="muted">{note}</p> : null}

      <section className="log-pane__corpora" aria-label="Corpora">
        <h3>Corpora</h3>
        {corpora.length === 0 ? (
          <p className="muted">No corpora yet.</p>
        ) : (
          <ul>
            {corpora.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  data-active={activeId === c.id ? "true" : "false"}
                  onClick={() => setActiveId(c.id)}
                >
                  {c.name} — {c.eventCount} events / {c.templateCount} templates (
                  {c.engine})
                </button>
                <button type="button" onClick={() => void onDiscard(c.id)}>
                  Discard
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {activeId ? (
        <>
          <section className="log-pane__clusters" aria-label="Problem clusters">
            <h3>Problem clusters</h3>
            {clusters.length === 0 ? (
              <p className="muted">No clusters.</p>
            ) : (
              <ul>
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
          </section>

          <section className="log-pane__timeline" aria-label="Timeline">
            <h3>Timeline</h3>
            {timeline.length === 0 ? (
              <p className="muted">No buckets.</p>
            ) : (
              <ul className="log-pane__timeline-bars">
                {timeline.map((b) => (
                  <li key={b.start}>
                    t={b.start}…{b.start + b.width}: {b.count}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="log-pane__search" aria-label="Search logs">
            <h3>Search</h3>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="paraphrase an error…"
              aria-label="Log search query"
            />
            <button type="button" onClick={() => void onSearch()} disabled={busy}>
              Search
            </button>
            <ul>
              {hits.map((h) => (
                <li key={h.templateId}>
                  <button
                    type="button"
                    onClick={() =>
                      setExemplar(h.exemplars[0] ?? h.pattern)
                    }
                  >
                    t{h.templateId} score={h.score.toFixed(2)} sem=
                    {h.semanticScore.toFixed(2)} — {h.pattern}
                  </button>
                </li>
              ))}
            </ul>
          </section>

          {exemplar ? (
            <section className="log-pane__exemplar" aria-label="Exemplar">
              <h3>Exemplar</h3>
              <pre>{exemplar}</pre>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
