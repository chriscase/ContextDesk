import { SelectField } from "../forms";
import type { SkinId } from "../../lib/skins";
import { ThemePicker } from "../ThemePicker";

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
  return (
    <div>
      <p className="section-lead">
        Choose the theme used throughout ContextDesk. Changes apply immediately
        — no Save required.
      </p>

      <ThemePicker
        variant="settings"
        theme={theme}
        onThemeChange={onThemeChange}
      />
      <p className="field__hint">
        The selected theme is applied and persisted immediately.
      </p>

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
