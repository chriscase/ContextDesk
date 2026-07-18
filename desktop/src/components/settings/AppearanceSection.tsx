import { SelectField } from "../forms";

export type AppearanceSectionProps = {
  baseId: string;
  theme: "dark" | "light";
  onThemeChange: (t: "dark" | "light") => void;
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
      <p className="section-lead">Dark is default. Light is available; more skins later.</p>
      <SelectField
        id={`${baseId}-theme`}
        label="Theme"
        value={theme}
        onChange={(e) =>
          onThemeChange(e.target.value === "light" ? "light" : "dark")
        }
      >
        <option value="dark">Dark</option>
        <option value="light">Light</option>
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
