//! Static memory tool specs + argument → [`MemoryWriteOp`] adapters (MEMORY.md §6).

use super::types::*;
use super::{audit_target, tool_names};
use crate::error::{CoreError, CoreResult};
use crate::tools::{ToolSideEffect, ToolSpec};
use serde_json::{json, Value};
use uuid::Uuid;

/// Static tool specs for durable memory (register when `durable_memory_enabled`).
pub fn memory_tool_specs() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: tool_names::RECALL_MEMORY.into(),
            description: "Recall durable memories (facts, decisions, bookmarks, preferences). Prefer this before answering questions about the user's world. Returns ids needed for supersede/retract.".into(),
            side_effect: ToolSideEffect::Read,
            parameters: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "kinds": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Optional kind filter: fact, decision, bookmark, preference, project_note, contact, term, task"
                    },
                    "k": { "type": "integer", "minimum": 1, "maximum": 50 },
                    "include_superseded": { "type": "boolean" },
                    "expand_neighbors": {
                        "type": "boolean",
                        "description": "Include one-hop linked memories (default true when edges configured)"
                    }
                },
                "required": ["query"]
            }),
        },
        ToolSpec {
            name: tool_names::SAVE_MEMORY.into(),
            description: "Propose saving a durable memory (SoftWrite — requires user Accept). When `id` is supplied, updates metadata only; content changes should use supersede_memory. Kind uses the same taxonomy as recall_memory (fact, decision, bookmark, preference, project_note, contact, term, task).".into(),
            side_effect: ToolSideEffect::SoftWrite,
            parameters: json!({
                "type": "object",
                "properties": {
                    "kind": {
                        "type": "string",
                        "description": "Memory kind (same taxonomy as recall_memory): fact, decision, bookmark, preference, project_note, contact, term, task. Case-insensitive; unknown values store as Other for backward compatibility."
                    },
                    "content": { "type": "string" },
                    "title": { "type": "string" },
                    "body_markdown": { "type": "string", "description": "Legacy alias for content (memory_fs path)" },
                    "structured": { "type": "object" },
                    "scope": { "type": "string", "enum": ["personal", "workspace"] },
                    "tags": { "type": "array", "items": { "type": "string" } },
                    "id": { "type": "string", "description": "Existing id for metadata update" },
                    "pinned": { "type": "boolean" }
                },
                // Keep the root schema a plain object. Some tool-calling
                // providers reject root-level anyOf/oneOf even when every
                // branch is object-shaped. The equivalent semantic rule is
                // enforced by write_op_from_save_args before any write can be
                // proposed: save needs content/body_markdown, or an id for a
                // metadata update.
                "required": []
            }),
        },
        ToolSpec {
            name: tool_names::SUPERSEDE_MEMORY.into(),
            description: "Propose superseding an existing memory with corrected content (SoftWrite). `old_id` must come from a prior recall_memory result.".into(),
            side_effect: ToolSideEffect::SoftWrite,
            parameters: json!({
                "type": "object",
                "properties": {
                    "old_id": { "type": "string" },
                    "content": { "type": "string" },
                    "kind": { "type": "string" },
                    "title": { "type": "string" },
                    "structured": { "type": "object" },
                    "scope": { "type": "string", "enum": ["personal", "workspace"] }
                },
                "required": ["old_id", "content"]
            }),
        },
        ToolSpec {
            // SoftWrite per MEMORY.md §10 owner default (reversible retract).
            // Permanent purge remains HardWrite / type-to-confirm (Phase 2).
            // Session grants never auto-satisfy this tool (#270).
            name: tool_names::RETRACT_MEMORY.into(),
            description: "Propose forgetting a memory (reversible soft tombstone). Requires user Accept; session path grants do not auto-approve.".into(),
            side_effect: ToolSideEffect::SoftWrite,
            parameters: json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string" }
                },
                "required": ["id"]
            }),
        },
        ToolSpec {
            name: tool_names::LINK_MEMORIES.into(),
            description: "Link two durable memories (decision→project, bookmark→fact, …). SoftWrite — requires user Accept.".into(),
            side_effect: ToolSideEffect::SoftWrite,
            parameters: json!({
                "type": "object",
                "properties": {
                    "from_id": { "type": "string" },
                    "to_id": { "type": "string" },
                    "edge_type": {
                        "type": "string",
                        "description": "Relationship: relates | supports | child_of | supersedes_proposed"
                    }
                },
                "required": ["from_id", "to_id"]
            }),
        },
        ToolSpec {
            name: tool_names::PROPOSE_MEMORY_CANDIDATES.into(),
            description: "Extract candidate memories from text into the review inbox (does NOT write durable memory). Offline rule-based cues.".into(),
            side_effect: ToolSideEffect::Read,
            parameters: json!({
                "type": "object",
                "properties": {
                    "text": { "type": "string" },
                    "assistant_text": { "type": "string" }
                },
                "required": ["text"]
            }),
        },
    ]
}

