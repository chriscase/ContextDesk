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
