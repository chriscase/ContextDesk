# Third-party notices — ContextDesk CLI

This binary is built from the ContextDesk monorepo and links open-source
Rust crates declared in `Cargo.lock`. SPDX license identifiers and crate
names are the source of truth for redistribution compliance.

## How to regenerate a detailed inventory

```bash
# From a checkout with cargo-license (optional operator tool):
cargo license -p cd-cli --json > third-party-licenses.json
```

The release SBOM (`sbom.cdx.json`) attached to draft CLI releases lists
archive digests and the application component version/git identity.

## License of ContextDesk itself

Apache-2.0 — see the `LICENSE` file shipped beside this notice.
