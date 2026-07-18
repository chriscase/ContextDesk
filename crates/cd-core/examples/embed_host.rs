//! Minimal embed host (#170): link `cd-core` and run an offline local research turn.
//!
//! ```text
//! cargo run -p cd-core --example embed_host -- /path/to/workspace "payments"
//! ```
//!
//! Uses only public `cd-core` APIs — no commercial host SDK, no network, no API keys.

use cd_core::research::{build_host, events_to_dto, research_local};
use cd_core::workspace::Workspace;
use std::env;
use std::path::PathBuf;
use std::process;

#[tokio::main]
async fn main() {
    let mut args = env::args().skip(1);
    let root = match args.next() {
        Some(r) => PathBuf::from(r),
        None => {
            eprintln!("usage: embed_host <workspace_root> [query]");
            process::exit(2);
        }
    };
    let query = args.next().unwrap_or_else(|| "overview".into());

    if !root.is_dir() {
        eprintln!("workspace root is not a directory: {}", root.display());
        process::exit(2);
    }

    let ws = Workspace::new("embed", vec![root]);
    let mut host = match build_host(ws, None) {
        Ok(h) => h,
        Err(e) => {
            eprintln!("build_host failed: {e}");
            process::exit(1);
        }
    };

    let events = match research_local(&mut host, &query, "embed-session").await {
        Ok(e) => e,
        Err(e) => {
            eprintln!("research_local failed: {e}");
            process::exit(1);
        }
    };

    // Honest consume of EventDto — print kind + payload (not discarded).
    for dto in events_to_dto(&events) {
        println!("{} {}", dto.kind, dto.payload);
    }
}
