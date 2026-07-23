# External modules — authoring guide

Third-party tools for ContextDesk run as **MCP servers over stdio**, not as
in-process plugins. This guide is normative for authors; product constraints
come from AGENTS.md and the ADR.

## Normative references

| Document | Role |
|----------|------|
| [ADR 0001: External module substrate](./adr/0001-external-module-substrate.md) | Decision: MCP stdio subprocess only (#133) |
| Manifest schema `cd.module.v1` | Parser in `crates/cd-core/src/modules.rs` (#134) |
| Settings → Modules | Local install / enable / remove (#136) |
| Capability grants | UI-originated only; no self-grant (#135) |
| Reference module | [`examples/modules/echo-notes/`](../examples/modules/echo-notes/) (#138) |

## What a module is

A module is a directory containing:

1. **`module.toml`** — validated against schema `cd.module.v1`
2. An **MCP stdio entrypoint** (absolute command + args) that implements at
   least `initialize`, `tools/list`, and `tools/call`

There is no WASM guest runtime and no `dlopen` of native code into the host.

## Manifest reference (`cd.module.v1`)

```toml
schema = "cd.module.v1"          # exact string required
id = "my-module"                 # stable id; install dir name should match
name = "My Module"               # human label
version = "0.1.0"                # valid semver

hard_write_tools = ["publish"]   # host treats these names as HardWrite
provided_connectors = []         # generic kinds only (e.g. "http") — no employer brands

[entrypoint]
command = "/absolute/path/to/runtime"   # MUST be absolute
args = ["server.mjs"]

[[provided_tools]]
name = "lookup"
description = "Optional UI hint"

[requested_capabilities]
filesystem_roots = []            # host still enforces workspace policy
network_hosts = []               # SSRF policy still applies
secret_refs = []                 # keychain refs only; never raw secrets
```

### Side-effect classes

| Class | Meaning | Default mediation |
|-------|---------|-------------------|
| **Read** | No durable host mutation | May run without prompt when policy allows |
| **SoftWrite** | Local reversible write | UI Accept / session grant |
| **HardWrite** | Destructive or remote-side effect | UI Accept; often type-to-confirm |

The host classifies tools. `hard_write_tools` lists names the host must treat
as HardWrite. Session-wide MCP grants apply to Read tools only; every MCP
SoftWrite/HardWrite requires a fresh action-specific decision. A module
**cannot** declare itself trusted or self-grant capabilities
(`ModuleGrantStore::try_self_grant_from_manifest` always fails).

### Capabilities

`requested_capabilities` is a **request**, not a grant. Empty capabilities mean
tools may attach without first-use capability approval. Non-empty
filesystem/network/secret requests trigger Settings enable approval (#135/#136).

Secrets: the host may inject env vars from the **OS keychain** for granted
`secret_refs`. Modules never receive raw secrets over the webview IPC
(DTOs/bools only).

## Install and enable (Settings)

1. Build or obtain a local directory with `module.toml` + entrypoint files.
2. Open **Settings → Modules**.
3. Enter the **absolute local path** and click **Install** (no network
   marketplace — NON_GOALS #7).
4. Toggle **Enabled**. If capabilities are requested, complete the approval
   dialog (type-to-confirm when required).
5. Tools attach on the next host rebuild; use **Modules** list to confirm
   tools and grant state.

Skills that ship a sibling `module.toml` can provision the same path when the
skill is enabled (**Settings → Skills**, #137).

## Reference module: Echo Notes

Path: [`examples/modules/echo-notes/`](../examples/modules/echo-notes/)

- Language: **Node.js 18+**, zero npm dependencies
- Tools: `note_read` (read buffer), `note_append` (append line)
- Automated check: `cargo test -p cd-core modules` includes a fixture that
  parses this tree’s `module.toml` (entrypoint absolute path normalized for
  the platform in the test)

Manual smoke (desktop):

```text
Settings → Modules → Install → <repo>/examples/modules/echo-notes
→ Enable → confirm tools listed
```

Edit `entrypoint.command` if your Node binary is not reachable via
`/usr/bin/env node`.

## Security guidance for authors

1. **No secret exfiltration** — never log, print, or return keychain material
   or host env secrets in tool results. Prefer host-injected refs only when
   necessary; treat tool I/O as untrusted-visible.
2. **Honor host-assigned side effects** — do not implement “admin” tools that
   assume HardWrite without listing them in `hard_write_tools` and without
   expecting UI mediation. SoftWrite/HardWrite always go through the host.
3. **Respect resource limits** — keep responses bounded; do not spawn unbounded
   subprocess trees or open unrestricted network sockets. Network hosts must
   be declared and still pass SSRF checks.
4. **Grants are host/UI-owned** — a module cannot self-grant. Do not ship
   “auto-approve” flags or claim ambient whole-home FS access.
5. **No employer branding or private URLs in manifests** — generic connector
   kinds only; product strings belong in `branding.toml`, not module source.
6. **Absolute entrypoints only** — no shell strings, no `npx` without a full
   path; host rejects relative commands.

## Browse-only registry (#139)

Optional discovery index (`cd.module.registry.v1` JSON). **Never auto-installs**
(NON_GOALS #7). Defaults: registry disabled, URL empty (no hardcoded company
index). Fetch is SSRF-gated; Settings can also browse a local JSON file.

Install from an entry only when `local_path` is set — that hands off to the
same local Install path as above (#136). Otherwise download/build yourself and
paste the directory path.

Fixture: [`examples/modules/registry-fixture.json`](../examples/modules/registry-fixture.json).

## Out of scope

- Marketplace auto-install (forbidden; browse is metadata-only)
- Embedding a third-party agent runtime (NON_GOALS #8)
- WASM / native dylib substrates (rejected in ADR 0001)

## Verification

```sh
# Manifest fixture (offline)
cargo test -p cd-core modules -- --nocapture

# Optional: run the MCP stub by hand (Node must be installed)
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  | /usr/bin/env node examples/modules/echo-notes/server.mjs
```
