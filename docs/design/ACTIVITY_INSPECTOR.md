# Activity Inspector — contract and capture seam

Status: **backend contract + capture seam landed, and the desktop UI now
reads it live. Durable persistence remains an explicit residual.**

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

`cd_workflow::turn::run_{ordinary,linked}_turn` already accepted
`trace_sink: Option<Arc<dyn TurnTraceSink>>`; both desktop call sites passed
`None`. That parameter *was* the seam. The desktop now passes a
`RecordingTurnTrace` when capture is enabled, and projects it after the turn
via `ActivityRecorder::record_provider_rounds`.

No second tracing path exists. CLI `--trace`/`--dry-run` and the inspector
consume the same `TracedCall`s.

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
timings, tool **names**, identifiers, and status — and **no prompt bodies at
all**, not truncated ones. `Full` is the only level that retains bodies, and
even then they are the already-redacted, already-capped ones the trace
produced. `ActivityRecorder::push` strips bodies below `Full`, so a caller
cannot smuggle them in by hand-building an event.

Bounds are explicit: over `MAX_ACTIVITY_EVENTS` a record counts what it
dropped and reports `is_truncated()`, so a UI cannot present a prefix as a
whole turn.

## Storage today

`ActivityStore` on `AppState`: bounded (200 records), evicting oldest-first,
**memory-only**, keyed `(session_id, assistant message id)`. Re-recording
one message replaces in place rather than consuming a second slot, so a
retried turn cannot push an unrelated record out.

Deletion lifecycle: `forget_session`, `forget_message`, `clear`. The desktop
exposes `forget_session_activity`. Read side is `get_turn_activity`; there
is deliberately no mutating command, because an explanation the user can
edit is not an explanation.

## Residual: durable persistence

**Not built.** Records do not survive a restart, and a record evicted by the
200-record bound is gone. The UI must say "not available for this turn"
rather than invent an explanation — the three ordinary causes are: capture
was disabled, the turn predates this process, or the record was evicted.

The contract is already shaped for durability, so this is wiring rather than
redesign:

- every type is `Serialize + Deserialize` with `#[serde(default)]` on
  `version`, `detail_level`, and `dropped_events`, so a row written before a
  field existed loads instead of failing;
- `ACTIVITY_CONTRACT_VERSION` is stamped on every record;
- the key is already `(session_id, message_id)`, matching how sessions are
  stored.

What a durable batch must decide and prove, none of which is decided here:

1. **Where.** A sidecar per session (`sessions/<id>.activity.json`) keeps
   the transcript schema untouched; an inline field on `StoredMessage`
   changes a durable schema every host reads. The sidecar is the safer
   default and is why nothing was added to `StoredMessage` in this batch.
2. **Exactly-once.** Turn persistence already runs under
   `chat_session_mutation`; an activity write must join that critical
   section or it can double-write on a retried turn.
3. **Deletion.** Trashing, deleting, and compacting a session must remove
   its activity in the same operation, not on a later sweep. At `Full`
   detail a record holds redacted conversation text, so "I deleted that
   chat" has to mean it.
4. **Size.** A per-session cap and a purge policy, since `Full` detail is
   unbounded across a long session even though each record is bounded.

## What is captured today, and what is not

Captured: one event per provider round, carrying round index, message count,
total redacted context characters, whether the message list was capped, tool
names offered, per-role tallies, elapsed time, finish reason or redacted
error, and the turn's terminal status via
`activity::status_for_turn_events`.

That classifier reads the whole event stream, not the terminal reason alone.
Two of this product's withholding conditions — `linked_no_tool` and
`linked_required_source_missing` — are emitted as `StreamEvent::Error` codes
while `TurnCompleted.reason` stays `"stop"`, so a reason-only classifier
would file a knowingly ungrounded answer as a clean success.
`events::WITHHELD_TURN_REASONS` and `events::WITHHELD_TURN_ERROR_CODES` are
split along exactly that line, and `budget_rounds` (the final answer failed)
is kept apart from `budget_rounds_answer` (an answer was produced).

Not captured yet, and each needs its own event source rather than a contract
change: individual tool executions, permission decisions, retrieval and
ranking steps, and connector calls. The `ActivityOrigin` variants for all of
these already exist and are tested; what is missing is a host-side call to
`ActivityRecorder::push` at each of those points.


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
- `elapsed` — milliseconds since turn start, which is exactly what the
  contract carries for provider rounds;
- `sequence` — order only, for steps the renderer observed without timing.

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

Per-turn chat activity currently shows provider rounds from the host record
plus what the renderer itself observed (tool calls, citations, search trail).
Tool executions, permission decisions, retrieval/ranking steps, and connector
calls still have no host-side `ActivityRecorder::push`, so the inspector
reports them as observed-but-untimed rather than as contract events. The
Explorer rail records the deterministic work it genuinely performs (corpus
summary reads, cross-surface timezone refreshes); linked-chat turns inside
the Explorer are not yet folded into that rail.
