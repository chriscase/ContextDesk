# docs/media

Screenshots and GIFs referenced by the top-level `README.md`.

## `screenshot.png` (shipped)

Real capture of the running desktop app (Tauri host, macOS), contributed via
[#176](https://github.com/chriscase/ContextDesk/issues/176) (attachment on the
issue, then committed here).

**What it shows:** empty chat shell with brand tagline, three starter chips
(How auth works / Summarize files / Remember this project), session sidebar,
pane tabs (Chat…Todos), composer with model picker, workspace + session chips
in the titlebar, preflight-ok status bar.

| Property | Value |
|----------|--------|
| Size | 1102 × 764 PNG |
| Source | Live `tauri:dev` / desktop host — not fabricated |

## Recapture instructions (if updating)

1. Run the desktop app: `cd desktop && npm install && npm run tauri:dev`.
2. Add the bundled `fixtures/kb/` folder as an allowlisted workspace.
3. Configure a local or remote chat model in Settings → AI.
4. Prefer either:
   - **Empty shell** (current asset): starters + composer visible, or
   - **Cited answer:** ask *"How does authentication work in this codebase?"*
     and wait for stream + search trail + citations before capture.
5. Screenshot the window and replace `screenshot.png` here.
   If a GIF is used instead, keep it under ~3 MB.

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
