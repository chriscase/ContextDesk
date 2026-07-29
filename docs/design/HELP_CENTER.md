# In-app Help Center

Status: accepted implementation design for epic
[#434](https://github.com/chriscase/ContextDesk/issues/434).

This document is the source of truth for ContextDesk's bundled, searchable
product help. It describes the corpus contract, indexing and citation model,
desktop experience, agent tools, packaging, and delivery plan. Engineering
design documents elsewhere under `docs/` remain authoritative for internal
implementation details; the Help Center curates only user-facing,
shipped-product guidance.

The Help navigation may open the separately bundled **Engineering handbook**.
That reader is a developer reference, not a Help section: its Markdown is not
added to `HelpIndex`, `search_help`, `read_help`, workspace indexing, memory, or
chat context merely because the app can display it.

## 1. Goals and invariants

The Help Center must:

1. work offline from a curated corpus bundled with the app;
2. provide ranked keyword search on every installation;
3. add semantic ranking when an `EmbedBackend` is available without making
   keyword search or startup depend on a model download;
4. open as a first-class desktop pane with section navigation, readable
   long-form content, tables, and trusted local diagrams;
5. let the agent search and read the same corpus through Read-tier tools and
   cite stable `help://` locators;
6. remain separate from workspace indexing and durable memory; and
7. describe only capabilities that are true on `main`, cross-checked against
   `docs/CLAIMS.md`, the README, and the relevant implementation.

The following are non-negotiable:

- Help never requires a workspace root or workspace allowlist.
- Help is never written into the workspace keyword-index SQLite database or a
  durable-memory SQLite database.
- No remote Markdown, remote SVG, or Help CDN is loaded in v1.
- `search_help` and `read_help` are Read tools. Help authoring is not exposed
  as SoftWrite or HardWrite.
- Full Help content is not injected into every turn. The model explicitly uses
  the tools when product guidance is relevant.
- A process page contains at least one explanatory SVG diagram or decision
  table. A page with a sequence of three or more meaningful steps is a process
  page.

## 2. Architecture and trust boundaries

```text
docs/help/**/*.md + docs/help/assets/**/*.svg
          │ author-time validation
          ▼
    versioned bundled corpus
          │ configured read-only root
          ▼
┌──────────────────────────────────────────────────────────┐
│ cd-core::help                                            │
│ parse → validate → heading chunks → keyword postings     │
│                              └─ optional EmbedBackend     │
│                                   + ExactIndex fusion     │
└───────────────────────┬───────────────────┬──────────────┘
                        │                   │
              typed Tauri commands     ToolHost attachment
                        │                   │
                        ▼                   ▼
              Help pane + deep links   search_help/read_help
                                            │
                                            ▼
                                      help:// citations
```

`HelpIndex` owns parsed Help pages and search-only vectors in memory. It does
not reuse `KeywordIndex` as a storage container because that type is coupled to
workspace traversal, allowlists, file mtimes, and optional persistent SQLite.
It does reuse the established retrieval primitives:

- `EmbedBackend` for optional embeddings;
- `ExactIndex` through the `VectorIndex` trait for the modest bundled chunk
  count;
- `cosine_similarity` and normalized hybrid-score conventions; and
- bounded candidate/result patterns from `index.rs`.

The desktop host is the trust boundary. It resolves the bundled corpus root,
constructs one read-only `HelpIndex`, attaches it to `ToolHost`, and exposes
typed non-secret DTOs. The webview cannot choose an arbitrary corpus root or
asset path.

## 3. Information architecture

The initial navigation tree and stable section keys are:

| Order | Section key | Navigation label | Typical content |
| ---: | --- | --- | --- |
| 10 | `overview` | Overview | What ContextDesk is, architecture at a glance |
| 20 | `getting-started` | Getting started | First run, workspace, AI, prelaunch |
| 30 | `chat-context` | Chat & context | Sessions, citations, context budgets |
| 40 | `workspace-indexing` | Workspace & indexing | Roots, indexing, retrieval |
| 50 | `permissions` | Permissions & writes | Read, SoftWrite, HardWrite |
| 60 | `memory` | Memory | Durable memory, recall, review, purge limits |
| 70 | `log-analysis` | Log analysis | Ingest, templates, event store, analysis tools |
| 80 | `connectors` | Connectors | Confluence, databases, MCP, web research |
| 90 | `skills` | Skills & context packs | Skills, pinning, session files and ZIPs |
| 100 | `settings` | Settings & prelaunch | Providers, health checks, configuration |
| 110 | `security` | Security model | Keychain, SSRF, redaction, confirmations |
| 120 | `troubleshooting` | Troubleshooting | Common failures and recovery |
| 130 | `reference` | Reference | Glossary, shortcuts, limitations |

Section order is a presentation concern, not part of citation identity. Pages
may move between sections without breaking `help://` links.

### 3.1 Repository layout

```text
docs/help/
├── README.md                    authoring and review rules; not indexed
├── overview/
│   └── product-overview.md
├── getting-started/
│   └── first-run.md
├── chat-context/
│   └── chat-citations-context.md
├── permissions/
│   └── permission-tiers.md
├── log-analysis/
│   └── log-analysis-pipeline.md
├── memory/
│   └── memory-overview.md
├── skills/
│   └── skills-and-context-packs.md
└── assets/
    ├── README.md                SVG conventions
    ├── log-analysis-pipeline.svg
    └── ...
```

Only Markdown files below a section directory are pages. `README.md`, hidden
files, symlinks, non-Markdown content, and files outside the configured corpus
root are not pages. Only `.svg` files below `assets/` are renderable assets in
v1.

## 4. Page and frontmatter contract

Each page starts with YAML frontmatter:

```yaml
---
id: log-analysis-pipeline
title: How log analysis works
summary: Turn incident logs into redacted templates, timelines, and evidence.
section: log-analysis
tags:
  - logs
  - troubleshooting
  - duckdb
order: 10
related:
  - permissions
  - skills-context-packs
---
```

The schema is intentionally small:

| Field | Type | Required | Validation and meaning |
| --- | --- | :---: | --- |
| `id` | string | yes | Globally unique, stable, lowercase kebab case matching `[a-z0-9]+(?:-[a-z0-9]+)*`; never derived from a mutable title |
| `title` | string | yes | Plain text, 1–120 Unicode scalar values |
| `summary` | string | yes | Plain text, 1–240 characters; usable as a result snippet fallback |
| `section` | string | yes | One of the section keys in §3 |
| `tags` | string array | yes | One or more unique lowercase kebab-case terms; maximum 20 |
| `order` | integer | yes | Non-negative order within a section; ties use title then id |
| `related` | string array | yes | Zero or more unique page ids; every id must resolve after the full corpus loads |

Unknown frontmatter fields fail validation. This catches author typos instead
of silently losing metadata. Duplicate ids, duplicate normalized asset paths,
missing H1, an H1 different from `title`, broken related ids, broken relative
asset links, absolute paths, `..` traversal, external images, and links to
assets outside `assets/` also fail validation.

The page body rules are:

- exactly one H1, equal to `title`, followed by normal Markdown sections;
- heading levels do not skip downward (H2 may contain H3, but not H4 directly);
- tables use GitHub-flavored pipe syntax supported by the desktop renderer;
- callouts use blockquotes beginning with `Note:`, `Tip:`, `Important:`,
  `Warning:`, or `Caution:`;
- diagrams use `![meaningful alt text](../assets/name.svg)`; and
- links to another Help page use `help://page-id` or
  `help://page-id#heading-anchor`, not repository-relative Markdown paths.

The author-time validator is the same parser used by `HelpIndex`, exposed
through a small validation binary/test so CI and production cannot disagree.

## 5. SVG conventions and asset policy

Help SVGs are explanatory content, not decorative screenshots. Each SVG must:

- include a non-empty `<title>` and, for a non-trivial diagram, `<desc>`;
- declare a `viewBox` and avoid fixed viewport assumptions;
- use `currentColor` and the documented semantic palette where practical;
- keep text legible at a 640-pixel reader width and at 200% zoom;
- include text labels in addition to color or arrow direction;
- avoid embedded raster images, scripts, animation, filters with remote
  references, external stylesheets, `<foreignObject>`, event attributes, and
  external `href`/`url()` targets; and
- stay under 256 KiB per asset.

The host validates the requested asset is a normalized relative path below the
bundled `assets/` directory and returns an `image/svg+xml` data URL only for a
known asset referenced by a parsed page. The Help pane renders it in an
`<img>`, not with `dangerouslySetInnerHTML`. This works with the existing
`img-src 'self' data:` CSP and keeps SVG markup out of the webview DOM. A
missing or rejected asset renders an accessible controlled-error card with the
alt text and asset name.

## 6. Deterministic chunking

Search operates on heading-aware chunks while `read_help` reads a page.
Chunking is deterministic across operating systems:

1. remove frontmatter;
2. normalize CRLF to LF;
3. keep the H1 as page metadata rather than repeating it in every chunk;
4. begin a chunk at each H2/H3 boundary;
5. keep fenced code, a table, a list, and a blockquote intact when each is
   within the hard limit;
6. split oversized sections at paragraph boundaries near 2,400 characters;
7. if a single block exceeds 3,200 characters, split on Unicode scalar
   boundaries with no byte slicing; and
8. carry the heading ancestry as metadata instead of duplicating body text.

There is no cross-section text overlap. The page title, summary, tags, section
label, and heading ancestry are indexed alongside each chunk, so overlap is
not needed to retain search context. Every chunk receives a stable key:

```text
{page_id}#{normalized-heading-anchor}:{ordinal-within-anchor}
```

Heading anchors use lowercase Unicode-aware words collapsed with ASCII `-`.
Duplicate headings receive `-2`, `-3`, and so on. A chunk records:

```rust
pub struct HelpChunk {
    pub key: String,
    pub page_id: String,
    pub heading: String,
    pub anchor: String,
    pub ordinal: u16,
    pub text: String,
}
```

Limits:

- 3,200 characters per chunk;
- 2 MiB per Markdown page;
- 1,000 pages and 20,000 chunks per bundled corpus; and
- 64 results considered for keyword/semantic fusion, 20 returned at most.

These are policy errors, not silent truncation. The bundled corpus is a build
artifact; an invalid or oversized corpus should fail CI and produce a bounded
host startup diagnostic rather than quietly claiming complete Help.

## 7. Search and score fusion

### 7.1 Keyword path (always available)

The dedicated Help keyword index tokenizes title, summary, section, tags,
heading ancestry, and body. Ranking is deterministic and case-insensitive:

```text
keyword_raw =
    body term TF × corpus IDF
  + 4.0 × title exact-token matches
  + 3.0 × tag exact-token matches
  + 2.5 × heading exact-token matches
  + 1.5 × summary exact-token matches
  + 2.0 × exact normalized query phrase in title
```

All query terms participate, but partial matches are allowed. Ties resolve by
matched-term count, then page order, then page id and chunk ordinal. Results
from multiple chunks of one page collapse to the best chunk unless the caller
explicitly requests chunks.

### 7.2 Optional semantic path

When the host supplies an `Arc<dyn EmbedBackend>`, corpus chunks are embedded
in bounded batches and upserted into an `ExactIndex`. Help is small enough that
HNSW adds complexity without useful latency savings; the `VectorIndex` trait
keeps a later switch possible.

Embeddings are optional acceleration, not availability:

- startup exposes keyword results immediately;
- semantic readiness is reported separately as
  `disabled | building | ready | degraded`;
- no default test downloads a model or contacts a service;
- `ConceptEmbedBackend` provides hermetic semantic fixtures; and
- any embed timeout, dimension mismatch, or provider error degrades that query
  to keyword-only and returns a redacted diagnostic state, never an empty Help
  Center.

Semantic search may add zero-keyword-overlap chunks to the candidate pool.
The pool is the union of the top 64 keyword chunks and top 64 vector matches.

### 7.3 Fusion

Help has no recency signal because all bundled pages ship in one app version.
For each candidate:

```text
kw  = keyword_raw / max_keyword_raw, or 0
sem = clamped cosine similarity in [0, 1], or 0

keyword-only score = kw
hybrid score       = 0.65 × kw + 0.35 × sem
```

Scores are bounded to `[0,1]`. The keyword weight stays dominant so exact
product vocabulary remains predictable. A `match_mode` field makes the UI
honest about whether semantic ranking participated; the UI never presents the
score as calibrated confidence.

The public DTO is:

```rust
pub enum HelpSearchMode {
    Keyword,
    Hybrid,
}

pub struct HelpSearchHit {
    pub page_id: String,
    pub title: String,
    pub summary: String,
    pub section: String,
    pub heading: Option<String>,
    pub anchor: Option<String>,
    pub snippet: String,
    pub score: f32,
    pub mode: HelpSearchMode,
    pub citation: String,
}
```

Snippets are derived from the winning chunk around the first keyword match or,
for semantic-only hits, from its first complete sentence. They are plain text,
collapse whitespace, never split UTF-8, and are capped at 320 characters.

## 8. Read API and citations

Page ids, not file paths, are the public identity:

- `help://{page-id}` identifies the whole page;
- `help://{page-id}#{heading-anchor}` identifies a heading; and
- assets never receive public citations.

The parser rejects ids or anchors containing `/`, `\`, `?`, `%`, whitespace,
`.` segments, or URL authority syntax. The UI parser accepts only the exact
`help://` scheme and known page ids; it does not pass these locators to the
operating system.

The core API is independent of Tauri:

```rust
impl HelpIndex {
    pub fn load(root: &Path) -> CoreResult<Self>;
    pub fn sections(&self) -> Vec<HelpSection>;
    pub fn page(&self, id: &str) -> CoreResult<HelpPage>;
    pub fn asset(&self, page_id: &str, path: &str) -> CoreResult<HelpAsset>;
    pub fn search_keyword(&self, query: &str, limit: usize)
        -> Vec<HelpSearchHit>;
    pub async fn search(
        &self,
        query: &str,
        limit: usize,
        embed: Option<&dyn EmbedBackend>,
    ) -> Vec<HelpSearchHit>;
}
```

`HelpPage` includes metadata, Markdown body, generated table-of-contents
entries, related-page summaries, and declared asset metadata. It never exposes
the absolute bundle path.

## 9. Desktop packaging and host lifecycle

`docs/help/` remains the authoring source of truth. Tauri's bundle configuration
maps `../../docs/help` to the resource destination `help/`. The packaging gate
inspects the produced resource tree; it does not rely only on a source-tree
test.

At runtime the desktop host:

1. resolves `help/` from Tauri's resource directory;
2. in development/tests only, may receive an explicit fixture/source root from
   trusted Rust setup code;
3. loads and validates the corpus once into `Arc<HelpIndex>`;
4. attaches that same instance to `ToolHost`; and
5. serves typed commands:

| Command | Input | Output |
| --- | --- | --- |
| `list_help_sections` | none | ordered sections and page summaries |
| `get_help_page` | page id | `HelpPageDto` |
| `search_help_pages` | query, bounded limit | scored hits and search mode |
| `get_help_asset` | page id, declared asset path | validated MIME + data URL |

No command accepts an absolute path. Returned errors are bounded and never
contain the resource directory, workspace path, provider endpoint, or
credential.

The `cd-server` may attach a configured bundled corpus later, but desktop
packaging is the v1 shipped path. `cd-core` itself does not assume a Tauri
directory layout.

## 10. Help pane product bar

`PaneId` gains `"help"`, and `PaneTabs` exposes Help as a normal destination.
The pane is a documentation browser, not a file list.

### 10.1 Layout

Desktop width uses three functional regions:

```text
┌────────────────┬────────────────────────────────┬───────────────┐
│ Section nav    │ Reader                         │ On this page  │
│ grouped pages  │ title · summary · Markdown     │ sticky TOC    │
│                │ diagrams · tables · callouts   │ related pages │
├────────────────┴────────────────────────────────┴───────────────┤
│ Search opens an in-pane ranked result surface above the reader  │
└─────────────────────────────────────────────────────────────────┘
```

At narrower widths, section navigation becomes a labeled drawer and the
in-page TOC becomes a disclosure above the article. Reader measure stays near
72 characters. Search never replaces navigation permanently: clearing a query
returns to the current page.

### 10.2 Search presentation

- Search input uses `type="search"`, an explicit label, clear button, and
  `Ctrl/Cmd+K` only when focus is inside Help; the app-wide discovery shortcut
  is defined in #440.
- Results show title, section badge, heading, snippet, and a relevance meter
  labeled “Keyword” or “Hybrid”.
- The numeric score may be available to assistive text and tests but is not
  shown as a false percentage confidence.
- Arrow keys move through results; Enter opens; Escape clears results before
  leaving the pane.
- The initial state offers queries such as “How does log analysis work?”,
  “When does ContextDesk ask before writing?”, and “Why is prelaunch blocked?”

### 10.3 Reader and diagrams

The reader uses a Help-specific static Markdown renderer that supports the
validated subset: headings, paragraphs, emphasis, code, lists, tables,
callouts, internal `help://` links, and declared SVG images. It must not inherit
the chat renderer's streaming assumptions or permit raw HTML. Heading ids come
from the core-generated TOC so deep links and sticky navigation agree.

Styles use existing semantic CSS variables, dark/light themes, visible focus,
horizontal containment for wide tables, and `prefers-reduced-motion`. Diagrams
have captions and controlled-error fallbacks. Reader landmarks are:

- `<nav aria-label="Help sections">`;
- `<main aria-label="Help article">`;
- `<aside aria-label="On this page">`; and
- a polite live region for result counts and load errors.

On page navigation, focus moves to the article H1 unless the action is an
in-page anchor. Browser-history semantics are local to the pane; no external
window or network navigation occurs for `help://`.

### 10.4 Engineering handbook boundary

Help includes one clearly labeled developer entry that opens or focuses a
single read-only Tauri window. The installed reader displays the exact
repository Markdown rooted at `docs/design/PROVEN_METHODS.md`, its
`docs/design/proven-methods/` chapters, and allowlisted canonical design
targets. It never accepts an arbitrary filesystem path.

Internal links are resolved by the host relative to the current bundled page.
Traversal, non-Markdown targets, unavailable files, unsupported schemes, and
paths outside the bundled documentation root fail closed. An HTTP(S) link
opens in the system browser only after the user activates that exact link.
Mermaid source is presented as a labeled, keyboard-readable diagram
equivalent; raw HTML and script execution remain unsupported.

The handbook window follows the registered app theme, supports close and
reopen, and reuses one stable window label so repeated activation focuses the
existing reader instead of creating duplicates. This display-only index stays
separate from `HelpIndex` and is never attached to `ToolHost`.

## 11. Agent surface

`ToolHost` accepts an optional `Arc<HelpIndex>`. When present, it registers:

| Tool | Tier | Arguments | Bounded result |
| --- | --- | --- | --- |
| `search_help` | Read | `{query, limit?}` | at most 8 hits; each snippet ≤320 chars; `help://` citation |
| `read_help` | Read | `{id, anchor?}` | one page or section, capped at 12,000 chars with explicit truncation metadata |

Both tools use the same index and ranking as the pane. Tool details are wrapped
as trusted bundled product content, not workspace/user content, but outputs
remain bounded. Each successful call emits:

- normal Tool start/finish events;
- a SearchTrail step such as `Help: searched "log triage"` or
  `Help: read How log analysis works`; and
- `StreamEvent::Citation` with `source_id` equal to the canonical
  `help://...` locator and the page title as label.

The webview maps a citation whose id begins with `help://` directly to
`PaneId::help` and the parsed page/anchor. It never calls `read_workspace_file`
for that locator.

No Help tool can request permission, write a file, alter memory, or raise a
skill's permission tier. The lightweight system guidance says to use Help
tools for questions about ContextDesk behavior. It does not inject the corpus,
run Help search on every turn, or promise that an answer is grounded unless
the tool actually emitted a citation.

## 12. Discovery and deep links

The stable UI contract for #440 is:

- app action `openHelp({ pageId?, anchor?, query? })`;
- command palette actions “Open Help” and “Search Help…”;
- app-wide shortcut `Ctrl/Cmd+Shift+/`, ignored while a modal is open and never
  triggered by plain `?` while typing;
- contextual Learn more links pass stable page ids; and
- at least Logs empty state, Memory empty state, and Settings AI/prelaunch or
  permission UI link to real pages.

Deep-link requests made before the index is ready are retained once, then
resolved after load. Unknown ids show a recoverable “Page unavailable” state
with search, not a blank pane.

## 13. Content quality and honesty

An author or reviewer must:

1. identify every capability statement in the page;
2. verify it against `docs/CLAIMS.md`, README wording, and the current
   production path;
3. describe roadmap behavior explicitly as unavailable or omit it;
4. avoid internal-only hostnames, tokens, customer data, or employer-specific
   workflows;
5. use user language first and link to deeper concepts rather than copying an
   engineering design dump;
6. add an SVG or decision table to each process page; and
7. run the corpus validator and broken-link/asset test.

Important honesty examples:

- S3 Help describes the shipped, human-confirmed Phase A backup/export only:
  no restore, remote delete, bidirectional sync, or S3-backed index.
- Log Help distinguishes shipped batch analysis from unshipped live tailing,
  alerting, and remote log-source connectors.
- Memory Help distinguishes shipped durable recall/review/purge behavior from
  any remaining bulk-import UI residual.
- Workspace Help uses the current configurable soft file cap and recorded
  resident-byte cap; it does not repeat obsolete “exactly 5,000 files” prose.

## 14. Verification strategy

### Contextual Help decision rule

Use contextual Help only after the control itself has a clear name, visible
state, sensible default, and direct feedback:

| Need | Product treatment |
| --- | --- |
| The basic action is repeatedly misunderstood | Redesign the control; a question mark is not a usability repair |
| A term or consequence needs one short sentence | Persistent inline hint or ordinary tooltip |
| Modes, tradeoffs, limits, privacy, or a short example matter at the decision point | Typed click-open `HelpTip` with a canonical `help://` locator |
| The complete workflow, decision table, or diagram is needed | **Open full Help** at the exact page and heading |

Required operating information is never hover-only. Rich Help is rendered in a
portal and collision-shifted on normal windows. At narrow widths it becomes a
modal bottom sheet with contained keyboard focus, Escape/backdrop/close
dismissal, and invoker focus restoration. Only one surface is open at a time.
Typed content may contain a definition, current state, use guidance, mode list
or compact comparison table, consequence, safety/privacy callouts, example,
shortcut, and canonical full-Help link. It does not fetch remote or
model-generated content at render time.

### Help impact on feature changes

Every user-visible feature PR records either the affected Help
page/anchor/contextual definition or `Help impact: none — <specific reason>`.
Review compares the Help claim to the current production path and
`docs/CLAIMS.md`; passing implementation tests is not sufficient when shipped
Help still teaches old controls.

### Core and corpus

- valid fixture and bundled corpus load;
- all required frontmatter failures, duplicate ids, related ids, traversal,
  symlinks, page/asset size limits, broken assets, and unsupported SVG content;
- stable chunk keys and UTF-8-safe boundaries;
- ranked keyword hits for `log template`, `soft write`, and `duckdb`;
- keyword-only operation with no embed backend;
- deterministic concept-embed query with zero lexical overlap changing rank;
- embed failure/timeout fallback;
- `read by id`, unknown id, anchor read, and bounded snippets/pages; and
- proof that no workspace root or SQLite store is created.

### Desktop

- navigation grouping, selected-page reader, sticky TOC anchors, and narrow
  layout state;
- search result ranking/mode affordance and keyboard interaction;
- `log analysis` opens the pipeline article and its SVG data URL;
- broken/rejected asset renders the controlled fallback;
- dark/light variables, visible focus, landmark labels, and reduced motion;
- a packaged-resource smoke test checks `help/` exists in the Tauri bundle
  configuration/output; and
- citation and contextual links open the exact Help page rather than Source.

### Agent

- specs are absent without an attached index and present with one;
- both tools are `Read`;
- offline execution returns bounded content, trail, and `help://` citations;
- log-triage wording returns the pipeline page;
- malformed ids/anchors and oversized limits are rejected or clamped; and
- permission state and durable memory remain unchanged.

Default `cargo test` and Vitest use fixtures and `ConceptEmbedBackend`; they do
not contact a model service or download an embedding model.

## 15. Delivery plan and claim gates

Work lands as an ordered commit series on `integrate/help-center`, promoted
once to `main` after the coherent batch passes the full gate:

| Order | Issue | Shippable layer | Claim/close gate |
| ---: | --- | --- | --- |
| 1 | #435 | This design | Document reviewed; explicit decision table below |
| 2 | #436 | Corpus, author guide, validator, seed pages/SVGs | Offline validation and honesty review pass |
| 3 | #437 | `cd-core::help::HelpIndex` and fixtures | Keyword/hybrid/read API tests pass |
| 4 | #438 | Tauri resource/commands and Help pane | Packaged offline browsing/search/diagram UI proven |
| 5 | #439 | ToolHost tools, trail/citations, citation navigation | Agent/tool product path proven offline |
| 6 | #440 | Palette, shortcut, contextual links | Three real entry points and shortcut proven |
| 7 | #441 | Remaining shipped-topic coverage and `CLAIMS.md` | Coverage audit and path:symbol anchors pass |

No child is closed while its work exists only on the integration branch. After
promotion, every child receives its own issue-specific close proof with merge
SHA/PR, pasted named test or UI evidence, agent/model attribution, and an
adversarial verdict. The epic closes only after its children and demo paths
are proven on `main`.

## 16. Locked decision table

| Fork | Decision | Why |
| --- | --- | --- |
| Corpus source | Curated `docs/help/` | Prevents internal design, mutation evidence, and agent instructions from leaking into user Help |
| Persistence | Read-only bundle; in-memory index/vector data | Corpus is small/versioned and must not mix with workspace or memory SQLite |
| Search availability | Keyword always; semantic optional | Offline Help and hermetic tests cannot depend on a model |
| Semantic implementation | `EmbedBackend` + `ExactIndex` through `VectorIndex` | Reuses proven primitives; bundled corpus does not justify HNSW |
| Fusion | 0.65 keyword / 0.35 semantic; no recency | Exact product terms stay predictable; bundle pages share one release |
| Public identity | `help://page-id[#anchor]` | Stable across file/section moves and usable by UI and agent |
| Desktop surface | First-class `PaneId = "help"` | Help remains browseable without chat |
| Asset rendering | Validated bundled SVG as `<img>` data URL | Works offline under current CSP without injecting SVG into the DOM |
| Agent permissions | `search_help` and `read_help`, Read only | Product documentation retrieval has no write reason |
| Ambient behavior | No automatic full-Help injection or search in v1 | Preserves model context budget and makes citations evidence-based |
| Authoring | Repository PRs only; no chat Help-write tool | Keeps review, claims checks, and release alignment authoritative |
| Remote content | None in v1 | Avoids SSRF, provenance, version skew, and untrusted-Markdown expansion |
