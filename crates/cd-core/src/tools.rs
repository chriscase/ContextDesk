//! Tool registry primitives and side-effect classification.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Side-effect class for policy gating.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolSideEffect {
    /// Read-only within policy (still audited).
    Read,
    /// Propose / draft; durable only after user Accept.
    SoftWrite,
    /// Mutates external or local state; requires explicit UI grant.
    HardWrite,
}

/// Static tool description for LLM schemas and UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolSpec {
    /// Stable tool name (snake_case).
    pub name: String,
    /// Human/LLM description.
    pub description: String,
    /// Side-effect class.
    pub side_effect: ToolSideEffect,
    /// JSON Schema for parameters.
    pub parameters: Value,
}

/// Built-in MVP tool names (implementations land in later issues).
pub mod names {
    /// Semantic/keyword search over indexed knowledge.
    pub const SEARCH_KB: &str = "search_kb";
    /// Read a bounded file slice under allowlisted roots.
    pub const READ_FILE_SLICE: &str = "read_file_slice";
    /// Append or create a project memory markdown note (SoftWrite).
    pub const SAVE_MEMORY: &str = "save_memory";
    /// Propose authoring a skill markdown playbook (SoftWrite + Accept).
    pub const SAVE_SKILL: &str = "save_skill";
}

/// MVP tool specifications (schemas only; execution is host/agent work).
pub fn mvp_tool_specs() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: names::SEARCH_KB.into(),
            description: "Search the workspace knowledge base (files + memory). Prefer this before guessing paths."
                .into(),
            side_effect: ToolSideEffect::Read,
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 50 }
                },
                "required": ["query"]
            }),
        },
        ToolSpec {
            name: names::READ_FILE_SLICE.into(),
            description: "Read a bounded line range from an allowlisted file path.".into(),
            side_effect: ToolSideEffect::Read,
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "start_line": { "type": "integer", "minimum": 1 },
                    "end_line": { "type": "integer", "minimum": 1 }
                },
                "required": ["path"]
            }),
        },
        ToolSpec {
            name: names::SAVE_MEMORY.into(),
            description: "Propose saving a markdown note to project memory (requires user Accept)."
                .into(),
            side_effect: ToolSideEffect::SoftWrite,
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "title": { "type": "string" },
                    "body_markdown": { "type": "string" },
                    "filename_hint": { "type": "string" }
                },
                "required": ["title", "body_markdown"]
            }),
        },
        ToolSpec {
            name: names::SAVE_SKILL.into(),
            description: "Propose authoring a skill playbook under workspace .contextdesk/skills (SoftWrite; requires user Accept). Skills cannot raise write permissions."
                .into(),
            side_effect: ToolSideEffect::SoftWrite,
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Stable skill id (slug)" },
                    "name": { "type": "string" },
                    "description": { "type": "string" },
                    "body_markdown": { "type": "string", "description": "Skill playbook body" },
                    "allows_write": { "type": "boolean", "description": "If true, skill is saved disabled until user enables" }
                },
                "required": ["id", "name", "description", "body_markdown"]
            }),
        },
    ]
}

/// Returns true if this side effect may auto-run without a write grant.
pub fn may_auto_execute(side: ToolSideEffect) -> bool {
    matches!(side, ToolSideEffect::Read)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mvp_tools_include_search_and_memory() {
        let specs = mvp_tool_specs();
        assert!(specs.iter().any(|t| t.name == names::SEARCH_KB));
        assert!(specs.iter().any(|t| t.name == names::SAVE_MEMORY));
        assert!(specs.iter().any(|t| t.name == names::SAVE_SKILL));
        let save = specs.iter().find(|t| t.name == names::SAVE_MEMORY).unwrap();
        assert_eq!(save.side_effect, ToolSideEffect::SoftWrite);
        let skill = specs.iter().find(|t| t.name == names::SAVE_SKILL).unwrap();
        assert_eq!(skill.side_effect, ToolSideEffect::SoftWrite);
        assert!(!may_auto_execute(ToolSideEffect::HardWrite));
        assert!(may_auto_execute(ToolSideEffect::Read));
    }
}
