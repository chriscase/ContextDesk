# Deterministic context assembly before model synthesis

**Method status:** **Partial.** ContextDesk ships bounded retrieval, context
budgets, ordinary-versus-linked chat isolation, native tool-capability checks,
required log grounding, a host-owned deterministic brief for conservatively
classified broad linked-log prompts, structured log evidence identities,
withholding of ungrounded linked-chat prose, phase-aware provider deadlines,
evidence-preserving synthesis retry, and bounded reversible model-picker
curation. Exact packaged acceptance on a
250,000+ event corpus with a real tools-enabled provider remains open on #745;
a genuine slow-provider run also remains an environment-dependent acceptance
step for #649. Neither deterministic retrieval nor passing component tests is a
universal model-quality claim.

## 1. Problem

An AI assistant cannot reason reliably over an entire workspace, log corpus,
memory store, database, connector estate, and skill library by pasting
everything into one prompt. That approach:

- exceeds model context limits and creates unpredictable truncation;
- obscures which source supports which statement;
- exposes data the user did not ask to share;
- gives small or self-hosted models too many tools and decisions at once;
- lets untrusted retrieved text compete with system policy;
- makes an ordinary chat accidentally inherit unrelated incident context; and
- tempts the UI to display plausible model prose as if a tool actually ran.

The reusable solution is to make the application—not the model—the authority
for context eligibility, retrieval bounds, provenance, permissions, and
completion criteria. The model receives a compact evidence package and performs
synthesis only after required deterministic steps succeed.

## 2. Status and evidence

