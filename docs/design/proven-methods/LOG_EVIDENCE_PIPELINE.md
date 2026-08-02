# Log evidence pipeline

**Method status:** **Partial.** ContextDesk ships the embedded post-mortem batch
pipeline: bounded ingest, redaction, parsing, Drain-style templates, DuckDB
events, template-scale vectors, structured/keyword/semantic search, facets,
analysis tools, packages, and Log Explorer query APIs. Bounded redacted
Original records, explicit-offset logfmt/RFC5424 normalization, and the shared
timeline/metric presentation are present on `main`. Built-in record grammars
use deterministic versioned fingerprints with content-only tie handling and
record-level dispatch. Bounded logical-record framing covers common stack,
PostgreSQL CSV, pretty-JSON, and CRI continuation shapes. Events persist parser
timestamp provenance, active time basis, and parser-recognized unresolved local
timestamp text. A user can review an inventory-bound exact import allowlist,
publish atomically, then preview/apply/undo multi-source IANA declarations
through revision-bound event publication. Whole-second storage, yearless
policy, abbreviation mapping, subsecond precision, and clock-skew review remain
#670; user-authored format profiles remain #751. #671 remains open for the
broader suppression surface beyond the shipped exact-template lens.

## 1. Problem

Post-mortem logs combine four difficult properties:

- very high volume;
- extreme repetition;
- inconsistent structure and timestamp quality; and
- sensitive, occasionally malformed source data.

A trustworthy system must make millions of events searchable without embedding
every line, must preserve enough source fidelity to audit formatting, and must
not align records across machines merely because their timestamp strings look
similar. It must also keep UI and model operations bounded regardless of corpus
size.

The reusable method is a layered evidence plane:

1. stream and normalize records safely;
2. redact before persistence or model-visible transformation;
3. parse only defensible structure and time;
4. persist event identity and quality in an analytical store;
5. collapse repetition into templates;
6. embed templates, not events;
7. expose bounded queries and summaries; and
8. let visualization and AI consume typed evidence rather than raw dumps.

## 2. Status and evidence

| Capability                                                  | Status                                    | ContextDesk evidence                                                                                                                           | Literal residual                                            |
| ----------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Streaming batch ingest and omission accounting              | **Shipped**                               | [`ingest.rs`](../../../crates/cd-core/src/log_analysis/ingest.rs)                                                                              | Live tailing remains later work                             |
| Bounded nested support-bundle ZIP intake                    | **Shipped**                               | [`ingest.rs`](../../../crates/cd-core/src/log_analysis/ingest.rs) nested-archive preflight, private staging, virtual identities, and adversarial tests | Three-container depth and fixed safety caps are deliberate  |
| Inventory-bound reviewed import                             | **Shipped — bounded #751/#763 slice**      | [`import_preview.rs`](../../../crates/cd-core/src/log_analysis/import_preview.rs), exact allowlist enforcement in [`ingest.rs`](../../../crates/cd-core/src/log_analysis/ingest.rs), `EngineClient`, and `ImportFlow` | Live manifest-role routing, per-source timezone exceptions, and packaged native proof remain |
| Bounded logical-record framing                              | **Shipped**                               | [`frame.rs`](../../../crates/cd-core/src/log_analysis/frame.rs) and the real-ingest [`log_conformance.rs`](../../../crates/cd-core/tests/log_conformance.rs) laboratory | Loose continuation recognition remains a bounded false-merge surface |
| Redaction before ordinary event persistence/embedding       | **Shipped**                               | [`redact_log.rs`](../../../crates/cd-core/src/log_analysis/redact_log.rs)                                                                      | Redaction cannot prove all domain-specific PII is removed   |
| Bounded redacted Original representation                    | **Shipped**                               | `prepare_original_record` and additive store fields in [`ingest.rs`](../../../crates/cd-core/src/log_analysis/ingest.rs) and [`store.rs`](../../../crates/cd-core/src/log_analysis/store.rs) | Bounded redacted fidelity, not unbounded raw retention      |
| JSON numeric/RFC3339 timestamp parsing                      | **Shipped**                               | [`parse.rs`](../../../crates/cd-core/src/log_analysis/parse.rs)                                                                                | Whole-second storage; no subsecond persistence               |
| Explicit-offset logfmt/RFC5424 normalization                | **Shipped**                               | [`parse.rs`](../../../crates/cd-core/src/log_analysis/parse.rs) and current-main proof on #681                                                  | Whole-second storage and no clock-skew correction            |
| Persisted parser timestamp evidence                         | **Shipped**                               | [`parse.rs`](../../../crates/cd-core/src/log_analysis/parse.rs), [`store.rs`](../../../crates/cd-core/src/log_analysis/store.rs), and [`query.rs`](../../../crates/cd-core/src/log_analysis/query.rs) | Persists provenance, active basis, and recognized unresolved local text; not byte-exact timestamp tokens or subsecond precision |
| Per-source IANA timezone preview/apply/clear                | **Shipped — bounded #779/#780 slice**      | [`timezone_resolution.rs`](../../../crates/cd-core/src/log_analysis/timezone_resolution.rs), [`timezone_application.rs`](../../../crates/cd-core/src/log_analysis/timezone_application.rs), and [`event_revision.rs`](../../../crates/cd-core/src/log_analysis/event_revision.rs) | No year inference, abbreviation guessing, custom profiles, or skew correction |
| Offsetless/yearless timestamps initially remain order-only  | **Shipped**                               | [`parse.rs`](../../../crates/cd-core/src/log_analysis/parse.rs)                                                                                | Only parser-recognized complete local calendar timestamps can use an explicit source IANA declaration; yearless forms remain unresolved |
| Versioned built-in grammar fingerprints                     | **Shipped**                               | [`format_profile.rs`](../../../crates/cd-core/src/log_analysis/format_profile.rs), [`parse.rs`](../../../crates/cd-core/src/log_analysis/parse.rs), and record-level ingest dispatch in [`ingest.rs`](../../../crates/cd-core/src/log_analysis/ingest.rs) | User-authored profiles and durable grammar/profile provenance remain #751 |
| Complete timestamp precision/year/abbreviation/skew policy  | **Planned/partial**                       | #670                                                                                                                                           | No current claim of seamless arbitrary timestamp alignment  |
| DuckDB event store                                          | **Shipped**                               | [`store.rs`](../../../crates/cd-core/src/log_analysis/store.rs)                                                                                | None for current batch architecture                         |
| Drain templates and template-only embedding                 | **Shipped**                               | [`drain.rs`](../../../crates/cd-core/src/log_analysis/drain.rs), [`embed_policy.rs`](../../../crates/cd-core/src/log_analysis/embed_policy.rs) | Cloud embedding remains opt-in/follow-up                    |
| Bounded event query, facets, Find, timeline summaries       | **Shipped**                               | [`query.rs`](../../../crates/cd-core/src/log_analysis/query.rs)                                                                                | Durable metric attachment and full #670 time policy         |
| Search/correlation/anomaly/trace tool surface               | **Shipped**                               | [`search.rs`](../../../crates/cd-core/src/log_analysis/search.rs), [`why.rs`](../../../crates/cd-core/src/log_analysis/why.rs)                 | Provider quality requires tools-enabled acceptance          |
| Privacy-reviewed diagnostic handoff                         | **Shipped**                               | `diagnostics.rs`, typed ingest evidence callbacks in `ingest.rs`, `logDiagnosticReport.ts`, `LogDiagnosticDialog.tsx`, `log_diagnostic_report.rs`, and `log_diagnostics.rs` | Reports are memory-only metadata; users still review before sharing |
| Exact-template noise/squelch policy                         | **Partial — #671 remains open**            | [`suppression.rs`](../../../crates/cd-core/src/log_analysis/suppression.rs), host-authoritative [`suppression_lens.rs`](../../../crates/cd-core/src/log_analysis/suppression_lens.rs) intersection on every Explorer read, shared query/analysis/tool lens, and Explorer Noise policy | Rule editing/creator identity; additional predicates; global/tool include-suppressed controls; Investigation/saved-view/package lifecycle; 100k and 1M suppression scale proof; baseline proposals; larger rule-set optimization |

