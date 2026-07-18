# docs/media

Screenshots and GIFs referenced by the top-level `README.md`.

## `screenshot.png` (expected)

The main README references `docs/media/screenshot.png` with alt text describing
a chat answer with inline file citations and a search trail beside an
allowlisted workspace.

**Capture instructions (coordinator / maintainer):**

1. Run the desktop app: `cd desktop && npm install && npm run tauri:dev`.
2. Add the bundled `fixtures/kb/` folder as an allowlisted workspace.
3. Configure the **Ollama (local)** provider (`http://127.0.0.1:11434`, e.g. `mistral`).
4. Ask *"How does authentication work in this codebase?"* and wait for the
   streaming answer, the search trail, and citations back to `fixtures/kb/auth.md`.
5. Screenshot the window and commit it here as `screenshot.png`.
   If a GIF is used instead, keep it under ~3 MB.

Until the real capture lands, the README image link resolves to this directory's
missing file on purpose — do not commit a fabricated or hand-drawn screenshot.
