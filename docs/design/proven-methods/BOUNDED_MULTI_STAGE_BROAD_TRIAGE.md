# Bounded multi-stage broad-log triage (experimental)

This is an experimental shared-core extension of deterministic broad-log
triage. It is used only when the host has produced at least two candidate
groups and the ordinary turn's provider-round and context budgets can reserve a
final comparison. Otherwise the established single-stage broad-log synthesis
continues unchanged.

```mermaid
flowchart TD
    H["Host: pin corpus + suppression revision"] --> B["Host: bounded broad brief"]
    B --> C["Host: <=4 structural candidates"]
    C --> S["LLM: candidate-only synthesis\n(max 2 attempts each)"]
    S --> V["Host: validate citations against that candidate only"]
    V -->|"valid groups >=2"| F["LLM: strict investigation_answer.v1 proposal"]
    V -->|"no groups / insufficient starting budget"| L["Existing single-stage path"]
    F --> G["Host: validate proposal against the immutable evidence ledger"]
    G --> E["Host: typed AnswerEnvelopeV1 (authority)"]
    E --> M["Host: deterministic Markdown projection (display)"]
    M --> O["Shared CLI / GUI stream events + telemetry"]
```

## Responsibility boundary

The host alone opens the corpus, pins revisions and suppression, constructs the
bounded broad brief, and selects no more than four groups. Parser-true
cross-source trace groups rank first; ungrouped ERROR/FATAL template groups
fill remaining slots. Warning and non-error noise candidates never become
incident groups. The LLM interprets a supplied group but cannot retrieve,
create groups, or move citations between groups.

Each candidate has a stable `group_id`, a small structural brief, and its own
trusted identity ledger (`seq`, `source`, `template_id`). A candidate response
must cite an identity from its own ledger. Invalid responses receive at most
one correction attempt and are then withheld. This avoids a global evidence
set incorrectly validating a decoy's citation from another incident.

## Two contracts: authority and display

The final comparison is a **strict `contextdesk.investigation_answer.v1`
proposal**, not prose. The model supplies only `candidate_id`, `claim_id`,
`text`, and `evidence_ids`; every host-owned field — citations, claim status,
corpus, revision, session, turn — is refused on input and derived by
`validate_model_answer` against the immutable ledger for that exact turn. The
result is an `AnswerEnvelopeV1`, emitted as `StreamEvent::InvestigationAnswer`.
That envelope is the sole authority and the only persistence path.

Before the initial final-comparison request, the host derives a **content-free
final-answer manifest** from that same immutable ledger. It lists every
required `candidate_id` exactly once and, beneath it, the exact `evidence_ids`
the validator permits for that candidate. It contains no source label,
locator, excerpt, corpus/revision, role, canonical citation, binding, or
digest. The initial prompt requires every manifest candidate exactly once and
candidate-scoped citations only. If the strict validator rejects that proposal,
the one semantic correction repeats the same bounded contract, user question,
candidate drafts, and unchanged manifest, plus only the stable validation
category (for example `wrong_scope`). It never replays the rejected proposal or
adds raw log/source/locator data, binding/digest, provider errors, or any other
host-owned envelope data. In other words, correction repeats the same bounded
initial-comparison context rather than adding or subtracting evidence. The
manifest remains the only permitted final `evidence_id` boundary, and the
validator remains the authority. The manifest itself is included in the same
context estimate and hard packing gate as every other final-comparison message.
This improves provider interoperability without weakening parsing, schema,
unknown-id, cross-candidate, or host-authority checks.

What a person reads is a **separate, deterministic host projection**:
`render_answer_markdown` renders the validated envelope as Markdown and that
text is what the visible `TextDelta` and transcript history carry. The
projection derives citations only from `canonical_citations`, keeps candidates
and claim kinds separate, marks any claim the host did not accept, states
root-cause establishment from `root_cause_established` alone, and invents no
confidence — V1 validates none, so the output says so. It is ordered by
host-owned identifiers, so a permuted envelope renders byte-identically.
Nothing parses that Markdown back: a later turn builds a fresh ledger.

### Presentation is a trust boundary too

A validated envelope is safe as *data* and still unsafe as *markup*: the
projection interpolates dynamic strings into a document a renderer reparses.
Claim text is model-controlled, and the corpus-derived fields — identifiers,
source labels, locators, excerpts — are only ever whatever an imported log
called itself, so host-owned does not mean safe to reparse. Without a boundary
a claim can open a new line and write a second "root cause established" line, a
heading, an evidence section, or a clickable link that looks host-issued.

