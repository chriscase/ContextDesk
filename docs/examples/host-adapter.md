# Host adapter (embed) example

Runnable third-party host surface for `cd-core` (#170, finishing #53).

## Embed surface (honest)

There is no separate proprietary host SDK. An embedder uses the **public**
`cd-core` API only:

| API | Role |
|-----|------|
| `Workspace::new` | Scope roots |
| `research::build_host` | Tool host + index |
| `research::research_local` / `research_turn` | Offline or provider-backed turn |
| `research::events_to_dto` | Wire-shaped `EventDto` list |
| `research::grant_and_execute` | Permission grants after `permission_required` |

No commercial desktop app types appear in `cd-core`. Secrets stay in the host
process (keychain) when using `research_turn` with a real provider.

## Runnable example

```sh
# From repo root — offline, no API keys
cargo run -p cd-core --example embed_host -- ./path/to/notes "payments"
```

Source: [`crates/cd-core/examples/embed_host.rs`](../../crates/cd-core/examples/embed_host.rs).

The loop **consumes** each DTO:

```rust
for dto in events_to_dto(&events) {
    println!("{} {}", dto.kind, dto.payload);
}
```

You should see `turn_started` … `turn_completed` (and tools/citations when the
workspace has matching content).

Build check:

```sh
cargo build -p cd-core --examples
```

## Streaming

Incremental host-mode streaming is the server SSE path (#166) or the desktop
Channel path — not required for this minimal embed example.
