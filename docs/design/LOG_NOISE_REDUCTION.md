# Log noise reduction — deterministic single-corpus candidates

**Status:** Implemented core detector contract for issue **#815** and
human-review surface for issue **#818**.
**Scope:** Single-corpus, proposal-only, read-only exact-template candidates
with bounded review and an explicit handoff to the existing human suppression
workflow.
**Non-scope:** Automatic suppression and cross-corpus learning.

The detector returns bounded evidence for human review. It never calls a
template “confirmed noise,” writes findings, changes Explorer filters, mutates
events or templates, or changes the active suppression policy.

## Human review surface

The Explorer's **Noise → Review suggestions** surface invokes the detector
without changing its ranking or facts. It shows at most 16 candidates per pass
with:

- exact event count and corpus share;
- source count, level distribution, time quality and coverage;
- a coarse **steady**, **bursty**, or **insufficient reliable time** shape;
- stable reason codes and the core explanation;
- up to three redacted representatives; and
- explicit result and scan bounds.

The UI says **Showing N of M eligible suggestions**. It separately distinguishes
candidate/response truncation from a bounded template scan; a bounded scan does
not claim that additional eligible candidates definitely exist.

Nothing is preselected and there is no bulk-accept action. **Not noise…**
requires a reviewed reason and records the dismissal only for the current
corpus event, template-analysis, and suppression revisions. The dismissal is
stored in the desktop profile and becomes inapplicable when any pinned revision
changes. If that record cannot be persisted, the candidate stays visible and
the failure is shown.

**Suppress…** does not activate the detector result. It opens the existing
trusted-core **Preview impact → Confirm suppression** workflow for that exact
template. A revision change marks the displayed proposals stale and disables
dismissal/suppression actions until the user refreshes. Escape, outside-click
dismissal, focus restoration, keyboard navigation, and a bounded narrow sheet
follow the same policy-panel accessibility contract.

## Facts versus inference

| Layer | What it is | Who may decide |
|-------|------------|----------------|
| **Facts** | Exact event counts and share, distinct sources, separate wall/order spans, time quality, level counts, trusted template identity, redacted representatives | Trusted core only |
| **Score** | Deterministic integer combination of documented fact components and severity penalties | Trusted core only |
| **Reason codes** | Stable machine codes derived from documented thresholds | Trusted core only |
| **Proposal label** | “suppression candidate” / “noise candidate” — never “confirmed noise” | Product copy |
| **Activation** | A separate #671 preview, explicit human approval, then rule activation | Human only |

## Bounded detector pass

Within the aggregate statement, the detector ranks templates by authoritative
current unsuppressed DuckDB event counts and retains at most **4,096 template
ids**. Ordering is event count descending, then `template_id` ascending.
Optional already-suppressed disclosure rows reserve space within the same hard
cap. Templates outside that retained set are not examined as candidates in the
pass, and `template_scan_truncated` discloses that fact. Stale sidecar
`TemplateInfo.count` values cannot decide candidate inclusion.

Corpus denominators still count the complete raw or active-lens corpus; they
are not limited to the retained templates.

One pass mechanically counts and permits at most four database statements:

1. complete raw-corpus and active-suppression-lens corpus facts;
2. authoritative template-count ranking plus aggregate facts for the
   deterministically retained templates;
3. exact level counts for final candidates, when any remain;
4. bounded representatives for final candidates, when any remain.

Cancellation and the shared **30-second database-work deadline** are checked
before every statement. A watchdog independently interrupts active DuckDB work
on cancellation or deadline expiry. Fewer than four statements are used when
the pass has no candidates or exits early.

## Scoring facts

For each retained exact `template_id`, the aggregate records:

- exact event count and corpus share;
- distinct source count;
- ERROR/FATAL, WARN/WARNING, and INFO/empty counts;
- separate wall-clock and order-only event counts and inclusive spans;
- distinct coarse wall-clock minute buckets;
- the largest event count in one coarse wall-clock minute bucket.

Active proposals use the exact unsuppressed event count as their share
denominator. Optional disclosure rows for already-suppressed templates use the
exact raw corpus count and carry `share_basis = raw_corpus`; active proposals
carry `share_basis = unsuppressed_corpus`. Suppressed events from templates
outside the 4,096-template retained set are still included in the exact
denominator.