Every dynamic value therefore passes through
`cd_core::investigation_answer::literal_display_text` and is emitted inside a
code span. Three normalizations, all deliberate and all documented here:

1. **Line, paragraph, and column boundaries become a single space.** This is
   the load-bearing rule. Every block construct — heading, list item, table
   row, fence, block quote — and every host status line is line-anchored, so a
   value that cannot contain a line break cannot author any of them. One rule
   covers the whole class without naming a single construct.
2. **C0, C1, and DEL are removed**, which takes ESC with them, so no ANSI or
   OSC sequence (including OSC 8 hyperlinks) can reach a terminal.
3. **Bidi formatting controls are removed**, so displayed order matches byte
   order. `TerminalTextSanitizer` applies the same set to all CLI output.

A backtick becomes a straight apostrophe — the one character that could close
the surrounding span early. Everything else is preserved, including non-ASCII
letters, emoji, and combining marks: this is a control-character and
line-structure boundary, not a character allowlist. A value that normalizes to
nothing renders as the host's `(empty)` placeholder rather than an empty span.

The code span is what survives into the renderer: its content is literal by
definition, so no emphasis, link, autolink, citation chip, or HTML can form
from a dynamic value. `MarkdownBody` was extracting code spans *after* running
its emphasis, link, chip, and `<br>` passes over the whole string, which meant
a code span protected nothing; it now extracts them first. The visible
backticks are part of the point: a reader can see exactly where host-owned
structure stops and quoted, untrusted content starts.

The legacy structured-triage answer contract (`observations`,
`causal_candidates`, `competing_explanations`, `confidence`,
`missing_or_next_evidence`) and its hermetic rubric still govern the
**single-stage** synthesis path, and only that path. The two contracts are kept
mechanically separate — the projection deliberately avoids the headings the
legacy parser keys on — so neither can be mistaken for the other.

## Causal vocabulary is never host authority

The host verifies identities, scopes, and typed roles — it never infers causal
semantics from corpus wording. An earlier single-model guard that recognized
literal coverage-gap/symptom phrases in bounded evidence (and rewrote
overclaiming answers into a host-authored `Cause not established:`) was
removed as fixture-vocabulary coupling: it only fired on the frozen lab's
phrasing, and untrusted log text could steer it. Whether evidence establishes
a mechanism is model judgment under the synthesis contract; typed
establishment remains host-only via `EvidenceRole::Cause` provenance and
role-withhold, which no production path assigns from text. The
vocabulary-generalization gates (`vocab_generalization_gates.rs`) hold this
boundary: shipped outcomes must be invariant under unseen corpus renames, and
production prompt/ranking sources must not contain fixture lexicon or alias
tables. See [`docs/design/VOCAB_AGNOSTIC_KNOWN_ROOT.md`](../VOCAB_AGNOSTIC_KNOWN_ROOT.md).

## Bounds and failures

`AgentOptions.max_rounds` is the hard provider-call cap for this path. It
includes candidate attempts and the final comparison; the experimental path
never starts without room for a comparison. Candidate and final contexts use
the same headroom-aware context budget as ordinary linked synthesis. The current
implementation has an in-flight concurrency cap of one (conservative while
preserving one ordered provider trace); it is designed so a future bounded
parallel executor can raise that cap without changing the evidence contract.

Cancellation and the whole-turn deadline use the existing shared agent clock.
Every provider request still passes through the normal backend/trace observer,
so CLI and Tauri project the same events and provider telemetry. No provider is
called in tests: scripted hermetic cases cover three independent groups, a
cross-group decoy, bounded invalid retry, and total-round caps.

Stage callbacks enter the shared event collector immediately. Investigator,
reviewer, and synthesizer `MultiModelStage` events are therefore live while a
provider stage is pending, rather than buffered until the whole pipeline
returns. Core's shared `TurnProgress` projection gives normal CLI text, JSONL,
and desktop IPC the same concise labels and host-measured elapsed clock; opaque
candidate ids and scrubbed bounded detail stay behind expandable diagnostics.

If groups are absent, the initial round budget is too small, or a candidate
context cannot fit, the workflow falls back before any multi-stage provider
request. Once an invalid candidate/comparison request has started, it fails
closed rather than silently mixing it into a global single-stage answer.

## Limitations

Candidate grouping is intentionally structural, not a root-cause verdict.
Cross-source trace identity is only parser-populated `trace_id`; no request,
span, or message token is promoted to a trace key. A no-trace corpus uses the
ERROR/FATAL template fallback and may not capture multi-template incidents.
The bounded sequential executor favors predictable cancellation, cost, and
telemetry over latency; live-provider quality and safe parallelism remain
separate acceptance work.