## 3. Reusable method

```mermaid
flowchart LR
%% title: Bounded log evidence pipeline
    A["Source bytes"]
    P["Reviewed import plan<br/>trusted inventory + exact allowlist"]
    B["Record framing<br/>streamed + bounded"]
    C["Normalize encoding<br/>and line ending"]
    D["Redact complete record"]
    E["Parse structure + time<br/>persist evidence; fail to order"]
    F["Event store<br/>stable identity + active time basis"]
    G["Drain-style template<br/>pattern + parameters"]
    H["Template vectors<br/>optional"]
    I["Bounded query plane<br/>page · facets · search · timeline"]
    T["Explicit source time review<br/>preview · apply · clear"]
    L["Exact-template noise lens<br/>preview · confirm · audit"]
    J["Explorer / tools<br/>evidence identities"]
    K["Redacted Original<br/>bounded fidelity view"]

    A --> P --> B --> C --> D
    D --> E --> F
    D --> K
    E --> G --> H
    F --> I
    F --> T --> I
    G --> I
    H --> I
    G --> L --> I
    I --> J
    K --> J
```

The ordering is a trust contract. Redaction occurs on the complete normalized
record before a bounded Original is derived and before parsing or templating.
Parsing failure does not drop the record; it preserves a redacted message and
ingest-order identity. Templates reduce repeated structure but never replace
the event store as the source of event truth.

### Why “N× reduction” is not compression

The template reduction ratio is:

```text
event count / distinct template count
```

A `100×` value means that, on average, one distinct template represents 100
events for clustering and embedding. It does **not** mean source bytes or corpus
storage are 100 times smaller. Events and their changing parameters still
exist in the analytical store.

For a triage engineer, present three separate concepts:

- **template repetition:** events per template (`N×`);
- **template uniqueness:** distinct templates as a percentage of events; and
- **storage footprint:** source bytes versus corpus bytes.

This avoids calling an indexing optimization “compression.” A percentage
reduction can be derived as `1 - templates/events`, but it describes only the
number of strings embedded/analyzed at template scale.

## 4. Inputs, outputs, and data contracts

### Source record contract

| Concept          | Meaning                                                                  | Rule                                                                            |
| ---------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| source identity  | Relative file/object identity                                            | Never a private absolute path in UI/model DTOs                                  |
| ingest sequence  | Stable order assigned during import                                      | Always available; corpus-scoped                                                 |
| source bytes     | Complete framed record before text decoding                              | Counted for accounting; not necessarily retained                                |
| normalized text  | UTF-8 text after deterministic replacement and line-ending normalization | Encoding change is recorded                                                     |
| redacted text    | Complete normalized text after secret scrub                              | Parser and template input                                                       |
| bounded Original | Prefix of redacted text at a UTF-8 boundary                              | Must state truncation, source byte count, encoding normalization, and redaction |

The current local-integration Original contract caps one stored redacted record
at 64 KiB. It is “Original (redacted),” not raw bytes and not necessarily the
entire record. Ordinary event/query/model DTOs do not carry it; it is fetched
explicitly for an inspector.

### Event contract

| Field                         | Meaning                                                 | Important semantics                                          |
| ----------------------------- | ------------------------------------------------------- | ------------------------------------------------------------ |
| `corpus_id` + `seq`           | Authoritative event identity                            | `seq` is meaningful only inside its corpus                   |
| `source`                      | Relative provenance                                     | Revalidated for saved evidence                               |
| `ts`                          | Wall-clock whole seconds or ingest-order fallback today | Must be paired with quality                                  |
| parser timestamp provenance  | Explicit wall, unresolved local, order-only, or legacy evidence | Immutable across a timezone application or clear       |
| active timestamp basis       | Explicit wall, resolved local, order-only, or legacy interpretation | Changes atomically with `ts` through an event revision |
| unresolved local timestamp   | Bounded parser-recognized local calendar text            | Retained after apply and clear; not an arbitrary message parse |
| `time_quality`                | `wall`, `mixed`, or `order_only` projections            | A reliable source cannot upgrade an unreliable one           |
| `level`                       | Normalized severity token                               | Original spelling may only be available in redacted Original |
| `service`, `host`, `trace_id` | Optional parsed facets                                  | Missing is not empty evidence                                |
| `template_id`                 | Repeated-message pattern identity                       | Supplemental to event citation, not a replacement            |
| `message`, `params`           | Redacted parsed content                                 | Bounded in result DTOs                                       |

### Time truth model

The portable model should separate at least:

| Basis           | Meaning                                                              |            Alignable by default?            |
| --------------- | -------------------------------------------------------------------- | :-----------------------------------------: |
| Wall            | UTC instant supported by explicit zone/offset or trusted source rule |       yes, at its recorded precision        |
| Relative        | Duration from a source-local origin                                  | no, unless an explicit mapping is validated |
| Order           | Ingest/source order only                                             |                     no                      |
| Legacy inferred | Old record classified by a heuristic                                 |        only with visible limitation         |

