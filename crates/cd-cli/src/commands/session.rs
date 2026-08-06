//! Durable chat session listing — thin wrapper over `cd_core::sessions`.
//! The same sessions directory the desktop app uses, so a session started
//! in either host is visible from the other.

use crate::cli::SessionAction;
use crate::envelope::{CliError, CliResult, Render};
use cd_core::sessions::SessionStore;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct SessionItem {
    pub id: String,
    pub title: String,
    pub message_count: usize,
    pub updated_at: chrono::DateTime<chrono::Utc>,
    pub linked_corpus_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SessionListOutput {
    pub sessions: Vec<SessionItem>,
}

impl Render for SessionListOutput {
    fn render_text(&self) -> String {
        if self.sessions.is_empty() {
            return "No sessions yet. Run `contextdesk chat \"<question>\"`.".to_string();
        }
        let mut out = format!("Chat sessions ({})\n", self.sessions.len());
        for s in &self.sessions {
            out.push_str(&format!(
                "\n  {}\n    {}\n    {} messages · updated {}{}\n",
                s.title,
                s.id,
                s.message_count,
                s.updated_at.format("%Y-%m-%d %H:%M UTC"),
                s.linked_corpus_id
                    .as_deref()
                    .map(|c| format!(" · corpus {c}"))
                    .unwrap_or_default()
            ));
        }
        out.trim_end().to_string()
    }

    fn render_json(&self) -> serde_json::Value {
        serde_json::to_value(self).expect("SessionListOutput is always serializable")
    }
}

#[derive(Debug, Serialize)]
pub struct SessionShowOutput {
    pub id: String,
    pub title: String,
    pub messages: Vec<MessageItem>,
}

#[derive(Debug, Serialize)]
pub struct MessageItem {
    pub role: String,
    pub content: String,
}

impl Render for SessionShowOutput {
    fn render_text(&self) -> String {
        let mut out = format!("{}\n{}\n", self.title, self.id);
        for m in &self.messages {
            out.push_str(&format!("\n{}\n{}\n", m.role.to_uppercase(), m.content));
        }
        out.trim_end().to_string()
    }

    fn render_json(&self) -> serde_json::Value {
        serde_json::to_value(self).expect("SessionShowOutput is always serializable")
    }
}

pub fn run(action: &SessionAction, store: &SessionStore) -> CliResult<Box<dyn Render>> {
    match action {
        SessionAction::List => {
            let metas = store
                .list_meta()
                .map_err(|e| CliError::internal(format!("list sessions: {e}")))?;
            Ok(Box::new(SessionListOutput {
                sessions: metas
                    .into_iter()
                    .map(|m| SessionItem {
                        id: m.id,
                        title: m.title,
                        message_count: m.message_count,
                        updated_at: m.updated_at,
                        linked_corpus_id: m.linked_corpus_id,
                    })
                    .collect(),
            }))
        }
        SessionAction::Show { id } => {
            let session = store
                .load(id)
                .map_err(|_| CliError::not_found(format!("no session {id}")))?;
            Ok(Box::new(SessionShowOutput {
                id: session.id,
                title: session.title,
                messages: session
                    .messages
                    .into_iter()
                    .map(|m| MessageItem {
                        role: m.role,
                        content: m.content,
                    })
                    .collect(),
            }))
        }
    }
}
