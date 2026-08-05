# Language integration — ContextDesk CLI subprocess protocol

Integrate ContextDesk from **Python, Node/TypeScript, Java, C#, Go, C, C++, or
Rust** by spawning the **authoritative `contextdesk` executable**. Adapters are
thin clients: argv + env + parse JSON/JSONL + map exit codes.

> **Never reimplement log parsing, import selection, or normalization in the
> client language.** One host binary owns product grammar. Clients only invoke
> it.

| Document | Role |
| -------- | ---- |
| **This page** | Integrator guide + minimal examples |
| [`CLI_CLIENT_PROTOCOL.md`](CLI_CLIENT_PROTOCOL.md) | Compact protocol reference |
| [`packages/cli-clients/`](../packages/cli-clients/) | Checked-in thin reference clients |
| [`fixtures/cli-client-protocol/`](../fixtures/cli-client-protocol/) | Shared envelope / progress fixtures |
| [`CLI.md`](CLI.md) | Full CLI grammar and ops |

## Status

| Item | Status |
| ---- | ------ |
| Subprocess + JSON envelope + exit categories | **Shipped** |
| Thin reference clients (8 languages) | **Shipped** (examples, not full SDKs) |
| Published language packages on npm/PyPI/Maven/… | **Not shipped** |
| C ABI / JNI / local long-running service | **Future** (staged only) |
| Client-side Parquet readers as product surface | **Not required / not shipped** — read JSONL files with ordinary tools |

### When you need no SDK

- **Consume normalize output:** open `sources/*.jsonl` and
  `normalization-report.json` with any JSONL/JSON library.
- **Drive import/explore/chat:** spawn `contextdesk` with `--json` / `--jsonl`.
- **Parquet:** not a shipped CLI export format on this tip — do not claim it.

## Process model

```
your app  --argv[] + env-->  contextdesk
          <-- stdout JSON / JSONL --
          <-- stderr progress (human) --
          <-- exit code category --
```

### Safe argument construction (no shell)

```text
# Good — argv array
["contextdesk", "--data-dir", dataDir, "--json", "capabilities"]

# Forbidden — shell string with untrusted input
"contextdesk --data-dir " + userPath + " import " + userFile
```

Use `subprocess` / `spawn` / `ProcessBuilder` / `exec.Command` / `CreateProcess`
with a **list of arguments**. Set `shell=False` / `UseShellExecute=false`.

### Resolve the binary

1. Explicit config path, or
2. Env `CONTEXTDESK_BIN`, or
3. Well-known install location you control.

Do not concatenate untrusted input into a `PATH` search without validation.

## Capability / version handshake

```bash
# Executable
contextdesk --data-dir "$DATA" --json capabilities
```

Success envelope (shape):

```json
{
  "schema_version": 1,
  "ok": true,
  "command": "capabilities",
  "data": {
    "cli_version": "0.1.0",
    "envelope_schema_version": 1,
    "git_sha": "…",
    "git_describe": "…",
    "build_channel": "installed",
    "exit_categories": [{"code": 0, "kind": "success"}],
    "commands": ["import", "corpus list", "…"]
  }
}
```

Fixture: [`fixtures/cli-client-protocol/capabilities.ok.json`](../fixtures/cli-client-protocol/capabilities.ok.json).

Client rules:

1. Reject `ok: false`.
2. Record `cli_version`, `envelope_schema_version`, `git_sha`, `build_channel`.
3. Ensure required commands exist (e.g. `import`, `capabilities`; `normalize` only if you need it).
4. Map later process exits via `exit_categories`.

## Working directory, data directory, environment

| Variable / flag | Role |
| --------------- | ---- |
| `--data-dir` / `CONTEXTDESK_DATA_DIR` | Isolates config, cache, sessions, CLI state |
| `CONTEXTDESK_BIN` | Path to executable for adapters |
| `CONTEXTDESK_FORMAT` | `text` / `json` / `jsonl` |
| `CONTEXTDESK_WORKING_DIR` | Optional base for relative source paths (normalize) |
| `CONTEXTDESK_NORMALIZE_OUTPUT` | Default normalize `--output` |
| CWD | Relative input paths only; prefer absolute paths in CI |

Provider secrets stay in the **OS keychain** via host config — never pass raw
API keys on argv.

## One-shot JSON envelope (`--json`)

