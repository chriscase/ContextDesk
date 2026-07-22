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
    /// Hybrid memory recall (Read) — durable store.
    pub const RECALL_MEMORY: &str = "recall_memory";
    /// Supersede a durable memory (SoftWrite).
    pub const SUPERSEDE_MEMORY: &str = "supersede_memory";
    /// Retract (soft-forget) a durable memory (SoftWrite; never session-auto).
    pub const RETRACT_MEMORY: &str = "retract_memory";
    /// Propose authoring a skill markdown playbook (SoftWrite + Accept).
    pub const SAVE_SKILL: &str = "save_skill";
    /// Confluence CQL search (read-only; PAT from host).
    pub const CONFLUENCE_SEARCH: &str = "confluence_search";
    /// Confluence page fetch (read-only).
    pub const CONFLUENCE_GET_PAGE: &str = "confluence_get_page";
    /// Confluence child pages or space roots (read-only). #326
    pub const CONFLUENCE_LIST_CHILDREN: &str = "confluence_list_children";
    /// Confluence ancestors breadcrumb (read-only). #326
    pub const CONFLUENCE_GET_ANCESTORS: &str = "confluence_get_ancestors";
    /// Confluence attachment metadata (read-only). #326
    pub const CONFLUENCE_LIST_ATTACHMENTS: &str = "confluence_list_attachments";
    /// Harvest Confluence page(s) into durable memory (SoftWrite). #326 PR3
    pub const HARVEST_FROM_SOURCE: &str = "harvest_from_source";
    /// Open-web search (opt-in; DuckDuckGo HTML lite by default).
    pub const WEB_SEARCH: &str = "web_search";
    /// Open-web page fetch (opt-in; SSRF-safe text extract).
    pub const WEB_FETCH: &str = "web_fetch";
    /// X (Twitter) recent search (opt-in; requires API bearer in keychain).
    pub const X_SEARCH: &str = "x_search";
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
            description: "Propose authoring a skill playbook under the workspace data dir skills/ folder (SoftWrite; requires user Accept). Skills cannot raise write permissions."
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
        ToolSpec {
            name: names::CONFLUENCE_SEARCH.into(),
            description: "Search Confluence (read-only CQL). Requires connector enabled + PAT in keychain. Space allowlist applied."
                .into(),
            side_effect: ToolSideEffect::Read,
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "CQL or free text (wrapped as text~)" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 25 }
                },
                "required": ["query"]
            }),
        },
        ToolSpec {
            name: names::CONFLUENCE_GET_PAGE.into(),
            description: "Fetch a Confluence page (read-only). format: plain (default strip_tags), meta, storage, or all (JSON). Space allowlist applied when set."
                .into(),
            side_effect: ToolSideEffect::Read,
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "page_id": { "type": "string" },
                    "format": {
                        "type": "string",
                        "description": "plain | meta | storage | all",
                        "enum": ["plain", "meta", "storage", "all"]
                    }
                },
                "required": ["page_id"]
            }),
        },
        ToolSpec {
            name: names::CONFLUENCE_LIST_CHILDREN.into(),
            description: "List Confluence child pages of a page_id, or space root pages when space is set (read-only tree browse)."
                .into(),
            side_effect: ToolSideEffect::Read,
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "page_id": { "type": "string", "description": "Parent page id (mutually exclusive with space for roots)" },
                    "space": { "type": "string", "description": "Space key — list root pages when page_id omitted" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 25 },
                    "start": { "type": "integer", "minimum": 0 }
                }
            }),
        },
        ToolSpec {
            name: names::CONFLUENCE_GET_ANCESTORS.into(),
            description: "List Confluence page ancestors (breadcrumb) for a page_id (read-only)."
                .into(),
            side_effect: ToolSideEffect::Read,
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "page_id": { "type": "string" }
                },
                "required": ["page_id"]
            }),
        },
        ToolSpec {
            name: names::CONFLUENCE_LIST_ATTACHMENTS.into(),
            description: "List Confluence attachment metadata for a page (read-only; no binary download)."
                .into(),
            side_effect: ToolSideEffect::Read,
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "page_id": { "type": "string" }
                },
                "required": ["page_id"]
            }),
        },
        ToolSpec {
            name: names::HARVEST_FROM_SOURCE.into(),
            description: "Harvest Confluence page(s) into durable memory with provenance (SoftWrite; requires Accept). Needs non-empty space allowlist. transform: plain_strip|raw_storage|structured_fields|summary|cleaned_markdown."
                .into(),
            side_effect: ToolSideEffect::SoftWrite,
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "system": { "type": "string", "description": "Only confluence in v1" },
                    "page_ids": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Confluence page ids (1..=batch max)"
                    },
                    "page_id": { "type": "string", "description": "Single page id alternative" },
                    "transform": { "type": "string" },
                    "destination": { "type": "string", "description": "memory only in PR3" },
                    "scope": { "type": "string", "description": "workspace|personal" }
                }
            }),
        },
        ToolSpec {
            name: names::WEB_SEARCH.into(),
            description: "Search the public web (Google News RSS + curated publisher feeds + fallbacks). Returns titles/snippets — NOT full articles. Optional packs narrow publisher fan-in to matching groups (intersected with user-enabled sources): public_intl, us_mainstream, middle_east, security, progressive, conservative. Omit packs to use all enabled publishers. For named people / casualties, run 2+ queries then web_fetch open articles. Requires Web research enabled."
                .into(),
            side_effect: ToolSideEffect::Read,
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Search query — prefer keywords over long questions" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 15 },
                    "packs": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Optional publisher pack ids to prefer (e.g. [\"middle_east\",\"security\"]). Invalid ids ignored; empty/omit = all enabled."
                    }
                },
                "required": ["query"]
            }),
        },
        ToolSpec {
            name: names::WEB_FETCH.into(),
            description: "Fetch a public http(s) URL for readable text (read-only). Use when you need names/details beyond RSS titles — especially Al Jazeera, Anadolu, Euronews, BBC, Wikipedia. Google News redirect URLs often fail; prefer publisher links when available. HTTP 401/403 is a soft failure: try another URL. SSRF-blocked for private/loopback/metadata."
                .into(),
            side_effect: ToolSideEffect::Read,
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "Absolute http(s) URL" }
                },
                "required": ["url"]
            }),
        },
        ToolSpec {
            name: names::X_SEARCH.into(),
            description: "Search recent posts on X (Twitter) via official API. Requires X connector enabled + API bearer in keychain (paid plan). Use for breaking social/primary posts; not a substitute for publisher long-form. Soft-fails on auth/rate limits. Do not invent posts when empty."
                .into(),
            side_effect: ToolSideEffect::Read,
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "X recent-search query (keywords, from:user, etc. per X operators)" },
                    "limit": { "type": "integer", "minimum": 10, "maximum": 25 }
                },
                "required": ["query"]
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
        assert!(specs.iter().any(|t| t.name == names::WEB_SEARCH));
        assert!(specs.iter().any(|t| t.name == names::WEB_FETCH));
        assert!(specs.iter().any(|t| t.name == names::X_SEARCH));
        let save = specs.iter().find(|t| t.name == names::SAVE_MEMORY).unwrap();
        assert_eq!(save.side_effect, ToolSideEffect::SoftWrite);
        let skill = specs.iter().find(|t| t.name == names::SAVE_SKILL).unwrap();
        assert_eq!(skill.side_effect, ToolSideEffect::SoftWrite);
        let web = specs.iter().find(|t| t.name == names::WEB_SEARCH).unwrap();
        assert_eq!(web.side_effect, ToolSideEffect::Read);
        assert!(!may_auto_execute(ToolSideEffect::HardWrite));
        assert!(may_auto_execute(ToolSideEffect::Read));
    }
}
