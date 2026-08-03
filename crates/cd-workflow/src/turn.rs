//! Grounded-chat turn orchestration shared by every host.
//!
//! [`cd_core::research::research_turn_with_cancel_and_context`] is already
//! the single, host-neutral entry point that drives a provider round —
//! it is not reimplemented here. What previously existed only inside the
//! Tauri `agent_turn` command was the sequencing AROUND that call: binding
//! (and later releasing) a linked log corpus on the tool host so a turn can
//! ground its answer in imported evidence. That sequencing is what this
//! module extracts, so a CLI grounding a question in `contextdesk chat` uses
//! the exact same binding discipline a linked Log Explorer chat does.

use cd_core::agent::LogExplorerTurnContext;
use cd_core::chat::ChatMessage;
use cd_core::error::CoreResult;
use cd_core::events::StreamEvent;
use cd_core::log_analysis::store::LogCorpus;
use cd_core::tool_host::ToolHost;
use cd_core::turn_trace::TurnTraceSink;
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use crate::provider::ResolvedTurnInputs;

/// Prior tool-host state captured by [`bind_linked_corpus`], so a caller can
/// restore it after the turn — mirrors the snapshot/restore Tauri's
/// `agent_turn` already performs around the same host methods, generalized
/// so it needs no `AppState`/host-generation concept to work.
pub struct LinkedCorpusBinding {
    previous_scope: Option<String>,
    previous_active: Option<String>,
    /// The corpus's event revision at the moment it was bound — a trace/
    /// dry-run summary's "which corpus content this turn was grounded
    /// against," since the corpus can keep receiving imports afterward.
    pub revision: u64,
}

/// Bind one corpus to the tool host for a linked turn: pin log-tool scope,
/// seed the already-opened corpus handle so every deterministic log tool in
/// the turn shares one initialized snapshot, and pin the current suppression
/// lens. Returns the prior state so [`unbind_linked_corpus`] can restore it.
pub fn bind_linked_corpus(
    host: &mut ToolHost,
    cache_root: &Path,
    corpus_id: &str,
) -> CoreResult<LinkedCorpusBinding> {
    let previous_scope = host.log_corpus_scope().map(str::to_string);
    let previous_active = host.active_log_corpus().map(str::to_string);

    host.set_log_corpus_scope(Some(corpus_id.to_string()));
    host.set_active_log_corpus(Some(corpus_id.to_string()));
    let corpus = Arc::new(LogCorpus::open(cache_root, corpus_id)?);
    let revision = corpus.revision();
    host.seed_log_corpus_handle(corpus_id, corpus)?;
    host.pin_log_suppression_lens(corpus_id)?;

    Ok(LinkedCorpusBinding {
        previous_scope,
        previous_active,
        revision,
    })
}

/// Restore the tool host to its state before [`bind_linked_corpus`].
pub fn unbind_linked_corpus(host: &mut ToolHost, binding: LinkedCorpusBinding) {
    host.set_log_corpus_scope(binding.previous_scope);
    host.set_active_log_corpus(binding.previous_active);
}

/// Run one grounded turn against a corpus already bound with
/// [`bind_linked_corpus`], via [`LogExplorerTurnContext::for_main_chat`] — no
/// viewport, filters, lanes, or selection implied, exactly the "one corpus
/// attached to a durable chat" shape a CLI needs.
///
/// `dry_run` and `trace_sink` pass straight through to
/// [`cd_core::research::research_turn_with_cancel_and_context_and_checkpoint_and_trace`]
/// — see that function's docs for exactly what each guarantees. Ordinary
/// callers that want neither pass `false, None`.
#[allow(clippy::too_many_arguments)]
pub async fn run_linked_turn(
    host: &mut ToolHost,
    resolved: &ResolvedTurnInputs,
    user_text: &str,
    history: &mut Vec<ChatMessage>,
    session_id: &str,
    corpus_id: &str,
    cancel: Option<Arc<AtomicBool>>,
    live: Option<&mut (dyn FnMut(StreamEvent) + Send)>,
    dry_run: bool,
    trace_sink: Option<Arc<dyn TurnTraceSink>>,
) -> CoreResult<Vec<StreamEvent>> {
    let context = LogExplorerTurnContext::for_main_chat(corpus_id)?;
    cd_core::research::research_turn_with_cancel_and_context_and_checkpoint_and_trace(
        host,
        &resolved.profile,
        resolved.api_key.clone(),
        user_text,
        history,
        session_id,
        false,
        cancel,
        Some(context),
        None,
        None,
        None,
        false,
        live,
        dry_run,
        trace_sink,
    )
    .await
}

/// Run one ordinary (unlinked) turn — no corpus, no log tools scoped.
///
/// See [`run_linked_turn`] for `dry_run`/`trace_sink`.
#[allow(clippy::too_many_arguments)]
pub async fn run_ordinary_turn(
    host: &mut ToolHost,
    resolved: &ResolvedTurnInputs,
    user_text: &str,
    history: &mut Vec<ChatMessage>,
    session_id: &str,
    cancel: Option<Arc<AtomicBool>>,
    live: Option<&mut (dyn FnMut(StreamEvent) + Send)>,
    dry_run: bool,
    trace_sink: Option<Arc<dyn TurnTraceSink>>,
) -> CoreResult<Vec<StreamEvent>> {
    cd_core::research::research_turn_with_cancel_and_context_and_checkpoint_and_trace(
        host,
        &resolved.profile,
        resolved.api_key.clone(),
        user_text,
        history,
        session_id,
        false,
        cancel,
        None,
        None,
        None,
        None,
        false,
        live,
        dry_run,
        trace_sink,
    )
    .await
}
