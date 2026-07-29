---
id: demo-log-datasets
title: Try the demo log datasets
summary: Import the synthetic Log Lab safely, know the exact expected results, and optionally align operational metrics.
section: log-analysis
tags:
  - logs
  - demo
  - testing
  - process
order: 5
related:
  - log-analysis-pipeline
  - log-explorer
---

# Try the demo log datasets

ContextDesk's repository includes deterministic, entirely synthetic logs for
learning the product and repeating investigations. They contain no customer,
employer, developer-machine, production, or third-party log material.

![Log analysis pipeline from ingest through redaction and analysis](../assets/log-analysis-pipeline.svg)

> Warning:
> Select only the path named **input** or **import** in the instructions below.
> **NEVER import a `truth/` directory or `truth/manifest.json`.** Truth files
> are evaluator-only answers and expectations. They must not enter a corpus,
> analysis result, or chat context.

## Start with the packaged first-run demo

The installed desktop app bundles only the input logs for the pinned
25,000-event investigation. On the first-run **Ready** step, select **Install
demo log corpus**, choose **Install demo**, then choose **Enter app · Open
Logs**. The option is off by default, reports progress and failures, and safely
selects the existing managed demo if it was already installed.

This convenience bundle does **not** contain evaluator truth, compact scenario
fixtures, or the optional operational-metrics document. The trusted host sends
the packaged input through the same bounded ingest, redaction, diagnostics, and
cancellation path as **Import logs…**.

## Where the source-checkout fixtures are

All demo fixtures are checked into the source repository. Clone the matching
source checkout when you want the compact scenarios, ZIP fixture, optional
operational metrics, or a repeatable repository-relative import path.

Paths below are relative to the repository root. To print a complete local path
without relying on another person's home directory, open a terminal anywhere
inside your ContextDesk checkout and copy:

```sh
cd "$(git rev-parse --show-toplevel)/fixtures/log-lab/scenarios/checkout-cascade/import" && pwd
```

Use the printed path in the folder chooser. Replace the part after
`fixtures/log-lab/` with another path from this page. A complete path is
machine-specific; Help never publishes a developer's `/Users/...` path.

## Import a compact scenario

1. Open **Logs** in the main window.
2. Choose **Import logs…**.
3. In the folder chooser, select the scenario's exact **import** directory.
4. Accept the **SoftWrite** confirmation. ContextDesk creates a disposable
   local analysis corpus after redacting secret-like values.
5. Select the new corpus and compare its overview with the expected result
   below.
6. Choose **Open Explorer…** for a separate investigation window, or
   **Open in app** to stay in the main window.

The repository-relative path for a compact scenario is
`fixtures/log-lab/scenarios/<scenario-name>/import/`.

| Scenario | What it demonstrates | Exact expected import |
| --- | --- | --- |
| `checkout-cascade` | Multi-source root-cause triage with a configuration change, poison-job retry loop, secondary symptoms, recovery, and deliberate decoys | 35 events · 6 files · 6,247 source bytes · wall clock |
| `company-known-noise` | Safe narrow noise candidates versus real errors that broad level or text suppression would hide; suppression itself is not claimed to ship | 14 events · 3 files · 2,865 source bytes · wall clock |
| `company-original-fidelity` | JSON, logfmt, syslog, plain, CRLF, Unicode, and long-line fidelity in the bounded **Original (redacted)** view | 8 events · 6 files · 1,651 source bytes · mixed time |
| `company-timestamp-diversity` | Explicit offsets and epoch encodings alongside unresolved local, yearless, malformed, skewed, and late-arriving timestamps | 15 events · 5 files · 2,817 source bytes · mixed time |
| `importer-edge-cases` | Honest partial import of safe, hidden, binary, and empty files; only `safe.log` contributes events | 2 events · 4 discovered files · 131 source bytes · order only |
| `mixed-time-quality` | Wall-clock, order-only, malformed, skewed, and late-arriving evidence without upgrading uncertain time | 11 events · 4 files · 1,203 source bytes · mixed time |
| `redaction` | Investigation after unmistakably synthetic credential-shaped values are removed | 3 events · 1 file · 709 source bytes · wall clock |
| `source-provenance` | Duplicate basenames, rotations, relative source paths, JSON, logfmt, syslog-like, plain, CRLF, UTF-8, and empty input | 12 events · 10 files · 1,137 source bytes · mixed time |

For the primary mystery, start with `job-7f3a`, `pool-max-4`, or
`trace-checkout-42`. The supported conclusion requires evidence from multiple
sources; the certificate rotation and healthy `/health` traffic are decoys.

