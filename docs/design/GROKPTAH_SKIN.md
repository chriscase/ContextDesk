# GrokPtah skin

**Status:** UI-only addition on branch `feat/ui-grokptah-skin-v1`, branched
from the exact release SHA `60107c5e` (`integrate/acceptance-release-v1`).
Skin/token work only — no Rust, provider, CLI, gateway-diagnostic, config, or
acceptance-behavior change. `dark` remains `DEFAULT_SKIN`; this doc records no
default-skin change.

## What it is

A registered desktop skin (`SkinId: "grokptah"`) via the existing skin
registry/theme-bridge/prepaint path documented in `docs/SKINS.md` — same
mechanism as `dark`/`light`/`slate`/`sand`/`forest`, no new architecture.
Graphite dark coding-workbench palette with a warm gold accent:

| Token | Value | Role |
|---|---|---|
| `--bg-app` | `#0b0c0e` | Window background |
| `--bg-panel` | `#12141a` | Sidebars / chrome |
| `--bg-elevated` | `#181b22` | Cards / elevated surfaces |
| `--accent` | `#f0b429` | Primary actions, links, focus ring |
| `--warning` | `#ff8a3d` | Status warning — deliberately ~18° hue-separated from `--accent` so gold-accent UI chrome and an actual warning state never read as the same signal |
| `--success` / `--danger` | `#7fd99a` / `#ff6b6b` | Status |

Full token set: `desktop/src/styles/themes/grokptah.css`. Font stack (Inter +
IBM Plex Mono) is structural (`desktop/src/styles/tokens.css`), shared by
every skin — nothing skin-specific was needed there.

## Files touched

- `desktop/src/styles/themes/grokptah.css` (new) — full token set
- `desktop/src/lib/skins.ts` — `SkinId` union + `SKINS` registry entry (appended last, so existing skin order/titlebar-cycle positions are unchanged)
- `desktop/src/main.tsx`, `desktop/visual/support/styles.ts` — CSS import, in the same position in both (visual-harness parity test enforces this)
- `desktop/public/theme-init.js` — pre-paint allow-list entry
- `desktop/src/styles/base.css` — added to the existing dark-scheme native `<select>` styling groups
- `desktop/src/styles/tokenResolution.test.ts` — added to the per-theme resolution `it.each` list
- `desktop/src/styles/themes/grokptahContrast.test.ts` (new), `desktop/src/lib/grokptahSkin.test.ts` (new)
- `docs/SKINS.md`, this file

No component TSX was edited, per `docs/SKINS.md`'s "do not edit component TSX
for a new palette" rule — every surface already consumes tokens.

## Visual QA steps

1. `cd desktop && npm run build` (or `npm run dev`), launch the app.
2. Settings → Appearance → select **GrokPtah**. Confirm the card preview
   swatches (graphite backgrounds, gold accent chip) match the live app once
   selected.
3. Confirm persistence: reload the window (or fully quit/relaunch). The skin
   must still read GrokPtah with no flash of another skin's background before
   paint (this is what `theme-init.js` + `critical-boot.css` exist to
   prevent).
4. Titlebar theme-cycle control: click through until GrokPtah appears; it
   should be the same skin Settings shows.
5. Walk the primary panes readable in the checklist `docs/SKINS.md` already
   requires: Chat (including a tool-call trail, to see `--tool-bg`), Memory,
   Compose, Settings, and a permission-prompt modal (`--overlay-scrim`).
6. Trigger one of each status color if convenient: a successful tool result
   (`--success`), a retried/degraded turn or connectivity warning
   (`--warning`), and a failed request (`--danger`) — confirm gold accent UI
   (links, focus rings, the active tab) and the warning state read as
   visibly different colors, not "the same gold twice."
7. Open a secondary window (Log Explorer or the Handbook) while GrokPtah is
   active and confirm it picks up the same skin via the cross-window theme
   bridge.

## Automated coverage

- `desktop/src/lib/skins.test.ts`, `desktop/src/styles/themes/skinContrast.test.ts`,
  `desktop/src/lib/themeBridge.test.ts`, `desktop/src/components/ThemePicker.test.tsx` —
  already generic over every registered skin; GrokPtah is covered automatically.
- `desktop/src/lib/grokptahSkin.test.ts` — GrokPtah-specific registration,
  full required-token-list completeness (the whole table in `docs/SKINS.md`,
  not just the reduced generic subset), pre-paint allow-list membership
  (and non-membership in the light-background map), and a persistence
  round-trip through `localStorage`.
- `desktop/src/styles/themes/grokptahContrast.test.ts` — AA contrast for
  body text, faint text, and every status/accent color against `--bg-app`
  and `--bg-panel`, plus an explicit hue-separation assertion between
  `--accent` and `--warning`.

## Bounded usability audit (recommendations only — not implemented here)

Scope of this lane was the skin itself; the notes below are observations
made while walking the existing chrome under GrokPtah, recorded for a future
UI lane. None of these were implemented, and none require a new skin.

1. **Sidebar/pane navigation depth.** The pane-tab row plus per-pane
   secondary nav (Log Explorer's own left rail, Settings' section list) puts
   some destinations three clicks deep with no persistent breadcrumb once a
   detail view is open. A slim breadcrumb or "back to <pane>" affordance in
   elevated detail views would reduce reorientation cost, independent of
   which skin is active.
2. **Status-color legibility depends on the operator noticing hue, not just
   brightness.** GrokPtah's accent and warning are both warm colors by
   design (matches the "gold" brief); the contrast test now pins their hue
   separation, but nothing in the UI itself pairs color with a redundant
   cue (icon shape, label text) everywhere a status is shown. Worth an
   accessibility pass to confirm every status pill/badge also carries a
   non-color signal (icon or text), not just for GrokPtah but as a
   cross-skin baseline — colorblind users lose the hue cue entirely.
3. **Titlebar skin-cycle discoverability.** The titlebar control cycles
   skins one click at a time with no visible label of which skin is next;
   a first-time user finding GrokPtah (or any non-default skin) this way
   has no preview before landing on it. Settings → Appearance already shows
   swatch previews — consider whether the titlebar control should show a
   tooltip naming the *next* skin before commit, or be deprioritized in
   favor of steering users to Appearance.
4. **Information hierarchy in the Compose/Chat split.** Tool-call trails
   (`--tool-bg`) and chat turns share a single scroll column; on a dense
   dark skin like GrokPtah, a long tool trail visually reads as part of the
   assistant's turn rather than a distinct, collapsible unit. A collapsed-
   by-default tool trail with an expand affordance (already partially
   present) could be made the consistent default across skins to reduce
   scan cost, independent of palette.

None of the above blocks this lane's scope; they are handed off as
observations for a future navigation/information-hierarchy pass.
