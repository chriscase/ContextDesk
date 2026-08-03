//! CLI-local "current corpus" and "current conversation" state.
//!
//! This is deliberately the one piece of this crate that is NOT shared with
//! Tauri: a GUI window already has an obvious notion of "the corpus I have
//! open" and "the chat I'm looking at" from its own live window/session
//! state, so it needs no on-disk pointer between invocations. A CLI process
//! is stateless between runs — `contextdesk import <archive>` and
//! `contextdesk chat "<question>"` are two separate processes — so *something*
//! has to remember which corpus and conversation were current. This module
//! is that something, versioned like every other durable store in this
//! codebase, and it is explicitly host-specific: list it as such in any
//! architecture review rather than presenting it as shared workflow logic.

use cd_core::error::{CoreError, CoreResult};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// Schema version for the on-disk CLI state file.
pub const CLI_STATE_SCHEMA_VERSION: u32 = 1;

/// The CLI's notion of "current" between invocations.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct CliState {
    /// Explicit schema version; stamped and never downgraded, mirroring
    /// [`cd_core::config::AppConfig::migrate`]'s rule.
    #[serde(default)]
    pub schema_version: u32,
    /// The corpus a bare `contextdesk chat` should ground against.
    #[serde(default)]
    pub current_corpus_id: Option<String>,
    /// The durable chat session a bare `contextdesk chat` should continue.
    #[serde(default)]
    pub current_session_id: Option<String>,
}

impl CliState {
    fn migrate(&mut self) {
        if self.schema_version < CLI_STATE_SCHEMA_VERSION {
            self.schema_version = CLI_STATE_SCHEMA_VERSION;
        }
    }

    /// Set the current corpus, implicitly starting a fresh conversation
    /// (an imported corpus with a stale session id pointing at a different
    /// corpus would silently ground answers in the wrong evidence).
    pub fn set_current_corpus(&mut self, corpus_id: impl Into<String>) {
        self.current_corpus_id = Some(corpus_id.into());
        self.current_session_id = None;
    }
}

/// Path to the CLI state file under `state_dir`.
pub fn cli_state_path(state_dir: &Path) -> PathBuf {
    state_dir.join("cli-state.json")
}

/// Load CLI state, or an empty default when the file has never been written.
pub fn load_cli_state(state_dir: &Path) -> CoreResult<CliState> {
    let path = cli_state_path(state_dir);
    if !path.exists() {
        return Ok(CliState::default());
    }
    let raw = fs::read_to_string(&path)
        .map_err(|error| CoreError::Message(format!("read CLI state: {error}")))?;
    let mut state: CliState = serde_json::from_str(&raw)
        .map_err(|error| CoreError::Message(format!("parse CLI state: {error}")))?;
    state.migrate();
    Ok(state)
}

/// Atomically persist CLI state, always stamped with the current version.
pub fn save_cli_state(state_dir: &Path, state: &CliState) -> CoreResult<()> {
    let mut state = state.clone();
    state.migrate();
    fs::create_dir_all(state_dir)
        .map_err(|error| CoreError::Message(format!("create CLI state dir: {error}")))?;
    let path = cli_state_path(state_dir);
    let raw = serde_json::to_string_pretty(&state)
        .map_err(|error| CoreError::Message(format!("serialize CLI state: {error}")))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, raw)
        .map_err(|error| CoreError::Message(format!("write CLI state: {error}")))?;
    fs::rename(&tmp, &path)
        .map_err(|error| CoreError::Message(format!("publish CLI state: {error}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn absent_state_loads_as_empty_default() {
        let dir = tempdir().unwrap();
        let state = load_cli_state(dir.path()).expect("load");
        assert_eq!(state, CliState::default());
        assert_eq!(state.current_corpus_id, None);
    }

    #[test]
    fn current_corpus_and_session_round_trip() {
        let dir = tempdir().unwrap();
        let mut state = load_cli_state(dir.path()).expect("load");
        state.set_current_corpus("corpus-123");
        state.current_session_id = Some("session-abc".to_string());
        save_cli_state(dir.path(), &state).expect("save");

        let reloaded = load_cli_state(dir.path()).expect("reload");
        assert_eq!(reloaded.current_corpus_id.as_deref(), Some("corpus-123"));
        assert_eq!(reloaded.current_session_id.as_deref(), Some("session-abc"));
        assert_eq!(reloaded.schema_version, CLI_STATE_SCHEMA_VERSION);
    }

    #[test]
    fn switching_corpus_clears_the_stale_session_so_answers_never_ground_in_the_wrong_evidence() {
        let dir = tempdir().unwrap();
        let mut state = load_cli_state(dir.path()).expect("load");
        state.set_current_corpus("corpus-a");
        state.current_session_id = Some("session-for-a".to_string());
        save_cli_state(dir.path(), &state).expect("save");

        let mut state = load_cli_state(dir.path()).expect("reload");
        state.set_current_corpus("corpus-b");
        assert_eq!(
            state.current_session_id, None,
            "stale session must not carry over"
        );
        save_cli_state(dir.path(), &state).expect("save again");

        let reloaded = load_cli_state(dir.path()).expect("final reload");
        assert_eq!(reloaded.current_corpus_id.as_deref(), Some("corpus-b"));
        assert_eq!(reloaded.current_session_id, None);
    }
}
