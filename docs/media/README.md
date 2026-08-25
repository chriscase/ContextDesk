# Public product media

Screenshots referenced by the top-level `README.md` are native captures of the
packaged application. They communicate visible product behavior; they are not
proof of provider quality, tool-loop success, universal performance,
company-data behavior, or owner acceptance.

## Exact app-build capture template

`docs/media/public-assets.json` is the authority for which app-source SHA each
published frame came from, so this section states it **per file** rather than in
aggregate. The current gallery was not captured from a single build — it spans
two, recorded below. Later documentation-only commits may advance repository
`HEAD` without changing the packaged application bytes.

| Property | Required value |
| --- | --- |
| App | Packaged macOS `.app` from `desktop/src-tauri/target/release/bundle/macos/ContextDesk.app` |
| Capture method | Native packaged-app window capture, cropped to the application window |
| Updater signing | Public key present; private key intentionally unset for the local unsigned bundle |

| File | Surface | Dimensions | App-source SHA |
| --- | --- | --- | --- |
| `gallery/logs-library-demo.png` | Synthetic 25,000-event corpus in the Logs library | 1100 × 760 PNG | `4cbdf664a794af3f424cd5bba8a4c621c3df3bae` |
| `gallery/log-explorer-investigation.png` | Synthetic Log Explorer investigation with aligned CPU/heap/client tracks, two lanes, payload-focused rows, and the chat rail collapsed | 1195 × 768 PNG | `fb30c99638a7c443c0d6acd23f914f865b9577eb` |
| `gallery/help-appearance.png` | Demo-datasets Help article with the public Appearance picker open | 1100 × 760 PNG | `4cbdf664a794af3f424cd5bba8a4c621c3df3bae` |

`scripts/check_public_media.mjs` requires every `sourceSha` recorded in the
ledger to appear in this file, so a recapture cannot silently leave this table
naming a build that no longer produced the frame.

It also requires every image the top-level `README.md` publishes to be a ledger
entry. Enforcement covers the three forms GitHub renders — inline
`![alt](path)`, reference style (`![alt][label]` with its `[label]:`
definition, including the collapsed and shortcut spellings), and raw
`<img src="path">`. Remote `http(s)`/`data:` sources are skipped as
non-repository media. Local raster syntax the checker cannot resolve — an
`<img>` whose `src` is not a quoted literal, or a reference image naming a
raster with no definition — is rejected rather than ignored.

The exact Git blob identities and completed byte-level publication review are
recorded in `docs/media/public-assets.json`.

## War Room web capture set

The War Room frames are captured from the loopback synthetic web demo, not
from a live provider or a customer installation. They all use the same exact
post-release source SHA and the deterministic, memory-backed checkout-timeout
fixture. The browser viewport is 1280 × 720; no provider/model inventory,
credential, private path, or non-synthetic corpus is visible.

| File | Surface | Dimensions | Source SHA | Fixture |
| --- | --- | --- | --- | --- |
| `gallery/war-room-overview.png` | Overview activity feed and active investigation | 1280 × 720 PNG | `ea3f2cd58e26b21c6719d8ee543d7ba77cce59bd` | Synthetic checkout-timeout War Room demo |
| `gallery/war-room-capture-analyze.png` | Capture provenance, imported-output boundary, and corpus intake | 1280 × 720 PNG | `ea3f2cd58e26b21c6719d8ee543d7ba77cce59bd` | Synthetic checkout-timeout War Room demo |
| `gallery/war-room-analyze.png` | Evidence board, snapshot lineage, and model lanes | 1280 × 720 PNG | `ea3f2cd58e26b21c6719d8ee543d7ba77cce59bd` | Synthetic checkout-timeout War Room demo |
| `gallery/war-room-compare-decide.png` | Comparison lab, historical artifacts, deep links, and lane focus | 1280 × 720 PNG | `ea3f2cd58e26b21c6719d8ee543d7ba77cce59bd` | Synthetic checkout-timeout War Room demo |
| `gallery/war-room-decide-export.png` | Accepted human decision journal | 1280 × 720 PNG | `ea3f2cd58e26b21c6719d8ee543d7ba77cce59bd` | Synthetic checkout-timeout War Room demo |
| `gallery/war-room-export.png` | Accepted decision and share-safe export boundary | 1280 × 720 PNG | `ea3f2cd58e26b21c6719d8ee543d7ba77cce59bd` | Synthetic checkout-timeout War Room demo |

**Known residual — this is not a single-build gallery.** #734 asks for one
exact packaged-app SHA and #677 asks for frames current with the promoted
build. Two frames predate the third, and `gallery/logs-library-demo.png` was
captured before the Logs toolbar was regrouped, so it no longer matches
production. Closing that requires native recapture from one freshly built
`.app`; it cannot be discharged by editing this file.

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

1. Build one packaged application and capture every frame from it, so the
   gallery stops spanning two builds (see the residual above). Record that one
   app-source SHA against every replaced frame in the ledger. A later
   repository `HEAD` is acceptable only when every intervening change is
   documentation-only and cannot alter the packaged application bytes.
2. Check out that exact app-source SHA in an isolated worktree and build it:

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
     optional synthetic CPU/heap/client tracks, payload-focused rows, timeline
     and investigation controls, chat rail fully collapsed, and no hover cards
     or popovers.
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
