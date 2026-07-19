/**
 * Skin registry (#300 / #54).
 *
 * Adding a skin:
 * 1. Add `desktop/src/styles/themes/<id>.css` with `html[data-theme="<id>"] { … }`
 *    defining every semantic token (see docs/SKINS.md).
 * 2. Import the CSS from `src/main.tsx`.
 * 3. Append an entry here (include swatches for the Appearance picker).
 * 4. Append the id to the allow-list in `public/theme-init.js` (pre-paint).
 * 5. Add/extend an AA contrast test for text tokens on --bg-app / --bg-panel.
 */

export type SkinId = "dark" | "light" | "slate" | "sand" | "forest";

/** Mini-preview swatches for the Appearance card grid (mirror theme CSS). */
export type SkinSwatches = {
  app: string;
  panel: string;
  elevated: string;
  accent: string;
  text: string;
};

export type SkinMeta = {
  id: SkinId;
  /** Settings / UI label */
  label: string;
  /** Short description for Appearance lead */
  description: string;
  /** OS form controls / scrollbars */
  colorScheme: "dark" | "light";
  /** Card preview colors (hex) — not applied to the live document */
  swatches: SkinSwatches;
};

/** Canonical registry — order is Appearance select + titlebar cycle order. */
export const SKINS: readonly SkinMeta[] = [
  {
    id: "dark",
    label: "Dark",
    description: "Default dense dark chrome",
    colorScheme: "dark",
    swatches: {
      app: "#0b0c0e",
      panel: "#12141a",
      elevated: "#181b22",
      accent: "#6ea8fe",
      text: "#e8eaed",
    },
  },
  {
    id: "light",
    label: "Light",
    description: "Cool light panels for bright rooms",
    colorScheme: "light",
    swatches: {
      app: "#f4f5f7",
      panel: "#ffffff",
      elevated: "#eef0f4",
      accent: "#2f6fed",
      text: "#1a1d24",
    },
  },
  {
    id: "slate",
    label: "Slate",
    description: "GitHub-adjacent dark blue-gray",
    colorScheme: "dark",
    swatches: {
      app: "#0f1419",
      panel: "#161b22",
      elevated: "#1c232d",
      accent: "#58a6ff",
      text: "#e6edf3",
    },
  },
  {
    id: "sand",
    label: "Sand",
    description: "Warm paper light for long reading",
    colorScheme: "light",
    swatches: {
      app: "#f6f1e8",
      panel: "#fffaf3",
      elevated: "#efe6d8",
      accent: "#a34a08",
      text: "#2a241c",
    },
  },
  {
    id: "forest",
    label: "Forest",
    description: "Verdant dark coding chrome",
    colorScheme: "dark",
    swatches: {
      app: "#0c1210",
      panel: "#121a17",
      elevated: "#18221e",
      accent: "#3ecf8e",
      text: "#e4ebe7",
    },
  },
] as const;

export const DEFAULT_SKIN: SkinId = "dark";

const SKIN_IDS = new Set<string>(SKINS.map((s) => s.id));

export function isSkinId(value: string | null | undefined): value is SkinId {
  return typeof value === "string" && SKIN_IDS.has(value);
}

export function parseSkinId(value: string | null | undefined): SkinId {
  return isSkinId(value) ? value : DEFAULT_SKIN;
}

export function skinMeta(id: SkinId): SkinMeta {
  return SKINS.find((s) => s.id === id) ?? SKINS[0]!;
}

/** Next skin in registry order (titlebar cycle). */
export function nextSkinId(current: SkinId): SkinId {
  const i = SKINS.findIndex((s) => s.id === current);
  const idx = i < 0 ? 0 : (i + 1) % SKINS.length;
  return SKINS[idx]!.id;
}

/** Ids as a comma-separated list for theme-init sync tests. */
export function skinIdList(): SkinId[] {
  return SKINS.map((s) => s.id);
}
