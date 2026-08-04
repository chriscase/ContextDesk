//! Shared synthetic fixtures and canaries for the continuity adversarial lab.
//! Neutral markers only — no private/employer data.

#![allow(dead_code)]

use cd_core::chat::{ChatCompletion, ChatMessage, FunctionCall, Role, ToolCallMsg};
use cd_core::index::KeywordIndex;
use cd_core::tool_host::ToolHost;
use cd_core::workspace::Workspace;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tempfile::TempDir;

/// Planted canaries used across budget / leak / disproof oracles.
#[derive(Debug, Clone)]
pub struct Canaries {
    pub session_id: String,
    pub incident_id: String,
    pub user_constraint: String,
    pub open_question: String,
    pub tool_result_id: String,
    pub citation_id: String,
    pub hypothesis_h1: String,
    pub disproof_evidence: String,
    pub private_session_a: String,
    pub private_corpus_x: String,
    pub stale_noise: String,
    pub invented_fact: String,
}

impl Default for Canaries {
    fn default() -> Self {
        Self {
            session_id: "sess-lab-ALPHA-7f3a".into(),
            incident_id: "INC-SYNTH-42".into(),
            user_constraint: "CONSTRAINT: never reboot production hosts".into(),
            open_question: "OPEN_Q: what is the true root cause of pool exhaustion?".into(),
            tool_result_id: "TOOL_RESULT_ID=tr-9c2e".into(),
            citation_id: "CITATION_ID=cit-worker-seq-101".into(),
            hypothesis_h1: "HYPOTHESIS_H1: network partition caused pool exhaustion".into(),
            disproof_evidence: "DISPROOF: config change db_pool_max 32→4 at seq=101, not network"
                .into(),
            private_session_a: "PRIVATE_SESS_A=secret-marker-should-not-leak".into(),
            private_corpus_x: "PRIVATE_CORPUS_X=corpus-x-only-marker".into(),
            stale_noise: "STALE_NOISE=irrelevant-old-ticket-ZZ99".into(),
            invented_fact: "INVENTED_FACT=summary-must-never-claim-this".into(),
        }
    }
}

impl Canaries {
    pub fn all_markers(&self) -> Vec<&str> {
        vec![
            &self.session_id,
            &self.incident_id,
            &self.user_constraint,
            &self.open_question,
            &self.tool_result_id,
            &self.citation_id,
            &self.hypothesis_h1,
            &self.disproof_evidence,
            &self.private_session_a,
            &self.private_corpus_x,
            &self.stale_noise,
            &self.invented_fact,
        ]
    }
}

/// Flat join of model-facing message bodies for canary presence checks.
pub fn model_context_blob(messages: &[ChatMessage]) -> String {
    messages
        .iter()
        .map(|m| m.content.as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn msg(role: Role, content: impl Into<String>) -> ChatMessage {
    ChatMessage {
        role,
        content: content.into(),
        tool_call_id: None,
        tool_calls: None,
    }
}

pub fn tool_call(id: &str, name: &str, arguments: &str) -> ChatCompletion {
    ChatCompletion {
        content: String::new(),
        tool_calls: vec![ToolCallMsg {
            id: id.into(),
            kind: "function".into(),
            function: FunctionCall {
                name: name.into(),
                arguments: arguments.into(),
            },
        }],
        finish_reason: "tool_calls".into(),
    }
}

pub fn final_answer(text: impl Into<String>) -> ChatCompletion {
    ChatCompletion {
        content: text.into(),
        tool_calls: vec![],
        finish_reason: "stop".into(),
    }
}

/// Captures every model-facing message batch the provider actually receives.
#[derive(Default)]
pub struct CaptureCtx {
    pub rounds: Mutex<Vec<Vec<ChatMessage>>>,
}

impl CaptureCtx {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            rounds: Mutex::new(Vec::new()),
        })
    }

    pub fn record(&self, messages: &[ChatMessage]) {
        self.rounds
            .lock()
            .expect("capture lock")
            .push(messages.to_vec());
    }

    pub fn last_blob(&self) -> String {
        let g = self.rounds.lock().expect("capture lock");
        g.last().map(|m| model_context_blob(m)).unwrap_or_default()
    }

    pub fn all_blob(&self) -> String {
        let g = self.rounds.lock().expect("capture lock");
        g.iter()
            .map(|m| model_context_blob(m))
            .collect::<Vec<_>>()
            .join("\n---ROUND---\n")
    }

    pub fn max_chars(&self) -> usize {
        let g = self.rounds.lock().expect("capture lock");
        g.iter()
            .map(|m| m.iter().map(|x| x.content.len()).sum::<usize>())
            .max()
            .unwrap_or(0)
    }

    pub fn max_message_count(&self) -> usize {
        let g = self.rounds.lock().expect("capture lock");
        g.iter().map(|m| m.len()).max().unwrap_or(0)
    }

    pub fn round_count(&self) -> usize {
        self.rounds.lock().expect("capture lock").len()
    }
}