## Import the pinned 25,000-event investigation

For a longer repeatable investigation, select this exact folder:

`fixtures/log-lab/acceptance/seven-day-25k/scenarios/behavior-scale/import/`

In an installed app, the first-run option imports this exact input directory
without requiring a source checkout. Manual selection remains useful for
development and fixture verification.

The expected import is **25,000 events**, **10 files**, and **4,201,281 source
bytes** spanning exactly **2025-01-01 12:00:00Z through 2025-01-08
12:00:00Z** with wall-clock time quality. Expected levels are 23,984 INFO, 458
DEBUG, 394 WARN, and 164 ERROR.

Useful probes are `FIND_RARE_BEYOND_PAGE`, `FIND_RARE_BEYOND_4K`,
`FIND_RARE_DEEP`, `BOOKMARK_PAGE_BOUNDARY`, `BOOKMARK_EVICT_WINDOW`,
`BOOKMARK_NEAR_END`, `STACK_TRACE_SENTINEL`, and `UTF8_café_λ`. The corpus
also contains deterministic shared timestamps, lane gaps, one same-second
burst, 90-second source skew, late arrivals, long lines, and rotated sources.

To exercise ZIP import instead of folder import, cancel the folder chooser
after choosing **Import logs…**, then select
`fixtures/log-lab/archives/checkout-cascade.zip` in the file chooser. It
contains 6 entries and imports the same 35 events as `checkout-cascade`.

## Add the optional operational metrics

Operational metrics are a separate, optional session input. If you do not load
this file, the CPU, heap, and client tracks remain absent; ordinary log
investigation is unaffected.

1. Import the pinned 25,000-event corpus and open its Explorer.
2. Expand the **Timeline** if it is collapsed.
3. Choose **Load metrics…**.
4. Select only
   `fixtures/log-lab/acceptance/seven-day-25k/scenarios/behavior-scale/metrics/operational-metrics.v1.json`.
5. Use the shared cursor or brush a range to compare metric points with the log
   histogram. Metrics are loaded for this Explorer session and are not durably
   attached to the corpus.

| Track | Exact fixture coverage |
| --- | --- |
| CPU | 673 points · 16% minimum · 98% maximum |
| Heap used | 668 points · 316,800,000-byte minimum · 952,000,000-byte maximum · one declared collector gap |
| Concurrent clients | 673 points · 12-client minimum · 180-client maximum |

The three series cover the entire seven-day log horizon at 15-minute
resolution. The synthetic test begins at low load, raises concurrent clients
through staged plateaus, and reaches its primary overload window around
**2025-01-05 13:00Z–20:00Z**. CPU follows the prior load sample with bounded
variation. Heap pressure accumulates, then drops at a synthetic major-GC
sample. Warnings and errors become more prevalent near overload and return
toward baseline after load drops.

For a useful triage walkthrough:

1. Brush the primary overload window and compare all three tracks.
2. Inspect the denser warning/error bars near **2025-01-05 15:00Z**.
3. Find `event_id=behavior-14763` to inspect an existing multiline
   `STACK_TRACE_SENTINEL`.
4. Compare the heap drop around **2025-01-05 17:15Z** with nearby logs.
5. Treat these as visible correlations that focus investigation, not proof that
   load, CPU, heap, GC, or any individual log caused another signal.

Do not choose `metrics/manifest.v1.json`,
`metrics/operational-metrics-patterns.v1.json`, or anything under `truth/` for
the normal demo. Those files describe or test the fixture rather than supply
the operational metric series.

## Troubleshooting and privacy

- If counts differ, discard the partial corpus and import the exact `import/`
  child, not its scenario parent. Importing the parent risks mixing input with
  evaluator material.
- If the directory picker closes without importing, choose **Import logs…**
  again. Canceling that folder picker intentionally opens the single-file or
  ZIP picker.
- A partial result for `importer-edge-cases` is expected. Other scenarios
  should match their manifest-backed counts.
- If **Load metrics…** is not visible, open the Explorer timeline. Metrics are
  not imported from the main **Logs** library.
- These fixtures are safe synthetic data. For real company data, review the
  selected provider and permissions before linked chat: bounded evidence can
  leave the machine when a remote model is used. Never place secrets or raw
  production logs in screenshots, issue comments, or copied diagnostics.

For the investigation controls, continue to help://log-explorer. For the
ingest, redaction, template, storage, and analysis boundaries, read
help://log-analysis-pipeline.
