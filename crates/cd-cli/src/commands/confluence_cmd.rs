//! `contextdesk confluence` — status / search / get-page.
//!
//! All network paths go through the same `ToolHost` + `confluence_ro` stack
//! the desktop agent uses. Secrets are keychain refs only.

use crate::adapters::{self, Paths};
use crate::cli::ConfluenceAction;
use crate::envelope::{CliError, CliResult, Render};
use cd_core::config::{AppConfig, CONFLUENCE_PAT_REF};
use cd_core::keychain_store::SecretStore;
use cd_core::tools::names;
use serde::Serialize;
use serde_json::json;

#[derive(Debug, Serialize)]
pub struct StatusOutput {
    pub enabled: bool,
    pub configured: bool,
    pub base_url: String,
    pub spaces: Vec<String>,
    pub pat_ref: Option<String>,
    pub pat_present: bool,
    pub auth_mode: String,
    pub basic_email_set: bool,
    pub write_enabled: bool,
    pub tools_offered: Vec<String>,
    /// True when a secret-store read was performed for Confluence this call.
    pub secret_store_read_attempted: bool,
    pub note: String,
}

impl Render for StatusOutput {
    fn render_text(&self) -> String {
        let lines = [
            format!("confluence.enabled: {}", self.enabled),
            format!("confluence.configured: {}", self.configured),
            format!("confluence.base_url: {}", self.base_url),
            format!("confluence.spaces: {}", self.spaces.join(", ")),
            format!(
                "confluence.pat_ref: {}",
                self.pat_ref.as_deref().unwrap_or("(none)")
            ),
            format!("confluence.pat_present: {}", self.pat_present),
            format!("confluence.auth_mode: {}", self.auth_mode),
            format!("confluence.basic_email_set: {}", self.basic_email_set),
            format!("confluence.write_enabled: {}", self.write_enabled),
            format!(
                "confluence.tools_offered: {}",
                if self.tools_offered.is_empty() {
                    "(none)".into()
                } else {
                    self.tools_offered.join(", ")
                }
            ),
            format!(
                "confluence.secret_store_read_attempted: {}",
                self.secret_store_read_attempted
            ),
            format!("note: {}", self.note),
        ];
        lines.join("\n")
    }

    fn render_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::Value::Null)
    }
}

#[derive(Debug, Serialize)]
pub struct ToolOutput {
    pub tool: String,
    pub ok: bool,
    pub summary: String,
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub citation: Option<String>,
}

impl Render for ToolOutput {
    fn render_text(&self) -> String {
        let mut out = format!(
            "tool: {}\nok: {}\nsummary: {}\n",
            self.tool, self.ok, self.summary
        );
        if let Some(c) = &self.citation {
            out.push_str(&format!("citation: {c}\n"));
        }
        out.push_str("---\n");
        out.push_str(&self.detail);
        out
    }

    fn render_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::Value::Null)
    }
}

pub async fn run(
    action: &ConfluenceAction,
    paths: &Paths,
    app_cfg: &AppConfig,
) -> CliResult<Box<dyn Render>> {
    match action {
        ConfluenceAction::Status => Ok(Box::new(status(paths, app_cfg)?)),
        ConfluenceAction::Search { query, limit } => {
            let out = execute_tool(
                paths,
                app_cfg,
                names::CONFLUENCE_SEARCH,
                json!({ "query": query, "limit": limit }),
            )
            .await?;
            Ok(Box::new(out))
        }
        ConfluenceAction::GetPage { page_id, format } => {
            let out = execute_tool(
                paths,
                app_cfg,
                names::CONFLUENCE_GET_PAGE,
                json!({ "page_id": page_id, "format": format }),
            )
            .await?;
            Ok(Box::new(out))
        }
    }
}

fn status(paths: &Paths, app_cfg: &AppConfig) -> CliResult<StatusOutput> {
    let _ = paths;
    let secrets = adapters::secret_store();
    let cf = &app_cfg.confluence;
    let secret_store_read_attempted = cf.enabled && cf.is_configured() && cf.pat_ref.is_some();
    let pat_present = if secret_store_read_attempted {
        secrets
            .has(CONFLUENCE_PAT_REF)
            .map_err(|e| CliError::internal(e.to_string()))?
    } else {
        false
    };
    let host = adapters::tool_host_with_app_config(&paths.cache_root, app_cfg, &secrets)?;
    let tools_offered: Vec<String> = host
        .specs_for_model()
        .into_iter()
        .map(|s| s.name)
        .filter(|n| n.starts_with("confluence_"))
        .collect();
    let note = if !cf.enabled {
        "Connector disabled (default). Enable under Settings or AppConfig.confluence.enabled."
            .into()
    } else if !cf.is_configured() {
        "Enabled but base_url empty — not configured.".into()
    } else if cf.pat_ref.is_none() {
        "Keyless profile: zero secret-store reads; no Confluence tools offered.".into()
    } else if !pat_present {
        "pat_ref set but secret missing from keychain — tools stay off (fail closed).".into()
    } else if tools_offered.is_empty() {
        "PAT present but no tools offered (unexpected).".into()
    } else {
        "Connector ready for search/read via ToolHost.".into()
    };
    Ok(StatusOutput {
        enabled: cf.enabled,
        configured: cf.is_configured(),
        base_url: cf.base_url.clone(),
        spaces: cf.spaces.clone(),
        pat_ref: cf.pat_ref.clone(),
        pat_present,
        auth_mode: match cf.auth_mode {
            cd_core::config::ConfluenceAuthMode::Bearer => "bearer".into(),
            cd_core::config::ConfluenceAuthMode::Basic => "basic".into(),
        },
        basic_email_set: cf
            .basic_email
            .as_ref()
            .is_some_and(|e| !e.trim().is_empty()),
        write_enabled: cf.write_enabled,
        tools_offered,
        secret_store_read_attempted,
        note,
    })
}

async fn execute_tool(
    paths: &Paths,
    app_cfg: &AppConfig,
    tool: &str,
    args: serde_json::Value,
) -> CliResult<ToolOutput> {
    let secrets = adapters::secret_store();
    let mut host = adapters::tool_host_with_app_config(&paths.cache_root, app_cfg, &secrets)?;
    if !host.specs_for_model().iter().any(|s| s.name == tool) {
        return Err(CliError::user(format!(
            "Confluence tool `{tool}` is not offered (disabled, keyless, or missing PAT). \
             Run `contextdesk confluence status`."
        )));
    }
    let result = host
        .execute(tool, &args, None)
        .await
        .map_err(|e| CliError::internal(e.to_string()))?;
    Ok(ToolOutput {
        tool: tool.into(),
        ok: result.ok,
        summary: result.summary,
        detail: result.detail_raw,
        citation: result.citation_path,
    })
}
