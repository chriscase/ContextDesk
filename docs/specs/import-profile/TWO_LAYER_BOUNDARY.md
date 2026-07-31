# Normative: Format Profiles and Import Profiles are two layers

ContextDesk has **two** things a user can save and reuse when importing logs.
They are related, they are easy to confuse, and confusing them produces a
system that decides a file's grammar from its path. This document is normative:
where code and this document disagree, one of them is a bug.

## The two layers

| | **Format Profile** | **Import Profile** |
| --- | --- | --- |
| Answers | "What grammar is *this record*?" | "What should we do with *these sources*?" |
| Scope | one parser / framing / field / timestamp grammar | a whole corpus or source tree |
| Lives in | `crates/cd-core/src/log_analysis/format_profile.rs` | `crates/cd-core/src/log_analysis/import_profile.rs` |
| Identity | `(format_id, version)`, e.g. `json-object-line@1` | `(profile_id, version, digest)` |
| Decided by | **content only** — `fingerprint_format` ignores the path it is given | the author, then checked against content |
| Schema | built-in registry (`BUILT_IN_FORMAT_PROFILES`) | `contextdesk.import_profile.v1` |
| Issue | #751 "declarative format profile" | #751 reuse + #763 one guided import |

An Import Profile **references** Format Profiles. It never contains one, never
defines a grammar, and never extends the registry.

## The rule that makes the split load-bearing

> **A path may select a candidate. Only content may confirm it.**

An Import Profile's `formatProfile` is an *expectation*, not an instruction.
`match_profile` reports it as satisfied only where the item's own content
fingerprint already produced that exact `(id, version)`. Where content
disagrees, or produced no confident format, the result is
`drift` (`format_disagrees` / `format_unconfirmed`) and the item keeps whatever
status content gave it.

This is #751's "detection evidence weighting" (extension and path are weak
hints; content is decisive) and #791's non-goal ("treating filenames alone as
proof of a format"), enforced in code rather than documented as an intention.

Collapsing the two layers into one type would break this rule by construction:
the path patterns and the grammar would live in the same object, and *any* code
that consulted that object would be consulting a path to decide a format.

## Naming

Use **"Format Profile"** for the grammar and **"Import Profile"** for the plan.
Do not use "recipe" for either — it previously named the plan layer and has been
renamed throughout (see the migration table in the lane handoff). The unrelated
`FindingViewRecipe` in `investigations` is a different, pre-existing concept
about Explorer view state and is deliberately untouched.

## What an Import Profile may contain

Only declarative, bounded data:

* `SafePattern` include/exclude globs — no regex, no alternation, no code.
* Source groups with a role from the Incident Evidence Bundle vocabulary
  (`log`, `operational_metrics`, `attachment`, `readme`, `unknown`).
* References to a Format Profile, a framing profile, and a reviewed timestamp
  policy — all by id and version.

It may **not** contain a grammar, a script, a regular expression, an absolute
path, or a timezone guess.

## Status/role compatibility is part of the boundary

An Import Profile assigns roles; it does not overrule the preview's content and
policy decisions. `role_is_compatible` is normative:

| Item status | Roles it may receive |
| --- | --- |
| `Blocked`, `Ignored`, `Unsupported` | **none** |
| `Ready`, `Review`, `RawFallback` | `log` only |
| `Supporting` | `operational_metrics`, `attachment`, `readme` |

A profile can therefore never re-enable hidden noise, binary content, or
policy-blocked entries, and cannot route a log source to the metrics path.

## What this layer does **not** claim

This foundation does not complete #751. Explicitly still open:

* **Custom declarative grammars.** Authors cannot yet define a new grammar; an
  Import Profile can only reference grammars the build already registers.
* **The profile lifecycle.** #751's `draft → validated → approved → canary →
  active → deprecated/revoked` envelope with rollback is not implemented. Only
  version + digest immutability exists.
* **UI.** No wizard, no review cards, no activation surface.
* **`EngineClient` / IPC.** Contracts are versioned and language-neutral but are
  not exposed over Tauri or the server API yet.
* **Bundle-manifest consumption.** `ImportManifestSummary` exists and is
  honoured by the classifier, but `preview_import_path` never populates it, so
  an Incident Evidence Bundle currently previews as ordinary files.
