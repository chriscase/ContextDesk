# Reviewed format profiles

`contextdesk.reviewed_format.v1` — a bounded grammar a user confirms so their
own log shape parses correctly, without ContextDesk shipping a regex for every
vendor.

> **Status.** The trusted core contract, validator, matcher, preview, and
> selection are implemented and tested through the production path. **No UI is
> wired yet** — there is no authoring screen and no ImportFlow step. See
> Residuals.

---

## Where it sits

| Layer | What it is | Who defines it |
| --- | --- | --- |
| `format_profile` | fixed built-in grammars, content-matched | ContextDesk |
| **`reviewed_format`** | **a declarative grammar for one log shape** | **the user, reviewed** |
| `import_profile` | the plan binding sources to grammars | the user |

`SourceGroupRule.formatProfile` is a `ProfileRef` and is the *intended* seam,
but it is **not wired yet**, and pointing one at a reviewed format today would
be actively misleading: `match_profile` compares a reference against the
content fingerprint from `import_preview`, which only knows built-in format
ids, so a reviewed-format id can only ever report **Drift**. Wiring that
comparison is residual work. This slice adds the grammar layer beside the
existing ones, not a parallel import system — but it does not yet join them.

---

## Why there are no regexes

#751 names catastrophic regex as an adversarial case to defend against. A
user-supplied pattern cannot be accepted safely without a complexity analysis
this project does not have, so a grammar is assembled from a **closed token
vocabulary** instead:

* `TimeToken` — `year4`, `month2`, `day2`, `hour24`, `minute2`, `second2`,
  `millis3`, `micros6`, `offset`, `literal(c)`
* `FieldSlot` — `whitespace`, `literal`, `level`, `logger`, `thread`, `message`

Matching is one left-to-right pass with no backtracking, and a line over
`MAX_MATCHABLE_LINE_BYTES` is refused **before** matching, so cost is decided
by line length rather than by the grammar. Path matching reuses the shipped
`SafePattern`, already proven linear.

A valid timestamp grammar contains exactly one year, month, day, hour, and
minute token. Seconds are optional; fractions require seconds and only one
fraction width may be present. Calendar and clock values are range-checked,
including real month/day combinations, before a line can match. An offset token
therefore cannot upgrade a partial or impossible calendar spelling into an
explicit instant.

---

## The timezone rule is structural

A grammar **without** an `offset` token yields `unresolved_local`. The calendar
text is kept as evidence and never converted.

```
2024-05-03 12:24:22,729 INFO - Example message     -> unresolved_local
2024-05-03 12:24:22,729+02:00 INFO - Example        -> explicit_wall_clock
```

That is not a policy a caller could forget to apply — a grammar with no offset
token has no way to express an instant. Resolution happens once, later, through
the shipped reviewed-declaration path (`apply_source_timezones`), which already
provides preview, atomic publication, undo, and "Decide later".

`suggestedTimezone` records what the profile author believes. **It is inert.**
It must name a real IANA zone to validate, and it never satisfies the review it
suggests — a test asserts exactly that.

---

## Rolled files share one profile

One `SafePattern` covers a family:

```
**/app.log*   ->  app.log, app.log.1, app.log.2024-05-03, app.log.2024-05-04
```

A pattern makes a format a **candidate**. Content still decides, so a profile
written for `app.log` cannot claim `access.log`, and cannot claim an `app.log`
whose shape has changed. That second case is the fail-closed staleness rule: a
source that no longer matches selects `NoMatch` rather than being forced
through a stale grammar.

---

## Multiline ownership

`continuation_until_next_timestamp`: a line that does not **start a new record**
belongs to the record above.

Ownership is decided by record-start, never by indentation — a flush-left
`Traceback (most recent call last):` would otherwise split the record it
belongs to. Lines before the first match are kept unattributed rather than
glued onto an unrelated record.

---

## Conflicts are reported, not guessed

When several valid formats match one source, the highest `priority` wins. Equal
priority is a **`Conflict`** listing the tied ids, for an explicit human choice
— #751 forbids guessing between competing profiles. Selection is
order-independent: supplying the same formats in a different order yields the
same result.

---

## Residuals

* **No UI.** No authoring screen, no ImportFlow step, no preview surface. The
  contract is transport-neutral and ready for one; nothing renders it today.
  There is consequently **no visual proof** in this slice, because no pixels
  changed.
* **`ProfileRef` linkage is not wired.** Referencing a reviewed format from an
  `ImportProfile` today yields Drift, because profile matching resolves
  references against built-in content fingerprints only.
* **Not wired into ingest.** `parse.rs` does not consult reviewed formats yet,
  so defining one does not change what a corpus contains. The production-path
  tests prove the grammar's behaviour and the shipped pipeline's behaviour
  separately, and that they agree about a rolled family — not that ingest
  applies the grammar.
* **No persistence.** Formats are values; there is no store, no reuse across
  sessions, and no `EngineClient` method yet.
* **Not exposed over `EngineClient`.** The contracts are versioned and
  transport-neutral, but no adapter method exists.
