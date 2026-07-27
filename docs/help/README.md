# Help corpus author guide

`docs/help/` is the curated, user-facing corpus bundled into ContextDesk. It is
not a mirror of the repository's engineering `docs/` tree. Do not copy agent
instructions, issue text, mutation evidence, private environment details, or
unshipped roadmap claims into this corpus.

The normative design is
[`docs/design/HELP_CENTER.md`](../design/HELP_CENTER.md).

## Add a page

1. Choose the existing section directory that matches the navigation location.
2. Create a Markdown file with every required frontmatter field:

   ```yaml
   ---
   id: stable-kebab-case-id
   title: Human-readable title
   summary: One short result-list description.
   section: getting-started
   tags:
     - setup
     - process
   order: 20
   related:
     - product-overview
   ---
   ```

3. Add exactly one H1 equal to `title`. Do not skip heading levels.
4. Link to another page with `help://page-id` or
   `help://page-id#heading-anchor`.
5. Put diagrams under `assets/` and link them with meaningful alt text, for
   example `![First-run flow](../assets/first-run.svg)`.
6. Add a `process` tag when a page explains a meaningful sequence. Process
   pages must include at least one SVG and one decision/tool table.
7. Run:

   ```sh
   node scripts/check_help_corpus.mjs
   node --test scripts/check_help_corpus.test.mjs
   ```

The validator rejects unknown frontmatter fields, duplicate or broken ids,
section/path mismatches, missing and traversal-shaped asset links, unsafe SVG
content, and process pages without both a diagram and table.

## Honesty review

Before review:

- Record `Help impact: <page/anchor and contextual definition>` for every
  user-visible behavior change, or `Help impact: none — <specific reason>`.
  Update affected Help in the feature PR rather than leaving a follow-up drift
  task.
- Check capability wording against `docs/CLAIMS.md` and the current code anchor.
- Check the README's “What it does (honest)” section.
- Use the current production path, not only a helper or design document.
- Describe partial or roadmap behavior as unavailable. Omit it when the
  distinction would confuse a normal user.
- Do not name private gateways, customer systems, or employer-only processes.
- Never include tokens, credentials, real workspace paths, or copied logs.

Examples:

- S3 backup is export-only Phase A. Do not promise restore, remote deletion,
  synchronization, lifecycle management, or an S3 index source.
- Log analysis is shipped for post-mortem batches. Do not promise live tailing,
  alerts, or remote log-source connectors.
- The optional team server does not yet provide finished team roles and shared
  memory.

## Markdown subset

Use headings, paragraphs, emphasis, code, lists, GFM pipe tables, blockquote
callouts, `help://` links, and declared SVG images. Raw HTML, remote images, and
embedded scripts are not supported.

Callouts begin with one of:

```text
> Note:
> Tip:
> Important:
> Warning:
> Caution:
```

Keep titles under 120 characters, summaries under 240 characters, pages under
2 MiB, and diagrams under 256 KiB. Search chunks are heading-aware, so use
specific H2/H3 labels instead of one very long section.

## Diagram checklist

- [ ] Non-empty `<title>` and `<desc>`
- [ ] `viewBox` present
- [ ] Meaningful labels; color is never the only signal
- [ ] Legible at about 640 px and at 200% zoom
- [ ] No script, `foreignObject`, embedded raster image, event handler, remote
      reference, or animation
- [ ] Descriptive Markdown alt text
- [ ] A nearby table or prose explanation provides the same essential meaning

See [`assets/README.md`](assets/README.md) for the visual palette and markup
conventions.