/// Scripted backend that records provider context then returns queued completions.
pub struct CapturingScriptedBackend {
    script: Mutex<std::collections::VecDeque<ChatCompletion>>,
    capture: Arc<CaptureCtx>,
}

impl CapturingScriptedBackend {
    pub fn new(responses: Vec<ChatCompletion>, capture: Arc<CaptureCtx>) -> Self {
        Self {
            script: Mutex::new(responses.into()),
            capture,
        }
    }

    pub fn push(&self, c: ChatCompletion) {
        self.script.lock().expect("script lock").push_back(c);
    }
}

#[async_trait::async_trait]
impl cd_core::agent::ChatBackend for CapturingScriptedBackend {
    async fn complete(
        &self,
        messages: &[ChatMessage],
        _tools: &[cd_core::tools::ToolSpec],
    ) -> cd_core::error::CoreResult<ChatCompletion> {
        self.capture.record(messages);
        self.script
            .lock()
            .map_err(|_| cd_core::error::CoreError::Message("script lock".into()))?
            .pop_front()
            .ok_or_else(|| cd_core::error::CoreError::Message("script exhausted".into()))
    }
}

/// Ordinary-chat workspace with synthetic KB document carrying canaries.
pub fn ordinary_workspace(root: &Path, canaries: &Canaries) -> (Workspace, KeywordIndex) {
    fs::create_dir_all(root).expect("workspace root");
    let doc = root.join("runbook.md");
    fs::write(
        &doc,
        format!(
            "# Synthetic runbook\n\n\
             Incident {inc}\n\
             {tool}\n\
             {cit}\n\
             Decision: keep pool ≥ 16 workers.\n",
            inc = canaries.incident_id,
            tool = canaries.tool_result_id,
            cit = canaries.citation_id,
        ),
    )
    .expect("write runbook");
    let ws = Workspace::new("continuity-lab", vec![root.to_path_buf()]);
    let idx = KeywordIndex::build(&ws).expect("index");
    (ws, idx)
}

/// Linked-log fixture: synthetic worker log + cache dir for ingest.
pub fn linked_log_fixture(root: &Path, canaries: &Canaries) -> (PathBuf, PathBuf, String) {
    let logs = root.join("logs");
    fs::create_dir_all(&logs).expect("logs dir");
    let mut f = fs::File::create(logs.join("worker.log")).expect("worker.log");
    writeln!(
        f,
        r#"{{"ts":1700000100,"level":"error","service":"worker","message":"event_id=job-7f3a {priv} pool exhausted"}}"#,
        priv = canaries.private_corpus_x
    )
    .unwrap();
    writeln!(
        f,
        r#"{{"ts":1700000101,"level":"info","service":"config","message":"{disproof}"}}"#,
        disproof = canaries.disproof_evidence
    )
    .unwrap();
    let cache = root.join("cache");
    fs::create_dir_all(&cache).unwrap();
    let report = cd_core::log_analysis::ingest_path(&cache, &logs, "synth-checkout", None, "none")
        .expect("ingest");
    (logs, cache, report.corpus_id)
}

/// Host with optional linked corpus activated.
pub fn make_host(root: &Path, canaries: &Canaries, linked: Option<(&Path, &str)>) -> ToolHost {
    let (ws, idx) = ordinary_workspace(root, canaries);
    let mut host = ToolHost::new(ws, idx, None);
    if let Some((cache, corpus_id)) = linked {
        host.set_log_analysis(true, Some(cache.to_path_buf()));
        host.set_active_log_corpus(Some(corpus_id.to_string()));
    }
    host
}

/// Temp root + canaries bundle for a lab scenario.
pub struct LabEnv {
    pub _temp: TempDir,
    pub root: PathBuf,
    pub canaries: Canaries,
}

impl LabEnv {
    pub fn new() -> Self {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().to_path_buf();
        Self {
            _temp: temp,
            root,
            canaries: Canaries::default(),
        }
    }
}

