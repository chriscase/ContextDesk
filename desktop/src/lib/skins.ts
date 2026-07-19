/**
 * Skin registry (#300 / #54).
 *
 * Adding a skin:
 * 1. Add `desktop/src/styles/themes/<id>.css` with `html[data-theme="<id>"] { … }`
 *    defining every semantic token (see docs/SKINS.md).
 * 2. Import the CSS from `src/main.tsx`.
 * 3. Append an entry here.
 * 4. Append the id to the allow-list in `public/theme-init.js` (pre-paint).
 * 5. Add/extend an AA contrast test for text tokens on --bg-app / --bg-panel.
 */

export type SkinId = "dark" | "light" | "slate";

export type SkinMeta = {
  id: SkinId;
  /** Settings / UI label */
  label: string;
  /** Short description for Appearance lead */
  description: string;
  /** OS form controls / scrollbars */
  colorScheme: "dark" | "light";
};

/** Canonical registry — order is Appearance select + titlebar cycle order. */
export const SKINS: readonly SkinMeta[] = [
  {
    id: "dark",
    label: "Dark",
    description: "Default dense dark chrome",
    colorScheme: "dark",
  },
  {
    id: "light",
    label: "Light",
    description: "Light panels for bright rooms",
    colorScheme: "light",
  },
  {
    id: "slate",
    label: "Slate",
    description: "GitHub-adjacent dark blue-gray",
    colorScheme: "dark",
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