| Capability                                                     | Status      | ContextDesk evidence                                                                                             | Residual                                                                                           |
| -------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Hard model-context budget and deterministic compaction         | **Shipped** | [`sessions.rs`](../../../crates/cd-core/src/sessions.rs) `prepare_model_context` / `fit_model_context_to_budget` | Token estimation is character-based and provider-specific budgets still require good configuration |
| Bounded source routing defaults                                | **Shipped** | [`router.rs`](../../../crates/cd-core/src/router.rs) `RouterBudget`                                              | Ranking remains intentionally simple                                                               |
| Ordinary chats do not inherit an ambient log corpus            | **Shipped** | [`agent.rs`](../../../crates/cd-core/src/agent.rs) `run_agent_turn_with_sink`                                    | Native acceptance should be repeated for each supported host                                       |
| Linked log chats require successful bounded log evidence       | **Shipped** | [`agent.rs`](../../../crates/cd-core/src/agent.rs) `LogExplorerContext` and linked-turn loop                     | Provider must support native tools                                                                 |
| Tools-disabled profile fails honestly                          | **Shipped** | [`research.rs`](../../../crates/cd-core/src/research.rs) capability gate                                         | User must select/configure a tools-enabled profile for a real loop                                 |
| Structured evidence identity, not rendered-text reconstruction | **Shipped** | [`tool_host.rs`](../../../crates/cd-core/src/tool_host.rs) `ToolResult.log_evidence`                             | Other source types have source-specific citation contracts                                         |
| Viewport snapshot is bounded and treated as data               | **Shipped** | [`view_context.rs`](../../../crates/cd-core/src/log_analysis/view_context.rs)                                    | Snapshot is a hint, not authoritative event content                                                |
| Session file packs are scoped and bounded                      | **Shipped** | [`session_context.rs`](../../../crates/cd-core/src/session_context.rs)                                           | Not the path for multi-million-line log corpora                                                    |
| Broad linked-log triage brief                                  | **Shipped (agent-testable)** | [`tool_host.rs`](../../../crates/cd-core/src/tool_host.rs) `build_broad_log_triage_brief` and [`agent.rs`](../../../crates/cd-core/src/agent.rs) broad-turn admission | Exact generated 250,000+ event acceptance with a tools-enabled provider remains #745 |
| Slow-provider phase lifecycle and synthesis-only retry         | **Shipped (agent-testable)** | One monotonic turn ceiling, bounded phases, immediate cancellation, host-only evidence checkpoint, and tool-closed retry | Native cold/slow tools-enabled provider acceptance remains on #649                                 |
| Bounded model-picker display curation                          | **Shipped** | Profile/endpoint/model-scoped pin, hide, provider hide, restore, exact default replacement, search, and one shared render cap | Display state is not deletion, access control, provider health, or capability evidence              |
| Name-based model-role guidance                                 | **Partial** | Versioned hints inform setup, Settings, and preflight without claiming measured capability                       | Names remain hints rather than a cross-gateway capability standard                                  |
| Explicit synthetic capability qualification                    | **Partial** | User-triggered probes, cache key isolation, inert tools, Settings control, and mock-transport tests ship (#724) | Packaged proof against real tools-enabled/disabled profiles remains owner/environment residual        |
| Ranked multi-source context planner                            | **Partial** | Deterministic eligibility and simple ranking ship                                                                | Richer planning must not weaken host policy                                                        |

Issue status is descriptive, not proof by itself. The production paths and
named tests in those files are the proof anchors.

## 3. Reusable method

The method has six gates:

1. **Classify the turn.** Determine whether it is ordinary, linked to a
   particular evidence corpus, or explicitly scoped to another source.
2. **Compute eligibility in trusted code.** Intersect source attachment,
   allowlists, read/write classification, first-use approval, profile
   capability, and turn scope.
3. **Retrieve in constrained stages.** For a conservatively recognized broad
   linked-log prompt, build one deterministic host-owned brief before the first
   model request. For focused prompts, use one reliable bounded grounding
   operation first.
4. **Canonicalize evidence.** Return stable identities, provenance, quality,
   bounds, and failures as typed host data.
5. **Synthesize from a closed package.** When all requested retrieval is
   complete, remove tools for the synthesis round and give the model only the
   bounded evidence needed for the answer.
6. **Validate before display.** Reject or visibly downgrade answers that lack
   required evidence identity, misuse boundary metadata, or claim unavailable
   sources.

```mermaid
flowchart TB
%% title: Governed context assembly and visible failure paths
    U["User question"]
    UI["Client turn<br/>explicit binding + bounded view hint"]
    H["Trusted host<br/>classify scope + capabilities"]
    X["Required capability unavailable"]
    XU["Visible unavailable-tools state"]
    Q{"Broad linked-log<br/>request?"}
    B["Trusted host builds deterministic brief<br/>one corpus + one suppression revision"]
    O{"One targeted<br/>deepening search?"}
    OG["Model requests bounded<br/>search_logs deepening"]
    OT["Trusted host validates + executes<br/>the bounded deepening"]
    OR["Deterministic search<br/>bounded + policy checked"]
    OE["Additional typed evidence<br/>identity + provenance + status"]
    G["Model grounding round<br/>constrained native Read tool"]
    T["Trusted host validates + executes<br/>the native tool request"]
    R["Deterministic retriever<br/>bounded + policy checked"]
    E["Typed evidence<br/>identity + provenance + status"]
    S["Trusted host builds<br/>tool-closed synthesis package"]
    Y["Model synthesis round"]
    D["Draft answer<br/>with evidence references"]
    V["Host validates grounding<br/>and evidence identity"]
    A["Answer<br/>citations + trail + limitations"]
    F["Visible retrieval or grounding failure"]

    U --> UI --> H
    H -->|required capability unavailable| X --> XU
    H -->|eligible read surface| Q
    Q -->|yes| B --> E --> O
    O -->|answer from complete brief| S
    O -->|deepen one candidate| OG --> OT --> OR --> OE --> S
    Q -->|no| G --> T --> R
    R --> E --> S --> Y --> D --> V --> A
    B -->|assembly failure: visible status + staged fallback| G
    T --> F
    R --> F
    V --> F
```

### Why host-first and staged retrieval help smaller models

A broad menu of logs, files, memory, SQL, connectors, and Help tools requires
the model to solve routing and syntax before it can inspect evidence. A staged
turn constrains the first choice to the source that defines success. A
conservatively classified prompt such as a general request to triage or identify
problems in the linked logs takes a stronger path: the trusted host computes the
first evidence brief before model participation, so success does not depend on
the model inventing a search/cluster/timeline sequence.

That brief pins the event revision, template-analysis revision, and
suppression-policy revision for one corpus. It contains bounded level, source,
service, and host distributions; structured ERROR and WARN templates with
capacity reserved for rare candidates; problem clusters; timeline
concentration; and bounded correlations only when time quality is reliably
wall-clock-safe. High-cardinality template analysis streams ranking metadata
and materializes at most 512 selected template payloads. It does not invoke a
semantic/embedding backend or a network backend. The model-facing untrusted
text is capped at 32 KiB, while at most 128 structured event identities travel
separately through the trusted identity channel. Long source names use a stable
compact citation alias whose mapping to the exact trusted source remains
host-owned.

The broad brief is a starting evidence package, not an exhaustive diagnosis.
When the request explicitly needs another eligible read source, the host may
stage that governed source after the brief. Focused follow-ups use the ordinary
bounded log tools. Tools are offered only when they are needed and eligible;
the brief does not widen permissions or bypass first-use approval.

This is not merely prompting. The host changes the offered tool set and checks
the actual native tool result. Printed JSON, prose such as “I will search,” and
tool-shaped Markdown are not evidence.

### Model names are routing hints, not capability standards

A provider inventory normally supplies deployment ids, not portable role or
capability metadata. A versioned name catalog can improve picker ordering and
explain why an id resembles an investigator, embedding model, or reranker, but
that classification is only a `name_hint` with explicit confidence. Private and
unknown ids remain selectable and unqualified. A familiar string never proves
native tools, context length, output quality, embeddings, or reranking.

Keep four evidence bases distinct in both data and presentation:
`name_hint`, `provider_metadata`, `measured_locally`, and `user_override`.
Presentation derives its basis label from that typed source rather than trusting
preformatted copy. Name hints never silently replace an existing user choice.
Model-picker curation is separate, reversible display state: it is scoped by
provider profile, normalized endpoint, and model identity; it remains bounded
even when many choices are pinned or hidden; and it never claims capability or
health. Renaming a profile preserves that scope, while repointing its endpoint
creates a distinct inventory. The role-hint slice remains **Partial** because
names are not a cross-gateway capability standard. Exact user-triggered
capability qualification (#724) ships as a **Partial** path: synthetic probes,
inert host-validated tools, local cache isolation, and Settings **Qualify
selected model…** are wired; packaged proof with real tools-enabled and
tools-disabled profiles remains an owner/environment residual.

## 4. Inputs, outputs, and portable contracts

The following are conceptual contracts for reimplementation, not invented
ContextDesk APIs.

### Turn scope

| Field                  | Meaning                                          | Rule                                         |
| ---------------------- | ------------------------------------------------ | -------------------------------------------- |
| `turn_id`              | Stable identity for cancellation/audit           | Unique within host                           |
| `conversation_id`      | Durable transcript identity                      | Does not imply source access                 |
| `binding`              | Ordinary or an explicit source/corpus identity   | Absent means no ambient corpus inheritance   |
| `user_request`         | User text                                        | Data, never a permission grant               |
| `view_hint`            | Current filters, lanes, selection, visible range | Bounded, untrusted hint                      |
| `profile_capabilities` | Native tools, context size, provider behavior    | Host-observed/configured, not model-asserted |
| `deadline` / `cancel`  | Turn lifecycle controls                          | Bounded and effective in every phase         |

### Source policy

| Field                  | Meaning                                                      |
| ---------------------- | ------------------------------------------------------------ |
| stable source identity | Corpus, workspace, memory scope, DB connection, or connector |
| availability           | Attached/configured/healthy state                            |
| side-effect class      | Read, SoftWrite, or HardWrite assigned by host               |
| permission state       | Pre-authorized, first-use approval required, or unavailable  |
| result cap             | Maximum records/chunks returned                              |
| data policy            | Redaction, egress, path/network allowlist, retention         |

### Evidence item

| Field          | Meaning                                         | Must not be inferred from |
| -------------- | ----------------------------------------------- | ------------------------- |
| `source_id`    | Stable source identity                          | Display label alone       |
| `record_id`    | Reopenable identity such as corpus+seq+source   | Message text              |
| `content`      | Bounded redacted observation                    | Model summary             |
| `provenance`   | Retriever/tool and source                       | User or model assertion   |
| `quality`      | Exact, inferred, mixed, order-only, stale, etc. | More reliable peer source |
| `truncation`   | Complete-within-contract or bounded excerpt     | UI appearance             |
| `retrieved_at` | Operational observation time                    | Source event time         |

### Synthesis package

A synthesis package contains:

- current user request;
- minimal governing policy;
- selected bounded evidence blocks;
- source identity and quality;
- explicit unavailable/failed source states;
- output requirements such as observation-versus-inference labels; and
- no tool schemas when the intended step is synthesis-only.

It excludes:

- raw whole corpora;
- evaluator answer keys or known expected conclusions;
- credentials and private connection details;
- unrelated chat attachments or ambient log corpora;
- first-use or write capabilities not approved for the turn; and
- model-generated “tool results.”

### Deterministic broad-log brief

For a conservatively classified broad linked-log prompt, the host assembles a
brief before the first provider request. Its portable contract is:

| Field / section | Contract |
| --------------- | -------- |
| corpus binding | Exactly the host-resolved linked corpus |
| revision lens | Event, template-analysis, and suppression revisions pinned before assembly and revalidated before provider use or synthesis retry |
| distributions | Bounded level, source, service, and host counts |
| severe templates | Structured ERROR/FATAL and WARN candidates with reserved rare-candidate slices and first/last identities |
| clusters | Bounded deterministic problem clusters |
| timeline | Bounded concentration summary with explicit wall/mixed/order-only quality |
| correlations | Bounded and present only when wall-clock time is safe |
| high-cardinality bound | Stream ranking metadata; materialize at most 512 selected template payloads |
| model-facing text | Complete untrusted-data envelope, no more than 32 KiB UTF-8 |
| evidence identity | At most 128 trusted event identities carried separately from text |
| long source identity | Stable compact model-facing alias; exact alias-to-source validation remains host-owned |
| noise proposals | Suggestion-only; never activate or mutate durable suppression policy |
| external dependency | No semantic/embedding or network backend |

The text can describe an identity, but only the separate structured identity
collection is authoritative. A model cannot promote a sequence or source
string found in untrusted content into trusted evidence.

## 5. Invariants and trust boundaries

1. **Binding is explicit.** An ordinary conversation cannot inherit a
   foreground Log Explorer corpus merely because the window is open. A main
   chat receives log tools only after the user attaches one imported corpus to
   that durable session.
2. **Source eligibility is host-owned.** The model cannot enable a connector,
   widen a root, change a side-effect class, or self-grant permission.
3. **A linked log answer is provisional until a bounded log tool succeeds.**
4. **Evidence identity is structured.** Never scrape event identity back out of
   rendered prose when the retriever can return it directly.
5. **Untrusted retrieval stays untrusted.** Tool results are data and are
   boundary-wrapped; instructions inside them do not override policy.
6. **Skills provide process, not incident truth.** A skill can tell the model
   how to investigate; it is not evidence that a production event occurred.
7. **Evaluator truth is outside every attached root.** Test fixtures may know
   the expected diagnosis, but that answer key cannot enter the model context.
8. **Context limits are hard.** The transcript may remain complete on disk
   while only a compacted, bounded model-facing projection is sent.
9. **Failure stays visible.** Unavailable, partial, timed-out, cancelled, and
   ungrounded are distinct from success.
10. **Write authority is separate.** Read-only context assembly never implies
    permission to persist memory, change a view, or mutate a remote system.
11. **Broad triage is revision-consistent.** Every section of one broad-log
    brief uses the same corpus event, template-analysis, and suppression-policy
    revisions. They are revalidated before provider participation and before a
    synthesis-only retry.
12. **Cancellation stops deterministic work.** A cancelled or expired broad
    scan interrupts the database operation and joins its worker; it does not
    leave a detached corpus scan consuming resources.
13. **Transcript publication is revisioned.** A renderer autosave names the
    last host revision it observed. The host rejects an older whole-session
    snapshot, and only the newest still-relevant client mutation may reconcile
    exact message identities with the winning durable revision.
14. **Governed citation identity includes provenance.** Equal event/template
    ids from different corpora remain distinct. Activation carries the exact
    citation object; an ambiguous bare inline id fails closed rather than using
    the first matching corpus.

```mermaid
flowchart TB
%% title: Context assembly trust and authority boundaries
    U["UNTRUSTED<br/>User/model text"]
    D["UNTRUSTED<br/>Retrieved documents/log fields"]
    P["UNTRUSTED<br/>Remote provider"]
    S["TRUSTED HOST<br/>Scope + capability policy"]
    T["TRUSTED HOST<br/>Tool execution + bounds"]
    V["TRUSTED HOST<br/>Evidence identity validation"]
    W["TRUSTED HOST<br/>Explicit write approval authority"]
    C["PRESENTATION<br/>Client UI"]

    U --> S
    S --> T
    D --> T
    T --> P
    P --> V
    V --> C
    C --> W
    W -.-> T
```

## 6. Algorithm detail

### 6.1 Classify

```text
if explicit linked source exists:
    mode = linked(source_id)
else:
    mode = ordinary
```

Do not infer linkage from window focus alone. Focus may contribute a bounded
viewport hint only after the explicit conversation binding is established.

### 6.2 Build the eligible read surface

For every registered tool:

1. verify it is attached and healthy;
2. apply the host-owned side-effect class;
3. require any connector first-use approval;
4. intersect with the turn binding;
5. intersect with provider native-tool capability; and
6. omit unavailable tools rather than teaching the model to fake them.

For a linked read turn, write tools remain unavailable even if the same session
could request writes in another workflow.

### 6.3 Retrieve

- Broad linked log: before the first model request, assemble the host-owned
  deterministic brief when the conservative classifier matches. On successful
  completion, retain a host-only retry checkpoint before provider inference.
  The first provider round may answer directly from the brief or use one
  offered bounded `search_logs` call to deepen a candidate; any following
  synthesis round is tool-closed. Another explicitly requested, eligible source
  is still retrieved through its governed staged path.
- Focused linked log: offer bounded `search_logs` first.
- Explicit runbook/workspace request: after log grounding, offer bounded
  workspace search.
- Memory: use tightly capped ambient recall or explicit recall, with citations.
- Files/session packs: search indexed chunks; read slices only after identity
  resolution.
- Databases/connectors: use read-only roles, query limits, timeouts, and
  source-specific citation locators.
- Skills: inject selected procedural guidance under its own identity; do not
  relabel it as observed evidence.

### 6.4 Normalize and wrap

The host records success separately from the model-facing string. For logs,
ContextDesk carries structured `SearchEvidenceIdentity` values alongside the
redacted result detail. A portable implementation should do the same for every
high-value source.

The broad-log brief follows the same rule. Its bounded text is an untrusted
data block; its separately carried event identities are the only trusted
identity channel. The host never reconstructs trust by parsing model-facing
text.

Retrieved text should be enclosed in an unambiguous untrusted-data envelope.
The envelope marker itself must never be interpreted as observed content or
cited as a finding.

### 6.5 Synthesize and validate

Once required retrieval succeeds:

1. distill the current request and successful evidence;
2. include explicit retrieval failures;
3. remove tool schemas if no further tool decision is required;
4. request citations using structured identities;
5. reject a linked answer with no valid evidence identity; and
6. render observations, inferences, and limitations distinctly.

## 7. Performance and bounds

ContextDesk defaults illustrate the method; they are product settings, not
universal recommendations:

| Dimension                   |                        Current default/cap | Anchor                                                                        | Overflow behavior                                          |
| --------------------------- | -----------------------------------------: | ----------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Sources considered per turn |               3 default, sanitized to 1–16 | [`router.rs`](../../../crates/cd-core/src/router.rs)                          | Rank and take bounded set                                  |
| Tool rounds                 |              12 default, sanitized to 1–32 | [`router.rs`](../../../crates/cd-core/src/router.rs)                          | Terminal bounded completion/error                          |
| Results per source          |               8 default, sanitized to 1–50 | [`router.rs`](../../../crates/cd-core/src/router.rs)                          | Retriever result cap                                       |
| Whole-turn deadline         | Adaptive: 300,000 ms local/private, 120,000 ms managed; explicit 500–600,000 ms | [`router.rs`](../../../crates/cd-core/src/router.rs) | Phase timeout or visible whole-turn timeout |
| Phase deadlines             | Choosing, retrieval, and synthesis are each capped inside the one monotonic turn ceiling | [`agent.rs`](../../../crates/cd-core/src/agent.rs) `TurnClock` | A phase cap never resets or extends the whole turn |
| Provider readiness          | Same absolute turn deadline starts before health/readiness/backend construction | [`research.rs`](../../../crates/cd-core/src/research.rs) | Stop and explicit short deadlines remain authoritative during cold local/private startup |
| Linked corpus preflight     | Same absolute deadline and cancel signal govern corpus validation/open in a bounded blocking task | [`lib.rs`](../../../desktop/src-tauri/src/lib.rs) | Setup cannot outlive Stop or consume time outside the turn ceiling |
| Model-facing context        |                 120,000 characters default | [`sessions.rs`](../../../crates/cd-core/src/sessions.rs)                      | Pair-safe compaction then deterministic truncation or fail |
| Current-turn evidence payload |                                 256 KiB | [`agent.rs`](../../../crates/cd-core/src/agent.rs)                            | UTF-8-safe truncation; successful governed results only    |
| Current-turn log identities |                                     512 | [`agent.rs`](../../../crates/cd-core/src/agent.rs)                            | Independent deduplicated identity cap                      |
| Broad-log brief text        |                                  32 KiB | [`tool_host.rs`](../../../crates/cd-core/src/tool_host.rs)                    | UTF-8-safe deterministic truncation inside the data envelope |
| Broad-log brief identities  |                                     128 | [`tool_host.rs`](../../../crates/cd-core/src/tool_host.rs)                    | Separate trusted identity cap; never reconstructed from text |
| Retry checkpoint store      | 30-minute TTL; 16 entries; 2 MiB retained payload bytes total | [`lib.rs`](../../../desktop/src-tauri/src/lib.rs) | Deterministic oldest-first eviction; this is a payload-byte bound, not an allocator/heap-size claim |
| View selection identities   |                                         64 | [`view_context.rs`](../../../crates/cd-core/src/log_analysis/view_context.rs) | Sort, deduplicate, truncate                                |
| View bookmark summaries     |                                         24 | [`view_context.rs`](../../../crates/cd-core/src/log_analysis/view_context.rs) | Truncate                                                   |
| Session context files       |                                200 default | [`session_context.rs`](../../../crates/cd-core/src/session_context.rs)        | Reject over cap                                            |
| Session context bytes       |          50 MiB total; 10 MiB/file default | [`session_context.rs`](../../../crates/cd-core/src/session_context.rs)        | Reject before publication                                  |
| Ambient memory              |      about 1,500 chars and at most 5 items | [`ambient.rs`](../../../crates/cd-core/src/memory/ambient.rs)                 | Score/echo filter and stop                                 |

Character limits are approximate model-token controls. An implementation with
provider tokenizers should still keep deterministic byte/character safety caps
at trust boundaries.

Adaptive provider classification is a pure configuration decision. An explicit
profile preference is authoritative; otherwise local-only/Ollama profiles,
loopback or private IPs, and private host suffixes such as `.internal`, `.local`,
`.lan`, `.corp`, `.intranet`, and `.private` receive the patient plan. The
classifier performs no DNS lookup or endpoint probe. A user-selected custom
whole-turn ceiling overrides either adaptive class. Existing serialized router
budgets migrate as custom so an upgrade cannot silently lengthen a prior
setting; new installs default to adaptive.

## 8. Failure and recovery

| Failure                                 | Detection                                     | Presentation                                                          | Recovery                                          | Guarantee                                |
| --------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------- |
| Profile reports native tools disabled   | Capability check before provider call         | “Tools unavailable” with selected profile context                     | Select/configure a tools-enabled profile          | No fake grounding                        |
| Model narrates a tool call              | No native call/result event                   | Withhold provisional prose; bounded retry/nudge                       | Retry native tool decision or fail visibly        | Narration never becomes evidence         |
| Required log search returns no evidence | Structured result count/identity empty        | Honest no-evidence state                                              | Refine query/filter                               | No invented event                        |
| Requested source unavailable            | Eligibility computation                       | Name unavailable source class without secrets                         | Configure/authorize source                        | Remaining answer discloses gap           |
| Context cannot fit                      | Deterministic budget helper                   | `context_too_long`                                                    | New chat/remove history/increase supported budget | Stored transcript not silently rewritten |
| Timeout before retrieval                | Deadline                                      | Visible timeout                                                       | Retry                                             | No success claim                         |
| Timeout/provider failure after complete retrieval | Synthesis phase or remaining whole-turn deadline; typed provider terminal | Visible failure; successful bounded evidence remains in the transcript and in a host-only checkpoint | Retry synthesis without running retrieval again | Checkpoint is bound to exact chat, corpus, provider profile, and model |
| Provider failure during partial retrieval | Typed linked-retrieval terminal | Original user turn and successful tool events remain visible; no retry checkpoint | Retry the complete investigation | Missing explicitly requested sources cannot become silent success |
| Cancellation                            | Per-turn cancel race around every provider/tool await | Cancelled terminal state                                           | Start another turn or retry preserved synthesis   | Cancellation is immediate and session-specific |
| Malicious retrieved instructions        | Untrusted wrapper and system policy           | Usually not surfaced as instructions                                  | Continue with data-only interpretation            | No permission elevation                  |
| Citation mismatch                       | Host validation against structured identities | Reject/downgrade answer                                               | Correct synthesis retry                           | Rendered text cannot forge identity      |
| Broad-brief assembly fails               | Typed host error before the first provider request | Visible failed deterministic-triage tool event; staged bounded tools remain available | Retry through the existing staged retrieval path | Failure does not become fabricated evidence |

Retry evidence comes only from a dedicated, bounded current-turn buffer
populated by successful governed tool results for the resolved corpus. Every
linked model-facing round strips historical `tool` messages and historical
assistant tool-call protocol, including broader connector, database, memory,
workspace, and web turns. A checkpoint is published only after all explicitly
requested source classes succeeded and subsequent synthesis failed or was
rejected. Historical, stale, cross-corpus, and partial-source evidence is never
swept into synthesis.
Single-owner session admission prevents another window from replacing the
active turn's cancellation or checkpoint ownership. The host keeps checkpoints
memory-only, applies TTL, entry-count, and total-byte caps with deterministic
oldest-first eviction, clears them on chat lifecycle/context changes, and is
the sole authority that may expose retry availability to the renderer.

## 9. Observability

A useful trail records:

- selected turn mode and bound source identity;
- offered tool names after policy filtering;
- budget values actually enforced;
- each tool start/finish, source, result count, and success;
- broad-brief byte count, trusted-identity count, truncation state, time quality,
  and pinned suppression revision;
- unavailable source classes;
- grounding, cross-source, and synthesis phases;
- compaction/truncation notices;
- cancellation/timeout phase; and
- final evidence identity validation.

It must not log credentials, raw provider headers, absolute private paths,
private model inventory in publishable media, or evaluator truth.

## 10. Security and privacy

- Credentials remain in the trusted host or OS keychain, never the webview or
  model context.
- File roots, database connections, network bases, and connector processes are
  allowlisted and policy checked.
- Retrieved documents and tool results are prompt-injection-capable untrusted
  data.
- Cloud-model and cloud-embedding egress must be explicit; local does not mean
  inherently safe if a connector sends data remotely.
- Memory is redacted before persistence and embedding; logs are redacted before
  event persistence and model access.
- Read, SoftWrite, and HardWrite classification remains host-owned. User text
  such as “approve” is not a permission token.
- Durable source linkage must survive conversation reopen without causing
  unrelated conversations to inherit the link.

## 11. UX and human factors

The user should see:

- which corpus/source a chat is linked to;
- which model/profile is active without exposing unnecessary inventory;
- whether tools are available;
- current phase—choosing evidence, retrieving, or synthesizing;
- a Stop action that targets only the active turn;
- expandable evidence/trail detail;
- citations or navigation proposals separate from prose;
- explicit partial/unavailable/timeout states; and
- an opt-in action before a proposed navigation changes the investigation view.

Small models benefit from the same UX as users: fewer simultaneous choices,
shorter grounding instructions, typed result contracts, and an explicit final
synthesis step.

## 12. Test recipe

| Layer            | Required proof                                                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Contract/unit    | Source ranking and caps; context fitting; capability matrix; binding serialization; untrusted wrapper cannot forge delimiters                                                                    |
| Core integration | Linked turn requires successful log evidence; a broad prompt receives its deterministic brief before the first provider call; one corpus with event/template/suppression revisions is pinned; ordinary turn excludes log tools; requested workspace search is staged; tools-disabled linked turn fails before provider; structured identity required |
| Adversarial      | Model prints call-shaped JSON; wrapper metadata appears in output; user asks to reveal evaluator truth; malicious tool text asks for permissions                                                 |
| Host/session     | Empty-chat link persists; stale/corrupt corpus fails before capability/provider handling; attach failure leaves durable state unchanged; ordinary session has no log scope; cancellation targets exact session; stale whole-session save cannot erase a newer durable turn |
| Component UI     | Add context attaches/detaches one corpus; availability/event count/Open Explorer remain visible; Return/Shift+Return/IME; errors remain visible; autoscroll/unread semantics; hydration/save/archive races retain the current owner; equal citation ids route by exact corpus provenance |
| Packaged/native  | On an exact 250,000+ event build, a tools-enabled provider receives the host brief before synthesis for a general zero-prep question from main chat and Explorer; visible status is truthful; cited identities reopen; tools-disabled profile is honest; ordinary chat has no corpus; linked chat keeps corpus after switch/reopen |
| Slow provider    | Deterministic cold/slow provider defaults; retrieval success then synthesis timeout; cancellation in choosing/retrieving/synthesizing; synthesis-only recovery; explicit deadline precedence |

Evaluator fixtures must store expected findings outside every imported corpus,
workspace root, memory store, session pack, and skill directory. The test should
assert the sentinel is absent from model-facing messages.

## 13. ContextDesk anchors

- [`agent.rs`](../../../crates/cd-core/src/agent.rs): linked context, staged
  grounding, ordinary-chat isolation, evidence validation.
- [`tool_host.rs`](../../../crates/cd-core/src/tool_host.rs): tool policy,
  bounded execution, structured log identities.
- [`sessions.rs`](../../../crates/cd-core/src/sessions.rs): durable linked corpus
  metadata and hard model-context budget.
- [`SessionContextBar.tsx`](../../../desktop/src/components/SessionContextBar.tsx):
  explicit single-corpus selection, availability, detach, and Explorer entry.
- [`desktop/src-tauri/src/lib.rs`](../../../desktop/src-tauri/src/lib.rs):
  atomic validated attachment, revision-checked session persistence,
  host-owned citation provenance, and provider-free corpus preflight.
- [`useChatSessions.ts`](../../../desktop/src/hooks/useChatSessions.ts): ordered
  hydration/synchronization and newest-mutation session reconciliation.
- [`turn.ts`](../../../desktop/src/lib/turn.ts) and
  [`SourceCitations.tsx`](../../../desktop/src/components/SourceCitations.tsx):
  provenance-aware citation folding, presentation, and exact activation.
- [`router.rs`](../../../crates/cd-core/src/router.rs): turn budgets and source
  ranking.
- [`injection.rs`](../../../crates/cd-core/src/injection.rs): untrusted result
  wrapping.
- [`index.rs`](../../../crates/cd-core/src/index.rs): bounded workspace
  indexing/search.
- [`session_context.rs`](../../../crates/cd-core/src/session_context.rs):
  chat-specific files.
- [`memory/ambient.rs`](../../../crates/cd-core/src/memory/ambient.rs): bounded
  durable-memory injection.
- [`research.rs`](../../../crates/cd-core/src/research.rs): profile capability
  honesty.
- Canonical design: [Log Explorer chat contract](../LOG_EXPLORER.md),
  [Memory](../MEMORY.md), [Architecture](../../ARCHITECTURE.md), and
  [threat model](../../THREAT_MODEL.md).

## 14. Shipped / partial / planned matrix

| Slice                       | Status      | What is true now                                                           | What is not claimed                                                       |
| --------------------------- | ----------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Ordinary chat isolation     | **Shipped** | No ambient log-tool inheritance                                            | No claim that every future source is automatically isolated without tests |
| Main-chat log attachment    | **Shipped** | One host-validated durable corpus, bounded linked-log tools, and reversible detach | Multi-corpus context remains #693; no hidden all-corpus fallback |
| Linked log grounding        | **Shipped** | Required bounded log result and evidence identity                          | No success under tools-disabled profile                                   |
| Broad linked-log triage     | **Shipped (agent-testable)** | Conservative broad prompts receive a deterministic 32 KiB/128-identity host brief before model participation | Exact generated 250,000+ tools-enabled provider proof remains #745; no universal model-quality claim |
| Cross-source read           | **Partial** | Requested governed reads can be offered after log grounding                | No unrestricted autonomous source crawl                                   |
| Small-model staging         | **Shipped** | Constrained first log search and tool-closed synthesis path                | No guarantee every small model follows native tools                       |
| Slow provider lifecycle     | **Shipped (agent-testable)** | Adaptive or explicit whole-turn ceiling, bounded truthful phases, immediate Stop, evidence-preserving synthesis retry | Native cold/slow tools-enabled profile acceptance remains #649 |
| Model-picker curation       | **Shipped** | Pin/hide/restore state is profile/endpoint/model scoped, persistent, reversible, searchable, and hard-bounded across rendered bands | Not deletion, authorization, redaction, health, or capability qualification |
| Durable transcript concurrency | **Shipped** | Host compare-and-swap rejects stale whole-session publication; newest client mutation alone may reconcile exact message ids | Not a multi-device collaborative-edit protocol |
| Cross-corpus citation identity | **Shipped** | Governed chips retain `(source id, corpus provenance)` and activate the exact citation | Ambiguous bare inline ids fail closed rather than guessing |
| Model-role guidance         | **Partial** | Versioned name hints are shown with typed basis and confidence; specialty and unknown ids stay selectable | No cross-gateway capability claim |
| Measured qualification      | **Partial** | Explicit synthetic probes record pass/degraded/fail/untested per profile/endpoint/model/schema (#724) | No quality or permanent reliability claim; real packaged profile proof residual |
| Model proposals changing UI | **Partial** | Structured `log_nav` is opt-in                                             | Rich finding proposal/approval lifecycle remains #646                     |
| Evaluator-truth exclusion   | **Shipped** | Known-truth fixture discipline keeps the answer key outside attached roots | Not a formal noninterference proof                                        |

## 15. Reimplementation notes

The minimum trustworthy subset is:

1. explicit turn/source binding;
2. host-owned eligible Read tool list;
3. one bounded deterministic retriever;
4. structured evidence identity;
5. hard context and result caps;
6. untrusted-data separation; and
7. refusal to display an evidence-backed answer before grounding succeeds.

The model vendor, vector store, SQL engine, desktop framework, and exact
streaming protocol are replaceable. Explicit binding, host authority,
structured identity, bounded retrieval, failure honesty, and write separation
are not.

Avoid these shortcuts:

- putting all sources in one prompt;
- asking the model which permissions it has;
- accepting model-emitted JSON as proof a tool ran;
- hiding timeout/partial retrieval behind a fluent answer;
- using an open Explorer window as implicit chat linkage;
- sending evaluator notes beside the test corpus; and
- letting retrieval summaries replace reopenable evidence identity.

## 16. Open residuals

- #745: exact generated 250,000+ event acceptance with a real tools-enabled
  provider, including visible host-brief status, grounded identity resolution,
  bounded completion, and honest failure. The deterministic builder and agent
  sequencing are agent-testable; model quality remains provider/model
  dependent.
- #649: native acceptance with a real cold/slow tools-enabled provider profile;
  the deterministic core/component lifecycle and synthesis-only retry ship.
- #646/#532: ranked proposals, review history, walkthroughs, and report
  assembly.
- #724 residual: packaged proof with real tools-enabled and tools-disabled
  provider profiles (owner environment; synthetic path ships in
  `crates/cd-core/src/capability_qualification.rs` and desktop host IPC).
- Provider acceptance: a real tools-enabled company profile must be selected
  and exercised; credentials and capability changes cannot be fabricated by an
  agent.
- Source-specific provenance contracts for every connector deserve their own
  chapters.
- Character budgets should eventually be complemented by reliable
  provider-specific token accounting without removing deterministic hard caps.
