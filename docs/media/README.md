# Public product media

Screenshots referenced by the top-level `README.md` are native captures of the
packaged application. They communicate visible product behavior; they are not
proof of provider quality, tool-loop success, universal performance,
company-data behavior, or owner acceptance.

## Exact app-build capture template

The already-built application intended for the three replacement frames was
built from exact app-source SHA
`2be6f56c3ddab6e0b1d481d6ca42a4720dc78040`. Later documentation-only commits
may advance repository `HEAD` without changing those packaged application
bytes.

| Property | Required value |
| --- | --- |
| App | Packaged macOS `.app` from `desktop/src-tauri/target/release/bundle/macos/ContextDesk.app` |
| App-source SHA | `2be6f56c3ddab6e0b1d481d6ca42a4720dc78040` |
| Capture method | Native packaged-app window capture, cropped to the application window |
| Updater signing | Public key present; private key intentionally unset for the local unsigned bundle |

| File | Surface | Dimensions |
| --- | --- | --- |
| `gallery/logs-library-demo.png` | Synthetic 25,000-event corpus in the Logs library | 1100 × 760 PNG |
| `gallery/log-explorer-investigation.png` | Synthetic Log Explorer investigation with timeline, two lanes, payload-focused rows, and the chat rail collapsed | 1195 × 768 PNG |
| `gallery/help-appearance.png` | Demo-datasets Help article with the public Appearance picker open | 1100 × 760 PNG |

The exact Git blob identities and completed byte-level publication review are
recorded in `docs/media/public-assets.json`.

## Publication privacy gate

Native acceptance evidence and public product imagery are different artifacts.
Acceptance captures may remain outside Git when they contain useful but
owner-specific state. An image is publishable only after a human or agent
reviews the exact final bytes and records them in the public-media manifest.
The manifest is a review ledger, not an OCR or secret-scanning claim.

Before adding or replacing a public image, verify all of the following:

- no provider or model dropdown is open;
- no personally named provider profile, private model inventory, or
  owner-specific selected model is visible;
- no API key, token, credential prompt, account identifier, or notification
  dialog is visible;
- no absolute local path, private hostname, customer or company name, or
  non-synthetic corpus title is visible;
- no private chat content, evaluator truth, developer diagnostic payload, or
  tool trace exposes information that the ordinary product UI should withhold;
- the frame uses a deterministic synthetic fixture and contains no company
  data;
- the capture has no clipped controls, overlapping panes, accidental tooltip,
  hover card, popover, or content touching a window edge without intentional
  padding;
- its README caption and alt text claim only what the frame actually shows;
- its exact packaged-app source SHA, fixture, dimensions, theme, and
  publishability review are recorded; and
- every raster under `docs/media/` appears exactly once in the complete
  `public-assets.json` ledger.

When the model control is not part of the story, collapse the chat rail or crop
the control out. When it is part of the story, use an intentionally generic
documentation profile created for public captures. Never rely on hiding a
choice in the UI as a security boundary, and never edit a screenshot to imply
that an untested model or provider was used.

## Recapture procedure

1. Use the already-built packaged application whose exact app-source SHA is
   `2be6f56c3ddab6e0b1d481d6ca42a4720dc78040`. A later repository `HEAD` is
   acceptable only when every intervening change is documentation-only and
   cannot alter the packaged application bytes.
2. If the app must be rebuilt, check out the exact app-source SHA in an
   isolated worktree and build it:

   ```sh
   cd desktop
   CARGO_TARGET_DIR="$PWD/src-tauri/target" \
     npm run tauri:build -- --bundles app
   ```

   A missing updater-signing private-key error after the `.app` is produced is
   expected. Do not request, create, expose, or simulate a release signing key.

3. Open
   `desktop/src-tauri/target/release/bundle/macos/ContextDesk.app` and capture
   only the application window using deterministic synthetic data.
4. Capture these final states:
   - Logs library: installed synthetic demo corpus, settled import summary, no
     menus, diagnostics, private paths, chat, or model controls.
   - Log Explorer: synthetic 25k corpus, two composed lanes, aligned time,
     payload-focused preview rows, timeline and investigation controls, chat
     rail fully collapsed, and no hover cards or popovers.
   - Help: demo-datasets article with only the public Appearance theme names,
     descriptions, and palettes visible.
5. Review the exact final pixels against the publication privacy gate.
6. Replace every pending dimensions marker with the measured width and height.
7. Calculate each final image's Git blob ID and create the complete
   `docs/media/public-assets.json` ledger using the exact app-source SHA above,
   not the later documentation commit SHA.
8. Validate before committing:

   ```sh
   node --test scripts/check_public_media.test.mjs
   node scripts/check_public_media.mjs
   git diff --check
   git status --short
   ```

   The media validator must report exactly three assets. Render the README once
   more and visually inspect every referenced image and caption before
   publication.

If any crop is changed after review, repeat the pixel review, dimension
measurement, Git blob calculation, manifest update, and validation. The exact
final bytes—not an earlier capture—are the publication artifact.
