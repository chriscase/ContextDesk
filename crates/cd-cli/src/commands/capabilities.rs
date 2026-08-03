//! `contextdesk capabilities` — a stable, machine-readable description of
//! this build: envelope schema version, exit-code categories, and the
//! command grammar. A script should probe this once rather than parsing
//! `--help` text, which is for humans and may reflow at any time.

use crate::envelope::{ExitCategory, Render, ENVELOPE_SCHEMA_VERSION};
use cd_core::branding::Branding;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct ExitCategoryDoc {
    pub code: i32,
    pub kind: &'static str,
}

#[derive(Debug, Serialize)]
pub struct CapabilitiesOutput {
    pub product_name: String,
    pub cli_version: &'static str,
    pub envelope_schema_version: u32,
    pub exit_categories: Vec<ExitCategoryDoc>,
    pub commands: Vec<&'static str>,
}

impl Render for CapabilitiesOutput {
    fn render_text(&self) -> String {
        let mut out = format!(
            "{} CLI — contextdesk {} (envelope schema {})\n\nexit codes:\n",
            self.product_name, self.cli_version, self.envelope_schema_version
        );
        for c in &self.exit_categories {
            out.push_str(&format!("  {:>3}  {}\n", c.code, c.kind));
        }
        out.push_str("\ncommands:\n");
        for c in &self.commands {
            out.push_str(&format!("  {c}\n"));
        }
        out.trim_end().to_string()
    }

    fn render_json(&self) -> serde_json::Value {
        serde_json::to_value(self).expect("CapabilitiesOutput is always serializable")
    }
}

const CATEGORIES: &[ExitCategory] = &[
    ExitCategory::Success,
    ExitCategory::UserError,
    ExitCategory::NotFound,
    ExitCategory::Conflict,
    ExitCategory::PermissionDenied,
    ExitCategory::ProviderError,
    ExitCategory::NotImplemented,
    ExitCategory::Internal,
];

const COMMANDS: &[&str] = &[
    "import",
    "corpus list",
    "corpus show",
    "corpus rename",
    "corpus delete",
    "corpus use",
    "timezone status",
    "timezone apply",
    "timezone clear",
    "explore",
    "context",
    "session list",
    "session show",
    "chat",
    "config init",
    "config validate",
    "config show",
    "config path",
    "capabilities",
];

pub fn run(branding: &Branding) -> CapabilitiesOutput {
    CapabilitiesOutput {
        product_name: branding.name.clone(),
        cli_version: env!("CARGO_PKG_VERSION"),
        envelope_schema_version: ENVELOPE_SCHEMA_VERSION,
        exit_categories: CATEGORIES
            .iter()
            .map(|c| ExitCategoryDoc {
                code: c.code(),
                kind: c.kind(),
            })
            .collect(),
        commands: COMMANDS.to_vec(),
    }
}
