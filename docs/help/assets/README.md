# Help SVG conventions

Help diagrams are trusted, bundled explanatory assets. They render through an
`<img>` data URL after the Rust host verifies the asset belongs to the selected
page. They are never inserted as live DOM markup.

Diagrams cannot inherit the page theme: the host serves them as a base64
`data:` URL and Help renders them through `<img>`, so nothing inside the file
sees the reader's skin. The `.help-figure` surface behind them resolves to
near-white in the **Light** and **Sand** skins.

Therefore **every label must sit on an opaque shape you filled yourself**.
A transparent canvas is fine where all text already sits on inset panels; when
a title, caption, or footnote would otherwise float on the canvas, give the
diagram a full-bleed background rect (`<rect width="W" height="H"
fill="#0f172a"/>` as the first child), as `incident-evidence-*.svg` do. This is
enforced: `scripts/check_help_corpus.mjs` rejects text on the bare canvas and
text below 4.5:1 against the shape it sits on.

Use this calm, dark-friendly palette:

| Role | Color |
| --- | --- |
| Primary text | `#e5e7eb` |
| Secondary text and strokes | `#9ca3af` (on the `#111827` panel fill only — it fails AA on lighter accent fills, so use primary text there) |
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

The validator includes a conservative geometry gate for clipped text,
text/text collisions, and text touching its containing rectangle. Deliberately
broken fixtures prove those checks fail. It does not pretend to know the exact
font metrics or whether an arrow is aesthetically well placed.

For the required rendered review, install `librsvg` and ImageMagick, then run:

```sh
scripts/render_help_svg_contact_sheet.sh /tmp/contextdesk-help-review
```

This renders every asset at 380, 760, and 1520 pixels (the last is the
200%-zoom review) and produces a labeled contact sheet plus an order/width
manifest. Review the contact sheet explicitly in addition to the automated
gate. Before close proof, also inspect representative diagrams inside the real
Help pane at narrow, normal, and wide layouts in each theme; the contact sheet
does not substitute for pane/CSS verification.
