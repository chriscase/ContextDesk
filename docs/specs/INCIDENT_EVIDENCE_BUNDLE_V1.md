# Incident Evidence Bundle v1

**Schema identifier:** `contextdesk.incident_evidence.v1`
**Status:** Normative interchange contract (documentation and offline validation).
**Parent issue:** #763 · **Conformance slice:** #764
**Related:** operational-metrics v1 (`docs/design/OPERATIONAL_METRIC_TRACKS.md`), portable analysis package `contextdesk.log_corpus.v1`, Investigation/Case workspaces (#532 Phase D).

This specification defines a **producer-facing interchange format** for authorized incident evidence: raw logs, operational metrics, optional bounded attachments, and declared provenance. It does **not** define ContextDesk product import UI, DuckDB analysis packages, or Investigation documents.

Language follows RFC 2119: **MUST**, **MUST NOT**, **SHOULD**, **MAY**.

---

## 1. Schema identifier and versioning

| Token | Value |
| --- | --- |
| Exact schema id | `contextdesk.incident_evidence.v1` |
| Manifest field | `schemaId` (string, exact match required) |
| Reader capability integer | `minReaderVersion` (u32); this document defines reader capability **1** |
| Operational metrics document | Reuse existing v1 document shape (`schemaVersion: 1` series document); do **not** invent a parallel metric-series schema |

### Rules

1. A conforming producer **MUST** emit `schemaId` exactly equal to `contextdesk.incident_evidence.v1`.
2. A conforming validator/reader **MUST** reject any other `schemaId`, including lookalikes (`…v1.1`, `…V1`, prefixes/suffixes).
3. Additive optional fields in the manifest **MAY** appear; readers that do not understand them **MUST** ignore them unless a future major requires otherwise.
4. Breaking changes **MUST** bump the major (`…v2`) and keep a dual-path window for N and N−1 when product import exists.
5. `minReaderVersion` **MUST** be ≤ the reader’s capability. Values greater than 1 **MUST** fail closed on this reader generation.

---

## 2. Directory and archive forms

### 2.1 Directory form (required for this slice)

A **bundle root directory** **MUST** contain:

```text
manifest.json                 # required, UTF-8 JSON
logs/                         # recommended when log components exist
metrics/                      # recommended when metric components exist
attachments/                  # optional bounded supporting files
README.md                     # optional human notes (never evaluator truth)
```

Logical layout is illustrative; the **manifest component inventory** is authoritative. Empty role directories without components **MAY** be omitted.

### 2.2 Deterministic archive form (#765)

A conforming ZIP transport **MUST**:

- place `manifest.json` at the **archive root** (canonical path `manifest.json`);
- store only relative, non-absolute, non-traversing UTF-8 entry names using `/`;
- reject duplicate entry names and case-insensitive portable collisions;
- preserve component relative paths as zip entry paths;
- apply directory form size/hash caps **and** archive caps below;
- stream component SHA-256 from zip entry readers without extracting the tree to temp.

#### Archive safety limits

| Limit | Value | Constant |
| --- | --- | --- |
| Max compressed archive size | 2 GiB | `MAX_ARCHIVE_COMPRESSED_BYTES` |
| Max zip entries | 513 (512 components + manifest) | `MAX_ARCHIVE_ENTRIES` |
| Max expanded/compressed ratio (Deflated) | 100 | `MAX_COMPRESSION_RATIO` |
| Max operational-metrics document | 8 MiB | `MAX_METRICS_DOC_BYTES` |
| Max series per metrics document | 256 | `MAX_METRICS_SERIES` |
| Max points per series | 100000 | `MAX_METRICS_POINTS_PER_SERIES` |

#### Deterministic pack guarantees

`cd-validate-incident-evidence pack` **MUST** produce **byte-identical** archives for identical directory inputs across independent runs:

- lexicographic entry order by path;
- `CompressionMethod::Stored` (documented; no nondeterministic deflate);
- fixed DOS timestamp 1980-01-01 00:00:00;
- unix permissions `0o644`;
- no machine-specific comments or extra fields;
- atomic publication from a uniquely created same-directory temporary file; no partial left on failure;
- refuse overwrite unless `--force`.

Packing **MUST NOT** follow filesystem symlinks (leaf or intermediate). Nested `.zip` files declared as `attachment` components are **opaque payloads** (hashed, never recursively expanded).

#### Product import residual

Product import/attachment of archives remains a later #763 slice. Offline pack/validate ship under #765.

---

## 3. Manifest fields

The root document **MUST** be a single JSON object named `manifest.json` at the bundle root.

| Field | Type | Requirement |
| --- | --- | --- |
| `schemaId` | string | **MUST** be `contextdesk.incident_evidence.v1` |
| `minReaderVersion` | integer ≥ 1 | **MUST** be present |
| `bundleId` | non-empty string ≤ 256 chars | **MUST** be stable within the producer’s domain |
| `createdAt` | string | **MUST** be RFC 3339 with explicit offset or `Z` |
| `producer` | object | **MUST** include `name` and `version` (non-empty strings ≤ 128) |
| `privacy` | object | **MUST** declare redaction/credentials/PII booleans (see §6) |
| `timeBasis` | object | **MUST** declare timezone honesty (see §7) |
| `components` | array | **MUST** list every payload file that is part of the bundle |

Unknown top-level fields **MAY** be present and **MUST** be ignored by v1 readers that do not understand them (unless listed in a future deny list).

---

## 4. Components

Each component object **MUST** include:

| Field | Type | Requirement |
| --- | --- | --- |
| `id` | string | Non-empty, unique within the manifest, ≤ 128 chars |
| `role` | string enum | One of: `log`, `operational_metrics`, `attachment`, `readme` |
| `path` | string | Relative path (see §8), unique within the manifest |
| `mediaType` | string | Non-empty media type hint (e.g. `text/plain`, `application/json`) |
| `bytes` | integer ≥ 0 | Exact byte length of the file on disk |
| `sha256` | string | 64-char **lowercase** hex SHA-256 of file bytes |

Optional:

| Field | Type | Notes |
| --- | --- | --- |
| `sourceLabel` | string | Human/source label for multi-source logs |
| `timeBasis` | object | Per-component override of bundle time basis |
| `lineage` | object | Optional `{ "parentId", "note" }` without absolute paths |

### Role semantics

| Role | Meaning |
| --- | --- |
| `log` | Raw authorized log payload (text/JSONL/etc.). Nested relative paths preserve multi-source identity. |
| `operational_metrics` | One operational-metrics **v1 document** (series/points). Referenced schema is the shipped metrics v1 document (same rules as the production TypeScript `validateOperationalMetricsDocument`, including **required series `provenance.source`** and `timeQuality`). |
| `attachment` | Bounded supporting artifact (screenshot, config excerpt). Not ambient chat context without future product governance. |
| `readme` | Optional human notes. **MUST NOT** contain evaluator truth, expected diagnoses, or private credentials. |

Unknown roles **MUST** cause validation failure in v1 (fail closed).

---

## 5. Hashes, byte counts, relative paths, lineage

1. Producers **MUST** hash the exact on-disk bytes with SHA-256 and emit lowercase hex.
2. Validators **MUST** recompute SHA-256 by **streaming** file contents and compare to the declared digest (case-sensitive lowercase).
3. Validators **MUST** compare declared `bytes` to the actual file length.
4. Relative path identity is **the full relative path string** (POSIX `/` separators). Duplicate basenames under different directories **MUST** remain distinct.
5. Lineage **MUST NOT** embed absolute host paths, usernames, or secrets.

---

## 6. Privacy and redaction

The `privacy` object **MUST** include:

| Field | Type | Requirement |
| --- | --- | --- |
| `redactionDeclared` | boolean | Whether the producer asserts redaction was applied as intended |
| `containsCredentials` | boolean | **MUST** be `false` for shareable bundles; `true` **MUST** fail validation for shareable conformance fixtures |
| `containsPii` | boolean | Honesty flag; shareable conformance fixtures **MUST** set `false` |
| `notes` | string optional | Free text ≤ 1024 chars; **MUST NOT** include secrets |

Shareable runtime bundles **MUST NOT** contain:

- evaluator truth / expected diagnosis catalogs;
- private absolute paths;
- credentials, API keys, session tokens;
- configured model inventories.

Validators **MUST** reject component paths and declared `log` / `readme` payloads that embed the frozen evaluator-truth sentinel set defined for conformance (for example `evaluator_truth`, case-insensitively). Payload scanning **MUST** be streaming, happen in the same bounded pass as hashing, and detect sentinels split across read-chunk boundaries. This frozen check is a narrow fixture-governance safeguard, not a claim of general content classification. Path/id/manifest fields **MUST** always be checked.

---

## 7. Timezone and time-basis behavior

Bundle and component `timeBasis` objects:

| Field | Type | Requirement |
| --- | --- | --- |
| `timezone` | string or null | Registered IANA name, valid numeric offset (`+00:00`), or `UTC`; **null** means unresolved |
| `timezoneResolved` | boolean | **MUST** be `true` only when `timezone` is non-null and intentionally applied |

### Honesty rules

1. If `timezone` is null or absent, `timezoneResolved` **MUST** be `false`.
2. If `timezoneResolved` is `true`, `timezone` **MUST** be a non-empty explicit value.
3. Validators **MUST** reject unknown IANA identifiers and malformed or out-of-range numeric offsets.
4. Validators **MUST NOT** invent or guess timezones.
5. Per-record offsets inside log/metric payloads remain authoritative when present; bundle defaults **MUST NOT** silently rewrite them.

---

## 8. Path safety

A component `path` **MUST**:

- be non-empty and relative;
- use `/` as the separator in the manifest (validators normalize only for comparison on platforms that require it after validation);
- reject `.` / `..` path segments;
- reject absolute paths (`/…`, `\…`, `C:…`);
- reject NUL and other control characters;
- reject empty path segments (`//`);
- be ≤ `MAX_RELATIVE_PATH_BYTES` (1024).

Validators **MUST** reject unsafe paths **before** reading payload content.

Symlinks that escape the bundle root **MUST** fail closed when detected during validation.

---

## 9. Validation limits (normative)

| Limit | Value | Constant |
| --- | --- | --- |
| Max manifest file size | 1 MiB | `MAX_MANIFEST_BYTES` |
| Max components | 512 | `MAX_COMPONENTS` |
| Max files (components) | 512 | same |
| Max per-file payload | 512 MiB | `MAX_PER_FILE_BYTES` |
| Max aggregate payload bytes | 2 GiB | `MAX_AGGREGATE_BYTES` |
| Max relative path bytes | 1024 | `MAX_RELATIVE_PATH_BYTES` |
| Max `bundleId` / component `id` length | 256 / 128 | — |
| Max producer name/version | 128 | — |
| SHA-256 hex length | 64 lowercase | — |

Exceeding any limit **MUST** fail validation with an actionable diagnostic.

---

## 10. Streaming validation and publication behavior

1. Validators **MUST** parse the manifest first (capped read).
2. Validators **MUST** stream payload hashing (chunked read); they **MUST NOT** require loading an entire large file into memory.
3. Validators **MUST NOT** perform network I/O.
4. Validators **MUST NOT** publish corpora, metrics, or partial product state.
5. On any failure, validators **MUST** leave the product store unchanged (offline tool has no product store).

---

## 11. Diagnostics

Diagnostics **MUST** be deterministic and suitable for CI:

- include a stable error `code`;
- include `path` (manifest JSON path and/or file path) when applicable;
- include a short `message`;
- sort stably (by code, then path, then message).

---

## 12. Relationships to other formats

| Format | Role | Relationship |
| --- | --- | --- |
| **Incident Evidence Bundle v1** (this spec) | Source interchange from producers | Input to future ContextDesk import |
| **`contextdesk.log_corpus.v1`** | Portable **analysis** package (DuckDB/templates already ingested) | Distinct; not a substitute for raw evidence bundles |
| **Operational metrics v1 document** | Series/points JSON | Embedded or referenced as `operational_metrics` components without redefining the series schema |
| **#532 Investigation/Case bundles** | Collaborative workspace artifacts (bookmarks, notes, reports) | Out of scope for v1 evidence interchange; Phase D remains open |

---

## 13. Compatibility and extension

- Additive optional JSON fields: allowed; unknown ignored by v1 readers.
- New component roles: require a minor doc revision and reader update; v1 validators **MUST** reject unknown roles.
- New schema majors: new `schemaId`.

---

## 14. Explicit non-goals (v1)

- Product import/attachment UX, progress UI, or one-click ingest (#763 later slices).
- Live streaming telemetry, remote collectors, or directory watchers.
- Requiring DuckDB, templates, embeddings, findings, or diagnoses from producers.
- Guessing log formats, timezones, causality, or metric relationships.
- Treating attachments as ambient model context without future governance.
- Closing #763 or #532 via this documentation slice alone.

---

## 15. Conformance resources

| Resource | Location |
| --- | --- |
| JSON Schemas | `docs/specs/incident-evidence/schemas/` |
| Fixtures | `fixtures/incident-evidence/` |
| Validator library | `crates/cd-core/src/incident_evidence.rs` |
| CLI | `cd-validate-incident-evidence` (crate binary) |
| Producer templates | `examples/incident-evidence-producers/` |
| Drift check | `scripts/check_incident_evidence_drift.mjs` |

---

## 16. Residual

1. **Product import/attachment UX** for directory and archive forms (#763).
2. Round-trip product tests once import ships.
3. #532 Investigation/Case portable bundles (distinct format).
