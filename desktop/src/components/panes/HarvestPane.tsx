/**
 * Harvest Browser — list provenance, open Confluence URL, Publish (#326 PR6/PR8).
 * Check/Apply sync go through agent tools (SoftWrite gated).
 * Publish goes through ToolHost HardWrite + type-to-confirm WRITE (no UI bypass).
 */
import { useCallback, useEffect, useState } from "react";
import { PermissionModal, type PermissionPrompt } from "../PermissionModal";
import {
  completePermission,
  hostGetConfluence,
  hostListHarvests,
  hostOpenExternalUrl,
  hostProposeConfluencePublish,
  type HarvestRowDto,
} from "../../lib/host";
import { applyEventsToMessage } from "../../lib/turn";

export function HarvestPane() {
  const [rows, setRows] = useState<HarvestRowDto[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [writeEnabled, setWriteEnabled] = useState(false);
  const [publishRow, setPublishRow] = useState<HarvestRowDto | null>(null);
  const [storagePaste, setStoragePaste] = useState("");
  const [permission, setPermission] = useState<PermissionPrompt | null>(null);
  const [pendingArgs, setPendingArgs] = useState<Record<string, unknown>>({});

  const refresh = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const [list, cf] = await Promise.all([
        hostListHarvests(100),
        hostGetConfluence(),
      ]);
      setRows(list);
      setWriteEnabled(Boolean(cf?.write_enabled));
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

  const startPublish = async (row: HarvestRowDto) => {
    setErr(null);
    setNote(null);
    if (!writeEnabled) {
      setErr(
        "Enable write_enabled in Settings → Connectors before Publish.",
      );
      return;
    }
    if (!row.canPublishFromLocal && !storagePaste.trim()) {
      setPublishRow(row);
      setNote(
        "This harvest is not raw_storage — paste Confluence storage HTML to publish (K16).",
      );
      return;
    }
    if (row.remoteVersion == null && !row.canPublishFromLocal) {
      // still need version for update
    }
    if (row.remoteVersion == null) {
      setErr(
        "Harvest has no remote_version — ask the agent to run check_source_sync first.",
      );
      return;
    }
    setBusy(true);
    try {
      const events = await hostProposeConfluencePublish({
        harvestId: row.id,
        bodyStorageOverride: storagePaste.trim() || undefined,
      });
      const { permission: perm } = applyEventsToMessage(
        { id: "pub", role: "assistant", content: "" },
        events,
      );
      const pr = events.find((e) => e.kind === "permission_required");
      const a = pr?.payload?.arguments;
      if (a && typeof a === "object" && !Array.isArray(a)) {
        setPendingArgs(a as Record<string, unknown>);
      } else {
        setPendingArgs({});
      }
      if (perm) {
        setPermission(perm);
        setPublishRow(null);
      } else {
        // Unexpected: no permission event (e.g. already granted) — surface raw
        const ok = events.some((e) => e.kind === "tool" || e.kind === "turn_completed");
        setNote(
          ok
            ? "Publish tool finished without a new prompt."
            : "No permission prompt returned — check write_enabled and Confluence config.",
        );
        await refresh();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onPermission = async (
    decision: "deny" | "allow_once" | "allow_session_path",
    typed?: string,
  ) => {
    if (!permission) return;
    // Never session-path for Confluence write (UI + core both block).
    const dec =
      decision === "allow_session_path" ? "deny" : decision;
    setBusy(true);
    setPermission(null);
    try {
      const events = await completePermission(
        permission.requestId,
        dec,
        permission.toolName,
        pendingArgs,
        typed,
      );
      const failed = events.some(
        (e) => e.kind === "error" || (e.kind === "tool" && e.payload?.ok === false),
      );
      const denied = dec === "deny";
      if (denied) {
        setNote("Publish denied.");
      } else if (failed) {
        const errEv = events.find((e) => e.kind === "error");
        setErr(
          String(errEv?.payload?.message ?? "Publish failed after grant"),
        );
      } else {
        setNote("Published (HardWrite). Harvest version bumped when harvest_id linked.");
        setStoragePaste("");
        await refresh();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setPendingArgs({});
    }
  };

  return (
    <div className="pane pane--fill">
      <header className="pane-chrome">
        <h2 className="pane-chrome__title">Harvest</h2>
        <div className="pane-chrome__meta">
          <span className="chip chip--static">{rows.length} rows</span>
          {writeEnabled ? (
            <span className="chip chip--static" data-tone="ok">
              write on
            </span>
          ) : (
            <span className="chip chip--static" title="Settings → Connectors">
              write off
            </span>
          )}
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
        Provenance-linked Confluence harvests (SoftWrite). Re-sync: agent{" "}
        <code>check_source_sync</code> / <code>apply_source_sync</code>.{" "}
        <strong>Publish</strong> updates remote via HardWrite (type{" "}
        <code>WRITE</code>) when <code>write_enabled</code> is on — preferred for{" "}
        <code>raw_storage</code> harvests.
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
      {note ? (
        <p className="field__hint" role="status" style={{ padding: "0 1rem" }}>
          {note}
        </p>
      ) : null}
      {publishRow ? (
        <div
          className="settings-connector-block"
          style={{ margin: "0 1rem 1rem" }}
          role="dialog"
          aria-label="Paste storage for publish"
        >
          <h3 className="settings-connector-block__title">
            Publish {publishRow.remoteId} (storage paste)
          </h3>
          <p className="field__hint">
            Transform is <code>{publishRow.transform}</code> — paste Confluence
            storage format body (not markdown) to avoid lossy round-trip.
          </p>
          <textarea
            className="field__control"
            rows={6}
            value={storagePaste}
            onChange={(e) => setStoragePaste(e.target.value)}
            placeholder="<p>…</p>"
          />
          <div className="workspace-root-actions">
            <button
              type="button"
              className="btn btn--ghost"
              disabled={busy}
              onClick={() => {
                setPublishRow(null);
                setStoragePaste("");
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy || !storagePaste.trim()}
              onClick={() => void startPublish(publishRow)}
            >
              Propose publish
            </button>
          </div>
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
                  {r.remoteVersion != null ? ` · v${r.remoteVersion}` : ""}
                </span>
                <span className="mem-list__meta">
                  <span
                    className="chip chip--static"
                    data-tone={
                      r.syncStatus === "conflict" ||
                      r.syncStatus === "remote_newer"
                        ? "warn"
                        : undefined
                    }
                  >
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
                  <button
                    type="button"
                    className="btn btn--primary btn--sm"
                    disabled={busy || !writeEnabled}
                    title={
                      writeEnabled
                        ? r.canPublishFromLocal
                          ? "HardWrite update (type WRITE)"
                          : "Requires storage paste (not raw_storage)"
                        : "Enable write_enabled in Settings"
                    }
                    onClick={() => {
                      if (!r.canPublishFromLocal) {
                        setPublishRow(r);
                        setNote(null);
                        return;
                      }
                      void startPublish(r);
                    }}
                  >
                    Publish
                  </button>
                </span>
              </div>
            </li>
          ))
        )}
      </ul>
      <PermissionModal prompt={permission} onRespond={(d, t) => void onPermission(d, t)} />
    </div>
  );
}
