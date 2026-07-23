# Launch surface design (epic #391)

**Status:** contract for implementation (#392–#397)  
**Product:** ContextDesk — open-source knowledge desk (not karaoke)

## Goals

1. Real **product launch moment** before main chrome (not “auto-open Settings → Preflight”).
2. **Animated splash** with custom ContextDesk SVG (NexaDeck-like choreography).
3. **Pre-launch** first-run: Workspace → AI → Ready → Enter.
4. **Work-context** health pills on Ready (and reusable Health in Settings).
5. **Settings** as ongoing config with clearer IA after launch.
6. **Identity phase slot** (local-only v1; collab later).

## Phase machine

```
splash → identity (stub: local desk) → pre-launch | skip → main chrome
```

| Phase | When | Blocks main? |
|-------|------|--------------|
| Splash | Always unless `?skipSplash` / `VITE_SKIP_SPLASH` | Yes until complete/timeout |
| Identity | v1 always auto-selects local desk (invisible or one-line) | No user wait |
| Pre-launch | First-run **or** host preflight `has_blocking` | Yes until Enter when non-blocking |
| Main | Launch-critical non-blocking | — |

**Returning users:** if last hydrate shows non-blocking preflight, skip pre-launch after splash (enter main). Splash may still run (shorter).

**Launch-critical (blocks Enter / send):** app data dir, workspace roots, AI provider + model + reachability/key as today.

**Work-context (visible; warn does not block Enter):** see below.

## Open-source constraints

- No license gate, no required cloud account.
- Pure **Ollama + local folder** must complete first launch.
- Secrets keychain-only; no hand-edited config as the happy path.
- Do not market collab/team as shipped.

## Work-context include / exclude

### Include (`category: work`)

| Source | Notes |
|--------|--------|
| Files (workspace roots) | Same as launch workspace item when roots set |
| Durable memory | Store attached / path ready |
| Confluence RO | If enabled in settings |
| SQLite RO connectors | If enabled |
| Postgres RO connectors | If enabled |
| MCP servers | If enabled |
| HTTP/OpenAPI work presets | If enabled (`kind: http`) |

### Exclude (never on pre-launch Ready)

- Web research **news source matrix**
- X / Twitter search
- Ambient open-web “curiosity” toggles as first-class launch checks

### Severity

| Level | Meaning | Blocks Enter? |
|-------|---------|---------------|
| pass | Configured + healthy | No |
| warn | Enabled but degraded | **No** (Fix CTA) |
| off | Not configured / disabled | No |
| fail | Launch-critical only | **Yes** |

Optional sources that are off show as **off**, not fail.

## NexaDeck port matrix

| Port | How |
|------|-----|
| SplashScreen API + CSS motion | Vendor under `desktop/src/components/launch/` |
| WizardStepIndicator / step rail | Vendor / reimplement thin |
| Phase flags in App | Same shape as MainApp |
| Dark full-bleed aesthetic | CSS tokens; CD branding |

| Do not port | Why |
|-------------|-----|
| FirstRunWizard | Karaoke domain |
| PreFlightCheck song library | Wrong product |
| ProfilePicker OAuth | Closed ecosystem |
| License / posture venue-home | N/A |

## Pre-launch steps (first-run / incomplete)

1. **Workspace** — default Documents folder or pick; persist immediately.
2. **AI** — existing `AiSetupWizard` (Ollama / Grok session / gateway).
3. **Ready** — launch-critical + work-context pills → **Enter app**.

Honest cold defaults: empty workspace; `providerKind: "none"` until wizard/host sets (no fake “Ollama ready”).

## Settings IA (after launch)

| Group | Sections |
|-------|----------|
| Core | Workspace, AI / Models |
| Sources | Connectors |
| Extensions | Modules, Skills |
| Preferences | Appearance |
| System | General |
| Health | Preflight / diagnostics (demoted; not first-run home) |

Prefer per-section save where feasible; AI wizard Apply & Save remains one-shot.

## Identity stub (#397)

- Between splash and pre-launch: `deskContext = { kind: "local" }`.
- No network; collab plugs into same callback later.

## Acceptance (epic-level)

- [ ] Incomplete setup never uses 8-nav Settings as primary onboarding.
- [ ] Splash SVG animation; first vs return duration; cannot hang forever.
- [ ] Pre-launch workspace → AI → Enter without Settings.
- [ ] Work-context pills; news/X absent; warn ≠ block.
- [ ] Settings grouped; Preflight demoted; identity stub present.
- [ ] README/CLAIMS honest; issues closed with proof or residual.

## Implementation notes

- Pure helpers for category filter + splash duration: unit-test offline.
- Host probes for work connectors: timeouts; default `cargo test` stays offline.
- Avoid `cd-server/`, `sql_ro.rs`, `web_research.rs` unless a probe truly needs shared types already elsewhere.
