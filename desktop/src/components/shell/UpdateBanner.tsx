/**
 * Opt-in background update available banner (#339).
 * Never installs silently — user must click through confirm flow.
 */
import { useEffect, useState } from "react";
import {
  hostCheckForUpdates,
  hostInstallUpdate,
  type BrandingDto,
} from "../../lib/host";
import {
  loadUpdatePollPrefs,
  mayUseInstallerUpdates,
  saveUpdatePollPrefs,
  shouldPollNow,
} from "../../lib/updatePoll";

type Props = {
  branding: BrandingDto;
};

export function UpdateBanner({ branding }: Props) {
  const [available, setAvailable] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!mayUseInstallerUpdates(branding.channel)) return;
    const prefs = loadUpdatePollPrefs();
    if (!shouldPollNow(prefs, Date.now())) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await hostCheckForUpdates();
        if (cancelled) return;
        saveUpdatePollPrefs({
          ...loadUpdatePollPrefs(),
          lastCheckAt: Date.now(),
        });
        if (r.available && r.version) {
          setAvailable(r.version);
        }
      } catch {
        // Quiet failure — offline is normal
        saveUpdatePollPrefs({
          ...loadUpdatePollPrefs(),
          lastCheckAt: Date.now(),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [branding.channel]);

  if (!available) return null;

  return (
    <div className="banner" role="status" data-testid="update-available-banner">
      <span className="banner__msg">
        <strong>Update available</strong>
        Version {available} is ready. Nothing installs without your confirmation.
        {note ? ` · ${note}` : null}
      </span>
      <span className="banner__actions">
        <button
          type="button"
          className="btn btn--primary btn--sm"
          disabled={busy}
          onClick={() => {
            void (async () => {
              setBusy(true);
              setNote(null);
              try {
                const { dialogConfirm } = await import("../../lib/dialogs");
                const ok = await dialogConfirm(
                  `Download and install ${available}? The app will restart after install.`,
                  { title: "Install update", kind: "info" },
                );
                if (!ok) {
                  setNote("Install cancelled");
                  return;
                }
                setNote("Downloading…");
                await hostInstallUpdate();
                setNote("Installed — restart if needed");
                setAvailable(null);
              } catch (e) {
                setNote(e instanceof Error ? e.message : "Update failed");
              } finally {
                setBusy(false);
              }
            })();
          }}
        >
          {busy ? "Working…" : "Review update…"}
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => setAvailable(null)}
        >
          Dismiss
        </button>
      </span>
    </div>
  );
}
