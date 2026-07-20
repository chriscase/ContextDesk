import type { MouseEvent as ReactMouseEvent } from "react";
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

/**
 * Start OS window drag from a titlebar drag region (Magic Trackpad–friendly).
 * Needs capability `core:window:allow-start-dragging` + remote localhost in
 * capabilities/default.json for `tauri dev` (devUrl is remote from ACL's view).
 * Failures are always swallowed; CSS `-webkit-app-region: drag` is fallback.
 */
function startWindowDrag(e: ReactMouseEvent): void {
  if (e.button !== 0) return;
  const t = e.target;
  if (!(t instanceof Element)) return;
  if (t.closest("button, a, input, select, textarea, [data-no-drag]")) return;
  if (!t.closest("[data-tauri-drag-region]")) return;
  e.preventDefault();
  void import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => getCurrentWindow().startDragging())
    .catch(() => {
      /* ACL / browser — CSS app-region still applies */
    });
}

/** App chrome titlebar (#146 / #153). */
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
    <header
      className="titlebar"
      data-tauri-drag-region
      onMouseDown={startWindowDrag}
    >
      <div className="titlebar__brand" data-tauri-drag-region>
        <IconSpark title={productName} />
        <span data-tauri-drag-region>{productName}</span>
        <button
          type="button"
          className="chip titlebar__no-drag"
          data-no-drag
          data-tone={hasWorkspace ? "ok" : "warn"}
          onClick={onOpenWorkspace}
          title="Workspace scope"
        >
          {scopeLabel}
        </button>
        <button
          type="button"
          className="chip titlebar__no-drag"
          data-no-drag
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
      {/* Dedicated empty drag surface — chips/actions otherwise leave almost none. */}
      <div className="titlebar__drag" data-tauri-drag-region aria-hidden />
      <div className="titlebar__actions" data-no-drag>
        <span
          className="titlebar__kbd-hint titlebar__no-drag"
          title="Command palette"
          aria-hidden
        >
          {typeof navigator !== "undefined" &&
          /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent)
            ? "⌘K"
            : "Ctrl+K"}
        </span>
        <button
          type="button"
          className="icon-btn titlebar__no-drag"
          data-no-drag
          title="Settings & preflight"
          onClick={onOpenSettings}
        >
          <IconSettings />
        </button>
        <button
          type="button"
          className="icon-btn titlebar__no-drag"
          data-no-drag
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
