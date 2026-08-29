# Exact-head demo acceptance

Scripts, docs, and synthetic fixtures for a **production-grade** ContextDesk
demo rehearsal. Product behavior is not changed here — only acceptance
hygiene (stale-binary rejection, consolidator flow, operator checklist).

| Artifact | Role |
|----------|------|
| `scripts/lib/exact_head_identity.py` | Pure SHA/stamp gate (unit-tested) |
| `scripts/lib/exact_head_binary.sh` | Build-or-prove `contextdesk` binary |
| `scripts/exact_head_cli_acceptance.sh` | Offline exact-head CLI consolidator |
| `scripts/tests/exact_head_identity_test.py` | Adversarial identity tests |
| This file | GUI checklist + persistence truth |

Base commit for this branch tip should be documented in the SHIP/BLOCK
handoff (`git rev-parse HEAD` / isolation note).

---

## Persistence truth (read first)

| State | Survives quit / relaunch? |
|-------|---------------------------|
| Imported **corpus** | **Yes** (durable under the data directory / cache) |
| Chat **sessions** | **Yes** (durable session store) |
| **Investigation** writes (after confirm) | **Yes** (durable investigation store) |
| **Activity** Inspector timeline | **No** — process-lifetime / in-memory capture for the turn; not a durable transcript |
| **Developer detail** | **No** — process-lifetime host trace for the turn; not restored on relaunch |

Operators must not claim “Activity is still there after quit” — that is false.
Corpus, sessions, and confirmed investigations **are** durable.

---

## 15-minute native GUI checklist

Synthetic / public fixtures only. No private or company corpora.

### 1. Import + timezone review (~2 min)
- [ ] Import a **synthetic** multi-source folder or ZIP with at least one
  **local (zone-less) timestamp**.
- [ ] When the trusted timezone host is installed and configured, complete
  timezone review; use **apply-all** (or Settings default TZ) so every
  ambiguous source resolves honestly — no silent guessing.
- [ ] Without that host, verify the UI reports timezone review/normalized
  chronology as unavailable and leaves zone-less timestamps unresolved. Do not
  mark the default provider-free demo as proof of successful normalization.

### 2. Explicit one-turn Context (~1 min)
- [ ] In chat, attach or select an explicit one-turn **Context** (selection /
  paste) for a focused question — not ambient desktop noise alone.

### 3. Automatic context-brain visibility (~1 min)
- [ ] Confirm the UI surfaces what context the turn will use (context pack /
  brain / attachment chips) **before or as** the turn starts — host-visible,
  not model-narrated only.

### 4. Developer detail (~1 min)
- [ ] Enable **Developer detail** for one turn; observe host tool/trace rows.
- [ ] Remember: this is **process-lifetime** — it will not reload after quit.

### 5. Grounded citations (~2 min)
- [ ] Ask a question that requires log retrieval; confirm the answer cites
  **host** identities (log event / source), not free-form model paths.

### 6. Evidence → 1–4 Explorer lanes (~2 min) — **MANUAL (native GUI only)**
> **Honest scope:** this step is **not** claimed by the offline CLI consolidator.
> It requires a packaged/native desktop session. Do not mark CLI `REHEARSAL_PASS`
> as proof of Evidence → Explorer lanes.

- [ ] **[MANUAL GUI]** Open **Evidence**; Select all log (eligible only).
- [ ] **[MANUAL GUI]** **Show in Explorer** → assign **1–4 lanes**; host source
  identities persist on the lanes (no reimport of the corpus).

### 7. Confirm-gated investigation write (~2 min) — **MANUAL (native GUI only)**
> Same honesty rule: confirm-gated investigation write is desktop UI; CLI
> consolidator does not fake this path.

- [ ] **[MANUAL GUI]** **Add to investigation** from Evidence (or equivalent).
- [ ] **[MANUAL GUI]** Confirm the write in the modal; discard must leave durable
  state clean.
- [ ] Never treat a draft preview as a completed write.

### 8. Stop / terminal state (~1 min)
- [ ] Start a longer turn; press **Stop** (or wait for natural terminal).
- [ ] UI shows a clear terminal reason (done / cancelled / failed) — not a
  frozen “still streaming” shell.

### 9. Continue the conversation (~1 min)
- [ ] Send a follow-up in the **same** session; prior durable messages remain.

### 10. Quit / relaunch continuity (~2 min)
- [ ] Quit the app fully; relaunch.
- [ ] Corpus list still shows the import; session still lists prior turns.
- [ ] Confirmed investigation still present.
- [ ] Activity / Developer detail from the previous process are **gone**
  (expected — see persistence truth).

---

## Exact-head CLI consolidator vs full gate

| Verdict | Meaning |
|---------|---------|
| `REHEARSAL_PASS` | Consolidator (`exact_head_cli_acceptance.sh`) alone succeeded |
| `FULL_GATE_PASS` | Top-level gate: unit tests + cargo labs + consolidator all ok |

```bash
# Full fail-closed gate (stops on first failure) — preferred CI/accept entry
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$PWD/target}"
export EXACT_HEAD_OUT=/path/to/scratch/cli-accept
export EXACT_HEAD_KEEP=1
./scripts/exact_head_full_gate.sh
# → FULL_GATE_PASS  (never upgrades REHEARSAL_PASS alone)

# Consolidator only (narrower)
./scripts/exact_head_cli_acceptance.sh
# → REHEARSAL_PASS
```

The script:

1. Rejects unstamped / mismatched pre-existing binaries (stamp + **embedded**
   `capabilities.git_sha` from `cd_core::build_identity`).
2. Builds or proves `contextdesk` for `git rev-parse HEAD` (base lineage:
   `12528f05…` — **do not merge** divergent demo-integration branches).
3. Runs synthetic ZIP/folder import, timezone apply-all (unresolved→0; UTC ms
   lab in `crates/cd-cli/tests/exact_head_timezone_utc_lab.rs`), explore/context,
   `--context-selection`, `--activity` / `--trace`, two chat turns with tools,
   session reopen, **honest SIGINT cancel**, recovery, and a required-scenario
   gate that fails if any step artifact is missing — offline mock only.

Adversarial unit tests (no cargo):

```bash
python3 scripts/tests/exact_head_identity_test.py
```

Preserve / re-run existing CLI labs (activity parity, context, session, cancel):

```bash
cargo test -p cd-cli --test cli_activity_parity -- --nocapture
cargo test -p cd-cli --test cli_public_acceptance_lab -- --nocapture
cargo test -p cd-cli --test chat_cancellation -- --nocapture
cargo test -p cd-cli --test exact_head_timezone_utc_lab -- --nocapture
cargo test -p cd-cli --test import_outcome_cli -- --nocapture
```

---

## Related docs

- [`docs/DEMO_RUNBOOK.md`](DEMO_RUNBOOK.md) — concise 10–15 min GUI + CLI
  rehearsal (public fixtures; honest LQA residual on tips without the command).
- [`docs/CLI.md`](CLI.md) — command grammar including `timezone apply-all`,
  `chat --activity`, `--trace`, `--context-selection`, and the typed
  import outcome contract (complete / partial / rejected with located,
  coded defects).
- `scripts/cli-live-provider-rehearsal.sh` — ZIP import + dry-run / live turns.
- `scripts/cli-activity-parity-demo.sh` — offline activity/trace mock demo.
