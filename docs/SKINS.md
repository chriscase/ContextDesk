# Skins (theme tokens)

ContextDesk skins recolor the desktop via **semantic CSS variables** on
`html[data-theme="<id>"]`. Components and layout CSS must not hard-code brand
colors; they consume tokens only.

Parent epic: **#300**. Registry issue: **#54**.

## Built-in skins

| Id | Label | `color-scheme` | File |
|----|-------|----------------|------|
| `dark` | Dark | dark | `desktop/src/styles/themes/dark.css` |
| `light` | Light | light | `desktop/src/styles/themes/light.css` |
| `slate` | Slate | dark | `desktop/src/styles/themes/slate.css` |

Structure (radii, type scale, space) lives in `desktop/src/styles/tokens.css` and
is shared by every skin.

## How to add a skin

1. **Copy a theme file** closest to your target (e.g. `dark.css` → `ember.css`).
2. Change the selector to `html[data-theme="ember"]` and set `color-scheme`.
3. Fill **every required token** (table below). Prefer hex for AA math tests.
4. **Import** the CSS in `desktop/src/main.tsx` next to the other themes.
5. **Register** in `desktop/src/lib/skins.ts` (`SKINS` array + `SkinId` union).
6. **Pre-paint:** add the id to the `KNOWN` map in `desktop/public/theme-init.js`.
7. **AA test:** extend or clone `desktop/src/styles/themes/slateContrast.test.ts`
   so `--text-faint` (and status/accent used as text) are ≥ 4.5:1 on `--bg-app`
   and `--bg-panel`.
8. Run `cd desktop && npm test` and flip Appearance → your skin on every pane.

Do **not** edit component TSX for a new palette. If a screen still hard-codes a
color, fix that screen to use a token (that is a #300 polish item).

## Required semantic tokens

Every skin must define:

| Token | Role |
|-------|------|
| `--bg-app` | Window background |
| `--bg-panel` | Sidebars / chrome panels |
| `--bg-elevated` | Cards, elevated surfaces |
| `--bg-input` | Inputs / textareas |
| `--bg-hover` | Hover wash |
| `--border` | Default borders |
| `--border-soft` | Subtle dividers |
| `--border-strong` | Emphasized borders |
| `--text` | Primary body text |
| `--text-muted` | Secondary text |
| `--text-faint` | Meta / tertiary (≥ 4.5:1 on app **and** panel) |
| `--accent` | Primary actions / focus hue |
| `--accent-strong` | Accent hover |
| `--accent-soft` | Soft accent fill |
| `--accent-on` | Text/icons on solid accent buttons |
| `--link` | Body links (may differ from accent for AA) |
| `--success` / `--warning` / `--danger` | Status |
| `--tool-bg` | Tool trail surfaces |
| `--chat-user-bg` | User bubble |
| `--chat-assistant-bg` | Assistant bubble (often transparent) |
| `--surface-deep` | Deepest wells |
| `--surface-chrome` | Nested chrome |
| `--surface-chip` | Chips / pills |
| `--status-bar-bg` | Bottom status bar |
| `--overlay-scrim` | Modal scrim |
| `--overlay-soft` / `--overlay-faint` | Soft overlays |
| `--focus-ring` | `:focus-visible` ring (box-shadow) |
| `--shadow-sm` / `--shadow-md` / `--shadow-inset` | Elevation (re-tint on light skins) |
| `--composer-shadow` / `--composer-shadow-focus` | Composer shell elevation |
| `--btn-inset` | Primary button top highlight |

Optional component-local vars (e.g. `--src-hue` on citations) are set in TSX and
are not part of the skin file.

## Runtime

- Preference key: `localStorage["cd-theme"]` = skin id.
- Applied as `document.documentElement.setAttribute("data-theme", id)`.
- `theme-init.js` runs before the module bundle to avoid a wrong-theme flash.
- Appearance settings and the titlebar control both cycle/select via the registry.

## Verification checklist

- [ ] Appearance lists the new skin; selection persists across reload
- [ ] Titlebar cycle reaches the new skin
- [ ] Chat, Memory, Compose, Settings, permission modal readable
- [ ] Contrast tests green
- [ ] No new raw hex in `desktop/src/components/**`
