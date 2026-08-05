# ContextDesk CLI — Quick start

Binary name: **`contextdesk`**.

## Install from a release archive

1. Download the archive for your platform (`contextdesk-<version>-<platform>.tar.gz` or `.zip`).
2. Extract it.
3. Put `contextdesk` (or `contextdesk.exe`) on your `PATH`, or invoke it by absolute path.
4. Verify identity:

```bash
contextdesk --version
contextdesk capabilities --json
```

Expect non-empty `git_sha`, `git_describe`, and `build_channel` on release builds.

## Isolated demo (no desktop profile)

```bash
contextdesk --data-dir ./cd-data import ./demo
contextdesk --data-dir ./cd-data corpus list --json
contextdesk --data-dir ./cd-data explore "timeout" --json
```

`--data-dir` keeps all state out of `~/.contextdesk` so scripts never touch a
developer's desktop profile.

## Machine-readable clients

Prefer:

| Mode | Flag | Shape |
|------|------|--------|
| One-shot | `--json` | Single JSON envelope (`schema_version`, `ok`, `command`, `data`/`error`) |
| Streaming | `--jsonl` | One JSON object per line (`type`, progress / result / terminal) |

Never construct a shell command string — spawn the binary with an argv array.
See `docs/CLI_CLIENT_PROTOCOL.md` and `packages/cli-clients/`.

## Signing note (RC)

Release-candidate archives from CI are **unsigned**:

- macOS: not notarized / not stapled
- Windows: no Authenticode signature

See `docs/CLI_PACKAGING.md` for residual signing requirements.
