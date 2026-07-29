import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import {
  IconCheck,
  IconChevronDown,
  IconMoon,
  IconSun,
} from "./icons";
import { SKINS, skinMeta, type SkinId, type SkinMeta } from "../lib/skins";

type ThemePickerProps = {
  theme: SkinId;
  onThemeChange: (theme: SkinId) => void;
  variant: "toolbar" | "settings";
};

function previewStyle(skin: SkinMeta): CSSProperties {
  return {
    "--theme-preview-app": skin.swatches.app,
    "--theme-preview-panel": skin.swatches.panel,
    "--theme-preview-elevated": skin.swatches.elevated,
    "--theme-preview-accent": skin.swatches.accent,
  } as CSSProperties;
}

function ThemePalette({ skin }: { skin: SkinMeta }) {
  return (
    <span
      className="theme-picker__palette"
      style={previewStyle(skin)}
      aria-hidden="true"
    >
      <span data-tone="app" />
      <span data-tone="panel" />
      <span data-tone="elevated" />
      <span data-tone="accent" />
    </span>
  );
}

export function ThemePicker({
  theme,
  onThemeChange,
  variant,
}: ThemePickerProps) {
  const active = skinMeta(theme);
  const [open, setOpen] = useState(false);
  const listboxId = useId();
  const optionIdPrefix = `${listboxId}-theme-option`;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) {
      window.setTimeout(() => triggerRef.current?.focus(), 0);
    }
  };

  useEffect(() => {
    if (!open) return;
    const selectedIndex = Math.max(
      0,
      SKINS.findIndex((skin) => skin.id === theme),
    );
    window.requestAnimationFrame(() => optionRefs.current[selectedIndex]?.focus());

    const onPointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !rootRef.current?.contains(event.target)
      ) {
        close(false);
      }
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close(true);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, theme]);

  const moveOptionFocus = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    let next: number;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      next = (index + 1) % SKINS.length;
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      next = (index - 1 + SKINS.length) % SKINS.length;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = SKINS.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    optionRefs.current[next]?.focus();
  };

  return (
    <div
      ref={rootRef}
      className={`theme-picker theme-picker--${variant}`}
      data-no-drag={variant === "toolbar" ? "" : undefined}
    >
      {variant === "toolbar" ? (
        <button
          ref={triggerRef}
          type="button"
          className="icon-btn titlebar__no-drag theme-picker__toolbar-trigger"
          data-no-drag
          aria-label={`Appearance, current theme ${active.label}`}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listboxId : undefined}
          title={`Appearance · ${active.label}`}
          onClick={() => setOpen((value) => !value)}
        >
          {active.colorScheme === "dark" ? <IconSun /> : <IconMoon />}
        </button>
      ) : (
        <button
          ref={triggerRef}
          type="button"
          className="theme-picker__settings-trigger"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listboxId : undefined}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="theme-picker__settings-label">Theme</span>
          <ThemePalette skin={active} />
          <span className="theme-picker__settings-copy">
            <strong>{active.label}</strong>
            <span>{active.description}</span>
          </span>
          <IconChevronDown className="theme-picker__chevron" />
        </button>
      )}

      {open ? (
        <div
          id={listboxId}
          className="theme-picker__popover"
          role="listbox"
          aria-label="Choose appearance theme"
        >
          <div className="theme-picker__heading">
            <strong>Appearance</strong>
            <span>Preview a theme before choosing it.</span>
          </div>
          <div className="theme-picker__options">
            {SKINS.map((skin, index) => (
              <button
                key={skin.id}
                id={`${optionIdPrefix}-${skin.id}`}
                ref={(node) => {
                  optionRefs.current[index] = node;
                }}
                type="button"
                role="option"
                aria-selected={skin.id === theme}
                className="theme-picker__option"
                onKeyDown={(event) => moveOptionFocus(event, index)}
                onClick={() => {
                  onThemeChange(skin.id);
                  close(true);
                }}
              >
                <ThemePalette skin={skin} />
                <span className="theme-picker__option-copy">
                  <strong>{skin.label}</strong>
                  <span>{skin.description}</span>
                </span>
                <span
                  className="theme-picker__check"
                  aria-hidden="true"
                  data-visible={skin.id === theme ? "true" : "false"}
                >
                  <IconCheck />
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
