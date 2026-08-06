# ContextDesk CLI — language-neutral subprocess client protocol

**Authority:** the `contextdesk` executable is the only product engine.
Every language adapter is a **thin client**: it spawns the binary with an
**argv array** (never a shell command string), passes env/cwd/data-dir,
reads stdout/stderr, and maps exit codes.

This document is the stable contract for Python, Node/TypeScript, Java, C#,
Go, C, C++, and Rust clients. Reference invocations live under
`packages/cli-clients/`. Shared fixtures live under
`fixtures/cli-client-protocol/`.

## Non-goals (staged / future)

| Option | Status |
|--------|--------|
| Direct C ABI into `cd-core` | **Future** — not the primary path |
| JNI package | **Future** |
| Local long-running gRPC/HTTP service | **Future** |
| Independent log parsers in client languages | **Forbidden** — use the binary |

## Process model

```
client  --argv+env-->  contextdesk  --stdout JSON/JSONL-->  client
                       \--stderr progress/human--> client (optional)
                       \--exit code category--> client
```

### Required client rules

1. **No shell construction.** Use `execve` / `CreateProcess` / `subprocess` with a list of arguments. Never `system("contextdesk " + user_input)`.
2. **Resolve the binary explicitly.** Config path, env `CONTEXTDESK_BIN`, or well-known install location — not `PATH` guesswork mixed with untrusted input without validation.
3. **Isolate state** with `--data-dir <dir>` (or `CONTEXTDESK_DATA_DIR`) for non-interactive automation.
4. **Prefer `--json` or `--jsonl`** for machine parsing; do not scrape human text.
5. **Capabilities handshake first** in long-lived clients.

## Capabilities handshake

```bash
contextdesk --data-dir "$DATA" --json capabilities
```

Envelope (`schema_version` = 1):

```json
{
  "schema_version": 1,
  "ok": true,
  "command": "capabilities",
  "data": {
    "product_name": "ContextDesk",
    "cli_version": "0.1.0",
    "envelope_schema_version": 1,
    "git_sha": "…",
    "git_describe": "…",
    "build_channel": "installed",
    "exit_categories": [{"code": 0, "kind": "success"}, …],
    "commands": ["import", "normalized validate", …],
    "completed_verdict_categories": [
      {"code": 8, "kind": "not_ready"},
      {"code": 9, "kind": "non_conforming"},
      {"code": 10, "kind": "partial"}
    ],
    "normalized": {
      "event_schema_id": "contextdesk.normalized_log_events.v1",
      "validation_schema_id": "contextdesk.normalized_validation.v1",
      "summary_schema_id": "contextdesk.normalized_summary.v1",
      "inspection_schema_version": 1,
      "max_files": 4096,
      "max_directories": 4096,
      "max_directory_entries": 65536,
      "max_retained_diagnostics": 512
    }
  }
}
```

Client must:

- Reject `ok: false`.
- Record `cli_version`, `envelope_schema_version`, `git_sha`, `build_channel`.
- Map `exit_categories` for later process exits.
- Treat `completed_verdict_categories` as report-bearing completions and
  handshake normalized schema ids/versions/limits before depending on them.
- Fail closed if required commands for the integration are absent.

Fixture: `fixtures/cli-client-protocol/capabilities.ok.json`.

## One-shot result envelope (`--json`)

Success:

```json
{
  "schema_version": 1,
  "ok": true,
  "command": "import",
  "data": { }
}
```

Failure:

```json
{
  "schema_version": 1,
  "ok": false,
  "command": "import",
  "error": { "kind": "user_error", "message": "…" }
}
```

Fixture: `fixtures/cli-client-protocol/envelope.ok.json`, `envelope.err.json`.

### Completed verdict envelope (`ok:true` + nonzero exit)

Exits 8 (`not_ready`), 9 (`non_conforming`), and 10 (`partial`) mean the
command completed and its report is authoritative, but the verdict should fail
an automation gate. The envelope remains `ok:true` and carries `data`; it is
not an internal error. Clients return a typed result containing the envelope,
exit code, and verdict kind. They must preserve the nonzero exit when used as a
command-line wrapper. Any other `ok:true` + nonzero exit is a protocol error.

Fixture: `fixtures/cli-client-protocol/envelope.completed-verdict.json`.

## JSONL progress + terminal (`--jsonl`)

Streaming commands (import progress, chat, doctor) may emit **one JSON object per line** on stdout.

Progress line (schema version 1):

```json
{
  "type": "progress",
  "schema_version": 1,
  "phase": "ingest",
  "fraction": 0.4,
  "message": "…"
}
```

Terminal lines use the shared stream envelope fields documented in
`crates/cd-cli/src/envelope.rs` (`JSONL_STREAM_SCHEMA` =
`contextdesk.cli.stream.v1`). Clients should:

