# Normalized log events v1

`contextdesk.normalized_log_events.v1`

A standalone, versioned JSONL contract a producer **may** emit so its logs
arrive already parsed, instead of ContextDesk guessing a grammar from bytes.

> **Status.** This document and its validator exist. There is **no fast
> import path**: a conforming file is imported today by the ordinary raw path,
> exactly like any other JSON-lines log. See §11.

---

## 1. Schema identifier and versioning

| | |
| --- | --- |
| `schemaId` | `contextdesk.normalized_log_events.v1` |
| Reader version | `1` |
| Media type hint | `application/x-ndjson` |

### Rules

1. A file **MUST** declare `schemaId` exactly. A lookalike (`…v2`, `…v01`) is
   rejected, never best-effort parsed.
2. A file declaring `minReaderVersion` above the reader's version **MUST** be
   refused whole rather than partially understood.
3. Additive optional fields **MAY** appear; readers that do not understand them
   **MUST** ignore them.
4. A new major uses a new `schemaId`.

---

## 2. Normalizing is optional

Producers are **never** required to normalize, and raw logs remain a
first-class bundle component. A bundle carrying only raw logs is fully
conforming. A producer that cannot reliably frame or interpret its own records
**SHOULD** emit raw logs — that is the honest choice, not a degraded one
(#751: "Keep raw as the honest default").

Nothing in ContextDesk requires this format, and nothing about it is faster
today.

---

## 3. File shape

JSONL. Line 1 is the **header**; every subsequent non-blank line is one
**event**. Blank lines are ignored. Lines are LF-terminated and each **MUST**
be ≤ 1 MiB — deliberately below the raw reader's 16 MiB line cap, so a
conforming file is always readable by the raw path too.

```
{"schemaId":"contextdesk.normalized_log_events.v1","minReaderVersion":1,"sourceId":"checkout-api","producer":{"name":"acme-exporter","version":"1.0.0"}}
{"sourceSeq":0,"time":{...},"severity":{...},"message":"...","canonical":"..."}
{"sourceSeq":1,...}
```

Declaring `sourceId` once, on the header, is what makes it a property of the
file rather than something individual lines could disagree about.

---

## 4. Identity

Event identity is **derived** from `(sourceId, sourceSeq)`.

There is deliberately **no** `uid`, `eventId`, or `id` field. A
producer-declared identifier can be forged, duplicated, or reused across files
and a reader cannot check any of it. `sourceSeq` is checkable: it **MUST**
start at 0 and be strictly increasing and gap-free, and the validator proves
it.

On import a reader assigns its own local ids while retaining the origin
identity for lineage, exactly as #763 requires for bundle components.

---

## 5. Timestamp legality (normative)

The central rule: **a guessed instant is unrepresentable.** Not discouraged —
it has no encoding, so it cannot be emitted, validated, or read.

`time.resolution` is one of four values, and there is deliberately no
`inferred`, `assumed`, or `best_effort` value:

| `resolution` | `instant` | `localText` | `resolvedTimezone` | `basis` |
| --- | --- | --- | --- | --- |
| `source_explicit` | **required** | optional | **forbidden** | `wall` |
| `producer_resolved` | **required** | **required** | **required** | `wall` |
| `unresolved` | **forbidden** | **required** | **forbidden** | `order` or `relative` |
| `order_only` | **forbidden** | **forbidden** | **forbidden** | `order` or `relative` |

No row yields an instant without either an explicit offset in the source or a
producer-declared timezone.

* **`instant`** is RFC3339 with an **explicit** offset. A bare local timestamp
  is rejected — a lenient parser would silently call it UTC, which is the
  guessed instant in disguise. `-00:00` is also rejected: RFC3339 reserves it
  for "offset unknown", which is the same thing as not having one.
* **`producer_resolved`** is a claim by the *producer*, not source truth. It
  **MUST** carry the original `localText` and the IANA zone used. A reader
  **MUST NOT** present it as source-declared, and **MAY** filter or distrust it
  differently (#763: a producer default "must retain provenance").
* **`unresolved`** keeps the text as evidence and no instant (#670:
  "unresolved local time remains evidence, never an instant").
* **`observed`**, when present, is the producer's own observation time, distinct
  from event time. It never overwrites `instant` (#787).

`wall`, `relative`, and `order` are incompatible axes (#670). Basis is checked
against resolution: a `wall` basis with no instant, or an `order` basis with
one, are both contradictions.

---

## 6. Severity

Exactly #790's four independent fields:

| Field | Meaning |
| --- | --- |
| `number` | OTel severity number, 0–24. **Absent** when unspecified — never `0`, because OTel assigns meaning to 0. |
| `text` | The source's severity string, verbatim (`WARN`, `NOTICE`, `D2`, `EMERGENCY`). |
| `source` | The source's severity in its **own type system** — a syslog PRI integer, a CEF 0–10, a Windows level, a Pino numeric. |
| `inferred` | **Required, always serialized**, even when `false`. |

`inferred` is mandatory precisely so an inferred severity can never be mistaken
for a source-declared one (#790: "never present inferred severity as
source-declared"). #790 names the failure this guards: inferring an error from
"no errors detected".

Readers **MAY** group by the normalized `number` while details, exports, and
raw views retain `text` and `source`.

---

## 7. Trace, span, and the eleven correlations

`traceId` (32 lowercase hex) and `spanId` (16 lowercase hex) are **their own
fields**. All-zero values are rejected as the W3C invalid sentinel.

The eleven typed correlation classes (#789) are:

`request`, `session`, `transaction`, `activity`, `audit`, `flow`, `boot`,
`container`, `pod`, `event`, `query`

Each may appear at most once per event. **Trace and span are deliberately not
in this enum** — so a span identifier cannot be routed into a trace slot
through the correlation mechanism. This is the structural distinctness #789
demands, enforced by the type rather than by a lint, and it is the same class
of bug as the live P0 in `parse_json` that accepts `span_id` as a `trace_id`
alias.

---

## 8. Canonical retention and round-trip

Every event **MUST** carry `canonical`: the original record text, verbatim,
bounded to 64 KiB (matching what ContextDesk itself retains). Multi-line
originals keep their newlines.

`canonicalTruncated` **MUST** be `true` when the bound was hit, so a
round-trip is never claimed for a record that cannot round-trip.

Retaining the canonical line is what makes normalization safe to accept: a
reader can always show what the producer actually saw, and can re-parse it if
it distrusts the normalization.

### Why this sidesteps #788

#788 exists because a *raw* multi-line record cannot be framed by splitting on
newlines. This contract does not inherit that problem, because the producer has
already framed its own records — one JSON object per line is one logical event,
however many physical lines it originally spanned, with the original preserved
in `canonical`. Normalizing is precisely the act of moving framing to the side
that knows the answer.

---

## 9. Privacy

* **ContextDesk redaction is mandatory and unconditional.** Every field of
  every event is re-redacted on import.
* `redaction` on the header is a **producer claim and advisory only**. A
  producer asserting `credentialsRemoved: true` does not exempt one byte. The
  field exists so intent is recorded and a reviewer can notice a producer that
  claims nothing.
* Evaluator-protection sentinels are rejected in `sourceId`, `sourceLabel`,
  `redaction.note`, `message`, and `canonical`.
* Validation **error samples** are bounded (≤5 samples, ≤256 chars) and
  re-redacted through ContextDesk's own redaction. A validation report is
  exactly the artifact that gets pasted into a ticket; an unredacted "here is
  the line that failed" would make the validator itself the leak.

---

## 10. Fail closed

A file is conforming or it is not. **There is no partial acceptance.**

`ok == false` means **no** event from the file may be imported — not "import
the good ones". Half a normalized source is worse than none: the gaps are
invisible downstream, the sequence no longer proves contiguity, and a reader
would under-report a corpus while believing it had the whole thing.

`eventsValidated` reports how far validation got. It is **not** a count of
importable events and **MUST NOT** be presented as coverage.

---

## 11. Bundle enrolment, and the absent fast path

A normalized file carried in an Incident Evidence Bundle is enrolled by the
component's optional `contentSchemaId` on a `role: "log"` component. No new
role is introduced.

* The **manifest is authoritative**. A future fast path **MUST** consult
  `contentSchemaId` — never a file extension, and never the directory a file
  happens to sit in (#763: "folder coincidence never implies linkage").
* An unrecognized `contentSchemaId` **MUST** degrade to "ordinary raw log", not
  fail validation.
* `contentSchemaId` on a non-`log` component is rejected: it would imply a
  contract the log path never consults.

**There is no fast path today.** A conforming file imports through the ordinary
raw path. `normalized_log_events_fallback.rs` proves what an older or current
reader actually does: every line fingerprints as `json-object-line`, the corpus
imports as **order-only**, and no wall-clock instant is derived from
`time.instant`. That degradation is the correct behavior, not a bug to fix
later — a reader that has not opted in must not silently adopt a producer's
clock.

---

## 12. Schema versus authoritative validation

The JSON Schema validates **one line at a time**. It cannot check:

* `sourceSeq` contiguity (a cross-line rule),
* byte-length bounds on the encoded line,
* forbidden sentinels,
* that a producer's emitted file round-trips.

**Passing JSON Schema alone is not conformance.** Producers **MUST** run the
offline validator.

---

## 13. Conformance resources

| Resource | Location |
| --- | --- |
| JSON Schema | `docs/specs/normalized-log-events/schemas/normalized-log-events.v1.json` |
| Fixtures | `fixtures/normalized-log-events/` (9 valid, 21 invalid) |
| Validator | `crates/cd-core/src/normalized_log_events.rs` |
| Rust producer | `examples/normalized-log-producers/rust/` |
| Node producer | `examples/normalized-log-producers/node/` |
| Python producer | `examples/normalized-log-producers/python/` |
| Cross-language check | `crates/cd-core/tests/normalized_log_events_cross_language.rs` |

All three reference producers validate the **same** frozen corpus, and a test
fails if any of them disagrees with the Rust validator about any file. That is
what makes this contract portable under #826, rather than three independent
readings of this prose.

---

## 14. Non-goals (v1)

- A fast import path, or any import behavior at all.
- Import UI, progress, or attachment UX.
- Requiring producers to normalize.
- Replacing raw evidence.
- Metric/log pairing inference of any kind.

---

## 15. Residual

1. **Fast import path** that consults `contentSchemaId` and skips
   fingerprinting — the entire point of the format, and not yet built.
2. **`EngineClient` / server exposure** of the validator (#826).
3. **Round-trip acceptance** against a real producer's corpus.
4. **Framing interaction with #788** when a producer normalizes only part of a
   source.
5. **Deduplication** when the same source is supplied both raw and normalized —
   undesigned; today they would import as two independent corpora.
