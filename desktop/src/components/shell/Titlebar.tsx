import { IconMoon, IconSettings, IconSpark, IconSun } from "../icons";
import { nextSkinId, skinMeta, type SkinId } from "../../lib/skins";

type Props = {
  productName: string;
  scopeLabel: string;
  egressLabel: string;
  localOnly: boolean;
  hasWorkspace: boolean;
  theme: SkinId;
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
    <header className="titlebar" data-tauri-drag-region>
      <div className="titlebar__brand" data-tauri-drag-region>
        <IconSpark title={productName} />
        <span data-tauri-drag-region>{productName}</span>
        <button
          type="button"
          className="chip titlebar__no-drag"
          data-tone={hasWorkspace ? "ok" : "warn"}
          onClick={onOpenWorkspace}
          title="Workspace scope"
        >
          {scopeLabel}
        </button>
        <button
          type="button"
          className="chip titlebar__no-drag"
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
        <span
          className="titlebar__kbd-hint titlebar__no-drag"
          title="Command palette"
          aria-hidden
        >
          ⌘K
        </span>
        <button
          type="button"
          className="icon-btn titlebar__no-drag"
          title="Settings & preflight"
          onClick={onOpenSettings}
        >
          <IconSettings />
        </button>
        <button
          type="button"
          className="icon-btn titlebar__no-drag"
          title={`Skin: ${skinMeta(theme).label} → ${skinMeta(nextSkinId(theme)).label}`}
          aria-label={`Cycle skin (current ${skinMeta(theme).label})`}
          onClick={onToggleTheme}
        >
          {skinMeta(theme).colorScheme === "dark" ? <IconSun /> : <IconMoon />}
        </button>
      </div>
    </header>
  );
}
