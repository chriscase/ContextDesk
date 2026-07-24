# Goal: Optional session process wizards + visual progress

Paste the **Goal prompt** (fenced block at the bottom) into Grok Build `/goal` or another agent after `git pull` on `main`.

Epic: [#442](https://github.com/chriscase/ContextDesk/issues/442)

Related: Help Center [#434](https://github.com/chriscase/ContextDesk/issues/434) (deep links; can ship in parallel)

## Issue map

| Order | Issue | Focus |
|------:|-------|--------|
| 1 | [#443](https://github.com/chriscase/ContextDesk/issues/443) | Design `SESSION_WIZARDS.md` |
| 2 | [#444](https://github.com/chriscase/ContextDesk/issues/444) | Wizard framework + SVG chrome |
| 3 | [#445](https://github.com/chriscase/ContextDesk/issues/445) | Progress events + pipeline UI |
| 4 | [#446](https://github.com/chriscase/ContextDesk/issues/446) | Flagship log troubleshooting wizard |
| 5 | [#447](https://github.com/chriscase/ContextDesk/issues/447) | Optional new-chat catalog entry |
| 6 | [#448](https://github.com/chriscase/ContextDesk/issues/448) | Extra wizards (catalog proof) |
| 7 | [#449](https://github.com/chriscase/ContextDesk/issues/449) | Help + skill integration |
| 8 | [#450](https://github.com/chriscase/ContextDesk/issues/450) | Polish + CLAIMS + demo path |

## Minimum bar for coworker demo

#443 → #444 → #445 → #446 → #447 (enough to walk logs into the system visually). #448–#450 can trail.

## Honesty

`docs/CLOSE_PROOF.md` · `docs/ISSUE_HONESTY.md` · prefer `integrate/session-wizards` then promote.

---

## Goal prompt (copy from here)

```
You are implementing ContextDesk epic #442: Optional session process wizards (guided multi-step flows + visual progress).

Workspace: ContextDesk — pull latest main. Follow AGENTS.md / Claude.md standing authorizations (branches, PRs, merge after green CI). Never log secrets; redact corp hosts.

## Honesty / proof (non-negotiable)
- Close each child with CLOSE_PROOF: merge SHA or PR URL, pasted tests/UI proof, issue-specific prose, Adversarial: CONFIRMED — … (docs/CLOSE_PROOF.md)
- docs/CLAIMS.md only Shipped when true on main with path:symbol
- Prefer integrate/session-wizards batch; promote once with full CI (docs/AGENT_WORKFLOW.md)
- Tag closes with agent/model labels
- If product fork not locked below, AskUserQuestion once with 2–4 options

## Locked product decisions
1. Wizards are OPTIONAL — never block blank “New chat”
2. Reusable SessionWizard framework (not one-off modals only for logs)
3. Flagship wizard: Log troubleshooting setup (path → ingest and/or session context → progress → pin log-triage skill → seed composer → ready chat)
4. Visual bar: SVG stage art per step + ProcessProgressPanel with pipeline graphic for long import/ingest (phases, not just “Working…”)
5. SoftWrite/HardWrite policy unchanged — confirms still required
6. Reuse patterns: AiSetupWizard UX quality, WizardStepIndicator generalization, S3 BackupProgress observer → log ingest + session context import progress events
7. Help Center #434: deep-link Learn more when Help exists; feature-detect; do not block on full Help epic
8. Do not replace pre-launch app onboarding (LAUNCH.md); these are session/workflow wizards

## Children (order; shippable PRs)

### #443 Design first
docs/design/SESSION_WIZARDS.md — when shown, schema, shell UX, progress model, SVG conventions, cancel semantics, flagship step list, PR plan.

### #444 Framework
SessionWizardShell: step rail, SVG stage slot, footer nav, registry/catalog types, a11y/focus trap, stub wizard tests.

### #445 Progress system
Host progress for log corpus ingest (scan/parse/template/redact/store/embed) + session context import/zip; Tauri events; ProcessProgressPanel with pipeline SVG + stats; wire Logs pane + context bar; cancel honesty.

### #446 Flagship log wizard
End-to-end guided path using real ingest/context APIs + skill pin + starter prompt; SoftWrite OK dialogs; cancel safe.

### #447 Entry points
New chat secondary “Guided setup…”, empty-state wizard cards, palette actions; one-click blank chat remains.

### #448 Expansion
≥1 more wizard (memory primer / session-context-only / Confluence allowlist primer / AI re-setup) proving multi-wizard catalog.

### #449 Help/skills glue
helpPageId Learn more; graceful without Help; skill pin contract documented.

### #450 Polish + CLAIMS
reduced-motion, error copy, demo script, CLAIMS, close #442 with proof.

## Execution tips
- Dual Cargo.lock if cd-core API changes
- Progress events: no paths with secrets; redact like other host events
- Large file demo: synthetic multi-MB log dir in fixtures or temp for manual proof
- Align log pipeline SVG stages with Help log page wording when both exist
- Offline cargo test + vitest smoke for shell/progress

## Done when (minimum demo)
- #443–#447 closed with proof
- User can: Guided setup → Log troubleshooting → see pipeline progress → chat ready with log-triage skill
- #448–#450 done or residual noted on epic
```
