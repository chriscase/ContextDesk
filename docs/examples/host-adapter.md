# Host adapter sketch (cd.v1)

Embed ContextDesk by linking `cd-core` and mapping events:

```rust
// Pseudocode — host owns UI; core owns tools + research.
use cd_core::research::{build_host, research_local, events_to_dto};
use cd_core::workspace::Workspace;

fn turn(ws: Workspace, q: &str) {
    let mut host = build_host(ws, None).unwrap();
    let events = research_local(&mut host, q, "embed-session").unwrap();
    for dto in events_to_dto(&events) {
        // forward dto.kind / dto.payload to host webview or RPC
        let _ = dto;
    }
}
```

Protocol event names: see `docs/PROTOCOL.md` (`cd.v1`). Version constant: `cd_core::PROTOCOL_VERSION`.