## Score formula

The deterministic integer score has five components totaling at most 100
before severity penalties:

1. **Volume (0–40):**
   `min(corpus_share_bps, 1000) / 25`.
2. **Source breadth (0–20):**
   `min(source_count, 10) * 2`.
3. **Wall-clock time coverage (0–15):** zero without a reliable all-wall-clock
   candidate and corpus baseline. Otherwise it uses candidate span coverage
   and distinct-minute-bucket coverage of the corpus:
   - 15 for span coverage ≥ 70% and bucket coverage ≥ 20%;
   - 12 for span coverage ≥ 70%;
   - 9 for span coverage ≥ 40% and bucket coverage ≥ 10%;
   - 7 for span coverage ≥ 40%;
   - 4 for span coverage ≥ 20%;
   - 1 for a shorter non-zero span; zero for a zero/unknown span.
4. **Coarse-bucket repetition stability (0–10):** zero unless there is a
   reliable wall-clock baseline, at least four occupied minute buckets, and a
   measurable peak bucket. Otherwise it scores 10 when the peak bucket holds
   at most 25% of template events, 6 when it holds at most 50%, and zero when
   more than half the events are in one minute bucket.
5. **Level profile (0–15):** 15 when INFO/empty is at least 70%; 12 when
   WARN/WARNING is at least 70%; 10 when those groups together are at least
   70%; otherwise 4.

Severity is evidence, not a veto. After components:

- ERROR/FATAL share ≥ 50% halves the score using integer arithmetic and adds
  `repetitive_error_risky`;
- otherwise, ERROR/FATAL share ≥ 10% subtracts 15 with a floor of zero and adds
  `repetitive_error_risky`.

The two severity penalties are mutually exclusive. When already-suppressed
templates are explicitly requested for disclosure, they receive
`already_suppressed` and are demoted again by halving their post-penalty score.

## Eligibility and ranking

Active proposals must pass all applicable gates before ranking:

- active-lens corpus count is at least 20;
- template count is at least 10, or at least 5 across at least 3 sources;
- corpus share is at least 0.5%, or absolute template count is at least 500;
- rare severe templates do not qualify through the relaxed low-count path;
- post-penalty score is at least 12.

Ranking is `score DESC`, then `template_id ASC`. The default result cap is 16
and the hard cap is **32 candidates**. Already-suppressed template ids are
always disclosed separately. Their optional ranked rows remain visibly marked,
use the raw denominator, and carry the additional score demotion.

## Time-quality contract

The detector keeps raw-corpus and active-suppression-lens time quality and
wall-clock span baselines separate. Active candidates are scored against the
active-lens baseline. An explicitly included already-suppressed row is scored
against the raw baseline because its events are absent from the active lens.
Neither baseline may substitute for the other.

- Wall-clock time coverage and coarse-bucket repetition stability score only
  when both the relevant corpus baseline and candidate are entirely in one
  reliable wall-clock domain.
- Order-only candidates expose only an order span and receive no wall-clock
  score or wall-clock reason.
- Mixed candidates expose wall and order spans separately. They receive no
  fabricated cross-domain duration and no wall-clock score or reason.
- Every representative carries its own `Wall` or `OrderOnly` time quality, so
  its displayed timestamp/order coordinate is not inferred from the candidate
  aggregate.
- Timestamp magnitude is never used to infer clock quality; the stored active
  timestamp basis is authoritative.

## Exact output accounting

Each candidate carries exact counts, share basis, source count, separate
wall/order spans, severity counts, reason codes, explanation, trusted template
fingerprint, bounded pattern, and bounded redacted representatives.

The displayed level histogram retains at most 16 deterministically ordered
level buckets. Counts are exact: displayed bucket counts plus
`other_level_count` must equal the candidate event count.
`level_counts_truncated` is true exactly when one or more level labels were
folded into `other_level_count`. Display labels remain privacy-sanitized.

Each candidate has 3 representatives by default and at most **5
representatives**. Representative selection remains deterministic when source
sequence values repeat, favors source breadth, and carries per-representative
time quality.

The response cap is **96 KiB of the exact serialized JSON response**, measured
with the production serializer. If necessary, candidates are removed from the
ranked tail until the serialized response fits; truncation is explicit. If
fixed report metadata alone cannot fit, the pass fails rather than returning an
oversized response. This is a serialized-byte bound, not a total process-memory
claim.

