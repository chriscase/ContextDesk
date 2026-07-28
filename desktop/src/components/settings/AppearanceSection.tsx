import type { CSSProperties } from "react";
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
  const active = SKINS.find((skin) => skin.id === theme) ?? SKINS[0];
  const previewStyle = {
    "--theme-preview-app": active.swatches.app,
    "--theme-preview-panel": active.swatches.panel,
    "--theme-preview-elevated": active.swatches.elevated,
    "--theme-preview-accent": active.swatches.accent,
  } as CSSProperties;

  return (
    <div>
      <p className="section-lead">
        Choose the theme used throughout ContextDesk. Changes apply immediately
        — no Save required.
      </p>

      <div className="appearance-theme-picker">
        <SelectField
          id={`${baseId}-theme`}
          label="Theme"
          hint="The selected theme is applied and persisted immediately."
          value={theme}
          onChange={(event) => {
            const next = SKINS.find(
              (skin) => skin.id === event.currentTarget.value,
            );
            if (next) onThemeChange(next.id);
          }}
        >
          {SKINS.map((skin) => (
            <option key={skin.id} value={skin.id}>
              {skin.label}
            </option>
          ))}
        </SelectField>

        <div
          className="appearance-theme-preview"
          role="status"
          aria-label="Selected theme preview"
          aria-live="polite"
          aria-atomic="true"
          style={previewStyle}
        >
          <span className="appearance-theme-preview__palette" aria-hidden="true">
            <span data-tone="app" />
            <span data-tone="panel" />
            <span data-tone="elevated" />
            <span data-tone="accent" />
          </span>
          <span className="appearance-theme-preview__copy">
            <strong>{active.label}</strong>
            <span>{active.description}</span>
          </span>
        </div>
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
