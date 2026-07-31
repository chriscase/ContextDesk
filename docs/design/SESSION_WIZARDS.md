# Session process wizards — design

**Status:** implementation contract for epic [#442](https://github.com/chriscase/ContextDesk/issues/442)  
**Product:** ContextDesk — optional guided multi-step **session** workflows (not app pre-launch)  
**Related:** Help Center [#434](https://github.com/chriscase/ContextDesk/issues/434) · Log analysis [#353](https://github.com/chriscase/ContextDesk/issues/353) · Session context [#337](https://github.com/chriscase/ContextDesk/issues/337) · Pre-launch [`LAUNCH.md`](LAUNCH.md) (out of scope)

## 0. Goals

1. **Optional** multi-step wizards that walk users through complex session setup (flagship: log troubleshooting).
2. **Reusable framework** — declarative catalog; shared shell (step rail, SVG stage, footer).
3. **Visual long-ops** — multi-phase progress for log corpus ingest and session-context import (not only “Working…”).
4. Never block one-click **New chat**. Never replace splash/pre-launch onboarding.

## 1. When wizards appear

| Surface | Behavior |
|---------|----------|
| New chat control | Primary **New chat** (blank). Secondary **Guided setup…** opens catalog. |
| Empty chat state | Cards for registered wizards + existing prompt starters. |
| Command palette | “Guided setup…”, “Log troubleshooting wizard”, etc. |
| Logs pane | Optional “Guided setup” link (does not replace direct Ingest). |

**Defaults:** catalog is opt-in per action; no forced wizard on app launch. Dismiss/skip always available. Mid-wizard abandon = discard step state (v1 no resume).

## 2. Wizard definition schema

```text
WizardDef {
  id: string                 // e.g. "log-troubleshooting"
  title: string
  description: string
  thumbnailSvgId?: string    // catalog art
  helpPageId?: string        // help:// deep link when Help exists
  skillPinId?: string        // e.g. "log-triage" — skills never raise write tiers
  steps: WizardStep[]
}

WizardStep {
  id: string
  title: string
  stageSvgId?: string
  helpPageId?: string
  body: "info" | "path_pick" | "mode_select" | "confirm_softwrite" | "run_progress" | "ready"
  // validate/continue owned by wizard implementation
}
```

Registry is a static TypeScript module listing `WizardDef`s; shell renders any wizard by id.

## 3. Shell UX

- **Presentation:** modal overlay (focus trap) over main chrome — does not replace LAUNCH splash/pre-launch.
- **Chrome:** title + optional Learn more · step rail · **SVG stage** (left or top) · step body · footer **Cancel | Back | Skip (when allowed) | Continue**.
- **A11y:** `role="dialog"`, `aria-modal`, step `aria-current`, Escape = Cancel, Tab trap.
- **Theme:** CSS variables; stage SVGs use `currentColor` where practical; `prefers-reduced-motion` disables decorative motion.

## 4. Progress model

Shared core type `ProcessProgress` (see `crates/cd-core/src/process_progress.rs`):

| Field | Notes |
|-------|--------|
| `kind` | `log_ingest` \| `session_context_import` |
| `phase` | snake_case enum (below) |
| `message` | short redacted UI string — **no secrets, no full home paths** |
| `fraction` | optional 0..1 |
| `lines_processed` / `files_processed` / `bytes_processed` / `templates` | optional stats |
| `cancellable` | honest: true only when host can still abort cleanly |

`fraction` is the only source of in-flight percentage truth. When it is absent
or invalid, the panel remains indeterminate and shows the active host-authored
phase plus safe counters; it never estimates completion from phase position,
elapsed time, animation, or historical duration. A host-reported `completed`
terminal phase may render as complete even when the last event omits a
fraction. Failed and cancelled phases stop activity without implying a
percentage.

### Log corpus ingest phases

`starting` → `scan` → **`stream`** (read, parse, template, and persist — one monotonic phase) → `embed` (optional; may be skipped when deferred) → `validate` → `publish` → `completed` | `failed` | `cancelled`

Interleaved parse/template/persist work must not emit rewinding bookend phases. Diagnostic `IngestPhaseTimings` accumulate real operation scopes separately from UI chrome and surface on the SoftWrite completion report (discover/read, parse/frame, template analysis, persist/index, optional embedding, validation, publication) via host DTO + TypeScript — not only as a combined Stream label.

### Session context import phases

`starting` → `read` → `validate` → `extract` (zip) → `write` → `completed` | `failed` | `cancelled`

### Cancel honesty

- Between files / before store flush: cancel → `cancelled`, partial corpus discarded when possible.
- After durable DuckDB flush / mid-embed: may be **non-cancellable**; UI shows phase and disables Cancel.
- Never report “cancelled” if work already completed.

### Transport

- Observer trait in cd-core (testable without Tauri).
- Desktop emits `process-progress` events (pattern after `s3-backup-progress`).
- Payload is Serialize JSON; paths redacted to basename or omitted.

## 5. Graphics conventions

- Stage SVGs: simple line art, `currentColor`, max ~320×180 viewBox, no external images.
- ProcessProgressPanel: horizontal pipeline of phases; active phase highlighted; bar from `fraction` or indeterminate.
- Catalog thumbs: small SVG monograms, not screenshots.

## 6. Permissions

| Action | Tier |
|--------|------|
| `ingest_logs` (agent tool) | SoftWrite — unchanged |
| UI host `ingest_log_path` | User-initiated path; wizard adds explicit **confirm SoftWrite** step before run |
| Session context import | Session-scoped; same as drop zone today |
| Skill pin | No write elevation |

Wizards **must not** invent HardWrite silent paths or bypass SoftWrite Accept for agent tools.

## 7. Flagship: Log troubleshooting

| Step | id | Body |
|------|-----|------|
| 1 | `welcome` | info + pipeline SVG; Learn more → help log page if present |
| 2 | `source` | path_pick (file/dir) |
| 3 | `mode` | corpus ingest and/or session context attach |
| 4 | `confirm` | SoftWrite summary (path basename, mode) |
| 5 | `run` | run_progress + ProcessProgressPanel |
| 6 | `ready` | pin `log-triage`, seed composer, enter chat |

Success: session focused, skill pinned, starter prompt in composer, optional corpus id noted.

## 8. Catalog expansion (v1+)

- `memory-primer` — explain Review vs Store; open Memory pane  
- `session-context-only` — attach files without full corpus ingest  
- (optional later) Confluence allowlist primer, AI re-setup wrapper  

## 9. Help / skills glue

- `helpPageId` → open Help pane when `PaneId` includes `help` and host can resolve page; else inline short copy.
- Skills never raise SoftWrite/HardWrite (existing contract).

## 10. Non-goals

- Replacing LAUNCH pre-launch  
- Live streaming / tail wizards  
- Third-party wizard marketplace  
- Agent freeform wizard authoring without review  

## 11. PR plan (integrate/session-wizards)

1. Design (this doc)  
2. process_progress + ingest/session_context observers + tests  
3. Desktop shell + progress panel + registry  
4. Flagship log wizard + entry points  
5. Memory primer (+ optional second wizard)  
6. Help deep-link feature-detect + CLAIMS + demo script  

Promote once CI green.
