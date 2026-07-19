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
        <code>docs/SKINS.md</code>). Default is Dark; Light and Slate ship
        built-in — add more by registering a theme CSS file.
      </p>
      <SelectField
        id={`${baseId}-theme`}
        label="Skin"
        hint={active?.description}
        value={theme}
        onChange={(e) => onThemeChange(e.target.value as SkinId)}
      >
        {SKINS.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </SelectField>
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
