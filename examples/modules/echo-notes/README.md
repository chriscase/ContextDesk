# Echo Notes (reference module)

Minimal third-party module for ContextDesk (`cd.module.v1`). See
[docs/MODULES.md](../../../docs/MODULES.md) for the full authoring guide.

## Contents

| File | Role |
|------|------|
| `module.toml` | Manifest (schema, entrypoint, tools, capabilities) |
| `server.mjs` | MCP stdio stub (Node 18+, no npm install) |

## Tools

| Tool | Declared intent | Host side-effect |
|------|-----------------|------------------|
| `note_read` | Read buffer | **Read** (default unless listed in `hard_write_tools`) |
| `note_append` | Append line | **Read** unless host maps it; SoftWrite grants still apply when host classifies writes |

Side-effect classes are **host-assigned**. Listing a tool in the manifest does
not grant permission; the host may reclassify and always mediates SoftWrite/HardWrite.

## Local install

1. Ensure `module.toml` `entrypoint.command` is an **absolute** path to a runner
   that can execute `server.mjs` (default `/usr/bin/env` + `node` args).
2. In the desktop app: **Settings → Modules → Install (local)** and paste the
   absolute path to this directory.
3. Enable the module; approve capability grants if prompted (this sample
   requests none).
4. After host rebuild/attach, tools appear under the module’s MCP namespace.

Do not use network/marketplace auto-install (product non-goal).