/// Count SoftWrite memory files under workspace `.contextdesk/memory`.
pub fn count_memory_files(root: &Path) -> usize {
    let dir = root.join(".contextdesk").join("memory");
    if !dir.is_dir() {
        return 0;
    }
    fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter(|e| e.path().extension().is_some_and(|x| x == "md"))
                .count()
        })
        .unwrap_or(0)
}

/// Fate of a planted canary after production `prepare_model_context`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CanaryFate {
    /// Full body appears in the pairing-safe keep tail (not only the compact note).
    Present,
    /// Appears only as a short snippet inside `[Compacted earlier conversation]`.
    Summarized,
    /// Not present in model-facing context at all.
    Omitted,
}

/// Classify where a marker survived after prepare_model_context.
///
/// A marker is **Present** only if it appears in a non-compact message body
/// (keep-tail / policy / truncated tail). **Summarized** if it appears solely
/// inside a compact-summary system message. **Omitted** otherwise.
pub fn classify_canary(model_msgs: &[ChatMessage], marker: &str) -> CanaryFate {
    let mut in_compact = false;
    let mut in_tail = false;
    for m in model_msgs {
        if !m.content.contains(marker) {
            continue;
        }
        let is_compact = m.content.contains("Compacted earlier conversation");
        if is_compact {
            in_compact = true;
        } else {
            in_tail = true;
        }
    }
    if in_tail {
        CanaryFate::Present
    } else if in_compact {
        CanaryFate::Summarized
    } else {
        CanaryFate::Omitted
    }
}

/// History layout for hard-budget classification:
/// early private/stale → filler → mid canaries (id/constraint/open_q/tool/cite/H1)
/// → keep-window recent turns that carry still-relevant investigation state.
pub fn long_history_with_canaries(canaries: &Canaries, filler_turns: usize) -> Vec<ChatMessage> {
    let mut hist = vec![msg(
        Role::System,
        "policy: tools only via function calls; never invent facts",
    )];
    // EARLY: private/stale — should be Omitted under tight summary (newest-old first).
    hist.push(msg(
        Role::User,
        format!("{} {}", canaries.private_session_a, canaries.stale_noise),
    ));
    hist.push(msg(Role::Assistant, "Acknowledged private note."));
    // Early filler so private is far from the keep boundary.
    for i in 0..filler_turns {
        hist.push(msg(
            Role::User,
            format!("early-filler user {i} {}", "x".repeat(100)),
        ));
        hist.push(msg(
            Role::Assistant,
            format!("early-filler asst {i} {}", "y".repeat(100)),
        ));
    }
    // MID: investigation canaries immediately before keep — prefer Summarized.
    hist.push(msg(
        Role::User,
        format!(
            "Session {} incident {} — {}. Also: {}",
            canaries.session_id,
            canaries.incident_id,
            canaries.user_constraint,
            canaries.open_question
        ),
    ));
    hist.push(msg(
        Role::Assistant,
        format!(
            "Working hypothesis: {}. Citation {}",
            canaries.hypothesis_h1, canaries.citation_id
        ),
    ));
    hist.push(msg(Role::User, "Search the runbook for pool settings."));
    hist.push(ChatMessage {
        role: Role::Assistant,
        content: String::new(),
        tool_call_id: None,
        tool_calls: Some(vec![ToolCallMsg {
            id: "c-canary".into(),
            kind: "function".into(),
            function: FunctionCall {
                name: "search_kb".into(),
                arguments: r#"{"query":"pool","limit":3}"#.into(),
            },
        }]),
    });
    hist.push(ChatMessage {
        role: Role::Tool,
        content: format!(
            "{} {} found in runbook",
            canaries.tool_result_id, canaries.incident_id
        ),
        tool_call_id: Some("c-canary".into()),
        tool_calls: None,
    });
    hist.push(msg(
        Role::Assistant,
        format!(
            "Noted {}. Still open: {}. Hyp still {}",
            canaries.tool_result_id, canaries.open_question, canaries.hypothesis_h1
        ),
    ));
    // KEEP tail: newest turns WITHOUT re-planting canary markers.
    // Mid-history canaries must be classified as Summarized/Omitted on their own;
    // still-relevant survival is proven when they appear in the compact summary
    // (newest-of-old) rather than by copying them into the keep window.
    hist.push(msg(
        Role::User,
        "Status check — continue the open investigation without restating markers.",
    ));
    hist.push(msg(
        Role::Assistant,
        "Continuing; will use compacted prior investigation state.",
    ));
    hist
}
