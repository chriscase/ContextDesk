# docs/media

Screenshots referenced by the top-level `README.md` and the product gallery.

## Capture baseline

| Property        | Value                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------ |
| App             | Packaged macOS `.app` from `desktop/src-tauri/target/release/bundle/macos/ContextDesk.app` |
| Source SHA      | `3ef9ab44cf3163844a5069b467b5fc5be504d736` (`origin/main` at capture)                      |
| Capture method  | Native window resize + full-display `screencapture` + crop to window bounds                |
| Updater signing | Public key present; private key intentionally unset (unsigned local bundle)                |

## `screenshot.png` (hero)

Updated first-chat product home at ~1100×760: brand tagline, **Fills composer** vs **Guided workflow** action cards, compact **No files or skill · session-only** context bar, composer, model picker, sidebar.

Do not commit fabricated or hand-drawn product art as the main README shot.

## Log Explorer acceptance captures

The files below are real captures of the packaged macOS application
investigating deterministic Log Lab corpora.

| File                                    | Size            | What it shows                                                                                                                                                    |
| --------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `log-explorer-align-100k.jpeg`          | 1195 × 768 JPEG | Two composed lanes in exact Align mode, explicit empty/gap cells, useful UTC time, source provenance, and the complete event inspector                           |
| `log-explorer-four-lanes-100k.jpeg`     | 2048 × 560 JPEG | Four composed evidence lanes at ultrawide width, bounded resident rows, compact controls, filters, and linked-chat rail                                          |
| `log-explorer-seven-day-navigator.jpeg` | 1100 × 760 JPEG | Final-bucket seek across a seven-day corpus with the Navigator still open, target row and surrounding evidence mounted, and the selected event inspector visible |

| Property              | Value                                                                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Packaged-app ancestry | `fb363947d091196b1321bab68dbb56663873b137` and `976960739118aab2fc6205c218f8915d8baffa64` acceptance builds; behavior rerun on `3ef9ab44cf3163844a5069b467b5fc5be504d736` |
| Corpus                | Deterministic synthetic Log Lab fixture; 100,000 events across 10 files                                                                                                   |
| Provenance            | Native Computer Use against `ContextDesk.app`; no DOM-only capture and no mockup                                                                                          |
| Claim boundary        | One-machine acceptance evidence only; no universal throughput or provider-tool claim                                                                                      |