```mermaid
flowchart LR
%% title: Timestamp evidence classification for alignment
    Z["Explicit UTC instant<br/>or numeric epoch"]
    O["Explicit numeric offset"]
    W["Wall-time evidence<br/>normalized to UTC"]
    A["Eligible for exact-time alignment<br/>at recorded precision"]
    L["Recognized offsetless<br/>local calendar timestamp"]
    D["User declares source IANA zone<br/>preview · confirm · revision"]
    U["Yearless · abbreviation-only<br/>malformed · missing"]
    Q["Order-only evidence<br/>stable ingest sequence"]
    C["No inferred timezone, year,<br/>or cross-source wall-time alignment"]

    Z --> W
    O --> W
    W --> A
    L --> Q
    L --> D --> W
    U --> Q --> C
```

The diagram does not suggest that every timestamp can be normalized. Explicit
instants participate in exact-time alignment at whole-second stored precision.
Explicit offsets win: a source declaration never rewrites a parser-proven
explicit instant. A parser-recognized complete local calendar timestamp starts
order-only and can become resolved wall time only after the user previews and
confirms a source-specific IANA declaration. Unsupported forms remain
navigable by stable ingest order.

Current ContextDesk storage persists the parser provenance, active basis, and
bounded unresolved local text alongside one whole-second `i64`. Preview is
bound to an exact corpus event revision and reports affected, existing
explicit-wall, and unchanged order-only counts; inclusive resolved range; DST
gap/fold counts; unsupported timestamp count; and out-of-range count. Apply
recomputes that preview and token before publication. The declaration survives
reopen; clear restores its resolved-local events to ingest order without
discarding parser evidence.

This is still a partial #670 implementation. It does not retain subsecond
precision or every byte of the original timestamp token, infer a year, map
timezone abbreviations, correct source clock skew, or support arbitrary
user-authored format profiles.

### Template contract

Each template has a stable corpus-local identity, pattern, count, first/last
seen, severity, and optional vector. An event retains its own identity and
changing parameters. Template vectors may rank candidate templates; a second
bounded event query resolves them back to evidence.

### Query contract

Every public query defines:

- exact corpus identity;
- filter intersection semantics;
- ordering and keyset cursor;
- inclusive/exclusive time bounds;
- maximum page, pattern, excerpt, and bucket sizes;
- time-quality requirements;
- cancellation behavior when supported; and
- whether a result is keyword, regex, semantic, or structured.

## 5. Invariants and trust boundaries

1. **Never parse or embed unredacted record text.**
2. **Never call the bounded redacted Original “raw” or “complete” when
   normalization, redaction, or truncation occurred.**
3. **Never drop a record solely because structured parsing failed.**
4. **Never invent a timezone, reference year, or DST choice.**
5. **Never let one wall-clock source upgrade another source's time quality.**
6. **Never use event payload fields as authoritative citation identity.**
7. **Never widen a noncontiguous evidence set to a sequence envelope.**
8. **Never embed every event merely to support semantic search.**
9. **Never let a malformed package or sidecar publish partial state.**
10. **Never describe template reduction as on-disk compression.**
11. **Never make blank timeline buckets disappear if gaps are semantically
    important.**
12. **Never apply a noise rule invisibly to evidence or model retrieval.**
13. **Never treat a support diagnostic as a corpus package.** Diagnostics use an
    explicit metadata allowlist, exclude event/template payloads and private
    configuration, reapply redaction at the native write boundary, and remain
    bounded and user-reviewed.

Trust boundaries:

- source bytes and paths are untrusted;
- the core/host owns decoding, redaction, parsing, caps, and storage;
- DuckDB and sidecars are authoritative only after validated publication;
- the webview receives typed redacted DTOs;
- the model receives bounded tool evidence, never corpus file access; and
- user-applied time/noise rules must be explicit durable policy with provenance.

## 6. Algorithm detail

### 6.0 Govern exact-template noise (#671 Slice 1)

1. A human starts from one corpus-local template identity and supplies a name
   and rationale.
2. The trusted core resolves the template fingerprint and computes an exact
   preview: raw matches, incremental hidden matches, levels, source count,
   inclusive span, and bounded redacted representatives.
3. The user reviews that preview and explicitly confirms it. Detector/model
   proposals cannot enable themselves.
4. The core publishes a versioned corpus sidecar. Mutations require the expected
   revision; disable, re-enable, and remove-to-tombstone operations append audit
   records. This is the current lifecycle surface, not full CRUD: rules cannot
   be edited and complete durable creator identity is not yet recorded.
5. Enabled template IDs become one bounded exclusion lens for rows, counts,
   facets, timeline, Find, analysis, and log tools. A linked turn pins one
   revision and discloses the revision and hidden-event count.
   The **host derives that set**; a caller's exclusions are a request. Every
   Explorer read intersects the request with the trusted set
   ([`suppression_lens.rs`](../../../crates/cd-core/src/log_analysis/suppression_lens.rs)),
   so a stale or compromised renderer can hide at most what the durable policy
   authorizes and never more. Intersecting rather than replacing is what keeps
   **Suspend all** and temporary reveal working: both request fewer IDs. A
   policy that cannot be resolved — malformed, truncated, future-version,
   cross-corpus, or superseded — yields an empty set with a typed reason, which
   hides nothing rather than continuing to hide stale IDs. Resolution is cached
   per corpus handle and revalidated against the sidecar's observed identity, so
   enforcement adds no sidecar read to paging, faceting, counting, or timeline
   work.
6. The raw/source/original/direct-evidence paths remain outside the lens.
   Resolving a suppressed bookmark offers a temporary, explicit reveal and a
   return to the prior lens.

The method intentionally makes no claim of automatic noise learning. It does
not delete events, alter source bytes, infer that a frequent template is
unimportant, or make a rule portable in package v1. The active lens is bounded
and fails closed rather than silently truncating an oversized rule set.

This exact-template Slice 1 is reversible and fail closed: enabled and
re-enabled predicates are revalidated against authoritative fingerprints,
bounded audit storage reserves terminal disable/remove capacity, publication
uses a cross-process corpus lock, sidecar reads do not follow links, and direct
adapter tests prove exclusion parity. #671 remains open for the broader policy
surface listed below.

### 6.1 Discover and frame

The optional reviewed path performs a read-only trusted preview before ingest.
The preview reports bounded portable identities, byte counts, classifications,
roles, reasons, and whether its inventory was truncated. A versioned SHA-256
plan token binds those facts. At run time trusted core re-enumerates the root
and rejects added, removed, resized, or reclassified entries before staging.
Only selected previewed `log` identities with an importable status enter the
exact allowlist; supporting, ignored, unsupported, blocked, duplicate, unknown,
and unreviewed-tail identities cannot become events. The allowlist applies
equally to a direct ZIP, directory ZIP, and nested archive chain. Cancellation
before atomic publication leaves no visible corpus; the UI remains present
until cancellation or the non-cancellable publication window is acknowledged.

