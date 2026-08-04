# Activity Inspector — contract and capture seam

Status: **backend contract + capture seam + desktop UI under integration
review. Activity records are bounded and process-lifetime only; durable
hydration is intentionally disabled pending privacy, retention, Windows,
and multi-process writer proof.**

The Activity Inspector answers one question about a finished turn: *what
actually happened, and how much should I trust each step?* This document
records the contract, where capture happens, what is deliberately not
captured, and exactly what is not built yet.

## Scope: source-agnostic by construction

The same inspector serves ordinary chat and linked-log chat, and is meant to
extend to memory, workspace files, and connectors such as Confluence without
a contract change. Nothing in `cd_core::activity` knows what a log corpus
is. A step differs only by its `DataScope` and its `EvidenceRef`s:

| Source | `DataScopeKind` | `EvidenceRef.kind` |
| --- | --- | --- |
| Ordinary chat | `conversation` | — |
| Linked log chat | `log_corpus` | `event` |
| Workspace | `workspace` | `file` |
| Memory | `memory` | `memory` |
| Connector | `connector` | `page`, `issue`, … |

`EvidenceRef.kind` is a free-form string on purpose: adding a source must
not require editing an enum in core.

**Activity is not evidence.** A record explains a turn; it is never a second
source of truth for what a corpus contains. Nothing in the inspector feeds
search, citation counts, or grounding checks, and no code path reads a
record back into a turn.

## Origins and determinism

`ActivityOrigin` distinguishes seven kinds of authority. `Determinism` is
derived from the origin by a total function, never set by a caller:

| Origin | Determinism | Meaning |
| --- | --- | --- |
| `client_evidence` | deterministic | what the user asked or supplied |
| `deterministic_host` | deterministic | exact host work with a defined result |
| `repeatable_heuristic` | **repeatable** | a rule — ranking, scoring, selection |
| `probabilistic_model` | probabilistic | a provider request |
| `external_connector` | probabilistic | a system outside this app |
| `user_decision` | human | a person answered |
| `governed_write` | deterministic | a mutation that had an explicit grant |

**A heuristic is never deterministic.** Ranking gives the same answer for
the same inputs, which is not the claim "this is a proof". Because
`determinism()` is computed from the origin inside `ActivityRecorder::push`,
a caller cannot make that claim even by filling the field in wrongly — there
is a test that constructs exactly that lie and asserts it is corrected.

## Capture seam

The shared `cd_core` research turn accepts an optional
`Arc<dyn TurnTraceSink>`. The desktop passes a `RecordingTurnTrace` when
capture is enabled. The same recorder timestamps provider completions and
metadata-only host stream observations against one turn origin, then
projects the ordered timeline after the turn via
`ActivityRecorder::record_timeline`.

No second desktop tracing path exists. A future CLI must consume this same
`TracedCall`/`TurnActivityRecord` contract; there is no CLI binary in this
workspace today, so GUI/CLI parity is not claimed here.

### Why this cannot change execution

- `TracingChatBackend` wraps the inner backend and forwards every call
  unchanged. It observes what was already assembled; it never composes,
  reorders, or withholds.
- With capture disabled the sink is `None` and both call sites take
  byte-identical arguments to before.
- The projection runs strictly *after* the turn, over data already produced.
  A failure there is non-fatal: an answer is never withheld because an
  explanation could not be filed.

`inspector_on_and_off_send_the_provider_identical_requests` captures what
the backend actually receives on both sides and compares messages, tools,
and order.

### Why credentials cannot be captured

The trace boundary is `ChatBackend::complete(&[ChatMessage], &[ToolSpec])`.
No API key, base URL, or HTTP header exists at that signature, so there is
nothing to record — this is a property of the type, not of code remembering
to scrub. `PrivacyClass` deliberately has no `Secret` variant, because
having one would imply secrets might arrive.

## Retention

`AppConfig.activity` has two independent switches, both serde-defaulted so
older config files load unchanged:

| Setting | Default | Effect |
| --- | --- | --- |
| `enabled` | `true` | capture a record at all |
| `retain_context_bodies` | **`false`** | retain prompt bodies |

