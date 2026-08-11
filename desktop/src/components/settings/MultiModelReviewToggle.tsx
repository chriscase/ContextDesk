/**
 * Multi-model investigation mode selector. It keeps the established
 * single-model default while exposing the opt-in reviewer and contribution
 * routes through the same host command.
 *
 * The reviewer and contribution routes degrade honestly when their configured
 * roles are unavailable. Provider profiles and credentials stay host-owned.
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

  const mode =
    settings.mode === "review" || settings.mode === "contributions"
      ? settings.mode
      : "single";

  async function setMode(next: "single" | "review" | "contributions") {
    setBusy(true);
    setError(null);
    try {
      await hostSetMultiModelMode(next);
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
      <h3 className="settings-block__title">Investigation mode</h3>
      <label>
        <span className="sr-only">Investigation mode</span>
        <select
          value={mode}
          disabled={busy}
          onChange={(e) =>
            void setMode(e.target.value as "single" | "review" | "contributions")
          }
        >
          <option value="single">Single model</option>
          <option value="review">Single model + reviewer</option>
          <option value="contributions">Bounded model contributions</option>
        </select>
      </label>
      <p className="settings-block__hint">
        {mode === "contributions"
          ? "Uses explicitly configured, qualified roles and always keeps the host as final authority."
          : mode === "review"
            ? "Adds one qualified reviewer and degrades honestly when unavailable."
            : "Uses the established single-model path."}
      </p>
      <p className="settings-block__hint">
        {settings.reviewer_profile_id
          ? `Reviewer: ${settings.reviewer_profile_id}${
              settings.reviewer_model ? ` · ${settings.reviewer_model}` : ""
            }${settings.reviewer_require_qualified ? " · requires qualification" : ""}${
              settings.reviewer_allow_remote ? " · remote allowed" : ""
            }`
          : "No reviewer configured — reviewer mode will degrade to single-model until a profile is set."}
      </p>
      {error ? <p className="settings-block__error">{error}</p> : null}
    </section>
  );
}