1. Traverse only the selected import scope.
2. Reject symlinks/path escapes and count excluded, ignored, and failed files.
3. Treat a directly selected ZIP, a ZIP discovered in a directory, or a ZIP
   member inside another ZIP as a container only after bounded central-directory
   preflight.
4. Validate every archive identity before payload reads. Reject absolute,
   traversing, backslash-ambiguous, NUL-containing, duplicate-normalized, or
   archive-delimiter-conflicting names.
5. Preserve nested provenance with a virtual identity such as
   `support.zip!/host-a.zip!/logs/app.log`; identical basenames in distinct
   paths remain distinct sources.
6. Stream ordinary members in place. Copy only a nested archive container into
   private per-ingest staging, using a fixed buffer, and remove it when
   recursion returns or the ingest guard unwinds.
7. Apply cumulative entry and expanded-byte budgets across every nested level,
   plus per-member, depth, and compression-ratio limits.
8. Read records with bounded buffers.
9. Frame records deterministically; today the common path is line-oriented.
10. Preserve source and ingest-order identity.
11. Report partial import honestly if discovered content was not fully imported.

The ContextDesk reference policy permits three ZIP containers in one identity
chain, 50,000 cumulative entries, 512 MiB expanded bytes per member, 4 GiB
aggregate expanded bytes, and a 2,048:1 expanded-to-compressed ratio. These are
replaceable product bounds, not portable magic numbers. A reimplementation
must retain explicit caps, cumulative accounting, preflight-before-payload,
private staging, stable virtual identity, cancellation, and atomic
non-publication.

### 6.2 Normalize and redact

1. Remove one record delimiter without claiming exact original line endings.
2. Decode UTF-8; use deterministic replacement for invalid sequences and record
   that normalization occurred.
3. Redact the complete normalized record.
4. Feed the complete redacted text to parsing and templating.
5. Derive any durable Original representation only after redaction, with a
   UTF-8-safe byte cap and explicit truncation metadata.

### 6.3 Parse structure and timestamp

Use format detection as a hint, not a reason to discard.

Current production:

- JSON accepts numeric Unix seconds/milliseconds and RFC3339 strings with an
  explicit offset;
- logfmt accepts numeric time and explicit-offset RFC3339 timestamps;
- RFC5424 accepts explicit-offset timestamps;
- classic syslog and plain text fall back to ingest order; and
- storage is whole-second.

Equivalent positive/negative offsets and epoch forms map to one UTC second.
Fractional input is deterministically truncated to whole seconds. Offsetless,
yearless, malformed, and missing timestamps remain order-only.

The stored event separates immutable parser evidence from its current
interpretation:

- `timestamp_provenance` records whether the parser proved explicit wall time,
  recognized an unresolved local calendar timestamp, or had only order
  evidence;
- `unresolved_local_timestamp` retains the bounded recognized local text needed
  for a later source review; and
- `active_timestamp_basis` records whether the active `ts` is explicit wall,
  user-resolved local, order-only, or legacy.

No numeric-magnitude heuristic can promote ingest sequence to wall time.

Before parser dispatch, every non-empty bounded physical record receives a
transient `FormatFingerprint`. The immutable built-in registry is:

| Grammar ID | Version | Decisive content clue | Optional producer hint |
| ---------- | ------: | --------------------- | ---------------------- |
| `json-object-line` | 1 | complete valid JSON object | none |
| `logfmt-record` | 1 | at least two valid pairs including a recognized semantic field | none |
| `rfc5424-record` | 1 | valid numeric PRI plus RFC5424 header/structured-data framing | none |
| `classic-syslog-record` | 1 | exact month, day, time, host, and message framing | none |
| `date-level-logger-thread-record` | 1 | date/level/bracketed logger/parenthesized thread grammar | possibly WildFly/JBoss family |
| `date-level-message-record` | 1 | fractional local calendar timestamp, recognized severity, and payload | none |
| `date-context-level-message-record` | 1 | fractional local calendar timestamp, one bounded context token, recognized severity, and payload | none |
| `bracketed-timestamp-level-component-node-record` | 1 | four strict timestamp/level/component/node bracket groups | possibly Elasticsearch classic family |
| `local-minute-zone-level-record` | 1 | strict local minute/fraction, uppercase zone, level, and payload grammar | none |
| `plain-line` | 1 | no defensible structured match | none |

The fingerprint reports outcome (`matched`, `unknown`, or `ambiguous`), grammar
ID/version, optional producer hint, decisive clue codes, top score, runner-up
margin, and equal-scoring candidate IDs/versions when ambiguous. Registry
declaration order has no semantic effect. Equal top scores have a zero margin
and no selected grammar; candidates below the fixed eligibility threshold and
insufficient content evidence are `unknown`. Both outcomes preserve the
complete redacted line through `plain-line` and ingest-order time.

Path and extension can be supplied to the API for future bounded shortlisting,
but cannot score or select a grammar. This makes `.jsonl` ordinary text remain
plain. Conversely, a startup banner cannot lock later JSON or logfmt records
to plain: the current bounded strategy classifies each physical record
independently. Mixed-format files therefore remain honest without buffering a
whole source or sampling unbounded content.

Grammar identity is not producer identity. A record matching the
date/level/logger/thread grammar can carry a `wildfly-or-jboss-family` hint,
but the parser does not assert that WildFly emitted it. The fingerprint is
transient in this slice; durable per-source/per-event profile provenance,
custom profiles, preview/approval UI, and profile drift belong to #751.

The #747 parser slice also recognizes the common JBoss/WildFly
`server.log` prefix
`YYYY-MM-DD HH:mm:ss,SSS LEVEL [logger] (thread) message` (including a dot
millisecond separator). Logger and thread text remain in the parsed message and
the redacted Original retains the complete normalized line. An attached or
separate `Z`/numeric offset is normalized to a whole Unix second. An offsetless
local calendar timestamp is validated but the event deliberately retains
ingest-order time. The event persists that validated source text as
`unresolved_local_timestamp` with unresolved-local parser provenance. A user
may preview and confirm an IANA timezone for that exact portable source; the
parser does not choose one.

