# ContextDesk log parsing and framing conformance lab

A deterministic, entirely synthetic laboratory for the real-world log shapes
ContextDesk does not yet handle correctly. It is an **acceptance-oracle lane**:
it states what the parser must eventually produce and proves, every run, what it
produces today. It contains no parser implementation and changes no production
behavior.

## What is here

```text
fixtures/log-conformance/
  cases.v1.json        the machine-readable oracle
  corpus/              27 bounded synthetic sample files, 6 families
```

The corpus is emitted by `scripts/generate_conformance_corpus.py`. Expectations
are driven through the **real** import pipeline — `ingest_path` →
`LogCorpus::open` → `query_events` — by `crates/cd-core/tests/log_conformance.rs`.
Nothing reaches into parser internals, so every claim here is a claim about what
a user actually gets from an import.

## The three kinds of expectation

| Status | Meaning | How it is asserted |
| --- | --- | --- |
| `holds` | Already correct on `main` | The desired value is asserted directly. A regression fails default CI. |
| `gap` | A known failure | The case records both `desired` and the `observed` behavior of today's code, plus the owning issue. Default CI asserts **`observed`**. |
| `invariant: true` | Must hold in every state | Asserted regardless of which gaps are open or repaired. |

A gap is a quarantine, not an amnesty. Three rules keep it honest:

- `desired` may never equal `observed` — a "gap" that agrees with production is
  not a gap, and the oracle refuses to load if one appears. This is what stops
  an expectation from being quietly weakened until it passes.
- When production improves, the quarantine **fails**, and the case must be
  reclassified to `holds` by hand.
- An invariant may never also be a gap.

## Commands

Default suite (green, part of ordinary `cargo test`):

```sh
cargo test -p cd-core --test log_conformance
```

The red-to-green driver. Asserts the **desired** result for every case including
known gaps, so it is red by construction today and turns green as the parser
work lands. It is `#[ignore]`d so a permanently failing test is never part of
default CI:

```sh
cargo test -p cd-core --test log_conformance -- --ignored --nocapture strict
```

Coverage and pass/fail inventory without failing:

```sh
cargo test -p cd-core --test log_conformance -- --ignored --nocapture report
```

Re-measure what production currently does, to refresh an `observed` block:

```sh
cargo test -p cd-core --test log_conformance -- --ignored --nocapture observe
```

Bounded stress variants (generated, never committed):

```sh
cargo test -p cd-core --test log_conformance -- --ignored --nocapture stress
```

## Families

| Family | Covers |
| --- | --- |
| `postgres-stderr` | `log_line_prefix` forms `%m [%p]` and `%t [%p]: [%l-1] user=%u,db=%d,app=%a,client=%h`, DETAIL/HINT/CONTEXT/STATEMENT continuations, session and process identifiers, unambiguous `UTC` versus ambiguous `CST`, rotation with overlapping time |
| `postgres-csvlog` | The documented 26-column csvlog contract, including a quoted `query` field containing embedded newlines |
| `postgres-jsonlog` | The documented jsonlog key contract, including `error_severity` and the non-RFC3339 `timestamp` spelling |
| `structured` | `ts`/`timestamp`/`time`/`@timestamp`/`@t`/`eventTime` aliases with RFC3339, Unix seconds/milliseconds/microseconds/nanoseconds, offsetless local, Linux calendar strings, a date-shaped integer, trace-versus-span identity, extended severity vocabularies, and logfmt |
| `multiline` | JVM, Kotlin coroutine, .NET inner-exception, chained Python traceback, Rust panic, and Go goroutine renderings — plus a false-continuation adversary |
| `mixed-hostile` | Mixed structured/plain files, malformed records, invalid UTF-8 boundaries, a 40 KB record, embedded and pretty-printed newlines, duplicate basenames, and rotation overlap |

## Safety and provenance

Every byte is synthetic and derived from public format documentation. There is
no customer, employer, production, or developer-machine material, no
credentials, no private paths, and no evaluator answer key.

`the_conformance_corpus_carries_nothing_private` enforces that on every run: no
home-shaped paths, no value copied from the current environment, RFC 5737
documentation IPs only, reserved URL hosts only, no epoch within five minutes of
the current clock, and — stricter than the Log Lab — no credential shape at all,
since this corpus has no credential cases to justify one.

This lab deliberately sits **outside** `fixtures/log-lab/`. The Log Lab scanner
treats any dotted token ending in an alphabetic label as a suspected public
hostname. That is correct for an incident corpus, but it rejects
`java.sql.SQLException`, `django.db.utils.OperationalError`, and `public.orders`
— exactly the content a parser conformance lab must contain. That scanner is
left untouched and still guards `fixtures/log-lab`; this root gets the
equivalent privacy rules from the check above.
