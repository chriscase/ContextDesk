# GUI demo checklist (public fixtures only)

Worktree base: ContextDesk `main` @ `9eb9fa29`.
Use only public fixtures under `fixtures/` (for example `fixtures/cli-release-demo`, `fixtures/company-import-lab`, `fixtures/log-lab`). Do **not** load private corpora.

## Preflight

1. Build and launch the desktop app from this worktree (`desktop/`: `npm ci` then `npm run tauri dev` or the project’s usual package path).
2. Confirm Settings → provider preflight is green for the demo provider (no secrets in chat transcript).
3. Window sizes to exercise: **narrow (~900px)**, **normal (~1280px)**, **ultrawide (≥1800px)**.

## Import + progress (one path)

1. Logs pane → **Import with review…** (or guided import).
2. Select a **public** folder or ZIP.
3. Confirm a **single** progress surface (no duplicate progress panel + duplicate Cancel).
4. Complete import → success summary with selection counts (examined / selected / unsupported kept distinct).
5. Cancel mid-import once: destination stays clean; UI shows cancelled/failed honestly, not “streaming” or partial success.

## Timezone

1. Open a corpus with unresolved local timestamps (company-import-lab or a fixture with zone-less local time).
2. Explorer or Logs → time resolution / timezone review.
3. Apply one source timezone → one clear progress/status path; Explorer events refresh (no stale wall/order labels).
4. Clear declaration → order-only honesty returns where expected.

## Stacking / menus (no collisions)

1. Log Explorer: open **Lanes / corpus / actions** header menus with Chat rail **expanded** and **collapsed** — menus stay fully usable and above the body.
2. Ordinary chat: expand **Context for this chat** → **+ Add context** — panel is fully visible above the composer (not clipped by the transcript dock).
3. Activity toggle menu opens and is not clipped by a narrow rail.
4. Evidence · N / selection “Add” menus remain clickable (not under sticky chat composer).

## Chat truthfulness

1. Ordinary chat: start a turn, **Stop/Cancel** before completion — no ThinkingIndicator / `streaming` chrome after host terminal status; Activity shows cancelled when enabled.
2. Linked chat (Explorer): same cancel race — role line must not say “streaming” once cancelled.
3. Activity Inspector: only live host records (no fixture theater in production).

## Layout

1. Narrow: filter/chat drawers do not permanently bury the event list; Escape/close returns focus safely.
2. Ultrawide: evidence/lanes keep usable width; primary investigation column remains readable; chat measure stays aligned with composer.

## Done when

- [ ] Import/timezone: single progress path, honest terminal states
- [ ] No menu/popover hidden under composer or chat rail
- [ ] Cancel never leaves “streaming” chrome
- [ ] Only public fixtures used
- [ ] `npm run typecheck && npm run lint && npm run test && npm run build` green in `desktop/`
