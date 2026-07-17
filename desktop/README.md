# ContextDesk desktop (UI)

React + Vite UI shell. Modular CSS under `src/styles/` (tokens, themes, components). Dark mode default.

## Dev (browser)

```sh
npm install
npm run dev
```

## Tauri

Tauri host wiring is tracked in issue **#12**. Until then, iterate on the UI in the browser.

## Conventions

- No secrets in the webview
- Component CSS in files — not scattered inline styles
- SVG icons in `src/components/icons.tsx`
