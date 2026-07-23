/**
 * Harvest Browser — list provenance rows, open Confluence URL (#326 PR6).
 * Check/Apply sync go through agent tools (SoftWrite gated).
 */
import { useCallback, useEffect, useState } from "react";
import { hostListHarvests, hostOpenExternalUrl, type HarvestRowDto } from "../../lib/host";

export function HarvestPane() {
  const [rows, setRows] = useState<HarvestRowDto[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const list = await hostListHarvests(100);
      setRows(list);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setRows([]);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="pane pane--fill">
      <header className="pane-chrome">
        <h2 className="pane-chrome__title">Harvest</h2>
        <div className="pane-chrome__meta">
          <span className="chip chip--static">{rows.length} rows</span>
        </div>
        <div className="pane-chrome__actions">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={busy}
            onClick={() => void refresh()}
          >
            Refresh
          </button>
        </div>
      </header>
      <p className="mem-detail__hint" style={{ padding: "0 1rem" }}>
        Provenance-linked Confluence harvests (SoftWrite). Re-sync: ask the agent{" "}
        <code>check_source_sync</code> / <code>apply_source_sync</code> with a
        harvest id (Accept required for apply). Publish writes require{" "}
        <code>write_enabled</code> in Settings → Connectors.
      </p>
      {err ? (
        <div className="callout callout--warn" role="alert">
          {err}
          <p className="mem-detail__hint">
            If spaces allowlist is empty, harvest is blocked — set space keys in
            Settings → Connectors.
          </p>
        </div>
      ) : null}
      <ul className="mem-list" aria-label="Harvest rows">
        {rows.length === 0 ? (
          <li className="mem-list__empty">
            <div className="empty-state__title">No harvests yet</div>
            <p className="empty-state__body">
              Use agent tool <code>harvest_from_source</code> with Confluence
              page ids (space allowlist required).
            </p>
          </li>
        ) : (
          rows.map((r) => (
            <li key={r.id}>
              <div className="mem-list__item" style={{ cursor: "default" }}>
                <span className="mem-list__title">
                  {r.space ? `${r.space}/` : ""}
                  {r.remoteId}
                </span>
                <span className="mem-list__snippet">
                  {r.destination} · {r.transform}
                </span>
                <span className="mem-list__meta">
                  <span className="chip chip--static" data-tone={
                    r.syncStatus === "conflict" || r.syncStatus === "remote_newer"
                      ? "warn"
                      : undefined
                  }>
                    {r.syncStatus}
                  </span>
                  <span className="chip chip--mono chip--static" title={r.id}>
                    {r.id.slice(0, 8)}…
                  </span>
                  {r.url ? (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => void hostOpenExternalUrl(r.url!)}
                    >
                      Open
                    </button>
                  ) : null}
                </span>
              </div>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
