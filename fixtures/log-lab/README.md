# ContextDesk Log Lab

The Log Lab is a deterministic, entirely synthetic set of incident logs for
exercising ContextDesk's real log ingestion, Log Explorer, and linked-chat
paths. It contains no customer, employer, developer-machine, production, or
third-party log material.

The compact fixtures are intentionally small enough for default offline tests.
The generator also produces 100,000-event and configurable million-event
profiles outside Git.

## Safety and provenance

- All hosts use `.example`; any IP fixture must use the RFC 5737 documentation
  ranges.
- Names, trace ids, request ids, jobs, credentials, and incidents are fictional.
- Credential-shaped values exist only in the `redaction` scenario. They contain
  the explicit `LOG-LAB-INVALID` marker and are not usable credentials.
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

# Generate the bounded medium smoke corpus (100,000 events).
cargo run -p cd-core --example generate_log_lab -- \
  --output /tmp/contextdesk-log-lab-medium \
  --profile medium

# Generate an explicitly local stress corpus. Large output is never committed.
cargo run -p cd-core --example generate_log_lab -- \
  --output /tmp/contextdesk-log-lab-large \
  --profile large \
  --events 1000000
```

Every successful run prints its file count, event count, byte count, and
deterministic tree SHA-256. The integration regression generates the compact
tree twice, compares it byte-for-byte, and compares it with the checked-in
snapshot.

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

### Generated `scale`

The medium and large profiles create four source files with deterministic
timestamps, trace ids, levels, and repeated templates. Medium is the required
100,000-event import/paging smoke test. Large is an opt-in local stress tool;
record the machine, corpus size, elapsed time, CPU, and memory before making a
performance statement.

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