Two lower-scored producer-neutral grammars cover the common variants
`YYYY-MM-DD HH:mm:ss[,|.]fraction LEVEL message` and
`YYYY-MM-DD HH:mm:ss[,|.]fraction CONTEXT LEVEL message`. They accept one to
nine fractional digits, require a valid local calendar and a recognized
severity, retain the full redacted Original, and keep the timestamp unresolved
until a source timezone is explicitly reviewed. The stricter
logger/thread grammar remains authoritative when both shapes match.

The #749 parser slice recognizes the classic Elasticsearch bracketed shape
`[YYYY-MM-DD HH:mm:ss,SSS][LEVEL][component][node] message` by content, even
when a file-level sample was classified as plain text. It trims padded
severity, component, and node fields; maps component and node into the existing
service and host fields; and keeps the complete original line. As with
WildFly, an explicit `Z` or numeric offset becomes a whole-second instant while
an offsetless local timestamp remains order-only and is persisted as unresolved
source-local evidence until an explicit source declaration is applied.

The #752 parser slice also recognizes the strict content shape
`YYYY-MM-DDTHH:mm,SSS ZONE. LEVEL: message`. It extracts severity and payload
but deliberately leaves the complete timestamp token unresolved and
order-only. The producer grammar has not established whether the comma field
means seconds, milliseconds, or another unit, and abbreviations such as `CET`
are not resolved through the workstation locale. A future declarative source
profile (#751) may define those semantics; #670 must then retain the selected
rule/version and original evidence.

For eligible unresolved local timestamps, a resolution preview is scoped to
the corpus id and current event revision and contains no event payloads. It
reports exact counts for records that would resolve, explicit wall records that
would remain unchanged, other order-only records, DST gaps and folds,
unsupported timestamp shapes, and out-of-range results, plus the inclusive
resolved UTC range. Apply validates the same source, IANA zone, revision, and
preview fingerprint before publishing.

Apply, reapply, and clear use the event-revision layer. A candidate event table,
timestamp-change audit, declaration metadata, event and wall-event counts, and
min/max values publish in one transaction under a corpus lock. Identity,
payload, redacted Original, parser provenance, and unresolved local evidence
must match the active revision and remain unchanged. The previous complete
event set and audit are retained for one-step undo; stale revision, stale
preview, schema mismatch, payload mutation, or audit mismatch fails closed.
Clear publishes a new revision, removes the declaration, and returns only its
resolved-local records to `ts = ingest sequence` / order-only.

Reopen reconstructs declarations and per-source unresolved, resolved-local,
explicit-wall, and other-order counts from the active revision. Source and
corpus quality are recomputed from active timestamp bases and transactional
wall-event counts, so apply can move a corpus from mixed/order-only toward wall
and clear or undo can move it back without trusting stale import metadata.

These parser and resolution slices remain limitations, not a complete
timestamp system. A reimplementation should preserve the separation among
source acquisition, byte decoding, record framing, recursive envelopes,
record grammar, optional schema/profile mapping, and the normalized event.
ContextDesk does not yet claim general source adapters, encoding-aware decoder
coverage, arbitrary continuation/envelope handling, or user-authored profiles.
#670 remains open for subsecond precision, yearless policy,
abbreviation mapping, and non-destructive skew review.

### 6.4 Template and embed

1. Tokenize the redacted parsed message.
2. Generalize changing tokens into placeholders with an incremental Drain-style
   parse tree.
3. Update template count and temporal/severity summary.
4. Embed unique template patterns under a bounded policy.
5. Mark semantic state `keyword_only`, `deferred`, `partial`, or `complete`.
6. Preserve keyword/structured availability when embeddings are absent.

### 6.5 Persist and publish

- Events live in an embedded columnar analytical store.
- Templates and vectors remain a separate layer.
- Corpus metadata records files, omissions, events, templates, bytes, levels,
  time range, formats, and embedding state.
- Import/package publication uses staging, bounded expansion, hashes, and a
  final atomic visibility step.
- Legacy metadata remains readable; missing derived stats are recomputed rather
  than passively rewriting the corpus.

### 6.6 Query

1. Validate the corpus and filter contract.
2. Build parameterized predicates.
3. Use composite keyset ordering for forward/backward paging.
4. Cap page size, pattern length, regex scan, excerpt length, timeline buckets,
   and time range.
5. For semantic search, rank templates then resolve bounded event identities.
6. Return stable identities, source, time quality, and explicit mode.
7. Fetch complete formatted or redacted Original content only through a
   deliberate inspector path.

### 6.7 Lanes, gaps, and timeline

- A lane is a source-set query intersected with global filters.
- Independent mode has no alignment claim.
- Follow seeks peers near a selected time and is approximate.
- Align uses shared exact timestamp slots only when each participating lane has
  defensible wall time.
- Missing events are visible gaps, not synthetic rows.
- The range timeline is a bounded aggregate, not an event-body transfer.
- Dense fixed buckets should represent zero counts explicitly and use one
  shared axis for severity and lane tracks.
- A long blank duration must remain a gap; future compressed-gap views need
  explicit nonlinear-axis disclosure.

### 6.8 Portable diagnostic handoff

A support diagnostic and a shareable `.cdlog.zip` corpus package solve different
problems. The package intentionally carries analyzed corpus data. The diagnostic
is a small metadata report for reproducing product behavior across an isolated
workstation and a support machine.

Diagnostics are built from explicit allowlists rather than serialized product
state. A persisted-corpus report contains application identity, OS, corpus
identity/name, safe scalar counts, parse/level summaries, bounded
basename-only omission examples, embedding state, and an optional bounded
reproduction note or current UI status.

An active Explorer adds only payload-free reproduction state: layout and row
modes, time quality/linking, lane and selected-source counts, filter-presence
and numeric range information, bounded sequence identities, and logical
viewport anchors. Filter text, trace values, source/service/host labels, event
content, chat state, and model/provider state are deliberately not represented.

A failed ingest has no corpus identity. The trusted core recorder discards
free-form progress messages and original errors after mapping them to one
stable final reason code. Raw intake sends a separate typed callback for only
six evidence classes: `binary`, `empty`, `hidden`, `oversized`, `read_failed`,
and `parse_failed`. That callback constructs a secret-scrubbed, bounded final
basename in core; it never carries a parent path, archive ancestry, event
payload, or parser/filesystem error string.

The recorder keeps complete saturating counters for those six classes and at
most 20 basename/reason observations in deterministic ingest order. An
`omitted_entries` counter discloses additional observations beyond the
transcript cap. `parse_failed` means a bounded source/archive representation
could not be decoded under the intake contract (for example malformed ZIP
metadata or an over-limit logical line); an unknown log syntax still uses the
honest plain-log fallback and is not mislabeled as a parse failure.

The desktop owns one in-memory slot. Raw ingest begins a new generation before
fallible cache/provider setup; a setup failure is recorded into that new
generation. Starting any later raw or package import clears the prior slot
before its own fallible setup, a stale overlapping attempt cannot replace the
newer generation, explicit Clear removes it, and restart removes it. A
successful later attempt leaves the slot empty. Failure and cancellation
therefore cannot publish a partial corpus merely to support diagnostics. The
same typed observer is used for directory, directly selected ZIP, and
recursively nested ZIP intake.

These structural choices keep top-template patterns, event payloads, source
labels and absolute paths, chats, provider/model inventories, evaluator truth,
private network identities, and secrets outside the report.

The user previews the exact Markdown or JSON before saving. The renderer sends
a recursively `deny_unknown_fields` metadata DTO, not report text. The host
validates identifier and Git-SHA shapes, applies secret/location scrubbing to
every untrusted string, enforces all collection and byte bounds, renders both
formats, and returns those exact previews under a bounded opaque in-memory
report ID. Unknown payload/model fields fail closed. Saving sends only that ID
and the selected format; the renderer cannot author export text, select a
destination, assert overwrite confirmation, or authorize itself through a
separate IPC call.

Reproduction-note edits are debounced and host preparations are serialized.
Queued stale generations are discarded before host work, stale completions are
released, an accepted replacement releases its prior report ID, and closing
the dialog releases the selected ID. This keeps the visible preview saveable
even when many edits occur within the host store's bounded report window.

Host privacy handling covers secret tokens, ordinary private-suffix hosts such
as `server.internal`, arbitrary absolute Unix/Windows paths, private/loopback
IPv4, and loopback/unique-local/link-local IPv6. The invoking native window
owns the Save panel. Cancellation is typed and writes nothing. A completed save
returns `saved`; a cleanup or directory-durability failure after publication
returns `saved_with_warning` so the UI never claims a committed report was not
saved.

For an accepted exact preview, the host writes and syncs a restricted,
create-new sibling temporary file. A new destination is published without
replacement using `renamex_np(RENAME_EXCL)` on macOS,
`renameat2(RENAME_NOREPLACE)` on Linux, or write-through `MoveFileExW` without
replacement on Windows. Unsupported Unix compatibility paths fail closed. A
native-panel-confirmed existing destination is atomically replaced with
same-filesystem rename on Unix or write-through `MoveFileExW` on Windows.
Publication is the commit point. The parent directory is then synced on Unix;
post-commit cleanup or sync failures become typed warnings. Temporary files are
cleaned after pre-publication errors, and symlink or Windows reparse-point
destinations are refused. Diagnostics remain distinct from a `.cdlog.zip`
package, which intentionally contains analyzed corpus data.

The renderer report builder still narrows product state into the allowlisted
DTO for display responsiveness, but only the host-rendered and host-retained
result can be copied or saved. The native write boundary revalidates the stored
content before publication. The UI therefore never reconstructs evidence by
parsing free-form progress or error strings.

## 7. Performance and bounds

| Dimension                              |                            ContextDesk bound/policy | Behavior                                               |
| -------------------------------------- | --------------------------------------------------: | ------------------------------------------------------ |
| Source ingest memory                   |                        Streamed record/file buffers | Does not load whole corpus                             |
| Archive-container depth                |                                          3 ZIP layers | Reject deeper chains atomically                        |
| Raw bundle entries                     |                                   50,000 cumulative | Reject before unbounded traversal                      |
| Archive member expanded bytes          |                                            512 MiB | Exclude or reject under the typed policy               |
| Raw ingest aggregate expanded bytes    |                                              4 GiB | Reject atomically                                      |
| Archive compression ratio              |                                            2,048:1 | Reject suspicious metadata before payload reads        |
| Original (redacted)                    |                     64 KiB redacted UTF-8 per event | Truncate with metadata after full-record redaction     |
| Ordinary event page                    |             200 default; core hard cap in query API | Keyset page                                            |
| Timeline buckets                       |                                         256 maximum | Clamp; no event bodies                                 |
| Find/regex pattern                     |                                      256 characters | Reject                                                 |
| Search excerpt                         |                                      160 characters | UTF-8-safe truncate                                    |
| Bounded regex scan                     | 50,000 resident/candidate events in the proven path | Refuse/limit broader work                              |
| Tool reported-time window              |                                              7 days | Both bounds required; lower inclusive, upper exclusive |
| View selected identities               |                                                  64 | Sort/deduplicate/truncate for model hint               |
| Bookmark exact refs/item               |                                                 512 | Reject larger save                                     |
| Bookmark total refs/sidecar            |                                               8,192 | Reject malformed/oversized sidecar                     |
| Template embeddings at ordinary ingest |                                   Top 256 templates | Persist honest partial state                           |
| Embedding defer threshold              |              More than **60 MiB** streamed source bytes (measured so the explicit generated triage-stress 250k acceptance corpus at 63,883,809 B defers; bundled seven-day 25k and smaller 100k product paths still embed) | Publish keyword/structured corpus                      |
| Trusted reanalysis                     |                               Up to 2,048 templates | Atomic sidecar publication                             |

Reference-machine measurements for the existing deterministic 100k-event proof
are useful regression evidence, not universal targets: 100,000 events across 10
files, roughly 16.4 MB source, 4.449 s import, 31 ms first page, 15 ms timeline,
73 ms deep Find, and 3.776 s bounded 50k-row regex on one machine.

For 10–100M-line aspirations, measure peak memory, staging disk, event scan
latency, template count, and cancellation—not only ingest throughput.

## 8. Failure and recovery

| Failure                       | Detection                        | User-visible state            | Recovery                                   | Guarantee                                 |
| ----------------------------- | -------------------------------- | ----------------------------- | ------------------------------------------ | ----------------------------------------- |
| Invalid UTF-8                 | Decoder reports replacement      | Encoding normalized label     | Inspect redacted Original                  | Event retained                            |
| Secret pattern                | Redactor changes/blocks content  | Redaction indicator           | None without privileged source outside app | Secret not persisted in ordinary fields   |
| Unknown format                | Parser cannot defend structure   | Plain/order-only quality      | Configure future source rule or use search | Record not dropped                        |
| Offsetless local timestamp    | No explicit zone/rule            | Order-only/unresolved         | Preview and explicitly confirm an IANA zone for that source | Workstation zone not guessed |
| DST fold or gap under selected zone | Preview resolver reports ambiguity/nonexistence | Counted and left unresolved | Choose a different defensible source declaration or keep order-only | No silent DST choice |
| Yearless syslog               | No reference-year policy         | Order-only/unresolved         | Future explicit rollover policy            | Current year not guessed                  |
| Fractional timestamp today    | Whole-second store               | Precision limitation          | #670 schema evolution                      | No false subsecond claim                  |
| Mixed time quality            | Active per-event bases and transactional wall count | Align disabled or limited | Inspect, preview, and explicitly apply eligible source policy | Reliable peer does not upgrade it |
| Stale timezone preview        | Corpus revision/token mismatch   | Apply refused                 | Reopen review and preview current revision | No stale mutation                         |
| Embedding unavailable/timeout | Embed status                     | Keyword-only/deferred/partial | Trusted reanalysis                         | Corpus remains usable                     |
| Import omission/read error    | Per-file counters/reasons        | Partial corpus status         | Correct input and reimport                 | Missing data not hidden                   |
| Unsafe/malformed nested ZIP   | Shared archive preflight/budgets | Stable import error           | Correct or split the bundle                | No partial corpus; private staging removed |
| Cancelled ingest/reanalysis   | Cancel flag/progress             | Cancelled                     | Retry                                      | Previous published corpus/index preserved |
| Malformed package             | Preflight/hash/schema checks     | Import error                  | Obtain valid package                       | No partial corpus publication             |
| Stale evidence identity       | Source/time hint revalidation    | Stale/missing                 | Locate replacement explicitly              | No silent rebinding                       |
| Noise overwhelms results      | User observation/filter counts   | Partial exact-template policy; #671 open | Preview/confirm a reviewed exact template; use filters otherwise | No deletion claim; incomplete lifecycle and hardening stay visible |

## 9. Observability

Persist or expose:

- discovered/imported/excluded/failed/ignored file counts;
- stable omission reasons with bounded basename-only examples;
- source bytes and corpus bytes;
- event and template counts;
- template repetition and embedding state;
- format and normalized severity counts;
- timestamp quality counts—not only min/max;
- persisted parser timestamp provenance and active timestamp-basis counts;
- source timezone declarations with their applied revision;
- preview affected/existing/unchanged, DST gap/fold, unsupported, out-of-range,
  and inclusive-range values;
- active event revision, wall-event count, and one-step undo availability;
- redaction, encoding normalization, and Original truncation flags;
- query mode, filter, result/page count, bucket count, and cancellation;
- per-phase progress and duration (progress chrome stays one monotonic Stream for interleaved work; completion diagnostics expose separate discover/read, parse/frame, template-analysis, persist/index, optional-embedding, validation, and publication timings from core through host DTO/TypeScript); and
- package version/hash verification.

Future #670 observability should add full precision, yearless/abbreviation
policy evidence, relative-time semantics, and any proposed skew overlay. The
shipped declaration metadata identifies the explicit source IANA rule and
revision responsible for resolved-local active time.

## 10. Security and privacy

- Redact before persist and before embed.
- Keep cloud embeddings off by default and require explicit per-corpus egress
  confirmation.
- Store corpora in application cache as disposable incident data; keep durable
  investigations elsewhere.
- Store local ONNX model artifacts in an application-owned model cache, never
  relative to the desktop process working directory.
- Do not expose home paths through IPC or public diagnostics.
- Treat filenames and log messages as untrusted content.
- Validate package paths, sizes, entry counts, hashes, and versions before
  publication.
- Never offer an unredacted Original view as a convenience feature.
- Exact-template noise rules are transparent to UI queries, analysis tools,
  and model context; they cannot secretly delete evidence. Linked tools pin and
  disclose the active policy revision and hidden count.
- A future clock correction must be a reversible overlay with provenance and
  uncertainty, not a rewrite of source truth.

## 11. UX and human factors

A triage engineer needs:

- useful normalized UTC when defensible;
- clear `mixed` or `order-only` labels when not;
- source provenance in every aggregate row;
- compact severity/source tokens with accessible full labels;
- formatted and Original (redacted) inspector tabs;
- explicit notices for truncation, redaction, and encoding normalization;
- independent Find highlights and Filter row reduction;
- forward/backward paging or seamless bidirectional scroll;
- lanes that preserve source membership and show gaps honestly;
- timeline volume/severity/lane tracks on a shared axis;
- explicit Follow versus Align semantics; and
- temporary filters separate from durable, visible noise policy.

Uncertainty and required operating information must be visible in focusable
details, not only a hover tooltip.

## 12. Test recipe

| Layer                | Required proof                                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Parser unit          | Registry identity/version uniqueness; JSON/logfmt/RFC5424/classic/special/plain fingerprints; equal-score ambiguity independent of order; banner/mixed records; incidental pairs; extension disagreement; pseudo-PRI; non-syslog `Jan…`; positive/negative offsets; malformed, offsetless, yearless, overflow; fractional precision contract; Unicode |
| Redaction unit       | Complete-record redaction precedes truncation; secret absent from parser/store; invalid UTF-8 and CRLF accounting                            |
| Store integration    | Stable corpus+seq+source identity; exact/noncontiguous references; legacy schema read; additive Original unavailable/available behavior      |
| Query integration    | Filter intersection; keyset forward/backward; time bounds; regex cap; semantic template-to-event resolution; dense gap buckets; exact-template suppression parity across rows/counts/facets/timeline/Find, with the excluded set derived by the host rather than accepted from the caller |
| Suppression store    | Trusted preview facts; human confirmation; stale preview/revision/fingerprint rejection; enable/disable/re-enable/tombstone audit; raw evidence unchanged |
| Tool integration     | Search/clustering/timeline/correlation/anomaly/trace share one pinned revision and disclose hidden count; suppressed identities do not leak into results |
| Package              | Frozen version fixture; path traversal, duplicate, cap, hash, too-new reader, staging cleanup                                                |
| Deterministic corpus | Known cross-zone shared instant, ambiguous controls, noise families, long line, secret sentinel, stale identity                              |
| Desktop component    | Inspector tabs/copy; time-quality labels; Find versus Filter; lane membership; gaps; timeline seek; focus restoration                        |
| Packaged/native      | Narrow/normal/wide/ultrawide; 25k/100k corpora; Original fresh/legacy; useful time; resizable columns; long rows; two-way paging             |
| Scale                | 100k deterministic regression every acceptance pass; larger generated corpora periodically with machine metadata                             |

The cross-zone fixture's expected answer must stay outside imported roots. Tests
should assert all supported explicit-offset forms resolve to the known UTC
instant while ambiguous controls remain order-only.

## 13. ContextDesk anchors

- [`ingest.rs`](../../../crates/cd-core/src/log_analysis/ingest.rs): streaming
  import, progress, cancellation, accounting.
- [`redact_log.rs`](../../../crates/cd-core/src/log_analysis/redact_log.rs):
  redaction and local-integration Original contract.
- [`format_profile.rs`](../../../crates/cd-core/src/log_analysis/format_profile.rs):
  immutable built-in registry and explainable transient fingerprint contract.
- [`parse.rs`](../../../crates/cd-core/src/log_analysis/parse.rs): record-level
  parser dispatch and timestamp parsing.
- [`store.rs`](../../../crates/cd-core/src/log_analysis/store.rs): DuckDB event
  store, corpus metadata, embedding state.
- [`drain.rs`](../../../crates/cd-core/src/log_analysis/drain.rs): incremental
  templates.
- [`embed_policy.rs`](../../../crates/cd-core/src/log_analysis/embed_policy.rs):
  deterministic embedding/defer policy.
- [`query.rs`](../../../crates/cd-core/src/log_analysis/query.rs): pages, facets,
  advanced Find, timeline summaries.
- [`search.rs`](../../../crates/cd-core/src/log_analysis/search.rs) and
  [`why.rs`](../../../crates/cd-core/src/log_analysis/why.rs): evidence
  retrieval and analysis.
- [`package.rs`](../../../crates/cd-core/src/log_analysis/package.rs): portable
  versioned package.
- [`bookmarks.rs`](../../../crates/cd-core/src/log_analysis/bookmarks.rs):
  payload-free exact evidence identity.
- Canonical designs: [Log analysis](../LOG_ANALYSIS.md) and
  [Log Explorer](../LOG_EXPLORER.md).

## 14. Shipped / partial / planned matrix

| Slice                          | Status                        | What is true now                                              | What is not claimed                     |
| ------------------------------ | ----------------------------- | ------------------------------------------------------------- | --------------------------------------- |
| Batch ingest/store/templates   | **Shipped**                   | Embedded local pipeline and deterministic states              | Live sources/tailing                    |
| Redacted Original              | **Shipped**                   | Bounded, redacted, tested source representation                | Unbounded raw retention or perfect domain-specific PII removal |
| Explicit-offset JSON           | **Shipped**                   | Defensible RFC3339/epoch to whole seconds with persisted explicit-wall provenance | Subsecond persistence |
| Explicit-offset logfmt/RFC5424 | **Shipped**                   | Explicit `Z`/offset forms normalize to whole seconds and remain authoritative under source declarations | Subsecond persistence and skew correction |
| Source timezone resolution     | **Shipped — bounded #779/#780 slice** | Persisted unresolved local evidence; revision-bound IANA preview/apply/reopen/clear; DST gap/fold counts; atomic quality recomputation; one-step undo | Yearless policy, abbreviation guessing, custom profiles, subsecond persistence, or skew correction |
| Built-in grammar fingerprints | **Shipped**                    | Immutable versioned registry, record-level dispatch, explicit unknown/ambiguous outcomes, and grammar/producer separation | Durable grammar/profile provenance, custom profiles, profile drift, and multiline framing (#751) |
| JBoss/WildFly `server.log`      | **Partial**                   | Structure and explicit offsets parse; recognized offsetless local text persists and can use an explicit source IANA declaration | No automatic zone/year inference or arbitrary grammar profile |
| Classic Elasticsearch logs     | **Partial**                   | Bracketed structure and explicit offsets parse; padded metadata is normalized; recognized local text can use an explicit source IANA declaration | No automatic zone/year inference or arbitrary grammar profile |
| Incomplete time + zone abbreviation | **Partial**              | Strict shape, level, payload, and unresolved source token are preserved | Comma-field semantics and abbreviation mapping require a versioned source profile (#751/#670) |
| Arbitrary timestamp diversity  | **Planned/partial**           | Ambiguous inputs fail to order rather than guess              | #670 timezone/year/DST/skew contract    |
| Query/facets/search            | **Shipped**                   | Bounded event and template-aware retrieval                    | Unbounded regex or raw dumps            |
| Timeline                       | **Partial**                   | Shared-axis log summary, durable one-per-corpus metric attachment, restore/replace/remove, scrubber, severity signal, resident range, lane coverage, and viewport-follow cursor | Multiple/bundle metric attachments, governed metric chat context, and full #670 time policy |
| Noise suppression              | **Partial — #671 remains open** | Human-confirmed exact-template rules and one shared evidence lens the host derives and enforces on every read | Rule editing/creator identity; other predicates; global/tool include-suppressed controls; Investigation/saved-view/package lifecycle; 100k and 1M suppression scale proof; baseline proposals; larger rule sets |
| Template “reduction”           | **Shipped**                   | Events/templates ratio                                        | Storage compression claim               |

## 15. Reimplementation notes

The analytical SQL engine, template algorithm, vector backend, and UI framework
are replaceable. Preserve:

- record streaming;
- redaction-before-parse;
- stable event identity;
- explicit time basis/quality;
- template/event separation;
- optional semantic availability;
- bounded queries;
- explicit gaps; and
- non-destructive source fidelity.

Freeze timestamp representation and provenance before production ingest. Moving
from whole seconds to subsecond instants after data exists affects ordering,
pagination cursors, evidence identity, package compatibility, and timeline
buckets.

Do not use event count divided by template count as evidence of storage savings.
Measure source bytes and corpus bytes separately. Do not use workstation locale
to “helpfully” interpret an offsetless production timestamp.

## 16. Open residuals

- #670 remains open: the bounded #779/#780 slice persists parser provenance,
  active basis, and recognized unresolved local text and ships explicit
  per-source IANA preview/apply/reopen/clear with DST gap/fold disclosure,
  atomic revision, quality recomputation, and one-step undo. Residuals include
  subsecond persistence, complete original timestamp-token fidelity, yearless
  policy, abbreviation mapping, relative-time semantics, clock-skew
  review/correction, package compatibility, and arbitrary custom profiles.
- #671 remains open/partial: add rule editing and complete creator identity;
  source/service/host, level-plus-template, and reviewed-text predicates;
  Investigation/saved-view and package lifecycle; global temporary and visible
  auditable tool include-suppressed controls; suppression-specific 25k/100k and
  optional-1M measurements; baseline proposals; and larger-rule-set
  optimization.
- #751: durable profile provenance, user-authored profile lifecycle,
  preview/approval UI, profile drift, and bounded multiline framing.
- #667: optional metric/time-series tracks on the shared axis.
- #639: final persistent timeline acceptance and future richer interactions.
- The current Original representation is redacted text after normalization, not
  byte-for-byte source. Exact byte preservation would require a separate
  security and retention design.
- Large 10–100M-line behavior needs periodic scale proof beyond the deterministic
  100k acceptance fixture.