At the default `Summary` level a record holds counts, per-role tallies,
turn-relative placement, provider-call latency, tool **names**, identifiers,
and status — and **no prompt bodies, tool arguments/results, permission
targets/previews, or search text at all**. `Full` is the only level that retains bodies, and
even then they are the already-redacted, already-capped ones the trace
produced. `ActivityRecorder::push` strips bodies below `Full`, so a caller
cannot smuggle them in by hand-building an event.

Evidence references in the ordinary Activity record are opaque SHA-256
prefixes. Source ids and locators are never retained verbatim: an ordinary
file citation may be a full local path, and treating that path as harmless
metadata would leak it through the store and IPC. Kinds are secret-scrubbed
and bounded; ids and locators are fixed-size opaque correlation values.

### Explicit developer detail

The Activity display mode (Off/Compact/Drawer/Docked) remains a presentation
choice. A separate **Developer detail** checkbox is Off at every process
start and is never written to local storage or config. When enabled for a
new turn, the existing shared turn trace emits a live, causally sequenced
developer stream containing:

- provider/profile, model, round, offered tools, and redacted request messages;
- the accumulated provider response and selected native tool calls;
- parsed tool arguments, host results/errors, permission gates, host phases,
  and cancellation metadata.

Every content payload is recursively redacted for known secret fields,
passed through the common credential scrubber, capped at 8 KiB of valid UTF-8,
and accompanied by original/retained byte counts plus an explicit truncation
flag. Debug formatting omits content. The host sends these events through a
dedicated IPC event that never enters the ordinary transcript reducer.

Developer payloads are held only in a bounded process-memory store keyed by
the exact `(session_id, assistant_message_id)`. There is intentionally no
serialization/filesystem API. Trash/delete/forget clears both ordinary and
developer activity under the same session lifecycle boundary.

Bounds are explicit: over `MAX_ACTIVITY_EVENTS` a record counts what it
dropped and reports `is_truncated()`, so a UI cannot present a prefix as a
whole turn.

## Storage today

`ActivityStore` on `AppState`: bounded (200 records), evicting oldest-first,
**memory-only**, and keyed `(session_id, assistant message id)`. Re-recording
one message replaces in place rather than consuming a second slot, so a
retried turn cannot push an unrelated record out.

Deletion lifecycle: `forget_session`, `forget_message`, `clear`. The desktop
exposes `forget_session_activity`. Read side is `get_turn_activity`; there
is deliberately no mutating command, because an explanation the user can
edit is not an explanation.

## Durable persistence (not enabled)

The product does not currently write or hydrate activity sidecars. The
draft `DurableActivityJournal` is not connected to the desktop host until
the durable representation has closed full-object privacy validation,
ordered and global retention, Windows replacement, deletion ordering, lazy
session hydration, and multiple-process writer behavior. Chat trash/delete
still clears the bounded in-memory record and retires any experimental
sidecar left by a development build.

**Residual:** Explorer-linked turns are not fully folded into the activity
rail; the CLI package is not a workspace member on this tip (the contract is
shared, but there is no `cd-cli` binary coverage here).

## What is captured today, and what is not

Captured: one event per provider round, carrying round index, message count,
total redacted context characters, whether the message list was capped, tool
names offered, per-role tallies, provider latency, turn-relative completion
time, finish reason or redacted
error, and the turn's terminal status via
`activity::status_for_turn_events`.

The same ordered capture includes tool lifecycle, count-only retrieval trails,
citation identities, and pending permission gates. `ToolHost` supplies tool
authority from its live registered catalog: local reads are host work,
connector reads are external, and approved mutations are governed writes.
The renderer does not guess from tool-name patterns. A permission request is
pending host policy, never a completed human decision; the later UI allow or
deny appends a `user_decision` event and the metadata-only governed tool
outcome to the original process-lifetime record.