## Reason codes

| Code | Meaning |
|------|---------|
| `high_frequency` | High absolute volume or strong share |
| `high_corpus_share` | Share meets the proposal threshold |
| `multi_source_repetition` | At least 3 distinct sources |
| `temporally_persistent` | Reliable wall-clock activity spans at least 70% of the relevant corpus baseline |
| `level_dominated_info` | Level profile is dominated by INFO/empty, or by the combined INFO/empty and WARN groups |
| `level_dominated_warn` | Level profile is dominated by WARN/WARNING |
| `repetitive_error_risky` | Material ERROR/FATAL share; review carefully |
| `steady_background` | No one coarse minute bucket contains more than 25% of template events |
| `already_suppressed` | Enabled in the pinned active suppression policy |

## Safety, coherence, and privacy

- The detector is proposal-only and read-only. It does not invoke suppression
  preview or activation.
- Event, template-analysis, and suppression revisions are pinned and rechecked.
  Concurrent change fails visibly as a stale snapshot.
- Representatives pass log redaction and candidate redaction; credential-heavy
  text becomes a typed placeholder. Pattern, source, and level displays are
  also redacted and UTF-8-byte bounded.
- Evaluator sentinels are checked after display redaction. Protected markers
  become typed placeholders and never pass through as representative or
  display text.
- Fingerprints must come from trusted template metadata, be non-empty and
  bounded, contain no control characters or evaluator sentinel, and remain
  unchanged by display redaction. A candidate without such a fingerprint is
  omitted and its template id is disclosed in
  `metadata_missing_template_ids`; the detector never fabricates identity.
- The DTO contains no evaluator truth, expected-cause labels, model-authored
  conclusions, or raw parameter arrays.
- Candidate metadata access clones only bounded identity/display strings. It
  does not clone embedding vectors, whole template payloads, or full event
  payloads. SQL returns only bounded representative fields for final
  candidates.
- Candidate count, representative count, retained templates, level buckets,
  display bytes, exact serialized response bytes, database statement count,
  and database-work duration all have hard bounds.

## Why severity alone cannot define noise

ERROR volume may be legitimate incident signal or a broken retry loop. The
detector discloses severity counts, penalizes ERROR/FATAL-heavy templates,
allows a high-volume risky template only when the remaining deterministic
evidence is strong enough, and does not let the relaxed low-count gate turn
rare severe evidence into a proposal. No proposal hides or suppresses an event.

## Performance evidence — one machine only

The deterministic synthetic 250,000-event test records detector elapsed time
and compares repeated results. Its timing is a **one-machine regression
observation**, not a universal latency claim or product SLA. The test's broad
pathology guard also is not a performance promise. The 30-second database-work
deadline is a safety bound, not evidence that every supported corpus completes
near that duration. Larger or differently distributed corpora require
machine-scoped measurement.

## Residual work belongs to separate issues

- **Suppression lifecycle:** #818 connects reviewed proposals to the existing
  exact-template Preview → Confirm workflow, but broader predicates, full rule
  editing/identity, and package lifecycle remain in #671.
- **Cross-corpus learning:** learning or transferring proposal priors across
  investigations or workspaces is separate, future work. It must be opt-in,
  privacy-reviewed, proposal-only, and must not weaken per-corpus human
  approval.

There is no multi-investigation learning, transfer of “known good noise”
fingerprints, automatic suppression, or sub-minute regularity claim in this
design.

## Caps

| Cap | Default / hard maximum |
|-----|------------------------|
| Candidates returned | 16 / 32 |
| Representatives per candidate | 3 / 5 |
| Templates retained by authoritative SQL aggregate | 4,096 |
| Representative excerpt | 512 UTF-8 bytes |
| Pattern display | 256 UTF-8 bytes |
| Displayed level buckets | 16 |
| Exact serialized JSON response | 96 KiB |
| Database statements | 4 |
| Shared database-work deadline | 30 seconds |

## Related

- Issue **#815** — deterministic proposal-only detector
- Issue **#818** — bounded explainable human review
- Issue **#671** — durable suppression rules
- Issue **#745** — broad triage brief; separate and not a replacement for this
  detector
