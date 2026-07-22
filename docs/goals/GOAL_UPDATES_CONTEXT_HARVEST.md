# Goal: Updates + session context packs + Confluence harvest (combined push)

Paste the **Goal prompt** (fenced block below) into Grok Build `/goal` (or an agent session) after `git pull` on `main`.

This supersedes the earlier updates-only goal doc for combined execution. Keep this file as the single paste source.

---

## Issue map (all tracks)

| Track | Epic | Children / PR order | Already on main |
|-------|------|---------------------|-----------------|
| **Updates** | [#336](https://github.com/chriscase/ContextDesk/issues/336) | [#338](https://github.com/chriscase/ContextDesk/issues/338) → [#339](https://github.com/chriscase/ContextDesk/issues/339) → [#340](https://github.com/chriscase/ContextDesk/issues/340) | #173 signed updater (manual check only) |
| **Session context / triage** | [#337](https://github.com/chriscase/ContextDesk/issues/337) | [#341](https://github.com/chriscase/ContextDesk/issues/341) → [#342](https://github.com/chriscase/ContextDesk/issues/342) → [#343](https://github.com/chriscase/ContextDesk/issues/343) | Workspace KB + skills SoftWrite |
| **Confluence harvest / memory forms** | [#326](https://github.com/chriscase/ContextDesk/issues/326) | Design + **PR1–2 done**; implement **PR3→9** per design | Design [#329](https://github.com/chriscase/ContextDesk/pull/329); RO maneuver [#332](https://github.com/chriscase/ContextDesk/pull/332); harvest schema [#333](https://github.com/chriscase/ContextDesk/pull/333) |

### #326 honest status (do not re-claim)

| Design PR | Title | Status |
|-----------|--------|--------|
| 1 | Confluence RO maneuver | **Merged** (#332) |
| 2 | SourceRef + harvest SQLite schema | **Merged** (#333) — library only, no SoftWrite tool |
| 3 | Transforms + SoftWrite harvest → memory | **Not started** |
| 4 | storage↔markdown + file destination | **Not started** |
| 5 | check/apply sync + supersede harvest.memory_id | **Not started** (store helpers exist) |
| 6 | Harvest Browser UI + citations | **Not started** |
| 7 | Confluence HardWrite core | **Not started** |
| 8 | Desktop Publish UI | **Not started** |
| 9 | Polish + CLAIMS | **Not started** |

Design SoT: [`docs/design/CONFLUENCE_HARVEST_MEMORY_TRANSFORM.md`](../design/CONFLUENCE_HARVEST_MEMORY_TRANSFORM.md).

---

## Honest close / proof rules (every issue)

Follow [`docs/CLOSE_PROOF.md`](../CLOSE_PROOF.md) and [`docs/ISSUE_HONESTY.md`](../ISSUE_HONESTY.md):

1. **Acceptance criteria literally true** — paste proof (test names + output, or UI path).
2. **Close comment** must include: merge SHA or PR number, pasted command output, issue-specific prose, `Adversarial: CONFIRMED — …` or leave open with `Residual: …`.
3. **`docs/CLAIMS.md`** — only mark **Shipped** when the capability is true on `main` with a real `path:symbol` anchor. No harvest/write/poll claims until that phase merges.
4. **No mass-close** of the epic until children meet their own proof bars.
5. Prefer **small PRs** (one child issue or one design PR) with green CI before merge.

---

## Goal prompt (copy from here)

```
You are implementing ContextDesk product arcs already designed and filed. Workspace: ContextDesk on main (pull latest). Follow AGENTS.md / Claude.md standing authorizations: branches, PRs, merge after green CI. Never log secrets; redact corp hosts in issues.

## Honesty / proof (non-negotiable)
- Every closed issue needs close-proof: merge SHA or PR URL, pasted test/gate output with test names, issue-specific prose, Adversarial line — see docs/CLOSE_PROOF.md
- Update docs/CLAIMS.md only when a capability truly ships on main (grep-able path:symbol)
- Do not mark #326 epic complete until PR3+ that you claim are actually merged with proof
- Prefer small sequential PRs over big bang; green CI before merge
- If blocked on product choice, AskUserQuestion once with 2–4 options (batch decisions)

## Epics (do not re-design from scratch)

### A. #336 Version identity, update polling, low-friction auto-update
Shipped foundation: #173 signed updater (manual Check for updates + confirm before install).
Children (order):
  - #338 Build identity — version, protocol, channel (installed|dev), optional git SHA/describe; Settings + #325 error reports
  - #339 Opt-in background poll + banner → existing confirm→download→install; no silent install; hide or redirect for dev channel
  - #340 Guided source-run update (git fetch/status; never reset --hard dirty; rebuild steps)
Constraints: honest channel; PACKAGING.md / THREAT_MODEL updater trust; CLAIMS only when phase ships.

### B. #337 Session context packs — logs/zips into a chat + triage skills
Children (order):
  - #341 Session context store + composer drop (files first); session-scoped root; tools search/read; caps; purge on session delete
  - #342 Nested zip ingest — zip-slip tests, bomb caps, no host-shell unzip, no execute
  - #343 Example triage skill(s) + pin skill to chat; skills cannot raise write permissions
Constraints: not permanent workspace root by default; untrusted extraction + injection wrappers; SoftWrite only if promoting to durable memory.

### C. #326 Confluence maneuver, provenance harvest, multi-memory transform, confirmed write
Design: docs/design/CONFLUENCE_HARVEST_MEMORY_TRANSFORM.md (on main).
ALREADY MERGED — do not re-implement:
  - PR1 RO maneuver (#332): children, ancestors, attachments, space_permitted, get_page formats
  - PR2 harvest schema (#333): SourceRef, HarvestStore, classify_sync, memory schema v2
IMPLEMENT remaining design PRs (small shippable PRs; tests offline/wiremock):
  - PR3 Transforms + SoftWrite harvest_from_source → durable memory; empty space allowlist blocks harvest; batch caps; AllowOnce only for harvest://
  - PR4 storage↔markdown converters + file destination under harvest/; golden fixtures
  - PR5 check_source_sync (Read) + apply_source_sync (SoftWrite); supersede rewrites harvest.memory_id; retract → missing_local
  - PR6 Desktop Harvest Browser + conflict Keep/Take + citation absolute URLs
  - PR7 Confluence write path (HardWrite, risk=remote, type-to-confirm WRITE, write_enabled default off)
  - PR8 Desktop Publish (converter-gated)
  - PR9 Polish + CLAIMS for RO maneuver / harvest / write only as each is true
Constraints (from design): personal-scope harvest allowed (default workspace); empty space allowlist blocks harvest/write; remote write always HardWrite; Server/DC first; MemoryForm trait deferred until second form needs it.

## Order of work (recommended combined push)
Interleave so each PR is shippable and proven:

1. #338 build identity (fast UX win; unblocks channel-aware updates + better diagnostics)
2. #326 PR3 SoftWrite harvest → memory (core product gap users expect)
3. #341 session context files + drop zone
4. #339 update poll + banner
5. #326 PR4 converters + file dest
6. #342 nested zip
7. #326 PR5 check/apply sync + supersede hooks
8. #340 source-run update guide
9. #343 triage skills
10. #326 PR6 Harvest UI (as bandwidth)
11. #326 PR7–9 write/publish/CLAIMS (as bandwidth; write after RO+harvest solid)

If time-boxed: minimum bar = #338 + #326 PR3 + #341 all merged with close-proof; then continue down the list.

## Execution rules
- One PR stack or sequential PRs per child issue / design PR number
- Link PRs: Fixes #N or Part of #326 / Part of #336
- Unit/integration tests offline where possible (wiremock for Confluence)
- Dual Cargo.lock: update root + desktop/src-tauri when cd-core deps change
- No secrets in git; no corp hostnames in public issue text

## Done when (combined)
- [#338] closed with proof: Settings shows channel + version (+ git when present); diagnostics include identity
- [#341] closed with proof: drop plain files into a chat; search/cite under session root
- [#326 PR3] merged with proof: SoftWrite harvest_from_source → memory + harvest row + provenance; empty allowlist policy error
- At least two of: #339, #342, #326 PR4/PR5 merged with proof
- CLAIMS honest (no false harvest/write/auto-update rows)
- Each closed issue has close-proof comment; epics stay open until their residual children are done or explicitly Residual-deferred in a comment
- SCRATCH or PR bodies hold verification evidence (commands + output)

## Explicit non-goals this push
- Silent auto-install of updates
- Auto git reset --hard
- MemoryForm trait for arbitrary forms (unless second form truly lands)
- Silent Confluence remote write
- Treating session context packs as permanent workspace roots without user intent
```

---

## Product notes (for implementers)

### Updates (#336)
- Do not re-litigate #173: plugin, pubkey, manual check, confirm-before-install exist.
- Gap: identity + poll + source guide + banner.
- `cd_core::VERSION` is `CARGO_PKG_VERSION` only until #338.

### Session context (#337)
- Persona: incident triage (logs, nested zips, email dumps) + optional skill.
- Prefer `.contextdesk/sessions/<id>/context/` (gitignored).
- Zip-slip and zip bombs are hard gates (tests required).

### Confluence harvest (#326)
- Users may believe harvest “shipped” because design + schema landed — **only RO + schema shipped**.
- Next user-visible win is **PR3** (Accept → page in durable memory with SourceRef).
- Multi-form transform = pure transform profiles in PR3–4 first; general MemoryForm later.
- Write path is HardWrite-only; `write_enabled` default off.

### Cross-links
- Diagnostics/version: #325 (expandable redacted reports) should consume #338 identity fields.
- Memory SoftWrite patterns: existing memory tools + permissions; harvest targets `harvest://…` exact-match only (design K15).
