# Renaming ContextDesk

The display name is a **working title**. Prefer renaming via configuration rather than a massive string replace.

## Checklist

1. Edit [`branding.toml`](../branding.toml): `product.name`, `product.slug`, paths, themes.
2. Keep Rust crate names as `cd-core` / `cd-server` (stable for dependents).
3. Update README title/tagline if needed (or generate from branding in a release script later).
4. Desktop package ids (`tauri.conf.json` productName, bundle identifiers) — use slug.
5. User data dirs: document migration if `config_dir_name` changes (`.contextdesk` → new).
6. GitHub repo rename is optional and independent of `branding.toml`.

## Do not

- Hardcode the product name in deep business logic; call `Branding`.
- Put employer or private product names into default branding committed to git.