/// True for tools that must never auto-run on a session path grant (#270).
pub fn is_destructive_memory_tool(name: &str) -> bool {
    matches!(
        name,
        tool_names::RETRACT_MEMORY | "purge_memory" | "memory_purge" | "purge_memory_gdpr"
    )
}

/// Build audit target for a memory tool result.
pub fn audit_target_for_record(rec: &MemoryRecord) -> String {
    audit_target(rec.scope, &rec.id, rec.rev)
}

/// Parse save_memory args into a write op (insert or update-meta).
/// Documented kind strings shared by `save_memory` and `recall_memory`.
pub const DOCUMENTED_MEMORY_KINDS: &[&str] = &[
    "fact",
    "decision",
    "bookmark",
    "preference",
    "project_note",
    "contact",
    "term",
    "task",
];

/// Normalize a save/recall kind string: case-insensitive, hyphen→underscore,
/// known aliases map to closed taxonomy; unknown → [`Kind::Other`] (backward compatible).
pub fn normalize_memory_kind(raw: &str) -> Kind {
    if raw.trim().is_empty() {
        Kind::ProjectNote
    } else {
        Kind::parse(raw)
    }
}

/// Parse `save_memory` arguments into a write op.
pub fn write_op_from_save_args(args: &Value) -> CoreResult<MemoryWriteOp> {
    if let Some(id_s) = args.get("id").and_then(|v| v.as_str()) {
        let id = Uuid::parse_str(id_s)
            .map_err(|_| CoreError::Message(format!("invalid memory id: {id_s}")))?;
        let tags = args.get("tags").and_then(|v| {
            v.as_array().map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(str::to_string))
                    .collect()
            })
        });
        let pinned = args.get("pinned").and_then(|v| v.as_bool());
        return Ok(MemoryWriteOp::UpdateMeta {
            id,
            tags,
            pinned,
            valid_to: None,
            status: None,
        });
    }
    let content = args
        .get("content")
        .or_else(|| args.get("body_markdown"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if content.is_empty() {
        return Err(CoreError::Message(
            "save_memory requires content or body_markdown".into(),
        ));
    }
    let kind = args
        .get("kind")
        .and_then(|v| v.as_str())
        .map(normalize_memory_kind)
        .unwrap_or(Kind::ProjectNote);
    let mut draft = MemoryDraft::new(kind, content);
    if let Some(t) = args.get("title").and_then(|v| v.as_str()) {
        draft.title = t.to_string();
    }
    if let Some(s) = args.get("structured") {
        draft.structured = s.clone();
    }
    if let Some(sc) = args
        .get("scope")
        .and_then(|v| v.as_str())
        .and_then(Scope::parse)
    {
        draft.scope = sc;
    }
    if let Some(tags) = args.get("tags").and_then(|v| v.as_array()) {
        draft.tags = tags
            .iter()
            .filter_map(|x| x.as_str().map(str::to_string))
            .collect();
    }
    if let Some(p) = args.get("pinned").and_then(|v| v.as_bool()) {
        draft.pinned = p;
    }
    draft.source = MemorySource::Agent;
    draft.origin_tool = Some(tool_names::SAVE_MEMORY.into());
    Ok(MemoryWriteOp::Insert(draft))
}

/// Parse supersede_memory args.
pub fn write_op_from_supersede_args(args: &Value) -> CoreResult<MemoryWriteOp> {
    let old_s = args
        .get("old_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| CoreError::Message("supersede_memory requires old_id".into()))?;
    let old = Uuid::parse_str(old_s)
        .map_err(|_| CoreError::Message(format!("invalid old_id: {old_s}")))?;
    let content = args
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if content.is_empty() {
        return Err(CoreError::Message(
            "supersede_memory requires content".into(),
        ));
    }
    let kind = args
        .get("kind")
        .and_then(|v| v.as_str())
        .map(normalize_memory_kind)
        .unwrap_or(Kind::Fact);
    let mut draft = MemoryDraft::new(kind, content);
    if let Some(t) = args.get("title").and_then(|v| v.as_str()) {
        draft.title = t.to_string();
    }
    if let Some(s) = args.get("structured") {
        draft.structured = s.clone();
    }
    if let Some(sc) = args
        .get("scope")
        .and_then(|v| v.as_str())
        .and_then(Scope::parse)
    {
        draft.scope = sc;
    }
    draft.source = MemorySource::Agent;
    draft.origin_tool = Some(tool_names::SUPERSEDE_MEMORY.into());
    Ok(MemoryWriteOp::Supersede { old, new: draft })
}

/// Parse retract_memory args.
pub fn write_op_from_retract_args(args: &Value) -> CoreResult<MemoryWriteOp> {
    let id_s = args
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| CoreError::Message("retract_memory requires id".into()))?;
    let id = Uuid::parse_str(id_s)
        .map_err(|_| CoreError::Message(format!("invalid memory id: {id_s}")))?;
    Ok(MemoryWriteOp::Retract { id })
}

/// Permission-gate target for a memory write (stable `mem://` form).
pub fn permission_target_for_write(op: &MemoryWriteOp) -> String {
    match op {
        MemoryWriteOp::Insert(d) => format!("mem://{}/new", d.scope.as_str()),
        MemoryWriteOp::UpdateMeta { id, .. } => format!("mem://update/{id}"),
        MemoryWriteOp::Supersede { old, .. } => format!("mem://supersede/{old}"),
        MemoryWriteOp::Retract { id } => format!("mem://retract/{id}"),
    }
}

/// Format recall hits as tool JSON for the model.
pub fn format_recall_hits(hits: &[RecallHit]) -> String {
    let rows: Vec<Value> = hits
        .iter()
        .map(|h| {
            json!({
                "id": h.record.id.to_string(),
                "kind": h.record.kind.as_str(),
                "title": h.record.title,
                "snippet": h.snippet,
                "score": h.score,
                "status": h.record.status.as_str(),
                "scope": h.record.scope.as_str(),
                "valid_from": h.record.valid_from,
                "valid_to": h.record.valid_to,
                "confidence": h.record.confidence,
                "source_id": h.source_id,
                "updated_at": h.record.updated_at,
            })
        })
        .collect();
    serde_json::to_string_pretty(&rows).unwrap_or_else(|_| "[]".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::embed::HybridWeights;
    use crate::memory::{MemoryStore, SqliteMemoryStore};

    #[test]
    fn specs_cover_four_tools() {
        let specs = memory_tool_specs();
        let names: Vec<_> = specs.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"link_memories"));
        assert!(names.contains(&"propose_memory_candidates"));
        assert!(names.contains(&"recall_memory"));
        assert!(names.contains(&"save_memory"));
        assert!(names.contains(&"supersede_memory"));
        assert!(names.contains(&"retract_memory"));
        let retract = specs.iter().find(|s| s.name == "retract_memory").unwrap();
        assert_eq!(retract.side_effect, ToolSideEffect::SoftWrite);
    }

    #[test]
    fn save_memory_schema_is_provider_compatible_and_runtime_validation_remains_strict() {
        let save = memory_tool_specs()
            .into_iter()
            .find(|spec| spec.name == "save_memory")
            .expect("save_memory tool spec");
        assert_eq!(save.parameters["type"], "object");
        assert!(save.parameters.get("anyOf").is_none());
        assert!(save.parameters.get("oneOf").is_none());

        let err = write_op_from_save_args(&json!({})).expect_err("missing write payload");
        assert!(err
            .to_string()
            .contains("requires content or body_markdown"));
        assert!(write_op_from_save_args(&json!({ "content": "remember this" })).is_ok());
        assert!(write_op_from_save_args(&json!({
            "id": Uuid::now_v7().to_string(),
            "pinned": true
        }))
        .is_ok());
    }

    #[test]
    fn save_insert_and_update_ops() {
        let op = write_op_from_save_args(&json!({
            "content": "hello",
            "kind": "fact"
        }))
        .unwrap();
        assert!(matches!(op, MemoryWriteOp::Insert(_)));
        let id = Uuid::now_v7();
        let op = write_op_from_save_args(&json!({ "id": id.to_string(), "pinned": true })).unwrap();
        match op {
            MemoryWriteOp::UpdateMeta { pinned, .. } => assert_eq!(pinned, Some(true)),
            _ => panic!("expected UpdateMeta"),
        }
    }

    #[test]
    fn store_round_trip_via_ops() {
        let store = SqliteMemoryStore::open_in_memory().unwrap();
        let op = write_op_from_save_args(&json!({
            "content": "launch date is June",
            "kind": "fact",
            "title": "Launch"
        }))
        .unwrap();
        let rec = store.put(op, 100).unwrap();
        let super_op = write_op_from_supersede_args(&json!({
            "old_id": rec.id.to_string(),
            "content": "launch date is July",
            "kind": "fact"
        }))
        .unwrap();
        let neu = store.put(super_op, 200).unwrap();
        assert_eq!(neu.supersedes, Some(rec.id));
        let retract = write_op_from_retract_args(&json!({ "id": neu.id.to_string() })).unwrap();
        let gone = store.put(retract, 300).unwrap();
        assert_eq!(gone.status, Status::Retracted);
        let hits = store
            .recall(
                &RecallQuery::new("launch"),
                None,
                HybridWeights::default(),
                300,
            )
            .unwrap();
        assert!(hits.is_empty());
        let t = audit_target_for_record(&gone);
        assert!(t.starts_with("mem://"));
        assert!(t.contains(&gone.id.to_string()));
    }

    #[test]
    fn destructive_tool_names() {
        assert!(is_destructive_memory_tool("retract_memory"));
        assert!(is_destructive_memory_tool("purge_memory"));
        assert!(!is_destructive_memory_tool("save_memory"));
    }

    #[test]
    fn normalize_memory_kind_case_and_aliases() {
        assert_eq!(normalize_memory_kind("PREFERENCE"), Kind::Preference);
        assert_eq!(normalize_memory_kind("Preference"), Kind::Preference);
        assert_eq!(normalize_memory_kind("project-note"), Kind::ProjectNote);
        assert_eq!(normalize_memory_kind("fact"), Kind::Fact);
        assert!(matches!(
            normalize_memory_kind("legacy_custom"),
            Kind::Other(_)
        ));
        assert_eq!(
            normalize_memory_kind("Future_Custom"),
            Kind::Other("Future_Custom".into()),
            "unknown kinds must retain their stored wire value"
        );
        for alias in [
            "facts",
            "decisions",
            "link",
            "PREFERENCES",
            "project-note",
            "person",
            "glossary",
            "todo",
        ] {
            assert_eq!(
                normalize_memory_kind(alias),
                Kind::parse(alias),
                "tool and storage normalization drifted for {alias}"
            );
        }
        assert_eq!(normalize_memory_kind("  "), Kind::ProjectNote);
        assert_eq!(Kind::parse("  "), Kind::Other("  ".into()));
        for k in DOCUMENTED_MEMORY_KINDS {
            assert_eq!(
                normalize_memory_kind(k).as_str().replace('-', "_"),
                (*k).replace('-', "_")
            );
        }
    }

    #[test]
    fn supersede_uses_the_same_kind_aliases_as_save() {
        let op = write_op_from_supersede_args(&json!({
            "old_id": Uuid::now_v7(),
            "content": "updated preference",
            "kind": "pref"
        }))
        .unwrap();
        let MemoryWriteOp::Supersede { new, .. } = op else {
            panic!("expected supersede");
        };
        assert_eq!(new.kind, Kind::Preference);
    }

    #[test]
    fn save_preference_then_filtered_recall_round_trip() {
        let store = SqliteMemoryStore::open_in_memory().unwrap();
        let op = write_op_from_save_args(&json!({
            "content": "GUI demo codename is cobalt-window",
            "kind": "PREFERENCE",
            "title": "cobalt-window"
        }))
        .unwrap();
        let rec = store.put(op, 100).unwrap();
        assert_eq!(rec.kind, Kind::Preference);

        // Filtered recall with only fact/project_note/term must miss Preference.
        let mut q = RecallQuery::new("cobalt-window codename");
        q.kinds = Some(vec![Kind::Fact, Kind::ProjectNote, Kind::Term]);
        let filtered = store
            .recall(&q, None, HybridWeights::default(), 100)
            .unwrap();
        assert!(
            !filtered.iter().any(|h| h.record.kind == Kind::Preference),
            "narrow kinds hide Preference"
        );

        // Filtered recall including preference finds it.
        q.kinds = Some(vec![Kind::Preference]);
        let pref_hits = store
            .recall(&q, None, HybridWeights::default(), 100)
            .unwrap();
        assert!(
            pref_hits.iter().any(|h| h.record.kind == Kind::Preference
                && (h.record.title.contains("cobalt") || h.snippet.contains("cobalt-window"))),
            "preference kinds filter must find saved Preference"
        );

        // Unfiltered inventory path finds it.
        q.kinds = None;
        let all = store
            .recall(&q, None, HybridWeights::default(), 100)
            .unwrap();
        assert!(all.iter().any(|h| h.record.kind == Kind::Preference));
    }

    #[test]
    fn save_invalid_kind_other_still_recallable_unfiltered() {
        let store = SqliteMemoryStore::open_in_memory().unwrap();
        let op = write_op_from_save_args(&json!({
            "content": "legacy_other_token_xyz body",
            "kind": "NotARealKind",
            "title": "legacy"
        }))
        .unwrap();
        let rec = store.put(op, 50).unwrap();
        assert!(matches!(rec.kind, Kind::Other(_)));
        let hits = store
            .recall(
                &RecallQuery::new("legacy_other_token_xyz"),
                None,
                HybridWeights::default(),
                50,
            )
            .unwrap();
        assert!(
            hits.iter()
                .any(|h| h.snippet.contains("legacy_other_token_xyz")
                    || h.record.content.contains("legacy_other_token_xyz")),
            "Other kinds remain in unfiltered recall for compatibility"
        );
    }
}
