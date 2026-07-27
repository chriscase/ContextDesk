# Bundled Help truth and Log Explorer impact audit

This is the review ledger required by #540. It records what was checked, not a
blanket claim that every future product change is automatically documented.

- Audited main baseline: `ae1ca8dc53aa5e0bf47c4e656480bb89cf26b7bf`
- Explorer completion branch: `integrate/codex-log-explorer-finish`
- Feature promotion merge: `813b6f7e064ccb480798773c5b07636d7d383a07`
- Render review: all 12 bundled SVGs at 380 / 760 / 1520 pixels
- Automated review: clipping, box-border, and text/text collision fixtures
- Remaining external proof: real packaged HelpPane/themes under owner tracker #525

## Log Explorer issue-to-Help impact

| Issue | Production behavior | Canonical Help impact | Audit result |
| --- | --- | --- | --- |
| #521 | Logs library no longer performs eager decorative timeline work | `log-explorer#timeline-navigator` | Navigator is explicitly closed/lazy; no CPU-saving claim beyond that path |
| #522 | Fixed-size backend timeline summary and bounded seek | `log-explorer#timeline-navigator` plus typed popover | Bucket cap, drag commit, order-only language, lane coverage, and empty spans documented |
| #523 | Contextual Find is distinct from row-reducing Filter | `log-explorer#find-vs-filter` plus typed popover | Literal/regex bounds and intersection semantics match production |
| #529 | Linked chat follows new output only while already near latest | `log-explorer#agent-context` / **Follow latest** table row | Jump-to-latest and no forced jump while reading history documented |
| #530 | Linked agent turn uses bounded log tools through completion | `log-explorer#agent-context` | No claim that the raw corpus is pasted into model context |
| #531 | Bookmark activation resolves a stable target and can temporarily reveal it | `log-explorer#bookmarks` | Restore-prior-view behavior documented; report workflow remains #532 |
| #533 | Hidden selection/detail is reconciled and turn context is immutable | `log-explorer#agent-context` | Context snapshot and stale-selection boundary documented |
| #534 | Corpus, matched, lane-matched, and resident counts are distinct | `log-explorer#counts` plus typed popover | No max-per-lane value is described as a global total |
| #535 | Adaptive UTC time and resizable columns | Log Explorer feature table | Persistence scope, auto-fit sample cap, reset, and order-only honesty documented |
| #536 | Narrow mode uses one lane and intentional Filters/Chat drawers | Log Explorer **Narrow layout** row | Focus restoration and primary log viewport behavior documented |
| #537 | Bounded previews plus complete resizable event inspector | `log-explorer#long-lines` plus typed popover | Preview never claims to contain the full event |
| #538 | Bidirectional keyset paging with bounded residency | Log Explorer **Bidirectional paging** row | Automatic edge paging and manual fallback documented |
| #539 | Responsive first-chat home and safe starters | `first-run` | Help avoids claiming workspace starters without authorized roots |
| #540 | Help truth and diagram quality | This ledger and `help/assets/README.md` | Geometry gate/contact-sheet command added; packaged theme proof remains external |
| #541 | Typed rich contextual help | `HELP_CENTER.md#contextual-help-decision-rule` | Portal, narrow sheet, canonical locator, and cross-window full-Help handoff documented |
| #542 | Deterministic behavior-rich scale profiles | `log-explorer#log-lab-scale-profiles-synthetic` | Explicit 100k command and one-machine measurement disclaimer documented |
| #543 | Compact corpus-chat switcher and collapsed technical context | `log-explorer#agent-context` plus linked-chat popover | Privacy disclosure remains available without exposing debug UI by default |

## Page-by-page production audit

| Page | Current production anchors checked | Result |
| --- | --- | --- |
| `product-overview` | sources, trusted core, desktop/agent surfaces | Aligned; diagram label repaired |
| `first-run` | root selection, provider setup, prelaunch, safe starters | Aligned; provider text split to avoid collision |
| `provider-setup` | local/remote routes, keychain/host ownership | Aligned; remote-context wording remains bounded |
| `chat-citations-context` | bounded context, tools, compaction, citations | Aligned; no raw-corpus/model-context claim |
| `workspace-indexing` | allowlist, exclusions, caps, local index | Aligned; exclusion callout repaired |
| `permission-tiers` | Read / SoftWrite / HardWrite and audit | Aligned; confirmation labels repaired |
| `memory-overview` | candidate review, durable store, bounded recall | Aligned; no automatic-durable-capture claim |
| `log-analysis-pipeline` | ingest, redact, templates, DuckDB, local embedding, tools | Aligned; live tail remains explicitly unshipped |
| `log-explorer` | search/filter, lanes, paging, navigator, chat, long lines | Aligned to this branch; packaged visual proof remains #525 |
| `portable-package` | package validation/import/export boundaries | Aligned; no restore/sync claim |
| `connectors-and-confluence` | config/keychain, host policy, confirmed writes | Aligned |
| `s3-backup` | explicit Phase A confirmation/export only | Aligned; no restore/delete/index-source claim |
| `skills-and-context-packs` | session-scoped files, pinned skill, unchanged grants | Aligned |
| `security-boundaries` | webview/host/local/remote/MCP trust boundaries | Aligned; dense labels split |
| `common-problems` | current recovery paths and honest limitations | No contradiction found in focused audit |
| `glossary` | shipped product terminology | No stale Log Explorer term found |

## Required close-proof rerun

1. Confirm the feature promotion merge above is an ancestor of current `main`.
2. Run `node scripts/check_help_corpus.mjs` and its Node tests.
3. Render the contact sheet with
   `scripts/render_help_svg_contact_sheet.sh OUTPUT_DIRECTORY`.
4. Search/read Help for lanes, Find vs Filter, bidirectional paging, long
   events, timeline navigator, linked chat, and first chat.
5. Capture real HelpPane screenshots in dark, light, and slate at narrow,
   normal, and wide sizes. Contact-sheet review does not replace this step.
