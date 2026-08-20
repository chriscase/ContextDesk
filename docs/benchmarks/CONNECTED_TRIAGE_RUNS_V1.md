# Connected Triage Runs v1

The War-Room can launch a provider-neutral triage job against an immutable case
snapshot. Synthetic runs remain deterministic and offline. Configured gateway
runs use the host-owned `contextdesk collab-triage-run` bridge, which reuses the
existing Rust live comparison path and its provider/profile configuration.

## Boundary

`cd-collab.triage_job_request.v1` contains only references and configuration:

- snapshot id, with the server binding the authoritative snapshot fingerprint;
- task fingerprint, never task text;
- strategy and optional policy fingerprint;
- candidate role/provider/model configuration, with an independent host-owned
  profile reference for each gateway lane;
- execution mode (`deterministic_mock` or `gateway`);
- optional gateway lane concurrency from 1 through 4 (default 2), included in
  the request fingerprint and never allowed to exceed the host ceiling;
- a host-owned provider profile id for gateway mode, never a key or endpoint.

The server derives a request fingerprint from the exact snapshot and request
configuration. A job cannot run without a case-local frozen snapshot.

## Lifecycle

Jobs move through `queued` → `running` → one terminal state. Within a gateway
job, candidates remain `queued` until the bounded host admits them, then move
to `running` and finally settle independently. The final same-snapshot proof
still waits for the host's terminal envelope.

- `completed`: every candidate completed;
- `partial`: some candidates completed or the comparison was cancelled after work;
  durable benchmark rows are preserved, while lanes that never started are
  recorded without fabricated run ids, hashes, timestamps, or answers;
- `failed`: every candidate failed;
- `timed_out`: every candidate timed out;
- `cancelled`: cancellation happened before any candidate produced a result.

Candidate failures are retained rather than hidden. Cancellation is identified
by a stable cancellation id and is recorded in the case timeline and audit log.
Usage and cost are explicitly `unknown` until a provider adapter can prove them.

## Privacy

The authenticated owner job view can show candidate model labels and synthetic
summaries. The `GET .../share-safe` projection intentionally removes provider
and model labels, task text, evidence ids, and raw output. It retains only
fingerprints, roles, lifecycle, evidence counts, fairness, cancellation state,
and unknown usage/cost markers.

For gateway mode, Collab writes a bounded private request file and invokes the
configured host executable without a shell. The Rust command materializes the
case, frozen evidence, and task in the configured benchmark library, then
delegates to `bench-compare`; credentials remain in the host config/secret
store. The returned benchmark run ids, output hashes, evidence references, and
packet/corpus fingerprints are attached to the Collab job for later Experiment
Lab import or comparison. A case lead can use **Review in Experiment Lab** to
project a completed or partial job into a share-safe strategy package. The
projection keeps connected lane identity, terminal status, observed latency
when both timestamps exist, evidence references, a bounded evidence-linked claim
summary when the replay contains one, and explicit unknowns; it does not copy
the raw provider answer or prompt into Collab or infer helpfulness, gold,
agreement, or correctness. Claim text is redacted at the bridge if it resembles
credential or endpoint material.

The same handoff can optionally include one previously imported external run.
For a pasted chat, the prompt (when supplied) becomes an attributed question
event, while the pasted output is parsed only as far as its text proves. Missing
turns, tools, evidence, timestamps, and workflow context stay unknown. An
external run with a conflicting snapshot binding is rejected; an unbound chat
is allowed but the Experiment Lab notes that snapshot fairness is unknown for
that candidate. Repeating the same job/chat selection is idempotent.

Gateway mode is a comparison, so it requires at least two candidate lanes. The
server and host bridge enforce the same minimum; synthetic mode may still run
one lane for fast deterministic checks. When a profile catalog is configured,
every gateway lane must choose a profile from that catalog; without one, the
lead may enter separate host-owned profile ids per lane. This permits a single
comparison to exercise, for example, Qwen and GPT-OSS through different host
credentials or gateways without putting either credential in the browser.

The host emits a bounded `cd-collab.triage_run_progress.v1` JSONL side channel
on stderr. `candidate_started` contains only job/case/snapshot identity and a
candidate id. `candidate_persisted` contains the same safe candidate projection
used by the final response. Collab validates both event types, serializes
durable updates, ignores late events after cancellation, and leaves the final
stdout JSON schema unchanged. Older hosts that emit no progress events remain
compatible because the final envelope is still authoritative.

Configure the bridge with `COLLAB_TRIAGE_RUNNER` and optionally
`COLLAB_TRIAGE_RUNNER_DATA_DIR`, `COLLAB_TRIAGE_LIBRARY`, and
`COLLAB_TRIAGE_RUNNER_TIMEOUT_MS`. If the runner is not configured, gateway
mode is rejected while synthetic mode continues to work.

Deployments may set `COLLAB_TRIAGE_PROFILE_CATALOG` to a bounded JSON array of
safe labels, for example:

```json
[{"id":"profile:employer","label":"Employer gateway","provider":"openai-compatible"}]
```

The War-Room exposes these labels through `GET /api/triage-profiles`; it never
returns endpoints or credentials. `GET /api/triage-capabilities` separately
reports whether the host runner is configured, the lane bounds, and the safe
profile count. The launcher uses that readiness signal to disable an
unavailable gateway instead of allowing a doomed launch. The catalog is
presented separately for each selected lane. Without a catalog, a case lead
may still enter a different host-owned profile id manually for each lane.

For a local War-Room rehearsal without Postgres or LDAP, run the in-memory demo
with the same explicit host boundary:

```text
COLLAB_DEMO_TRIAGE_RUNNER=/absolute/path/to/contextdesk npm run demo -w @cd-collab/server
```

The demo still uses synthetic case state and authentication; only gateway
execution is enabled. Pass `COLLAB_TRIAGE_RUNNER_DATA_DIR` so the host resolves
the intended provider profiles and secret-store references. Omit the demo
runner variable to keep the demo fully offline.

The server verifies the authorized snapshot's content hashes before handing
bytes to the host bridge. The host response is strict: it must prove the
expected schema/action/job/case/snapshot, return terminal candidate statuses,
and cite only evidence in the authorized snapshot. Snapshot proof is unknown
until that validation succeeds. Host output is bounded and its process group
is interrupted on cancellation, timeout, or overflow. Recovery on restart
turns in-flight work into an honest partial/failed result and records an audit
event; the current worker is process-local and should be deployed as a single
active worker until a distributed lease is added. Agreement is never converted
into correctness.
