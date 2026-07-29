# ContextDesk Log Lab

The Log Lab is a deterministic, entirely synthetic set of incident logs for
exercising ContextDesk's real log ingestion, Log Explorer, and linked-chat
paths. It contains no customer, employer, developer-machine, production, or
third-party log material.

The compact fixtures are intentionally small enough for default offline tests.
The generator also produces scale and **behavior-rich** profiles outside Git:

| Profile | Purpose | Default size |
| --- | --- | --- |
| `small` | Checked-in mystery scenarios | ~100 events |
| `medium` | Legacy regular 100k import/paging smoke | 100,000 / 4 sources |
| `ui-medium` | Multi-day investigation corpus (#542) | 100,000 / 8 sources / 3 days |
| `seven-day` | Sparse/burst lane + navigator corpus | 25,000 / 8 sources / 7 days |
| `paging-stress` | Boundary sentinels for eviction/seek | 12,000 / 6 sources |
| `triage-stress` | Error-heavy broad triage and exact-template de-noising | 250,000 / 12 sources / 8h 40m 49s |
| `large` | Opt-in stress (never commit) | 1,000,000+ |

Event count, wall-clock span, source count, and traffic shape are **independent**
controls on behavior profiles (`--events`, `--span-secs`, `--sources`).

The default `seven-day` output is also pinned under
`acceptance/seven-day-25k/` as a long-lived golden acceptance corpus. The
100,000-event and million-event profiles remain generated on demand so Git
history stays bounded.

## Safety and provenance

- All hosts use `.example`; any IP fixture must use the RFC 5737 documentation
  ranges.
- Names, trace ids, request ids, jobs, credentials, and incidents are fictional.
- Credential-shaped values exist only in the `redaction` and
  `company-original-fidelity` scenarios. They contain the explicit
  `LOG-LAB-INVALID` marker and are not usable credentials.
- `truth/` is evaluator-only. Never select a scenario directory as the import
  root: select its `import/` child.
- The generator safety check rejects home-shaped paths, the current `HOME`
  value, unapproved credential shapes, non-reserved URLs, and non-documentation
  IPv4 addresses.
- The corpus and generator are original repository test material under the
  repository license.

## Generate

The output directory must be absent or empty. These commands require no
network, credential, model, or external log service.

```sh
# Regenerate the compact frozen corpus in a temporary directory.
cargo run -p cd-core --example generate_log_lab -- \
  --output /tmp/contextdesk-log-lab-small \
  --profile small

# Generate the bounded medium smoke corpus (100,000 events, legacy regular rate).
cargo run -p cd-core --example generate_log_lab -- \
  --output /tmp/contextdesk-log-lab-medium \
  --profile medium

# Behavior-rich UI medium (100k, 8 sources, multi-day, rare Find/bookmark sentinels).
cargo run -p cd-core --example generate_log_lab -- \
  --output /tmp/contextdesk-log-lab-ui-medium \
  --profile ui-medium \
  --record-perf

# Seven-day sparse/burst (event count independent of calendar span).
cargo run -p cd-core --example generate_log_lab -- \
  --output /tmp/contextdesk-log-lab-seven-day \
  --profile seven-day

# Paging/eviction sentinels.
cargo run -p cd-core --example generate_log_lab -- \
  --output /tmp/contextdesk-log-lab-paging \
  --profile paging-stress

# Estimate, then generate the local-only 250k broad-triage corpus.
cargo run -p cd-core --example generate_log_lab -- \
  --profile triage-stress \
  --estimate-only
cargo run -p cd-core --example generate_log_lab -- \
  --output target/contextdesk-demo-lab/triage-stress-250k \
  --profile triage-stress \
  --record-perf

# Disk estimate only (no files written).
cargo run -p cd-core --example generate_log_lab -- \
  --profile large --events 1000000 --estimate-only

# Generate an explicitly local stress corpus. Large output is never committed.
cargo run -p cd-core --example generate_log_lab -- \
  --output /tmp/contextdesk-log-lab-large \
  --profile large \
  --events 1000000
```

Every successful run prints its file count, event count, byte count, and
deterministic tree SHA-256. Two identical runs with the same profile and
controls are byte-for-byte identical. The integration regression generates the
compact tree twice, compares it byte-for-byte, and compares it with the
checked-in snapshot.

`--record-perf` writes `performance-record.template.json` next to the corpus.
Fill measured import/first-page/deep-seek/peak-memory fields on **your**
machine; never treat one host as a universal performance threshold.

## Scenarios

### `checkout-cascade`

The primary mystery spans API, deployment audit, database, edge, queue, and
worker logs. The supported conclusion requires correlating a pool-size change
with a repeatedly delivered poison job, the resulting database saturation,
secondary 504/429 symptoms, and recovery after dead-letter plus rollback.

The certificate rotation and healthy `/health` traffic are deliberate decoys.
The answer cannot be established from a single file. It requires at least three
sources and identifiers such as `trace-checkout-42`, `job-7f3a`,
`req-7f3a`, and `change-204`.

Canonical starting questions:

1. What caused the checkout failures, and which events establish the causal
   chain?
2. Which failures were primary versus secondary symptoms?
3. Which apparent clue is a decoy, and what disproves it?
4. What changed immediately before recovery?

Useful literal/structured probes include `job-7f3a`, `pool-max-4`,
`trace-checkout-42`, error events from `edge/access.jsonl`, and the
`audit-rollback` event. The complete expected evidence and scoring rubric are
under `truth/manifest.json`.

### `mixed-time-quality`

Contains wall-clock JSON, order-only plain text, malformed/missing JSON
timestamps, clock skew, and late arrival. It is designed to prove that
order-only evidence cannot be upgraded into calendar time and that empty,
failed, or unloaded lanes do not strengthen a time claim.

### `source-provenance`

Contains JSON, logfmt, syslog-like, plain, CRLF, UTF-8, empty, stack-trace, and
rotated inputs. `region-a/app.jsonl` and `region-b/app.jsonl` deliberately share
a basename so basename-only provenance is insufficient.

### `importer-edge-cases`

The compact import root contains safe, binary, hidden, and empty files.
`recipes/archives.json` specifies traversal, absolute, drive-prefix,
backslash, ambiguous-separator, duplicate-name, compressed-limit, truncated,
and zero-safe-file archives that focused tests construct without checking
large hostile artifacts into Git.

### `redaction`

Contains unmistakably invalid credential-shaped values. Investigation remains
possible through event ids, the fictional user, and trace id after the raw
values are removed. Tests must prove raw values are absent from persisted
events, search, Explorer DTOs, linked-chat context, diagnostics, snapshots, and
portable packages.

### `company-timestamp-diversity`

Company-trial fixture for timestamp encodings. Includes RFC3339 UTC, the same
instant with positive and negative offsets, epoch seconds, epoch milliseconds,
fractional seconds, logfmt with an explicit RFC3339 offset, RFC5424-style
syslog with an offset, yearless classic syslog, DST-ambiguous local time without
an offset, malformed and missing timestamps, known source-clock skew, and a
late-arriving event.

Truth distinguishes exact shared instants, similar local display only, unusable
timestamps, order-only or incomplete times, known skew **without** claiming
automatic correction, and late arrival. Import only
`scenarios/company-timestamp-diversity/import/`.

Canonical probes: `shared-instant`, `event_id=ts-yearless-syslog`,
`event_id=ts-dst-ambiguous`. This scenario supports evaluation of future
timestamp work (#670); it does **not** claim normalization already ships.

### `company-known-noise`

Company-trial fixture for noise versus real signal. Includes frequent health
checks, repetitive retry warnings, a known-benign health-probe connection-reset
template, a superficially similar but important payment-settle reset, other
ERROR events that share only a level, and a real checkout incident whose
visibility would be damaged by suppress-all-ERROR.

Truth lists exact `safe_suppression_candidates` counts, events that
`must_remain_visible`, and `unsafe_broad_predicates` (level-only and broad
regex) with would-hide counts. Import only
`scenarios/company-known-noise/import/`.

Canonical probes: `event_id=noise-important-reset`,
`event_id=noise-incident-error`, `GET /health`. Supports evaluation of future
known-noise work (#671); it does **not** claim suppression already ships.

### `company-original-fidelity`

Company-trial fixture for original-line fidelity across JSON (deliberate key
order, unknown fields, nested objects), logfmt, syslog, plain text, CRLF, a
long but bounded line, Unicode, punctuation/escapes, and
`LOG-LAB-INVALID` credential-shaped markers.

Truth lists which textual properties should remain visible in a future
**Original (redacted)** representation and which synthetic values must be
redacted. Import only `scenarios/company-original-fidelity/import/`.

Canonical probes: `event_id=fid-json-nested`, `event_id=fid-long-line`, `café`.
Supports evaluation of future Original (redacted) work (#673); it does **not**
claim that view already ships.

A non-technical company-data trial procedure lives in
`docs/COMPANY_LOG_DATA_TRIAL.md`.

### Generated `triage-stress`

This local-only #745 profile recreates the shape that challenged broad linked
triage on a company corpus without copying company data. The default emits
exactly 250,000 wall-clock events over 12 synthetic sources and services:
160,000 INFO, 7,500 DEBUG, 37,500 WARN, and 45,000 ERROR.

It deliberately combines:

- four high-volume repetitive ERROR families and four repetitive WARN
  families;
- 620 lower-severity routine INFO families, one DEBUG family, and enough total
  cardinality to cross the 512-template clustering candidate cap;
- three seven-step, multi-source incident chains: database pool exhaustion,
  incomplete signing-key rollout, and cache-refresh stampede; and
- 16 occurrences of every incident role so high-value patterns are rare
  relative to the corpus but still deterministic and independently searchable.

The generator records 650 exact family identities. Production ingest currently
reduces those to exactly 648 parser templates; the distinction is explicit in
the generated truth manifest. The evaluator-only manifest also records exact
per-source counts, safe exact-template noise candidates, incident windows,
canonical probes, and a broad-chat rubric.

Import only:

```text
target/contextdesk-demo-lab/triage-stress-250k/scenarios/triage-stress/import/
```

Do not import or attach its sibling `truth/` directory. Useful opaque probes
include `CDLAB2004`, `CDLAB3102`, `CDLAB4203`, `trace-fixture-a17`,
`trace-fixture-b29`, and `trace-fixture-c41`. The imported records do not name
the evaluator incidents or causal roles; those remain truth-only.

The generated tree is ignored by Git and must remain local. `--events` may be
overridden down to 10,000; source count and timestamp design are fixed so the
truth contract remains meaningful. The command rejects nonempty output
directories rather than overwriting prior work.

### Generated `scale` (legacy medium / large)

The medium and large profiles create four source files with deterministic
timestamps, trace ids, levels, and repeated templates. Medium is the required
100,000-event import/paging smoke test. Large is an opt-in local stress tool;
record the machine, corpus size, elapsed time, CPU, and memory before making a
performance statement.

### Generated `behavior-scale` (`ui-medium`, `seven-day`, `paging-stress`)

Behavior-rich profiles (#542) write under `scenarios/behavior-scale/` with a
scenario-v2 truth manifest derived from the generated row plan. It records:

- generator/scenario versions, seed, counts, hashes;
- source identities and per-source counts;
- requested and actual time extrema/span, time quality, traffic shape;
- deterministic same-second burst windows;
- genuinely event-free source-specific gaps;
- exact 90-second source-skew and late-arrival windows;
- sentinel event tokens for Find/Filter and bookmarks (including beyond first
  page and beyond ~4,000 events);
- expected queries, lane gaps, shared timestamps, long/multiline samples;
- rotation siblings when enabled.

Import root: `scenarios/behavior-scale/import/` (never the scenario parent).

Canonical sentinel tokens include `FIND_RARE_BEYOND_PAGE`,
`FIND_RARE_BEYOND_4K`, `FIND_RARE_DEEP`, `BOOKMARK_PAGE_BOUNDARY`,
`BOOKMARK_EVICT_WINDOW`, and `BOOKMARK_NEAR_END`.

## Pinned seven-day golden acceptance corpus

For repeatable manual, packaged-app, and provider testing, select this exact
directory in **Logs → Import**:

```text
fixtures/log-lab/acceptance/seven-day-25k/scenarios/behavior-scale/import/
```

Do not select its parent. The authoritative expected results are deliberately
outside the import root:

```text
fixtures/log-lab/acceptance/seven-day-25k/scenarios/behavior-scale/truth/manifest.json
```

Pinned identity:

| Property | Expected |
| --- | --- |
| Import events | 25,000 |
| Import files | 10 |
| Import source bytes | 4,201,281 |
| Time span | 2025-01-01 12:00:00Z–2025-01-08 12:00:00Z (exactly 7 days) |
| Time quality | Wall clock |
| Levels | 23,984 INFO · 458 DEBUG · 394 WARN · 164 ERROR |
| Generated tree SHA-256 | `948551a0ffcc32ce27cb0916027e36babb9b2282519c509c7c23592dbd3665c3` |

Long-term golden checks:

| Action | Expected result |
| --- | --- |
| Find `FIND_RARE_BEYOND_PAGE` | Finds the event at generation index 250 in `edge/access.jsonl` |
| Find `FIND_RARE_BEYOND_4K` | Finds the event at generation index 4,500 in `edge/access.jsonl` |
| Find `FIND_RARE_DEEP` | Finds the event at generation index 20,000 in `edge/access.jsonl` |
| Bookmark `BOOKMARK_PAGE_BOUNDARY` | Reopens the source event at index 100 |
| Bookmark `BOOKMARK_EVICT_WINDOW` | Reopens the source event at index 2,500 after residency eviction |
| Bookmark `BOOKMARK_NEAR_END` | Reopens the source event at index 24,949 |
| Filter level ERROR | Reports 164 matching events |
| Search `STACK_TRACE_SENTINEL` | Returns a long multiline stack sample |
| Search `UTF8_café_λ` | Returns the deterministic UTF-8 sample |
| Align sources around indices 500/501 | Shows the exact shared timestamp without fabricating a log row |
| Inspect the primary quiet gap | Affected sources have no events for exactly 100,795 seconds |
| Seek the final Navigator bucket | Loads a bounded near-end page with the selected row visibly mounted |

The truth manifest additionally records all source counts and hashes, the
same-second 40-event burst, the exact 90-second skew/late-arrival window,
rotations, long-line counts, expected lane gaps, and canonical queries. Tests
regenerate the default profile, compare every generated log and primary-truth
byte, and compare the JSON meaning of the metric and evaluator fixtures. This
keeps log identity exact while allowing harmless JSON formatting changes.

## Import and investigate

1. In ContextDesk, open **Logs**.
2. Select a scenario's `import/` directory, never its scenario parent.
3. Confirm the SoftWrite import.
4. Open the created corpus in **Log Explorer**.
5. Exercise source, level, service, host, time, and template filters.
6. Verify every row shows a privacy-safe relative source identity.
7. Create **New linked chat** and ask the scenario's canonical questions.
8. Preserve the tool trail, cited event/source identities, and final answer.
9. Only after investigation, compare the result with the sibling
   `truth/manifest.json`.

The checked-in `archives/checkout-cascade.zip` exercises the real raw ZIP
ingestion path with fixed entry order, timestamps, permissions, and compression
settings.

## Grade linked chat

Do not require exact prose. Record the provider/model separately, then score
whether the response:

- reaches the supported conclusion;
- cites the required sources and stable event identifiers;
- correlates at least two identifiers;
- orders evidence consistently with its time quality;
- separates root cause from symptoms;
- rejects documented decoys;
- avoids unsupported certainty;
- proposes a bounded next action.

A live model is never part of the default test suite. Deterministic tests prove
that the linked turn receives the intended corpus snapshot, evaluator truth is
absent, and any cited fixture event actually exists.

## Owner GUI acceptance (#525)

Use `checkout-cascade/import/` for the compact dev/package lifecycle run and a
generated medium profile for the large-corpus smoke step.

In both Tauri development and packaged applications:

- open Logs, import the scenario, and open Explorer;
- close/focus/reopen Explorer twice;
- verify source identity, filters, bookmarks, lane quality, and visible errors;
- create and send a linked chat, then create a second linked chat;
- capture 960×720, 1440×900, and 2560×1080-or-wider layouts;
- record console/host errors and measured corpus/load details.

Native Computer Use evidence is valid only when the environment exposes a real
desktop-control channel with macOS Accessibility and Screen Recording
permission. DOM-only tests are not packaged-app evidence.

Timeline-value and advanced-search product changes remain tracked by #521,
#522, and #523. The Log Lab makes those features testable but does not implement
them.

## Updating or adding a scenario

1. Preserve existing frozen scenarios unless their literal bug is documented.
2. For a meaningful change, bump `scenario_version`; for a truth-contract
   change, add a new truth schema instead of silently weakening v1.
3. Update the generator, regenerate into a new empty temporary directory, and
   review the complete diff.
4. Run the determinism, safety, import, query, redaction, desktop, and full
   repository gates.
5. Paste changed hashes/counts and the reason in the PR.

Never update hashes merely to make a failing regression green. Explain why the
fixture changed and revalidate the independent truth.
