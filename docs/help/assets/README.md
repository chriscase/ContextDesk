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
