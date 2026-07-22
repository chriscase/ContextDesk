# Goal: Updates + session context packs

Paste the **Goal prompt** below into Grok Build `/goal` (or an agent session) after pulling `main`.

## Issue map

| Track | Epic | Children (order) |
|-------|------|------------------|
| Updates | [#336](https://github.com/chriscase/ContextDesk/issues/336) | [#338](https://github.com/chriscase/ContextDesk/issues/338) → [#339](https://github.com/chriscase/ContextDesk/issues/339) → [#340](https://github.com/chriscase/ContextDesk/issues/340) |
| Chat context / triage | [#337](https://github.com/chriscase/ContextDesk/issues/337) | [#341](https://github.com/chriscase/ContextDesk/issues/341) → [#342](https://github.com/chriscase/ContextDesk/issues/342) → [#343](https://github.com/chriscase/ContextDesk/issues/343) |

Shipped foundations: signed updater **#173**, diagnostics version in reports **#325**, skills SoftWrite, workspace allowlist tools.

---

## Goal prompt (copy from here)

```
You are implementing ContextDesk product arcs already filed. Workspace: ContextDesk on main (pull latest). Follow AGENTS.md / Claude.md standing authorizations: branches, PRs, merge after green CI. Never log secrets; redact corp hosts in issues.

## Epics / issues (do not re-design from scratch; implement or refine)
1. #336 Version identity, update polling, low-friction auto-update (source + installed)
   Design constraints:
   - Installed builds: extend shipped Tauri signed updater (#173) — pubkey + latest.json; NEVER silent install
   - Source/dev builds: honest channel; guided git fetch/pull + rebuild; never git reset --hard on dirty trees
   - Build identity always visible (version, protocol, channel, optional git SHA)
   - Background poll is opt-in (or clearly defaulted); banner → existing confirm→download→install
   - Docs: PACKAGING.md / THREAT_MODEL updater trust; CLAIMS only when phase truly ships
   Children:
   - PR order: #338 identity → #339 poll+banner → #340 source-run guide
   - Optional later: epic P4 auto-download still confirms install

2. #337 Session context packs — drop logs/zips into a chat + triage skills
   Design constraints:
   - Session-scoped context root (not permanent workspace root by default)
   - Safe zip + nested zip: zip-slip tests, size/depth/entry caps, no host-shell unzip, no execute
   - Extracted content untrusted (injection wrappers); tools search/read within session root + allowlist
   - Skills: example log-triage; pin skill to chat; skills cannot raise write permissions
   - SoftWrite only if promoting findings to durable memory
   Children:
   - PR order: #341 store+drop (files) → #342 nested zip → #343 triage skills

## Execution rules
- One PR stack or sequential PRs per issue; green CI before merge
- Update docs/CLAIMS.md only when capability truly ships
- Unit/integration tests offline where possible
- Prefer small shippable PRs over big bang
- If blocked on product choice, use AskUserQuestion once with 2–4 options

## Order of work (recommended)
A. #338 build identity (unblocks diagnostics + channel-aware update UX)
B. #341 session context store + composer drop (unblocks triage demos without zip)
C. #339 background update poll + banner (installed)
D. #342 nested zip ingest
E. #340 source-run update guide + #343 triage skills as bandwidth allows

## Done when
- #338 merged with tests; Settings shows channel + version (+ git when present)
- #341 merged; user can drop plain files into a chat and search/cite them
- #339 and/or #342 merged if time (at least one of poll-or-zip beyond P0s)
- All PRs linked to issues; CLAIMS honest; threat notes for archives/updater poll
```

---

## Product notes (for implementers)

### Updates
- Do **not** re-litigate #173: plugin, pubkey, manual check, confirm-before-install already exist.
- Gap is identity + poll + source path + low-friction banner.
- `cd_core::VERSION` is `CARGO_PKG_VERSION` only today.

### Context packs
- Primary persona: incident triage (logs, nested zips, email exports) with optional skill playbook.
- Prefer app-data / `.contextdesk/sessions/<id>/context/` over mutating permanent workspace roots.
- Zip bombs and zip-slip are hard gates (tests required).