The seven-day Navigator frame was captured from the packaged acceptance build
at feature head `1851ed0` (based on `c61a93f`), after importing the default
`seven-day` fixture: 25,000 events across 10 imported source files, spanning
2025-01-01 12:00:00Z through 2025-01-08 12:00:00Z. The screenshot intentionally
shows the final-bucket seek while the Navigator remains open; it is evidence
for the deep-seek visibility repair tracked in
[#627](https://github.com/chriscase/ContextDesk/issues/627), not a claim that
the acceptance branch was already on `main` when captured.

When recapturing, build the packaged app from the intended `main` SHA, import
the deterministic `ui-medium` corpus, avoid diagnostic/error overlays, and
record the exact app SHA and corpus profile. Keep the source corpus and other
generated acceptance artifacts outside Git.

## `gallery/` (product gallery)

All files are real packaged-app crops. No credentials, API keys, or absolute private paths appear in the frames.

| File                             | Surface                                                                                               |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `first-chat-home-narrow.png`     | Empty first-chat home at practical 800×600 (Chat tab)                                                 |
| `first-chat-home-normal.png`     | Empty first-chat home at ~1100×760                                                                    |
| `first-chat-home-wide.png`       | Empty first-chat home at **max width on built-in Retina** (~1427 logical px) — not external ultrawide |
| `help-dark.png`                  | Help Center, Dark theme, normal width                                                                 |
| `help-light.png`                 | Help Center, Light theme                                                                              |
| `help-slate.png`                 | Help Center, Slate theme                                                                              |
| `help-narrow-dark.png`           | Help Center, Dark, 800×600                                                                            |
| `ordinary-chat-session-only.png` | Ordinary chat showing **No files or skill · session-only**                                            |
| `logs-library.png`               | Logs library with Open Explorer entry point                                                           |
| `nav-800x600-chat.png`           | **Chat** pane at 800×600 (first-chat home) — visually verified                                        |
| `nav-800x600-logs.png`           | **Logs** pane at 800×600 — visually verified                                                          |
| `nav-800x600-help.png`           | **Help** pane at 800×600 — visually verified                                                          |
| `main-nav-800x600.png`           | Contact strip of Chat + Logs + Help at 800×600                                                        |

## Honesty notes

- These frames support README product communication and tracker residual audits. They do **not** close owner GUI acceptance [#525](https://github.com/chriscase/ContextDesk/issues/525).
- Multi-chat overflow is visible on the ordinary-chat frame (header chips); dedicated Log Explorer linked-chat **rail** packaged proof remains a residual on [#543](https://github.com/chriscase/ContextDesk/issues/543).
- Sidebar may list local synthetic corpus/chat titles (`incident`, acceptance chats). No secret material.
- **Not claimed:** first-chat product home at true external ultrawide (≥1800 logical px on the LC49G95T). Wide frames are built-in max only.
- Prior mislabeled `nav-800x600-*` gallery frames that showed Source/Compose/Todos were replaced by the verified Chat/Logs/Help set above.

## Publication privacy gate

Native acceptance evidence and public product imagery are different artifacts.
Acceptance captures may stay outside Git when they contain useful but
owner-specific state. An image is publishable only after a human or agent
reviews the exact final bytes and records them in the public-media manifest.
The manifest is a review ledger, not an OCR or secret-scanning claim.

Before adding or replacing a README/gallery image, verify all of the following:

- no provider or model dropdown is open;
- no personally named provider profile, private model inventory, or
  owner-specific selected model is visible;
- no API key, token, credential prompt, account identifier, or notification
  dialog is visible;
- no absolute local path, private hostname, customer/company name, or
  non-synthetic corpus title is visible;
- no private chat content, evaluator truth, developer diagnostic payload, or
  tool trace exposes information that the ordinary product UI should withhold;
- the frame uses a deterministic synthetic fixture and contains no company
  data;
- the capture has no clipped controls, overlapping panes, accidental hover
  state, or content touching a window edge without intentional padding;
- its README caption and alt text claim only what the frame actually proves;
  and
- its exact packaged-app source SHA, fixture/profile, dimensions, theme, and
  publishability review are recorded here.

When the model control is not part of the story, collapse the chat rail or crop
the control out. When it is part of the story, use an intentionally generic
documentation profile created for public captures. Never rely on hiding a
choice in the UI as a security boundary, and never edit a screenshot to imply
that an untested model or provider was used.

### Current inventory audit

Agent review of the exact repository bytes on 2026-07-28 found that the current
raster inventory cannot honestly receive a complete schema-version-1
`public-assets.json` ledger:

- `screenshot.png` and every raster under `gallery/` visibly expose the
  owner-specific `Grok session` profile and/or the selected `grok-3` model.
  `ordinary-chat-session-only.png` additionally shows provider/profile
  diagnostics. The three `nav-800x600-*` frames and `screenshot.png` reuse
  exact image bytes already present elsewhere in the gallery; that duplication
  does not remove the disclosure.
- `log-explorer-seven-day-navigator.jpeg` visibly exposes the selected
  `mistral:latest` model in the application status bar.
- `log-explorer-align-100k.jpeg` and
  `log-explorer-four-lanes-100k.jpeg` do not visibly expose a provider or model
  inventory, but the historical notes identify two possible acceptance-build
  SHAs without an exact per-file mapping. An exact `sourceSha` therefore cannot
  be asserted for either file from the recorded provenance alone.

Because the validator requires every raster in `docs/media/` to be listed as
`publishable`, a partial or passing manifest would misrepresent the current
inventory. The manifest remains intentionally absent. Replace the disclosed
frames with neutral-profile captures, record exact per-file source SHAs, then
review the final bytes and generate the complete ledger.

## Recapture

1. `cd desktop && npm ci && npm run tauri:build` (missing updater private key is OK if `.app` is produced).
2. Open `desktop/src-tauri/target/release/bundle/macos/ContextDesk.app`.
3. Use only synthetic fixtures and a neutral documentation profile; prefer a
   collapsed chat rail when model selection is not the demonstrated feature.
4. Prefer empty first-chat (Cmd+N), Help tab × theme selector, ordinary chat
   with empty context bar, and intentional Log Explorer investigation states.
5. Crop to the app window and apply the publication privacy gate above.
6. Record the exact `git rev-parse HEAD` of the build tree and the final asset
   review in this file.
