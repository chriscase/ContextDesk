//! Architectural guard, not a behavior test: proves the Tauri desktop host
//! still DELEGATES its provider-selection helpers to this crate instead of
//! quietly regaining a private copy of the logic. `crates/cd-workflow`'s
//! whole reason to exist is "both hosts call the same code and can never
//! quietly drift into parallel implementations that merely look
//! equivalent" (see `src/lib.rs`); nothing in the ordinary `cargo test
//! --workspace` run otherwise notices if a future edit reintroduces
//! `provider_profile_for_turn`'s old ~20-line body instead of the
//! one-line delegation to [`crate::provider::resolve_provider_profile`].
//!
//! This reads source text rather than calling into `desktop/src-tauri`
//! because that crate is a NESTED workspace (see the repo root
//! `AGENTS.md`), not a dependency this crate could exercise directly.

use std::fs;
use std::path::PathBuf;

fn tauri_lib_source() -> String {
    let path: PathBuf = [
        env!("CARGO_MANIFEST_DIR"),
        "..",
        "..",
        "desktop",
        "src-tauri",
        "src",
        "lib.rs",
    ]
    .iter()
    .collect();
    fs::read_to_string(&path)
        .unwrap_or_else(|e| {
            panic!(
                "read {}: {e} (has desktop/src-tauri moved?)",
                path.display()
            )
        })
        .replace("\r\n", "\n")
}

/// Extracts the body of a single `fn name(...) { ... }` as the lines from
/// its signature up to (and not including) the next line that is a bare
/// `}` at zero indentation closing the function — good enough for the
/// small, flat helper functions this test targets, not a general Rust
/// parser.
fn function_body<'a>(source: &'a str, fn_name: &str) -> &'a str {
    let needle = format!("fn {fn_name}(");
    let start = source
        .find(&needle)
        .unwrap_or_else(|| panic!("`fn {fn_name}` not found in desktop/src-tauri/src/lib.rs — has it been renamed or removed?"));
    let after_signature = source[start..]
        .find('{')
        .map(|i| start + i)
        .expect("function has a body");
    let close = source[after_signature..]
        .find("\n}\n")
        .map(|i| after_signature + i)
        .expect("function body has a closing brace at column 0");
    &source[after_signature..close]
}

#[test]
fn provider_profile_for_turn_delegates_to_cd_workflow_provider() {
    let source = tauri_lib_source();
    let body = function_body(&source, "provider_profile_for_turn");
    assert!(
        body.contains("cd_workflow::provider::resolve_provider_profile"),
        "desktop/src-tauri's provider_profile_for_turn must delegate to \
         cd_workflow::provider::resolve_provider_profile instead of carrying its own \
         copy of profile-selection logic — found body:\n{body}"
    );
    assert!(
        body.lines().filter(|l| !l.trim().is_empty()).count() <= 3,
        "a thin delegation should be a one-line call, not a reimplementation — found body:\n{body}"
    );
}

#[test]
fn model_tools_disabled_reason_delegates_to_cd_workflow_provider() {
    let source = tauri_lib_source();
    let body = function_body(&source, "model_tools_disabled_reason");
    assert!(
        body.contains("cd_workflow::provider::model_tools_disabled_reason"),
        "desktop/src-tauri's model_tools_disabled_reason must delegate to \
         cd_workflow::provider::model_tools_disabled_reason — found body:\n{body}"
    );
}

#[test]
fn model_tools_enabled_delegates_to_cd_workflow_provider() {
    let source = tauri_lib_source();
    let body = function_body(&source, "model_tools_enabled");
    assert!(
        body.contains("cd_workflow::provider::model_tools_enabled"),
        "desktop/src-tauri's model_tools_enabled must delegate to \
         cd_workflow::provider::model_tools_enabled — found body:\n{body}"
    );
}

/// Guards the core deliverable of the Tauri-chat-kernel migration:
/// `agent_turn` must drive its provider round through this crate's
/// [`crate::turn::run_linked_turn`]/[`crate::turn::run_ordinary_turn`], the
/// same functions the CLI calls, rather than hand-assembling a call to
/// `cd_core::research::research_turn_with_cancel_and_context*` itself —
/// exactly the "second chat implementation" the migration eliminated.
/// Nothing in an ordinary `cargo test --workspace` run otherwise notices a
/// future edit that reintroduces that direct call.
///
/// `force_local`'s branch (`cd_core::research::research_local_with_skills`)
/// is a genuinely separate local-research path with no equivalent in
/// `cd_workflow::turn` — it does not contain the forbidden substring this
/// test checks for, so it needs no special-casing here.
#[test]
fn agent_turn_calls_cd_workflow_turn_kernel_not_research_turn_directly() {
    let source = tauri_lib_source();
    let body = function_body(&source, "agent_turn");
    assert!(
        body.contains("cd_workflow::turn::run_turn"),
        "desktop/src-tauri's agent_turn must call cd_workflow::turn::run_turn \
         for both linked and ordinary turns instead of driving cd_core::research directly \
         — found body:\n{body}"
    );
    assert!(
        !body.contains("research_turn_with_cancel_and_context"),
        "desktop/src-tauri's agent_turn must not call \
         cd_core::research::research_turn_with_cancel_and_context* directly — that call \
         belongs exclusively inside cd_workflow::turn::run_turn \
         now; agent_turn regaining a direct call would recreate the parallel \
         implementation this migration removed — found body:\n{body}"
    );
}

/// The nested Tauri workspace must actually depend on this crate — a
/// delegating function body with no matching `Cargo.toml` dependency would
/// not compile, but this pins the intent explicitly so a dependency
/// removal fails here with a clear message instead of a confusing build
/// error somewhere else.
#[test]
fn tauri_host_depends_on_cd_workflow() {
    let path: PathBuf = [
        env!("CARGO_MANIFEST_DIR"),
        "..",
        "..",
        "desktop",
        "src-tauri",
        "Cargo.toml",
    ]
    .iter()
    .collect();
    let manifest =
        fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    assert!(
        manifest.contains("cd-workflow"),
        "desktop/src-tauri/Cargo.toml must depend on cd-workflow"
    );
}
