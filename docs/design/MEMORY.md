# Memory infrastructure — design

**Status:** design (2026-07-18) · **Scope:** cd-core memory subsystem · **Owner decisions:** see [§10](#10-decisions-that-need-the-owner).

This document specifies ContextDesk's durable, typed, temporal memory. The goal is a store the agent can use as a *second brain* — recalling facts, decisions (with supersession), bookmarks, preferences — with high‑quality hybrid recall, while never writing on the model's unconfirmed say‑so and never leaking secrets.

It was produced from a six‑facet parallel design pass plus an adversarial critic; the critic's contradiction reconciliations are recorded in [§8](#8-reconciled-contradictions) so nobody re‑litigates them.

---

## 1. Principles (non‑negotiable)

1. **Reuse, don't reinvent.** Ranking reuses `embed.rs` (`cosine_similarity` :74, `recency_boost` :95, `hybrid_score` :102, `EmbedBackend`, `HybridWeights`) verbatim. Backend portability mirrors `sql_ro.rs` (`SqlBackend` :33, `postgres_rustls_client_config` :156). Writes route through the existing `ToolHost::execute` permission gate (`tool_host.rs:690`) and the hash‑chained `audit.rs` log. No new vector stack, no new permission machinery.
2. **Nothing is destructively deleted.** Content is *append‑and‑supersede*. A correction is a **new row** that supersedes the old; the old row flips `status`, it is never `DELETE`d. "Forget" = `status='retracted'` (a reversible soft tombstone). Permanent purge is a separate, gated, UI‑only operation.
3. **Writes need human confirmation.** Every memory write is a classified tool through the existing tiers: save/update/supersede = **SoftWrite** (Accept/Discard); retract & purge & cross‑scope = **HardWrite** (type‑to‑confirm). The model proposes; the human commits.
4. **Secrets never enter memory.** A `redact` pass runs before any persist *and* before any embed. Default `cargo test` needs no network or keys.
5. **Embedded‑first.** SQLite by default (nothing to run). Postgres is an opt‑in power‑user backend behind the same trait — the *trait seam is built in v1; the Postgres backend is deferred*.
6. **Forward‑compatible with sync, but sync is not built here.** Records carry the fields a future server‑authoritative layer needs (stable UUIDv7, `rev`, `updated_at`, `origin_node`, retract‑tombstones). Personal‑scope memory is structurally barred from ever syncing.

---

## 2. Phase 0 — frozen contracts (write these before any DDL)

The critic's top finding: the six facets never shared a column dictionary, a timestamp unit, a kind taxonomy, or a pending‑write model. **These are now frozen. Do not deviate in implementation without editing this section first.**

### 2.1 Timestamp unit — `INTEGER` unix **seconds**, everywhere
Not RFC3339, not milliseconds. This makes `embed::recency_boost(mtime_secs, now)` and `embed::now_unix_secs()` reusable verbatim and temporal predicates cheap integer compares. **Lock this before the first write** — converting a populated store later is painful.

### 2.2 Identifiers — **UUIDv7**
K‑sortable, time‑ordered, offline‑stable, and the sync‑forward id. Add the `v7` feature to the `uuid` dep (currently `["v4","serde"]`).

### 2.3 `now` injection — a `Clock`
Production uses `embed::now_unix_secs()`; tests inject. Thread a `now_secs: i64` into store writes and recall so lazy expiry, valid‑time predicates, and recency are deterministic and offline‑testable. Keep it minimal (a param or a tiny `Clock` trait), but pick one and use it everywhere.

### 2.4 Kind taxonomy — closed enum with an open escape hatch
```
fact · decision · bookmark · preference · project_note · contact · term · task
```
plus `Other(String)` so an unrecognized kind round‑trips instead of erroring (imports, forward‑compat). `snippet` and `open_question` are Phase 2 additions. `kind` is the frozen column name (not `mtype`).

### 2.5 Canonical column dictionary
Frozen names (the critic found `content`/`body`, `rev`/`revision`/`version`, `kind`/`mtype` all diverging): `id, kind, title, content, structured, status, valid_from, valid_to, supersedes, superseded_by, scope, workspace_id, confidence, pinned, source, created_by, origin_session_id, origin_tool, created_at, updated_at, rev, origin_node, content_hash, url, due_at`.

### 2.6 The store trait
```rust
/// Read/write memory store. SqliteMemoryStore (default, embedded) in v1;
/// PgMemoryStore (opt-in) is additive later behind this same trait.
pub trait MemoryStore: Send + Sync {
    fn put(&self, op: MemoryWriteOp, now_secs: i64) -> CoreResult<MemoryRecord>;
    fn get(&self, id: &Uuid) -> CoreResult<Option<MemoryRecord>>;
    fn recall(&self, q: &RecallQuery, embed: Option<&dyn EmbedBackend>,
              w: HybridWeights, now_secs: i64) -> CoreResult<Vec<RecallHit>>;
    fn changes_since(&self, cursor: i64) -> CoreResult<Vec<MemoryRecord>>; // sync-reserved
}

/// Every mutation is one of these — one shape LocalWriter (SQLite) uses today
/// and a future RemoteWriter (server) will share. Insert/Update never mutate
/// content in place except metadata; a content change is Supersede.
pub enum MemoryWriteOp {
    Insert(MemoryDraft),
    UpdateMeta { id: Uuid, tags: Option<Vec<String>>, pinned: Option<bool>,
                 valid_to: Option<i64>, status: Option<Status> },
    Supersede { old: Uuid, new: MemoryDraft },
    Retract { id: Uuid },              // -> status='retracted' (reversible)
}
```

### 2.7 Tool names (frozen)
`recall_memory` (Read), `save_memory` (SoftWrite; insert, or update when an `id` is supplied), `supersede_memory` (SoftWrite), `retract_memory` (HardWrite). `link_memories` is Phase 2. Keep the existing `save_memory` name — it is already SoftWrite and already wired to the desktop modal.

---

## 3. Data model

One kind‑discriminated `memory` table: kind‑invariant fields are columns; kind‑specific fields live in a `structured` JSON blob (json1 is bundled with rusqlite 0.32); many‑to‑many concerns are separate tables. **No table‑per‑kind** — cross‑kind recall is the whole point.

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;                 -- single writer, concurrent readers

CREATE TABLE IF NOT EXISTS memory (
  id             TEXT PRIMARY KEY,          -- UUIDv7
  kind           TEXT NOT NULL,
  title          TEXT NOT NULL DEFAULT '',  -- derived from content if empty (memory_fs::title_from_body_or_name)
  content        TEXT NOT NULL,             -- markdown; embedded + keyword-indexed
  structured     TEXT NOT NULL DEFAULT '{}',-- kind-specific JSON

  status         TEXT NOT NULL DEFAULT 'active',   -- active|superseded|expired|retracted
  valid_from     INTEGER,                   -- unix secs; NULL => since created_at
  valid_to       INTEGER,                   -- unix secs; NULL => still valid
  supersedes     TEXT REFERENCES memory(id) ON DELETE SET NULL,
  superseded_by  TEXT REFERENCES memory(id) ON DELETE SET NULL,

  scope          TEXT NOT NULL DEFAULT 'workspace', -- workspace | personal
  workspace_id   TEXT,                       -- NULL when scope='personal'

  confidence     REAL,                       -- 0..1; NULL = unspecified
  pinned         INTEGER NOT NULL DEFAULT 0,
  source         TEXT NOT NULL DEFAULT 'user',    -- user|agent|import|connector
  created_by     TEXT NOT NULL DEFAULT 'user',
  origin_session_id TEXT,                     -- sessions.rs Session.id when agent-authored
  origin_tool    TEXT,

  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  rev            INTEGER NOT NULL DEFAULT 1,  -- bumped every mutation (LWW tiebreak; sync-reserved)
  origin_node    TEXT,                        -- authoring node; NULL=local (sync-reserved)
  content_hash   TEXT NOT NULL,               -- embed::chunk_content_key(content); dedupe + embed key

  url            TEXT,                         -- bookmark (written by Rust from `structured`)
  due_at         INTEGER                       -- task/reminder (written by Rust from `structured`)
);

CREATE INDEX IF NOT EXISTS idx_memory_current  ON memory(status, scope, workspace_id);
CREATE INDEX IF NOT EXISTS idx_memory_kind     ON memory(kind, status);
CREATE INDEX IF NOT EXISTS idx_memory_updated  ON memory(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_valid_to ON memory(valid_to)      WHERE valid_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memory_hash     ON memory(content_hash);

-- store-maintained (NO external-content triggers — migration-safe)
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(content, title, memory_id UNINDEXED);

-- SEPARATE from the index DB's embeddings table (that one is a rebuildable cache; sharing it
-- would silently wipe every memory vector on reindex — a verified footgun).
CREATE TABLE IF NOT EXISTS memory_embeddings (
  memory_id  TEXT PRIMARY KEY REFERENCES memory(id) ON DELETE CASCADE,
  model      TEXT NOT NULL,      -- provider-profile id: mixing models silently poisons cosine
  vector     BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_tags (
  memory_id TEXT NOT NULL REFERENCES memory(id) ON DELETE CASCADE,
  tag       TEXT NOT NULL,
  PRIMARY KEY (memory_id, tag)
);
```

- **`url`/`due_at` are real columns written by Rust** from `structured` (not SQLite `GENERATED` columns) so the DDL stays byte‑parallel with Postgres.
- **`content_hash` = `embed::chunk_content_key(content)`** — the same key drives dedupe *and* the embedding cache.

Per‑kind `structured` payloads (examples): `decision → {rationale, decided_at, decided_by, alternatives?[], outcome?}`; `bookmark → {url, why, site?}`; `preference → {key, value, strength?}`; `contact → {name, org?, role?, handles{…}}` (PII — see [§7](#7-permissions-privacy-safety)); `term → {term, definition, aliases?[]}`; `task → {due_at, done, priority?}`.

---

## 4. Retrieval & recall

Hybrid recall over memory reusing the KB machinery, **defaulting to the currently‑valid view**.

- **Candidate gather:** keyword (`memory_fts`) ∪ semantic (`EmbedBackend` + `memory_embeddings`), filtered by `status='active'` and valid‑now (`valid_from IS NULL OR valid_from<=now` and `valid_to IS NULL OR valid_to>now`), scoped to the active workspace ∪ personal.
- **Score** (reuse `embed::hybrid_score`, extended):
  `score = w_kw·kw + w_sem·sem + w_rec·recency_boost(updated_at, now) + pinned_boost + w_conf·confidence`
  One recency curve for v1 (reuse `recency_boost` as‑is); per‑type half‑lives are Phase 2. `pinned` gets a flat boost and never auto‑expires.
- **Supersession collapse:** never return a superseded row unless `include_superseded` is set; when set, return the chain newest‑first.
- **Contradiction:** if two active memories both rank and disagree, **surface both** (with dates) rather than silently picking — automatic contradiction *detection* is Phase 3.
- **Two‑store union:** personal + workspace are separate DBs; normalize each pool's keyword scores **before** merging (the critic flagged that a global `kw_max` breaks across two independent pools).

**Ambient recall** (the "it just knows" feel): after history compaction, inject the top memories into context each turn — **tightly budgeted: ≤ ~1,500 chars, ≤ 5 memories, min‑score floor ~0.35, echo‑suppressed** (do not re‑inject what's already in the visible history). This is 16× smaller than one facet proposed on purpose — it must not crowd out the conversation. Recalled memories reuse the existing **Citation chip** (`source_id="memory:{id}"`) + a SearchTrail step — no new event types. Wrap ambient memory as *first‑party* context (not `wrap_untrusted`); write‑time redaction is what keeps secrets out.

> **The recall→act id contract:** `supersede_memory`/`retract_memory` take ids, and the model only knows ids that recall surfaced. If the user says "forget that" about something not in the current recall block, the tool must first `recall_memory` to resolve it — never guess an id.

---

## 5. Ingestion & capture

**v1 ships explicit capture only.** The entire auto‑extraction subsystem (cue/LLM extractors, salience+confidence scoring, a `memory_candidate` table, a review inbox) is **Phase 2** — it is the single biggest scope lever and doubles v1.

v1 capture paths:
1. **User/agent explicit "remember this"** → a `save_memory` tool call → the existing **SoftWrite** `PermissionRequest` (candidate rides in `arguments`, preview shown) → on **Accept**, one `MemoryWriteOp::Insert` commits. No candidate table needed; the in‑memory permission request *is* the pending state.
2. **One‑shot migration** of existing `memory_fs` `.md` notes and the cd‑server `memory.jsonl` into the store (stable id = hash of relative path so re‑running is idempotent). After migration the desktop `MemoryPane` reads the store.

**Dedup / supersession:** detect automatically (by `content_hash` and semantic near‑match), but **commit only on human confirm**. A detected duplicate defaults to discard; a detected supersession proposes the `Supersede` op (never a delete).

**Redaction** (`redact` extracted from `audit::scrub_line`, hardened: JWT/AWS/GH/PEM/high‑entropy) runs before persist *and* before embed. A credential‑dominant candidate is blocked; a token inside prose is redacted and the redaction is shown in the Accept preview.

---

## 6. Tool surface & agent integration

Register memory tools **statically** via `memory_tool_specs()` behind a `durable_memory_enabled` flag (mirrors how `web_search` is gated) — simpler than a dynamic connector arm.

| tool | tier | notes |
|---|---|---|
| `recall_memory` | Read | folds search/get/list; args `{query, kinds?, k?, include_superseded?}` → hits with `{id, kind, title, snippet, valid, confidence, source_id}` |
| `save_memory` | SoftWrite | insert; **update** when `id` supplied; args `{kind, content, structured?, scope?, tags?, id?}`; Accept/Discard preview |
| `supersede_memory` | SoftWrite | `{old_id, new: {…}}` → closes `valid_to`, links, inserts replacement; reversible |
| `retract_memory` | HardWrite | `{id}` → `status='retracted'`; type‑to‑confirm (see the session‑grant hardening in §7) |

Ambient‑recall injection lives beside `sessions::context_chat_messages` (`sessions.rs:159`) / `recompact_chat_history` (:141) as a new `inject_memory_context` helper sharing the same budget bookkeeping, hooked at the `agent.rs:305` context/shrink point. **Prompt guidance** tells the model to consult recall before answering factual questions about the user's world, and to propose `save_memory` when a durable fact/decision/preference is stated — proposals, never silent writes.

**MCP exposure:** the memory read tools can be exposed on the memory MCP surface for external modules and the cd‑server chat bridge; **write tools are propose‑only over MCP** (enqueue a proposal a human approves in the desktop) — this preserves the UI‑originated‑grant invariant across surfaces.

---

## 7. Permissions, privacy, safety

- **Every write through the existing gate** (`ToolHost::execute` → `PermissionRequest` → `validate_decision`). Zero new permission macros.
- **Audit reuse without breaking the chain:** `AuditEntry` is hash‑chain‑**frozen** — adding any field re‑serializes historical lines and breaks `verify_chain` (verified). Encode memory‑op metadata in the existing `target` field as `mem://{scope}/{id}@v{rev}`. Do **not** add columns to `AuditEntry`.
- **Scope = the one privacy axis (v1):** `personal` vs `workspace`. Personal memory lives in the OS app‑data dir and is structurally barred from `changes_since` (so it can never sync). Workspace memory is shareable within its workspace; workspace‑visibility writes require Admin (reuse `Role`/`require_admin`; a single‑user desktop is locally Admin, so UX is unchanged). A second orthogonal `visibility` axis is deferred to the sync phase.
- **Verified security hardening (do in v1):** `may_execute_without_prompt` currently returns `session_path_allowed(target)` for HardWrite, so a broad `mem://` `AllowSessionPath` grant could auto‑satisfy a *destructive* memory op without re‑typing. Destructive memory ops (`retract`, purge) must **always** require a fresh `AllowOnce` type‑to‑confirm, regardless of any session grant.
- **DB location:** personal store in OS app‑data (never git‑committable); workspace store under `<workspace_root>/<slug>/memory/memory.sqlite`, **gitignored by default** (travels with the project only if the user opts in). *This split is an owner decision — see §10.*
- **User owns their data:** `memory_export` (JSONL) includes personal records (local export). Permanent purge is Phase‑2, UI‑only, type‑to‑confirm; v1 "forget" is the reversible retract tombstone.

---

## 8. Reconciled contradictions (do not re‑litigate)

| # | The split | Decision |
|---|---|---|
| 1 | timestamp unit (secs / RFC3339 / ms) | **unix seconds INTEGER** — reuses `embed::recency_boost`/`now_unix_secs` |
| 2 | column names (`content`/`body`, `rev`/`version`, `kind`/`mtype`) | freeze the [§2.5](#25-canonical-column-dictionary) dictionary |
| 3 | pending write (draft‑row / candidate‑table / in‑memory) | v1 = **in‑memory `PermissionRequest`** (no candidate table until Phase‑2 auto‑extraction) |
| 4 | lifecycle (status enum / deleted+purged booleans) | **status enum** `{active,superseded,expired,retracted}` |
| 5 | history (snapshot `memory_revisions` table / none) | **none** — supersession chain + audit reconstruct belief‑over‑time |
| 6 | embeddings location (shared index table / separate) | **separate `memory_embeddings`** — sharing the index cache silently wipes vectors on reindex |
| 7 | scope axis (`personal/workspace` / `project/workspace` / +`visibility`) | one axis **`{personal, workspace}`** in v1; visibility deferred to sync |
| 8 | ambient budget (1.5k / 24k chars) | **~1,500 chars, ≤5 memories** — the tight setting |
| 9 | tool registration (dynamic connector arm / static gated specs) | **static `memory_tool_specs()`** behind `durable_memory_enabled` |
| 10 | FTS (external‑content triggers / store‑maintained) | **store‑maintained standalone FTS** (migration‑safe) |
| 11 | markdown mirror (keep / single path) | **single path** — migrate `.md` once; recall_memory is the memory path (no double‑surfacing via search_kb) |

---

## 9. Phasing

- **Phase 0 — freeze contracts (no code):** the column dictionary, kind taxonomy, `MemoryStore`/`MemoryRecord`/`MemoryDraft`/`MemoryWriteOp`, the `Clock`/now mechanism, tool names, unix‑seconds. *This doc is Phase 0.*
- **Phase 1 — core store + explicit capture (the v1 "brain"):** migration runner + `SqliteMemoryStore` (WAL, single‑writer) + two‑scope facade + separate `memory_embeddings`; the `memory` table + supersession; `MemoryReader`/`RecallEngine` reusing `hybrid_score`/`cosine`/`recency_boost` + store‑maintained FTS, active‑now default + `include_superseded`; the 4 tools through the existing gate; `redact` extraction; ambient recall (tight budget); migrate `memory_fs` + server `memory.jsonl`; desktop `MemoryPane` reads the store.
- **Phase 2 — capture quality + relationships:** auto‑extraction (rule‑based `CueExtractor` default, LLM opt‑in) + candidate review inbox + salience/confidence; `memory_edges` + `link_memories` + graph expansion; per‑type half‑lives; bulk import; GDPR purge.
- **Phase 3 — advanced recall + power backend:** `subject_key`/`canonical_value` + automatic contradiction surfacing; AsOf point‑in‑time history; **Postgres** memory backend.
- **Phase 4 — server‑authoritative sync** (columns already reserved): `RemoteMemoryStore`, `changes_since`/`apply_remote`, `reconcile()` (LWW + supersession‑preserving merge), Private‑never‑leaves enforcement, cd‑server `MemoryNote` upgrade. **Gated on the sync spike (#TBD).**

---

## 10. Decisions that need the owner

These change v1 shape or cost; I've given a recommendation but they're yours:

1. **Ambient recall default — ON or OFF, and the budget.** Even at 1.5k chars it's one embed call + two store reads per user turn. *Recommend ON* (that's the second‑brain feel) with the tight budget and a settings toggle — consistent with the smart‑defaults‑plus‑opt‑out philosophy. If token cost per turn matters more, OFF‑until‑opted‑in.
2. **Workspace memory DB location — in‑repo (`<root>/<slug>/memory`, travels with the project, gitignored by default) vs OS app‑data (never git‑leaks, doesn't travel).** *Recommend in‑repo + gitignored* for workspace scope, OS app‑data for personal scope.
3. **`retract` friction — SoftWrite (reversible, low‑friction preview) vs HardWrite type‑to‑confirm.** *Recommend SoftWrite* (it's reversible) and reserve type‑to‑confirm for permanent purge.
4. **Auto‑extraction in v1 — explicit‑capture‑only (recommended) vs build the extractor + inbox now.** This roughly doubles v1.
5. **PII / `contact` kind — allow and flag‑don't‑strip emails/phones (recommended; stripping corrupts contact memories) vs refuse PII.** And: are personal/contact memories permanently barred from syncing (recommended yes).
6. **Preference conflict — a new value for the same key auto‑supersedes vs keep‑both‑and‑rank.** Auto‑supersede needs a `subject_key` concept (deferred), so *v1 keeps both* unless you want `subject_key` pulled forward.

---

## 11. Risks (verified)

- **Audit chain is frozen** — never add fields to `AuditEntry`; use the `target` string. (Verified: `verify_chain` re‑serializes and re‑hashes.)
- **Do not share the index `embeddings` table** — it's a rebuildable cache; a reindex would silently drop every memory vector and force a full (paid) re‑embed.
- **Per‑turn cost:** ambient recall touches 3 SQLite files (personal, workspace, index) before the model call. WAL + short‑lived RO connections + the tight budget keep it cheap; do **not** enable per‑turn reinforcement writes in v1 (write amplification through the single WAL writer).
- **Timestamp lock‑in:** write nothing until unix‑seconds is locked.
- **Migration idempotency:** `memory_fs` `.md` import must key on a stable id (hash of relative path) and the imported notes must stop being indexed as *both* KB notes and memories.
