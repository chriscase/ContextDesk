/**
 * Multi-model review mode toggle. On/off control for the reviewer pipeline.
 *
 * Turning it on sets the configured default mode to `review`; corpus-linked
 * investigation turns then run investigator → reviewer → synthesis, degrading
 * to single-model (with a reported reason) whenever the reviewer is
 * unconfigured, unqualified, remote-without-acknowledgment, over budget, or
 * the turn is not eligible. The reviewer references a provider profile id;
 * credentials never leave the Rust host.
 */
import { useEffect, useState } from "react";
import {
  hostGetMultiModelSettings,
  hostSetMultiModelMode,
  type MultiModelSettingsDto,
} from "../../lib/host";

export function MultiModelReviewToggle() {
  const [settings, setSettings] = useState<MultiModelSettingsDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void hostGetMultiModelSettings()
      .then((s) => {
        if (alive) setSettings(s);
      })
      .catch(() => {
        if (alive) setSettings(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!settings) return null;

  const enabled = settings.mode === "review";

  async function toggle(next: boolean) {
    setBusy(true);
    setError(null);
    try {
      await hostSetMultiModelMode(next ? "review" : "single");
      const fresh = await hostGetMultiModelSettings();
      setSettings(fresh);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-block">
      <h3 className="settings-block__title">Multi-model review</h3>
      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy}
          onChange={(e) => void toggle(e.target.checked)}
        />
        <span>Review investigations with a second model</span>
      </label>
      <p className="settings-block__hint">
        {settings.reviewer_profile_id
          ? `Reviewer: ${settings.reviewer_profile_id}${
              settings.reviewer_model ? ` · ${settings.reviewer_model}` : ""
            }${settings.reviewer_require_qualified ? " · requires qualification" : ""}${
              settings.reviewer_allow_remote ? " · remote allowed" : ""
            }`
          : "No reviewer configured — review will degrade to single-model until a reviewer profile is set."}
      </p>
      {error ? <p className="settings-block__error">{error}</p> : null}
    </section>
  );
}
