# Independent-incident truth for production triage rubric

Status: design only — not implemented. Companion audit to the
`symptom_vs_cause` role-integrity fix. Do not expand schema or invent lexical
heuristics until host-authored truth exists.

## Verdict

**Existing `TriageKnownAnswerKey` and production fixtures are not sufficient**
to enforce an independent-incident demotion rule safely.

| Surface | Independent-incident identity? |
| --- | --- |
| `TriageKnownAnswerKey` | No field (has trigger, competing triggers, decoy earliest, symptoms only) |
| `fixtures/triage-root-cause-lab/cases/*/truth/answer_key.json` | No independent tokens or roles |
| Retrieval-ablation `RaRole` | `Trigger \| Propagation \| Symptom \| Recovery \| Decoy \| Neutral` — no Independent |
| Quality-eval `KnownAnswerTruth` | Has `independent_incident_tokens` + scorer dimension |

Without a host-only identity for “this event belongs to a separate incident,”
any production check would have to guess from prose, candidate order, or
fixture-specific wording. That is out of bounds for this rubric.

## Quality-eval precedent (do not copy blindly)

`quality_eval::answer_score` enforces `independent_incident_separation` when
`truth.independent_incident_tokens` is non-empty:

- fail if an independent token is role-labeled `trigger` or `symptom` while the
  main trigger is also present;
- fail if a single claim binds main-trigger and independent tokens as one cause;
- pass when the independent claim carries an explicit `independent` role.

That scorer is evaluator-facing and already carries richer truth. Production
`score_structured_triage_answer` must stay on host citation identity + structured
role placement, matching the hardened `symptom_vs_cause` style.

## Minimum truth / schema addition

Add one optional field to `TriageKnownAnswerKey` (serde-default empty so existing
JSON continues to deserialize):

```rust
/// Message tokens identifying events that belong to a separate incident
/// and must not be demoted into the primary causal chain.
#[serde(default)]
pub independent_incident_message_tokens: Vec<String>,
```

No other schema change is required for a first invariant. Optional later:

- `independent` listed in `TriageClaim.role` docs (already free-text; document only);
- bridge from retrieval-ablation `RaRole` once an Independent variant exists.

### Proposed invariant (when tokens are non-empty)

Fail `independent_incident_separation` (new dimension id, or a clearly named
sibling of `symptom_vs_cause`) when **any** of:

1. A `causal_candidates` entry cites a host identity resolved from
   `independent_incident_message_tokens` and its role is `trigger` or `symptom`
   (or role is absent — fail closed).
2. A single causal claim's citation set binds both a primary-trigger identity
   and an independent-incident identity (if multi-cite is ever supported; today
   each claim has one seq/source — then (1) alone is enough).

Pass when independent identities appear only with role `independent`,
`observation`, `noise`, or `unknown`, or only under `observations` /
`competing_explanations` without causal promotion.

Do **not** fail merely because multiple causal candidates exist, or because
`competing_trigger_message_tokens` lists several primary triggers.

## Compatibility implications

| Change | Risk |
| --- | --- |
| New `#[serde(default)]` field on `TriageKnownAnswerKey` | Low — empty default; existing fixtures unchanged |
| New rubric dimension | Medium — overall `passed` becomes stricter only when tokens are populated |
| Populating tokens on existing cases | Requires re-authoring truth; leave empty until fixtures exist |
| `ra_triage_key` bridge | Needs Independent role or explicit token list in RA truth |

Backward compatibility: cases with empty tokens keep today's score vector shape
if the dimension is only emitted when tokens are non-empty, **or** always emit
the dimension as pass when tokens are empty (prefer always-emit for stable
dimension sets).

## Required fixtures and tests (before implementation)

Host-authored cases (synthetic, no employer data):

1. **Primary + independent, correctly labeled** — trigger cited as `trigger`;
   independent cited as `independent` → pass.
2. **Independent demoted to `trigger`** while primary trigger also present → fail.
3. **Independent demoted to `symptom`** while primary trigger present → fail.
4. **Independent role absent** on causal candidate citing independent identity →
   fail closed.
5. **Two primary competing triggers** (existing `competing_trigger_message_tokens`)
   with empty independent tokens → still pass (multi-cause counterexample).
6. **Independent only under observations** with role `observation` → pass.

Unit tests live next to `score_structured_triage_answer`; lab cases under
`fixtures/triage-root-cause-lab/` once authored.

## Explicit non-goals for the first cut

- Lexical substring lists of “independent” / “unrelated” in free text
- Inferring independence from candidate order or chronology alone
- Provider/model/fixture-id special cases
- Silently treating `Neutral` or `Decoy` as independent without host tokens

## Review / integration note

This document is an optional cherry-pick relative to the `symptom_vs_cause`
masking fix. Schema expansion and scorer work should land in a follow-up PR
only after fixtures name independent identities.