Success: `schema_version`, `ok: true`, `command`, `data`.  
Failure: `ok: false`, `error: { kind, message }`.

Fixtures: `envelope.ok.json`, `envelope.err.json` under
[`fixtures/cli-client-protocol/`](../fixtures/cli-client-protocol/).

## JSONL progress and terminal (`--jsonl`)

Long operations (import, normalize, chat, doctor) may emit **one JSON object
per line** on stdout. Progress lines use `type: "progress"` and
`schema_version: 1` (see `crates/cd-cli/src/progress.rs`).

Fixture: [`progress.line.json`](../fixtures/cli-client-protocol/progress.line.json).

Terminal lines use the stream schema `contextdesk.cli.stream.v1` where
applicable. **Process exit code remains authoritative** if the stream ends
early.

## Cancellation

- Interactive: Ctrl-C → exit **130** (`cancelled`).
- Programmatic: signal the process (SIGINT) or terminate the process group
  you created; do not leave orphaned children.
- Import/normalize are designed so cancel does not publish partial durable
  output.

## Exit / error mapping

| Code | Kind | Typical use |
| ---- | ---- | ----------- |
| 0 | success | Completed |
| 1 | user_error | Bad args / non-empty output dir |
| 3 | not_found | Missing corpus / path |
| 4 | conflict | Stale revision |
| 5 | permission_denied | Tool grant denied |
| 6 | provider_error | Model/gateway |
| 7 | not_implemented | Grammar accepted, feature not shipped |
| 8 | not_ready | Doctor verdict |
| 70 | internal | Unexpected |
| 130 | cancelled | SIGINT / cancel |

Prefer `error.kind` from JSON when present; else map the exit code.

## Minimal tested examples

Reference clients under [`packages/cli-clients/`](../packages/cli-clients/) —
each spawns the binary (no product parsers).

### Python

```bash
# Executable (requires built binary)
export CONTEXTDESK_BIN=./target/release/contextdesk
python3 packages/cli-clients/python/contextdesk_client.py capabilities --data-dir /tmp/cd-py
```

### Node / TypeScript

```bash
export CONTEXTDESK_BIN=./target/release/contextdesk
node packages/cli-clients/node/contextdesk_client.mjs capabilities --data-dir /tmp/cd-node
```

### Java

```bash
# Illustrative compile + run (JDK required)
javac packages/cli-clients/java/ContextDeskClient.java
CONTEXTDESK_BIN=./target/release/contextdesk \
  java -cp packages/cli-clients/java ContextDeskClient capabilities --data-dir /tmp/cd-java
```

### C#

```bash
# Illustrative — .NET SDK required
# See packages/cli-clients/csharp/ContextDeskClient.cs (ProcessStartInfo + ArgumentList)
```

### Go

```bash
# Illustrative
CONTEXTDESK_BIN=./target/release/contextdesk go run packages/cli-clients/go/contextdesk_client.go capabilities
```

### C / C++

```bash
# Illustrative
cc -o /tmp/cd-c packages/cli-clients/c/contextdesk_client.c
CONTEXTDESK_BIN=./target/release/contextdesk /tmp/cd-c capabilities
```

### Rust

```bash
# Illustrative
CONTEXTDESK_BIN=./target/release/contextdesk \
  cargo run --manifest-path packages/cli-clients/rust/Cargo.toml -- capabilities
```

### Shared conformance

```bash
# Executable
python3 scripts/cli-release/check_client_protocol_fixtures.py
```

## Automation / CI sketch

```bash
set -euo pipefail
cargo build -p cd-cli --release
export CONTEXTDESK_BIN="$PWD/target/release/contextdesk"
export CONTEXTDESK_DATA_DIR="${RUNNER_TEMP:-/tmp}/cd-ci-$$"
"$CONTEXTDESK_BIN" --json capabilities
"$CONTEXTDESK_BIN" --json import ./fixtures/cli-release-demo
# Optional when normalize exists:
# "$CONTEXTDESK_BIN" normalize ./fixtures/cli-release-demo --output "$CONTEXTDESK_DATA_DIR/norm" --json
```

## Future options (not this path)

| Option | Status |
| ------ | ------ |
| Direct C ABI into `cd-core` | Future |
| JNI package | Future |
| Local gRPC/HTTP service wrapping the engine | Future |

Until then: **one executable**, many thin clients.
