# GrokPtah skin — visual QA and usability audit

Companion to [`SKINS.md`](SKINS.md) for the `grokptah` skin: a graphite coding
workbench with a warm gold accent.

## What shipped

Color only. `grokptah.css` defines the same 38 semantic tokens as the reference
`dark.css` and nothing else — no component TSX, no layout, no shared structure
tokens were touched, so the default `dark` skin renders byte-identically to
before.

| Role | Token | Value |
|------|-------|-------|
| Window / panel / card | `--bg-app` / `--bg-panel` / `--bg-elevated` | `#0b0c0e` / `#12141a` / `#181b22` |
| Accent (actions, focus, links) | `--accent` | `#f0b429` |
| Label on solid accent | `--accent-on` | `#17130a` |
| Success / warning / danger | `--success` / `--warning` / `--danger` | `#6fcf97` / `#fb8043` / `#f07178` |
| Tool trail well | `--tool-bg` | `#14161d` |

Two deliberate choices worth knowing before editing the palette:

- **Warning is orange, not amber.** With a gold accent, an amber warning
  collapses accent and warn into one warm smear. `#fb8043` sits ~22° from the
  gold and ~23° from the danger red — the widest minimum separation available
  in the gap between them. `grokptahSkin.test.tsx` asserts ≥15° so a future
  tweak cannot quietly close it.
- **Neutrals are warmed a few points** off the default dark skin's cool grays so
  the gold reads as part of the palette rather than a sticker on cold graphite.
  The three surfaces named above are exact matches to the default, so window
  chrome density reads identically when switching between them.

Type is unchanged and shared: Inter (`--font-sans`) with IBM Plex Mono
(`--font-mono`), both bundled as WOFF2 so offline builds keep product type.

## Visual QA steps

Automated tests cover token math, registration, pre-paint, and persistence.
These steps cover what math cannot — whether it actually looks right.

1. `cd desktop && npm run tauri:dev`.
2. **Settings → Appearance → Theme → GrokPtah.** It applies immediately, with no
   Save. The trigger preview swatch strip updates to graphite + gold.
3. **Reload the window (or quit and relaunch).** GrokPtah is still active and
   there is **no light flash** during boot — the pre-paint script fills the
   window graphite before the bundle loads. A white flash here means the id is
   missing from the `KNOWN` map in `public/theme-init.js`.
4. **Walk every pane** — Chat, Archive, Memory, Compose, Source, Todos, Logs,
   Investigations, Harvest, Help. Check specifically:
   - Body text and timestamps/meta legible on panel *and* card surfaces.
   - Tool-call rows readable collapsed and expanded; the trail well is
     distinguishable from the app background.
   - Streaming markdown, code blocks, and citation chips.
5. **Status colors in context.** Trigger a success, a warning, and an error
   banner and confirm all three are distinguishable from each other *and* from
   gold accent buttons sitting nearby. This is the highest-risk area for a
   warm-accent skin.
6. **Focus rings.** Tab through the composer, pane tabs, and the permission
   modal. The gold ring must be visible against every surface it lands on.
7. **Native controls.** Open a `<select>` (Settings → UI scale) and confirm the
   dropdown paints dark, not OS-default white.
8. **Second window.** Open Log Explorer or the Handbook; it must boot in
   GrokPtah too (cross-webview theme bridge), not fall back to dark.
9. **Reduced motion.** With `prefers-reduced-motion` on, confirm nothing new
   animates.
10. Switch back to **Dark** and confirm it is unchanged.

Contrast is verified in CI, not by eye: every token used as text clears WCAG AA
(4.5:1) on all three surfaces, and `--accent-on` clears AA on both the accent
and its hover shade.

## Usability audit (recorded, not implemented)

Scope note: this lane shipped the skin only. The findings below are recorded
here so they can be triaged and scheduled as their own issues — **none of them
were implemented**, because each changes navigation or component structure
rather than color, and that is out of a skin's remit.

### Navigation

1. **Ten flat peer panes.** `PaneTabs.tsx` renders Chat, Archive, Memory,
   Compose, Source, Todos, Logs, Investigations, Harvest, and Help as one
   undifferentiated tablist. Ten peers exceeds what a person scans as a set, and
   the order reflects neither frequency nor workflow. Recommend grouping into
   ~3 clusters (*Converse* · *Evidence* · *Workspace*), with Help demoted out of
   the primary tablist into the existing titlebar affordance.
2. **No persistent "where am I".** The active tab is the only location signal;
   there is no breadcrumb or section heading inside the pane body. On a wide
   window the active tab is far from the content it labels. Recommend a compact
   pane header that restates the destination and carries pane-level actions.
3. **Selected-tab affordance leans on color alone.** `data-active` drives the
   treatment. Recommend pairing it with a weight or underline change so the
   selected pane survives both a color-blind viewer and a future low-chroma
   skin.
4. **Keyboard reach is linear.** The tablist has correct roving-tabindex
   behavior, but reaching Harvest from Chat is eight arrow presses. Recommend
   direct shortcuts for the top-level destinations.

### Information hierarchy

5. **Three competing chrome bands.** Titlebar (40px), pane tabs, and status bar
   (24px) each claim horizontal space before content. Recommend merging pane
   tabs into the titlebar row on wide windows.
6. **Density is global, not per-surface.** `--text-md` (12px) is body text
   everywhere, so a scanning surface (Logs) and a reading surface (Help,
   Handbook) get the same measure. Handbook and Help already reach for
   `--text-xl` to escape this. Recommend a documented reading-surface scale
   rather than per-file opt-outs.
7. **Skins cannot express density.** The brief for this skin asked for "compact
   chrome", but structure tokens live in the shared `tokens.css` layer — a skin
   changing them would silently re-space every other skin. Today the compact
   baseline is global and already tuned for coding-agent chrome. If per-skin
   density is genuinely wanted, it needs a deliberate structural-variant layer
   (skin → optional density preset) rather than skins reaching into shared
   structure. Recommend treating that as its own design issue.
8. **Status bar carries low-salience information at high persistence.** It is
   always visible but rarely the thing being looked at. Recommend auditing what
   earns permanent residence there versus what belongs in a transient toast.