1. Read line-by-line (no multi-line JSON).
2. Dispatch on `type` / `schema` fields.
3. Treat process exit as the final authority if the stream ends without a terminal event.

Fixtures: `fixtures/cli-client-protocol/progress.line.json`, `stream.terminal.done.json`.

### Chat trace semantics

For `type: "trace_summary"`, clients should prefer the precise additive
fields over the legacy union:

- `tools_executed`: tools with actual host lifecycle events;
- `tools_offered`: schemas made available to a provider call;
- `tool_names`: backward-compatible union of the two;
- `retrieved_evidence` / `evidence_ids`: governed citation identities,
  including trusted identities produced by deterministic broad triage;
- `grounding_scope: "citation_identity_only"`: cited identities were checked,
  not the model's interpretation or causal conclusion;
- `interpretation_validated: false`: v1 has no deterministic diagnosis oracle.

Do not infer that an offered tool ran, or that `grounding: "grounded"`
certifies a root-cause conclusion.

## Exit / error mapping

Stable categories (`crates/cd-cli/src/envelope.rs`):

| Code | Kind | Meaning |
|------|------|---------|
| 0 | success | Completed as stated |
| 1 | user_error | Invalid args / input |
| 3 | not_found | Missing corpus/session/… |
| 4 | conflict | Stale revision / concurrent change |
| 5 | permission_denied | Tool/permission denied |
| 6 | provider_error | Model/provider failure |
| 7 | not_implemented | Grammar accepted, behavior not shipped |
| 8 | not_ready | Doctor verdict not ready |
| 9 | non_conforming | Normalized inspection completed; content is invalid |
| 10 | partial | Normalize published valid output; report is partial |
| 70 | internal | Unexpected bug |
| 130 | cancelled | Ctrl-C / SIGINT |

Map `error.kind` from JSON when present; otherwise map process exit code via the capabilities table.
For exits 8/9/10, map the completed verdict and retain the `ok:true` report
instead of constructing an error envelope.

## Cancellation

- Interactive: Ctrl-C → process exits **130** (`cancelled`).
- Programmatic: send **SIGINT** (Unix) or terminate the process group the client created; do not leave orphaned children.
- Import/cancel is designed so partial publishes are not left behind (engine cleanup).

Clients should create a new process group when they need to cancel a tree of children.

## Working directory, data directory, environment

| Concern | Contract |
|---------|----------|
| CWD | May affect relative input paths only; not used for secret discovery when `--data-dir` is set |
| `--data-dir` / `CONTEXTDESK_DATA_DIR` | Isolates config, cache, sessions, CLI state |
| `CONTEXTDESK_BIN` | Optional absolute path to the executable for adapters |
| `CONTEXTDESK_FORMAT` | `json` / `jsonl` / text |
| `CONTEXTDESK_ASCII` | Human-terminal typography only (`1` ASCII, `0` Unicode); machine JSON/JSONL is always UTF-8 |
| Provider secrets | OS keychain via host config — never pass raw API keys on argv |

`normalized validate`, `normalized summarize`, `normalize`, and `capabilities`
are state-free: they do not read or create the data directory, app/project CLI
config, provider config, or CLI state. Explicit input/output paths and global
format/color flags remain authoritative for these commands.

## Minimal invocation shape (all languages)

```
argv = [bin, "--data-dir", data_dir, "--json", "capabilities"]
env  = parent_env  # plus optional CONTEXTDESK_* 
cwd  = optional project directory for relative paths
```

Reference clients:

| Language | Path |
|----------|------|
| Python | `packages/cli-clients/python/contextdesk_client.py` |
| Node/TS | `packages/cli-clients/node/contextdesk_client.mjs` |
| Java | `packages/cli-clients/java/ContextDeskClient.java` |
| C# | `packages/cli-clients/csharp/ContextDeskClient.cs` |
| Go | `packages/cli-clients/go/contextdesk_client.go` |
| C | `packages/cli-clients/c/contextdesk_client.c` |
| C++ | `packages/cli-clients/cpp/contextdesk_client.cpp` |
| Rust | `packages/cli-clients/rust/src/main.rs` |

Each file is intentionally small: spawn + parse envelope + map exit. **No product parsers.**

## Conformance

```bash
python3 scripts/cli-release/check_client_protocol_fixtures.py
# Optional live (needs built binary):
CONTEXTDESK_BIN=target/release/contextdesk \
  python3 packages/cli-clients/python/contextdesk_client.py capabilities
```

## Versioning

- Envelope `schema_version` and JSONL `schema_version` / `JSONL_STREAM_VERSION` bump only on breaking shape changes.
- New optional fields are non-breaking.
- New exit categories use unused sparse codes — never renumber existing ones.