That classifier reads the whole event stream, not the terminal reason alone.
Two of this product's withholding conditions — `linked_no_tool` and
`linked_required_source_missing` — are emitted as `StreamEvent::Error` codes
while `TurnCompleted.reason` stays `"stop"`, so a reason-only classifier
would file a knowingly ungrounded answer as a clean success.
`events::WITHHELD_TURN_REASONS` and `events::WITHHELD_TURN_ERROR_CODES` are
split along exactly that line, and `budget_rounds` (the final answer failed)
is kept apart from `budget_rounds_answer` (an answer was produced).

Still not captured: provider token billing when a gateway does not report it,
raw tool arguments/results by design, fine-grained ranking candidates, and
connector-internal retries that have no host event source.


## The desktop surface

One renderer model (`desktop/src/lib/activity/types.ts`) mirrors this
contract, and one shared persisted preference — Off / Compact / Drawer /
Docked — governs display in ordinary chat, the Logs pane, and the Log
Explorer alike. Off hides the whole ContextDesk group and changes nothing
about processing; host-side capture is `AppConfig.activity`, deliberately a
different switch.

### Two synchronized groups, never one

| | Customer evidence lanes | ContextDesk activity lanes |
| --- | --- | --- |
| Made of | `ExplorerEventDto` | `ActivityEvent` |
| Governed by | corpus, source facets, filters, suppression policy | operation / import / chat-turn / model-round / tool / correlation id |
| Feeds | search, facets, grounded citations | nothing but the inspector |

The separation is structural rather than conventional: every activity event
carries `laneGroup: "contextdesk"`, that field's type is the single literal,
and a repo-wide test asserts no production module outside `lib/activity`
constructs one. Activity therefore cannot enter the corpus, the source
facets, search or filter results, the suppression policy, or grounded
evidence — none of those surfaces read the type.

### Time is never invented

An event's position is an `ActivityClock` union, not a nullable timestamp:

- `wall` — real calendar time on this machine (import runs, Explorer work);
- `elapsed` — milliseconds since turn start, captured for provider and host
  observations on one shared clock;
- `sequence` — order only, for steps the renderer observed without timing.

Provider call duration is a separate `provider_latency_ms` field. It is never
relabelled as turn-relative elapsed. Events appended after an older persisted
turn (for example a permission response) use sequence placement when their
original turn-relative time is unavailable; they never use a fabricated zero.

`lib/activity/dualLaneAxis.ts` is the only place that decides whether the two
groups may share a visual axis. It requires wall-clock evidence on **both**
sides: an `order_only` or `mixed` corpus, or any activity event that is
sequence- or elapsed-only, drops the view to two labelled tracks with the
reason stated in words. Partial dating is refused rather than filled in —
one undated event among dated ones would otherwise be placed at a moment
nobody measured.

### No fixture theater

An earlier draft filled context categories, a token budget, and a round
count from fixtures, tagging each `source: "fixture"` and rendering
"(placeholder)" beside numbers that looked measured. That is removed.
Production shows live facts or the words "not reported"; fixtures are
test/story-only, and two repo-wide tests pin that no production file imports
them and no activity module carries a live-vs-fixture provenance field.

### Residual on the desktop side

Per-turn chat activity uses the host record as authoritative. Renderer-folded
tool/citation/search rows are fallback-only when no host record exists, so a
live record cannot display every operation twice. The Explorer rail records
the deterministic work it genuinely performs (corpus
summary reads, cross-surface timezone refreshes); linked-chat turns inside
the Explorer are not yet folded into that rail.

Developer detail is currently strongest for ordinary/provider-backed chat.
Provider responses are emitted after the streaming accumulator completes;
individual token/SSE chunks are not retained. Context bodies show what was
sent after preparation, but the record does not yet name which ambient
memory, attachment, skill, connector context, ranking candidate, or
compaction decision contributed each block. Package/demo installation,
import/reanalysis `ProcessProgress`, timezone refresh failures, Explorer
operations, and linked-chat activity inside the Explorer rail do not yet
produce equivalent developer payload events. Permission decisions remain
truthful in the ordinary Activity record, but an already-open renderer cache
still needs explicit invalidation to show a decision made after the original
turn record was fetched.
