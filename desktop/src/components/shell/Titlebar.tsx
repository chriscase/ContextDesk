import { IconMoon, IconSettings, IconSpark, IconSun } from "../icons";

type Props = {
  productName: string;
  scopeLabel: string;
  egressLabel: string;
  localOnly: boolean;
  hasWorkspace: boolean;
  theme: "dark" | "light";
  onOpenWorkspace: () => void;
  onOpenAi: () => void;
  onOpenSettings: () => void;
  onToggleTheme: () => void;
};

/** App chrome titlebar (#146). */
export function Titlebar({
  productName,
  scopeLabel,
  egressLabel,
  localOnly,
  hasWorkspace,
  theme,
  onOpenWorkspace,
  onOpenAi,
  onOpenSettings,
  onToggleTheme,
}: Props) {
  return (
    <header className="titlebar">
      <div className="titlebar__brand">
        <IconSpark title={productName} />
        <span>{productName}</span>
        <button
          type="button"
          className="chip"
          data-tone={hasWorkspace ? "ok" : "warn"}
          onClick={onOpenWorkspace}
          title="Workspace scope"
        >
          {scopeLabel}
        </button>
        <button
          type="button"
          className="chip"
          data-tone={localOnly ? "ok" : "warn"}
          onClick={onOpenAi}
          title={
            localOnly
              ? "Local-only profile — remote bases refused"
              : "Remote provider may send prompts off-machine"
          }
        >
          {egressLabel}
        </button>
      </div>
      <div className="titlebar__actions">
        <button
          type="button"
          className="icon-btn"
          title="Settings & preflight"
          onClick={onOpenSettings}
        >
          <IconSettings />
        </button>
        <button
          type="button"
          className="icon-btn"
          title={theme === "dark" ? "Light mode" : "Dark mode"}
          onClick={onToggleTheme}
        >
          {theme === "dark" ? <IconSun /> : <IconMoon />}
        </button>
      </div>
    </header>
  );
}
