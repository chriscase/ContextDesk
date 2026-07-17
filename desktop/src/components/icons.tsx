/** Inline SVG icons — stroke 1.75, 24 viewBox. Keep silhouettes distinct. */

import type { ReactNode } from "react";

type IconProps = { className?: string; title?: string };

const base = {
  width: 18,
  height: 18,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function Svg({
  children,
  title,
  className,
}: IconProps & { children: ReactNode }) {
  return (
    <svg
      {...base}
      className={className}
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

/** Brand mark — four-point sparkle (not a sun). */
export function IconSpark({ title = "ContextDesk", className }: IconProps) {
  return (
    <Svg title={title} className={className}>
      <path d="M12 3v6M12 15v6M3 12h6M15 12h6" />
      <path d="m7.5 7.5 3 3M13.5 13.5l3 3M16.5 7.5l-3 3M10.5 13.5l-3 3" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** Theme: switch to light. */
export function IconSun({ className }: IconProps) {
  return (
    <Svg className={className}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </Svg>
  );
}

/** Theme: switch to dark. */
export function IconMoon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M21 14.5A8.5 8.5 0 1 1 9.5 3 7 7 0 0 0 21 14.5z" />
    </Svg>
  );
}

export function IconSend({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="m22 2-7 20-4-9-9-4 20-7z" />
      <path d="M22 2 11 13" />
    </Svg>
  );
}

export function IconExpand({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" />
    </Svg>
  );
}

/** Wrench for tool calls. */
export function IconTool({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.5-2.5z" />
    </Svg>
  );
}

/** Gear for settings chrome / general. */
export function IconSettings({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  );
}

export function IconClose({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M18 6 6 18M6 6l12 12" />
    </Svg>
  );
}

/** Circle question mark — setup help / popover trigger. */
export function IconHelp({ className }: IconProps) {
  return (
    <Svg className={className}>
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <path d="M12 17h.01" />
    </Svg>
  );
}

export function IconCheck({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M20 6 9 17l-5-5" />
    </Svg>
  );
}

/** Triangle warning. */
export function IconWarn({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <path d="M12 9v4M12 17h.01" />
    </Svg>
  );
}

/** Circle error / alert. */
export function IconAlert({ className }: IconProps) {
  return (
    <Svg className={className}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v5M12 16h.01" />
    </Svg>
  );
}

export function IconRefresh({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </Svg>
  );
}

/** Preflight / health checklist. */
export function IconPreflight({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M9 11 12 14l8-8" />
      <path d="M21 12a9 9 0 1 1-3.2-6.8" />
    </Svg>
  );
}

/** Workspace / folders. */
export function IconWorkspace({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9l-.81-1.2A2 2 0 0 0 7.93 2H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2z" />
    </Svg>
  );
}

/** AI / models — CPU chip. */
export function IconAi({ className }: IconProps) {
  return (
    <Svg className={className}>
      <rect x="5" y="5" width="14" height="14" rx="2" />
      <path d="M9 9h6v6H9z" />
      <path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" />
    </Svg>
  );
}

/** Connectors / plug. */
export function IconConnectors({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M12 2v6" />
      <path d="M8 8h8" />
      <path d="M7 8v3a5 5 0 0 0 10 0V8" />
      <path d="M12 16v6" />
    </Svg>
  );
}

/** Appearance / palette. */
export function IconAppearance({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M12 22a10 10 0 1 1 0-20 10 10 0 0 1 0 20z" />
      <path d="M12 2a4 4 0 0 1 0 8 4 4 0 0 0 0 8" />
      <circle cx="12" cy="7" r="1" fill="currentColor" stroke="none" />
      <circle cx="16.5" cy="10" r="1" fill="currentColor" stroke="none" />
      <circle cx="16.5" cy="14" r="1" fill="currentColor" stroke="none" />
      <circle cx="7.5" cy="10" r="1" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** General — sliders. */
export function IconSliders({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M2 14h4M10 8h4M18 16h4" />
    </Svg>
  );
}

/** External link (corner arrow). */
export function IconLink({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <path d="M15 3h6v6" />
      <path d="m10 14 11-11" />
    </Svg>
  );
}

/** Document / workspace file. */
export function IconFile({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6M8 13h8M8 17h6" />
    </Svg>
  );
}

/** Globe for web sources. */
export function IconWeb({ className }: IconProps) {
  return (
    <Svg className={className}>
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </Svg>
  );
}
