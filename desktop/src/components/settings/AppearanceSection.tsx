import { SelectField } from "../forms";
import { SKINS, type SkinId } from "../../lib/skins";

export type AppearanceSectionProps = {
  baseId: string;
  theme: SkinId;
  onThemeChange: (t: SkinId) => void;
  uiScale: "90" | "100" | "110";
  onUiScaleChange?: (s: "90" | "100" | "110") => void;
};

export function AppearanceSection({
  baseId,
  theme,
  onThemeChange,
  uiScale,
  onUiScaleChange,
}: AppearanceSectionProps) {
  const active = SKINS.find((s) => s.id === theme);
  return (
    <div>
      <p className="section-lead">
        Skins recolor the whole shell via design tokens (
        <code>docs/SKINS.md</code>). Applies immediately — no Save required.
      </p>

      <div className="field">
        <div className="field__label-row">
          <label className="field__label" id={`${baseId}-skin-label`}>
            Skin
          </label>
        </div>
        <div
          className="skin-grid"
          role="radiogroup"
          aria-labelledby={`${baseId}-skin-label`}
        >
          {SKINS.map((s) => {
            const selected = s.id === theme;
            const { swatches: w } = s;
            return (
              <button
                key={s.id}
                type="button"
                role="radio"
                className="skin-card"
                data-selected={selected ? "true" : "false"}
                aria-checked={selected}
                onClick={() => onThemeChange(s.id)}
              >
                <div
                  className="skin-card__preview"
                  aria-hidden
                  style={{ background: w.app, borderColor: w.panel }}
                >
                  <div
                    className="skin-card__chrome"
                    style={{ background: w.panel }}
                  />
                  <div className="skin-card__body">
                    <div
                      className="skin-card__rail"
                      style={{ background: w.panel }}
                    />
                    <div className="skin-card__main">
                      <div
                        className="skin-card__bubble"
                        style={{ background: w.elevated, color: w.text }}
                      />
                      <div
                        className="skin-card__accent"
                        style={{ background: w.accent }}
                      />
                    </div>
                  </div>
                </div>
                <span className="skin-card__label">{s.label}</span>
                <span className="skin-card__desc">{s.description}</span>
              </button>
            );
          })}
        </div>
        {active ? (
          <p className="field__hint">{active.description}</p>
        ) : null}
      </div>

      <SelectField
        id={`${baseId}-ui-scale`}
        label="UI scale"
        hint="Scales the rem type system (root font-size). Persists locally."
        value={uiScale}
        onChange={(e) => {
          const v = e.target.value;
          const next = v === "90" || v === "110" || v === "100" ? v : "100";
          onUiScaleChange?.(next);
        }}
      >
        <option value="90">Small (90%)</option>
        <option value="100">Default (100%)</option>
        <option value="110">Large (110%)</option>
      </SelectField>
    </div>
  );
}
