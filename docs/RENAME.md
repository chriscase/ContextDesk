# Renaming ContextDesk

The display name is a **working title**. Prefer renaming via configuration rather than a massive string replace.

## Checklist

1. Edit [`branding.toml`](../branding.toml): `product.name`, `product.slug`, paths, themes.
2. Keep Rust crate names as `cd-core` / `cd-server` (stable for dependents). The desktop npm package may stay `contextdesk-desktop` for build stability.
3. Update README title/tagline if needed.
4. **Desktop Tauri identity (#174):** run from `desktop/`:
   ```sh
   npm run gen:tauri-conf
   ```
   This rewrites `src-tauri/tauri.conf.json` `productName`, `app.windows[0].title`, and `identifier` (`cc.chriscase.{slug}`) from `branding.toml`.  
   `beforeDevCommand` / `beforeBuildCommand` invoke the same generator automatically.
5. **Icons:** place a square source PNG (1024×1024 recommended) at `desktop/src-tauri/icons/app-icon-source.png` (or any path), then:
   ```sh
   cd desktop && npx tauri icon src-tauri/icons/app-icon-source.png
   ```
   Commit the generated `src-tauri/icons/*` set. Documented source lives under `desktop/src-tauri/icons/`.
6. User data dirs: document migration if `config_dir_name` / `workspace_dir_name` changes.
7. GitHub repo rename is optional and independent of `branding.toml`.

## Runtime vs build-time

| Surface | Source |
|---------|--------|
| Config/data dirs, tool paths, `get_branding` IPC | `Branding::embedded()` from committed `branding.toml` (#179) |
| Tauri `productName` / window title / bundle `identifier` | `desktop/scripts/gen-tauri-conf.mjs` at build/dev time (#174) |
| App icons | `npx tauri icon <source>` (#174) |

## Smoke test (rename)

```sh
# From repo root — temporary rename (revert afterward)
# 1) Edit branding.toml product.name / product.slug
# 2) cd desktop && npm run gen:tauri-conf
# 3) grep productName src-tauri/tauri.conf.json
# 4) git checkout -- branding.toml desktop/src-tauri/tauri.conf.json
```

## Do not

- Hardcode the product name in deep business logic; call `Branding`.
- Put employer or private product names into default branding committed to git.
