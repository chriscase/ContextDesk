# Help SVG conventions

Help diagrams are trusted, bundled explanatory assets. They render through an
`<img>` data URL after the Rust host verifies the asset belongs to the selected
page. They are never inserted as live DOM markup.

Use a transparent canvas and this calm, dark-friendly palette:

| Role | Color |
| --- | --- |
| Primary text | `#e5e7eb` |
| Secondary text and strokes | `#9ca3af` |
| Panel fill | `#111827` |
| Panel border | `#475569` |
| Blue accent | `#38bdf8` |
| Green/safe accent | `#34d399` |
| Amber/confirmation accent | `#fbbf24` |
| Red/risk accent | `#fb7185` |

Every asset requires a `viewBox`, `<title>`, and `<desc>`. Prefer labeled boxes
and short verbs. Include arrowheads in the SVG rather than relying on Unicode
arrow glyphs. Keep critical meaning in text and repeat the process in a nearby
Markdown table for accessible fallback.

Forbidden content includes scripts, event attributes, `foreignObject`,
embedded raster images, animation, remote `href`, remote `url()`, and external
stylesheets.

## Visual quality gate (#540)

Syntactic SVG safety is **not** sufficient. Before shipping a diagram:

1. Open the Help page that embeds it in a real dark UI (or `npm run dev` Help pane).
2. Confirm labels are readable at the rendered size (no clipped words, no
   overlapping text, no low-contrast grey-on-grey).
3. Prefer short verbs in boxes; put process detail in a Markdown table under the
   figure when needed.
4. Reject “odd” AI word wrapping (mid-word breaks, stacked single letters,
   decorative junk text).
5. Run `node scripts/check_help_corpus.mjs` (or the desktop test suite that
   includes help corpus validation).
