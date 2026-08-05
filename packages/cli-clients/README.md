# Thin language clients for `contextdesk`

These are **reference invocations**, not SDKs. Each spawns the authoritative
`contextdesk` executable with an argv array, reads JSON envelopes, and maps
exit codes. They do **not** parse logs or reimplement product logic.

See `docs/CLI_CLIENT_PROTOCOL.md`.

| Language | Entry |
|----------|--------|
| Python | `python/contextdesk_client.py` |
| Node / TypeScript | `node/contextdesk_client.mjs` |
| Java | `java/ContextDeskClient.java` |
| C# | `csharp/ContextDeskClient.cs` |
| Go | `go/contextdesk_client.go` |
| C | `c/contextdesk_client.c` |
| C++ | `cpp/contextdesk_client.cpp` |
| Rust | `rust/src/main.rs` |

**Future (not implemented here):** direct C ABI, JNI, local service.
