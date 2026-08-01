# Normalized-log producer SDK

How to emit `contextdesk.normalized_log_events.v1` from your own service.

> **The ContextDesk fast path is NOT shipped.** Emitting this format does not
> make import faster today. A conforming file is read by the ordinary raw
> path, exactly like any other JSON-lines log, and
> `normalized_log_events_fallback.rs` proves it. Adopt this format for the
> honesty guarantees below — not for speed that does not exist yet.

---

## Do you need this at all?

**Probably not.** Raw logs are first-class and always will be. Emit raw logs
when:

* you cannot reliably frame your own multi-line records;
* you cannot state where a timestamp's offset came from;
* you would have to guess a timezone to fill a field.

Guessing is worse than not normalizing. A producer that emits raw text loses
nothing — ContextDesk's detection handles it. A producer that emits a
confident wrong instant corrupts a corpus in a way nobody can see.

---

## Minimal producer

Every kit is dependency-free and under 400 lines. Read one; they are the spec
in executable form.

| Language | Path | Run |
| --- | --- | --- |
| Rust | `crates/cd-core/examples/normalized_log_producer.rs` | `cargo run -p cd-core --example normalized_log_producer` |
| Node | `examples/normalized-log-producers/node/produce-and-validate.mjs` | `node produce-and-validate.mjs --emit` |
| Python | `examples/normalized-log-producers/python/produce_and_validate.py` | `python3 produce_and_validate.py --emit` |

All three emit byte-identical canonical output and validate the same 50-fixture
corpus. That is enforced by `normalized_log_events_cross_language.rs`, in both
directions: what each accepts, and what each emits.

```jsonl
{"minReaderVersion":1,"producer":{"name":"my-exporter","version":"1.0.0"},"schemaId":"contextdesk.normalized_log_events.v1","sourceId":"checkout-api"}
{"canonical":"2026-01-01T00:00:00Z INFO ready","message":"ready","severity":{"canonical":9,"confidence":"high","provenance":"source_declared","raw":"INFO"},"sourceSeq":0,"time":{"basis":"wall","instant":"2026-01-01T00:00:00Z","resolution":"source_explicit"}}
```

---

## The four rules that matter

**1. Never invent an instant.** Pick the row that is true:

| Your source has | `resolution` | `instant` | `localText` | `resolvedTimezone` |
| --- | --- | --- | --- | --- |
| a timestamp with an explicit offset | `source_explicit` | required | optional | forbidden |
| a local time, and you know the zone | `producer_resolved` | required | required | required (real IANA) |
| a local time, zone unknown | `unresolved` | forbidden | required | forbidden |
| no usable time | `order_only` | forbidden | forbidden | forbidden |

There is no `inferred` or `assumed` value. If you would need one, use
`unresolved` — the text is still evidence.

**2. Keep the source's own severity.** `raw` is what your source emitted, in
its own type. `canonical` is the OTel number. `confidence` and `provenance`
are required and must agree, so a guess cannot read as source truth.

**3. Identity is derived.** There is no `uid` field. `sourceSeq` starts at 0
and is strictly increasing and gap-free; the validator checks it, which is
exactly what an opaque producer id would prevent.

**4. Redaction is not your call.** The `redaction` block is advisory.
ContextDesk re-runs its own redaction over every byte regardless of what you
claim. Declare honestly; do not rely on it to exempt anything.

---

## Validating before you ship

```sh
cargo run -p cd-core --bin cd_normalized_log_lab -- validate  ./out.jsonl
cargo run -p cd-core --bin cd_normalized_log_lab -- summarize ./out.jsonl
cargo run -p cd-core --bin cd_normalized_log_lab -- canonicalize ./out.jsonl ./canonical.jsonl
```

The lab never contacts a provider, never mutates its input, never overwrites
its output, and prints no filesystem path or record content — `summarize` is
aggregate-only. Passing the JSON Schema alone is **not** conformance: the
schema validates one line at a time and cannot check `sourceSeq` contiguity or
the cross-field time rules.

---

## Compatibility

| Change | v1 reader behavior |
| --- | --- |
| Unknown **additive** field | ignored; file still valid |
| Reserved key `ts` / `timestamp` / `@timestamp` | **rejected** — an older reader would read these as wall-clock time |
| `minReaderVersion` above the reader | refused whole, never partly understood |
| Unrecognized `schemaId` | refused; not best-effort parsed |
| New `schemaId` major | new file format; v1 readers refuse it |
| A build with no knowledge of this format | reads the file as plain JSON lines, **order-only**, upgrading no producer claim |

### Bundle carriage

Inside an Incident Evidence Bundle, a normalized file is a **`role: "log"`**
component carrying optional `contentSchemaId`. No new role is introduced,
because an unknown role is a hard failure for a v1 reader while an unknown
optional field is ignored — so an old reader sees an ordinary log component
and imports it raw.

`contentSchemaId` is the **only** thing that enrols a component as normalized.
A future fast path must consult the manifest, never a file extension or the
directory a file happens to sit in (#763: "folder coincidence never implies
linkage"). That seam exists now; nothing consumes it yet, and IEB v1 is
otherwise unchanged.

---

## Not shipped

* The ContextDesk fast import path.
* `EngineClient` / server exposure of the validator (#826).
* Deduplication when a source arrives both raw and normalized.
* Partial normalization of a single source (#788 framing interaction).
