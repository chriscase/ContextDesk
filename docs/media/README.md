# docs/media

Screenshots referenced by the top-level `README.md` and the product gallery.

## Capture baseline

| Property | Value |
|----------|--------|
| App | Packaged macOS `.app` from `desktop/src-tauri/target/release/bundle/macos/ContextDesk.app` |
| Source SHA | `3ef9ab44cf3163844a5069b467b5fc5be504d736` (`origin/main` at capture) |
| Capture method | Native window resize + full-display `screencapture` + crop to window bounds |
| Updater signing | Public key present; private key intentionally unset (unsigned local bundle) |

## `screenshot.png` (hero)

Updated first-chat product home at ~1100×760: brand tagline, **Fills composer** vs **Guided workflow** action cards, compact **No files or skill · session-only** context bar, composer, model picker, sidebar.

Do not commit fabricated or hand-drawn product art as the main README shot.

## Log Explorer acceptance captures

`log-explorer-align-100k.jpeg` and
`log-explorer-four-lanes-100k.jpeg` are real captures of the packaged macOS
application investigating the deterministic Log Lab `ui-medium` corpus.

| File | Size | What it shows |
|------|------|---------------|
| `log-explorer-align-100k.jpeg` | 1195 × 768 JPEG | Two composed lanes in exact Align mode, explicit empty/gap cells, useful UTC time, source provenance, and the complete event inspector |
| `log-explorer-four-lanes-100k.jpeg` | 2048 × 560 JPEG | Four composed evidence lanes at ultrawide width, bounded resident rows, compact controls, filters, and linked-chat rail |

| Property | Value |
|----------|-------|
| Packaged-app ancestry | `fb363947d091196b1321bab68dbb56663873b137` and `976960739118aab2fc6205c218f8915d8baffa64` acceptance builds; behavior rerun on `3ef9ab44cf3163844a5069b467b5fc5be504d736` |
| Corpus | Deterministic synthetic Log Lab fixture; 100,000 events across 10 files |
| Provenance | Native Computer Use against `ContextDesk.app`; no DOM-only capture and no mockup |
| Claim boundary | One-machine acceptance evidence only; no universal throughput or provider-tool claim |

When recapturing, build the packaged app from the intended `main` SHA, import
the deterministic `ui-medium` corpus, avoid diagnostic/error overlays, and
record the exact app SHA and corpus profile. Keep the source corpus and other
generated acceptance artifacts outside Git.

## `gallery/` (product gallery)

All files are real packaged-app crops. No credentials, API keys, or absolute private paths appear in the frames.

| File | Surface |
|------|---------|
| `first-chat-home-narrow.png` | Empty first-chat home at practical 800×600 |
| `first-chat-home-normal.png` | Empty first-chat home at ~1100×760 |
| `first-chat-home-wide.png` | Empty first-chat home at wide layout |
| `help-dark.png` | Help Center, Dark theme, normal width |
| `help-light.png` | Help Center, Light theme |
| `help-slate.png` | Help Center, Slate theme |
| `help-narrow-dark.png` | Help Center, Dark, narrow |
| `ordinary-chat-session-only.png` | Ordinary chat showing **No files or skill · session-only** |
| `logs-library.png` | Logs library with Open Explorer entry point |
| `main-nav-800x600.png` | Main chrome navigation at 800×600 |

## Honesty notes

- These frames support README product communication and tracker residual audits. They do **not** close owner GUI acceptance [#525](https://github.com/chriscase/ContextDesk/issues/525).
- Multi-chat overflow is visible on the ordinary-chat frame (header chips); dedicated Log Explorer linked-chat **rail** packaged proof remains a residual on [#543](https://github.com/chriscase/ContextDesk/issues/543).
- Sidebar may list local synthetic corpus/chat titles (`incident`, acceptance chats). No secret material.

## Recapture

1. `cd desktop && npm ci && npm run tauri:build` (missing updater private key is OK if `.app` is produced).
2. Open `desktop/src-tauri/target/release/bundle/macos/ContextDesk.app`.
3. Prefer empty first-chat (Cmd+N), Help tab × theme toggle, ordinary chat with empty context bar.
4. Crop to the app window; scrub any private paths before commit.
5. Record the exact `git rev-parse HEAD` of the build tree in this file.
