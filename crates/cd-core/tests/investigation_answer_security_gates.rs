//! Anti-overfit and authority-boundary gates for typed investigation answers.
//!
//! These tests deliberately use generated opaque tokens. Correctness is
//! expressed as invariants over the validated topology, never expected prose
//! or a benchmark-specific incident answer.

use cd_core::investigation_answer::{
    parse_model_json, validate_model_answer, AnswerBindingV1, AnswerEnvelopeV1, ClaimStatus,
    EvidenceRole, HostEvidenceEntry, HostEvidenceLedger, LogSnapshotRevisionV1, ValidationError,
    SCHEMA_V1,
};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

fn opaque(namespace: u8, ordinal: usize) -> String {
    format!("z{namespace:02x}{ordinal:04x}q")
}

#[derive(Clone)]
struct ScenarioNames {
    session: String,
    turn: String,
    corpus: String,
    revision: LogSnapshotRevisionV1,
    candidates: Vec<String>,
    evidence: Vec<String>,
    sources: Vec<String>,
    locators: Vec<String>,
    contents: Vec<String>,
    claims: Vec<String>,
    texts: Vec<String>,
}

impl ScenarioNames {
    fn generated(namespace: u8) -> Self {
        let token = |ordinal| opaque(namespace, ordinal);
        Self {
            session: token(0),
            turn: token(1),
            corpus: token(2),
            revision: LogSnapshotRevisionV1 {
                event_revision: 3,
                template_analysis_revision: 5,
                suppression_revision: 7,
            },
            candidates: vec![token(10), token(11)],
            evidence: vec![token(20), token(21), token(22)],
            sources: vec![token(30), token(31), token(32)],
            locators: vec![token(40), token(41), token(42)],
            contents: vec![token(50), token(51), token(52)],
            claims: vec![token(60), token(61), token(62), token(63)],
            texts: vec![token(70), token(71), token(72), token(73)],
        }
    }

    fn inverse_map(&self, original: &Self) -> BTreeMap<String, String> {
        let mut inverse = BTreeMap::new();
        for (renamed, base) in [
            (&self.session, &original.session),
            (&self.turn, &original.turn),
            (&self.corpus, &original.corpus),
        ] {
            inverse.insert(renamed.clone(), base.clone());
        }
        for (renamed, base) in self
            .candidates
            .iter()
            .chain(&self.evidence)
            .chain(&self.sources)
            .chain(&self.locators)
            .chain(&self.contents)
            .chain(&self.claims)
            .chain(&self.texts)
            .zip(
                original
                    .candidates
                    .iter()
                    .chain(&original.evidence)
                    .chain(&original.sources)
                    .chain(&original.locators)
                    .chain(&original.contents)
                    .chain(&original.claims)
                    .chain(&original.texts),
            )
        {
            inverse.insert(renamed.clone(), base.clone());
        }
        inverse
    }
}

fn scenario_rows(names: &ScenarioNames) -> Vec<HostEvidenceEntry> {
    vec![
        HostEvidenceEntry {
            evidence_id: names.evidence[0].clone(),
            candidate_id: names.candidates[0].clone(),
            source_label: names.sources[0].clone(),
            locator: names.locators[0].clone(),
            corpus_id: names.corpus.clone(),
            revision: names.revision,
            role: EvidenceRole::Cause,
            content: names.contents[0].clone(),
        },
        HostEvidenceEntry {
            evidence_id: names.evidence[1].clone(),
            candidate_id: names.candidates[0].clone(),
            source_label: names.sources[1].clone(),
            locator: names.locators[1].clone(),
            corpus_id: names.corpus.clone(),
            revision: names.revision,
            role: EvidenceRole::Symptom,
            content: names.contents[1].clone(),
        },
        HostEvidenceEntry {
            evidence_id: names.evidence[2].clone(),
            candidate_id: names.candidates[1].clone(),
            source_label: names.sources[2].clone(),
            locator: names.locators[2].clone(),
            corpus_id: names.corpus.clone(),
            revision: names.revision,
            role: EvidenceRole::Neutral,
            content: names.contents[2].clone(),
        },
    ]
}

fn binding_for_rows(names: &ScenarioNames, rows: &[HostEvidenceEntry]) -> AnswerBindingV1 {
    AnswerBindingV1 {
        session_id: names.session.clone(),
        turn_id: names.turn.clone(),
        corpus_id: names.corpus.clone(),
        revision: names.revision,
        ledger_digest: HostEvidenceLedger::digest(rows),
    }
}

fn ledger_from_rows(names: &ScenarioNames, rows: Vec<HostEvidenceEntry>) -> HostEvidenceLedger {
    HostEvidenceLedger::new(binding_for_rows(names, &rows), rows)
        .expect("generated ledger must be valid")
}

fn scenario_proposal(names: &ScenarioNames) -> String {
    json!({
        "schema": SCHEMA_V1,
        "candidates": [
            {
                "candidate_id": names.candidates[0],
                "initiating_causes": [{
                    "claim_id": names.claims[0],
                    "text": names.texts[0],
                    "evidence_ids": [names.evidence[0]],
                }],
                "symptoms": [{
                    "claim_id": names.claims[1],
                    "text": names.texts[1],
                    "evidence_ids": [names.evidence[1]],
                }],
            },
            {
                "candidate_id": names.candidates[1],
                "observations": [{
                    "claim_id": names.claims[2],
                    "text": names.texts[2],
                    "evidence_ids": [names.evidence[2]],
                }],
                "missing_evidence": [{
                    "claim_id": names.claims[3],
                    "text": names.texts[3],
                    "evidence_ids": [],
                }],
            },
        ],
    })
    .to_string()
}

fn map_token(value: &mut String, inverse: &BTreeMap<String, String>) {
    if let Some(original) = inverse.get(value) {
        *value = original.clone();
    }
}

fn apply_inverse_mapping(
    envelope: &mut AnswerEnvelopeV1,
    inverse: &BTreeMap<String, String>,
    original_digest: &str,
) {
    map_token(&mut envelope.binding.session_id, inverse);
    map_token(&mut envelope.binding.turn_id, inverse);
    map_token(&mut envelope.binding.corpus_id, inverse);
    envelope.binding.ledger_digest = original_digest.to_string();
    for entry in &mut envelope.evidence {
        map_token(&mut entry.evidence_id, inverse);
        map_token(&mut entry.candidate_id, inverse);
        map_token(&mut entry.source_label, inverse);
        map_token(&mut entry.locator, inverse);
        map_token(&mut entry.corpus_id, inverse);
        map_token(&mut entry.content, inverse);
    }
    for candidate in &mut envelope.answer.candidates {
        map_token(&mut candidate.candidate_id, inverse);
        for claim in &mut candidate.claims {
            map_token(&mut claim.claim_id, inverse);
            map_token(&mut claim.text, inverse);
            map_token(&mut claim.candidate_id, inverse);
            for evidence_id in &mut claim.evidence_ids {
                map_token(evidence_id, inverse);
            }
        }
    }
    for citation in &mut envelope.answer.canonical_citations {
        map_token(&mut citation.evidence_id, inverse);
        map_token(&mut citation.candidate_id, inverse);
        map_token(&mut citation.source_label, inverse);
        map_token(&mut citation.locator, inverse);
        map_token(&mut citation.corpus_id, inverse);
        map_token(&mut citation.content, inverse);
    }
}

#[test]
fn opaque_vocabulary_bijection_preserves_validated_authority_topology() {
    let original_names = ScenarioNames::generated(0x11);
    let renamed_names = ScenarioNames::generated(0xe7);
    let original_ledger = ledger_from_rows(&original_names, scenario_rows(&original_names));
    let renamed_ledger = ledger_from_rows(&renamed_names, scenario_rows(&renamed_names));

    let original = validate_model_answer(&scenario_proposal(&original_names), &original_ledger)
        .expect("original opaque proposal");
    let mut renamed = validate_model_answer(&scenario_proposal(&renamed_names), &renamed_ledger)
        .expect("bijectively renamed opaque proposal");

    let inverse = renamed_names.inverse_map(&original_names);
    apply_inverse_mapping(&mut renamed, &inverse, &original.binding.ledger_digest);
    assert_eq!(renamed, original);
}

fn strict_proposal_value() -> Value {
    json!({
        "schema": SCHEMA_V1,
        "candidates": [{
            "candidate_id": opaque(0x22, 0),
            "observations": [{
                "claim_id": opaque(0x22, 1),
                "text": opaque(0x22, 2),
                "evidence_ids": [opaque(0x22, 3)],
            }],
        }],
    })
}

#[test]
fn strict_boundary_rejects_forged_host_authority_at_every_model_shape() {
    let top_level_host_fields = [
        "canonical_citations",
        "root_cause_established",
        "binding",
        "evidence",
        "semantic_attempts",
    ];
    for field in top_level_host_fields {
        let mut value = strict_proposal_value();
        value[field] = json!([]);
        assert_eq!(
            parse_model_json(&value.to_string()),
            Err(ValidationError::Parse),
            "top-level host field must be rejected: {field}"
        );
    }

    for field in ["claims", "confidence", "canonical_citations"] {
        let mut value = strict_proposal_value();
        value["candidates"][0][field] = json!([]);
        assert_eq!(
            parse_model_json(&value.to_string()),
            Err(ValidationError::Parse),
            "candidate host field must be rejected: {field}"
        );
    }

    for field in [
        "status",
        "claim_kind",
        "candidate_id",
        "source_label",
        "locator",
        "corpus_id",
        "revision",
        "role",
        "content",
    ] {
        let mut value = strict_proposal_value();
        value["candidates"][0]["observations"][0][field] = json!(opaque(0x22, 9));
        assert_eq!(
            parse_model_json(&value.to_string()),
            Err(ValidationError::Parse),
            "claim host field must be rejected: {field}"
        );
    }

    let valid = strict_proposal_value().to_string();
    for framed in [
        format!("prefix{valid}"),
        format!("{valid}suffix"),
        format!("{valid}{valid}"),
        format!("```json\n{valid}\n```"),
    ] {
        assert_eq!(parse_model_json(&framed), Err(ValidationError::Parse));
    }
}

#[test]
fn scope_digest_and_identifier_mutations_fail_closed() {
    let names = ScenarioNames::generated(0x33);
    let rows = scenario_rows(&names);
    let ledger = ledger_from_rows(&names, rows.clone());

    let proposal_citing_only_first_row = json!({
        "schema": SCHEMA_V1,
        "candidates": [{
            "candidate_id": names.candidates[0],
            "observations": [{
                "claim_id": names.claims[0],
                "text": names.texts[0],
                "evidence_ids": [names.evidence[0]],
            }],
        }],
    })
    .to_string();
    assert!(!proposal_citing_only_first_row.contains(&names.evidence[1]));
    let same_candidate_rows = rows[..2].to_vec();
    let same_candidate_ledger = HostEvidenceLedger::new(
        binding_for_rows(&names, &same_candidate_rows),
        same_candidate_rows,
    )
    .expect("fully bound unreferenced row is allowed");
    validate_model_answer(&proposal_citing_only_first_row, &same_candidate_ledger)
        .expect("the first row is a valid citation and the second is intentionally unreferenced");

    let unreferenced_scope_mutations: [fn(&mut HostEvidenceEntry); 2] = [
        |row: &mut HostEvidenceEntry| row.corpus_id = opaque(0x33, 90),
        |row: &mut HostEvidenceEntry| row.revision.event_revision += 1,
    ];
    for mutate in unreferenced_scope_mutations {
        // The proposal cites row zero only. Mutate another row for the same
        // candidate so claim-level validation could not observe it; ledger
        // construction must still reject it before any envelope can exist.
        let mut unreferenced_bad_rows = rows[..2].to_vec();
        mutate(&mut unreferenced_bad_rows[1]);
        assert!(matches!(
            HostEvidenceLedger::new(
                binding_for_rows(&names, &unreferenced_bad_rows),
                unreferenced_bad_rows,
            ),
            Err(ValidationError::WrongRevision)
        ));
    }

    let mut blank_evidence_rows = rows.clone();
    blank_evidence_rows[0].evidence_id = " \t".into();
    assert!(matches!(
        HostEvidenceLedger::new(
            binding_for_rows(&names, &blank_evidence_rows),
            blank_evidence_rows,
        ),
        Err(ValidationError::DuplicateId)
    ));
    let mut blank_candidate_rows = rows.clone();
    blank_candidate_rows[0].candidate_id = " \t".into();
    assert!(matches!(
        HostEvidenceLedger::new(
            binding_for_rows(&names, &blank_candidate_rows),
            blank_candidate_rows,
        ),
        Err(ValidationError::WrongScope)
    ));

    let mut transplanted: Value =
        serde_json::from_str(&scenario_proposal(&names)).expect("proposal json");
    transplanted["candidates"][1]["observations"][0]["evidence_ids"] = json!([names.evidence[0]]);
    assert_eq!(
        validate_model_answer(&transplanted.to_string(), &ledger),
        Err(ValidationError::WrongScope)
    );

    for mutation in 0..8 {
        let mut tampered = rows.clone();
        match mutation {
            0 => tampered[0].evidence_id.push('x'),
            1 => tampered[0].candidate_id.push('x'),
            2 => tampered[0].source_label.push('x'),
            3 => tampered[0].locator.push('x'),
            4 => tampered[0].corpus_id.push('x'),
            5 => tampered[0].revision.suppression_revision += 1,
            6 => tampered[0].role = EvidenceRole::Supporting,
            _ => tampered[0].content.push('x'),
        }
        assert!(matches!(
            HostEvidenceLedger::new(ledger.binding().clone(), tampered),
            Err(ValidationError::DigestMismatch)
        ));
    }

    let mut duplicate_rows = rows.clone();
    duplicate_rows.push(rows[0].clone());
    let duplicate_binding = AnswerBindingV1 {
        ledger_digest: HostEvidenceLedger::digest(&duplicate_rows),
        ..ledger.binding().clone()
    };
    assert!(matches!(
        HostEvidenceLedger::new(duplicate_binding, duplicate_rows),
        Err(ValidationError::DuplicateId)
    ));

    let mut duplicate_claim: Value =
        serde_json::from_str(&scenario_proposal(&names)).expect("proposal json");
    duplicate_claim["candidates"][1]["observations"][0]["claim_id"] = json!(names.claims[0]);
    assert_eq!(
        validate_model_answer(&duplicate_claim.to_string(), &ledger),
        Err(ValidationError::DuplicateId)
    );
}

fn frequency_rows(names: &ScenarioNames, roles: &[EvidenceRole]) -> Vec<HostEvidenceEntry> {
    roles
        .iter()
        .enumerate()
        .map(|(index, role)| HostEvidenceEntry {
            evidence_id: opaque(0x44, index),
            candidate_id: names.candidates[0].clone(),
            source_label: names.sources[0].clone(),
            locator: names.locators[0].clone(),
            corpus_id: names.corpus.clone(),
            revision: names.revision,
            role: *role,
            // Deliberately frequency-like duplicate evidence content.
            content: names.contents[0].clone(),
        })
        .collect()
}

fn root_proposal(names: &ScenarioNames, evidence_ids: &[String]) -> String {
    json!({
        "schema": SCHEMA_V1,
        "candidates": [{
            "candidate_id": names.candidates[0],
            "initiating_causes": [{
                "claim_id": names.claims[0],
                "text": names.texts[0],
                "evidence_ids": evidence_ids,
            }],
        }],
    })
    .to_string()
}

#[test]
fn only_explicit_host_cause_establishes_root_despite_order_or_frequency() {
    let names = ScenarioNames::generated(0x44);
    let non_cause_roles = [
        EvidenceRole::Supporting,
        EvidenceRole::Symptom,
        EvidenceRole::Neutral,
        EvidenceRole::Supporting,
        EvidenceRole::Symptom,
        EvidenceRole::Neutral,
    ];
    let non_cause_rows = frequency_rows(&names, &non_cause_roles);
    let non_cause_ids = non_cause_rows
        .iter()
        .map(|entry| entry.evidence_id.clone())
        .collect::<Vec<_>>();
    let non_cause = validate_model_answer(
        &root_proposal(&names, &non_cause_ids),
        &ledger_from_rows(&names, non_cause_rows.clone()),
    )
    .expect("non-cause rows remain disclosable");
    assert!(!non_cause.answer.root_cause_established);
    assert_eq!(
        non_cause.answer.candidates[0].claims[0].status,
        ClaimStatus::Withheld
    );

    let mut reordered_rows = non_cause_rows.clone();
    reordered_rows.reverse();
    let reordered = validate_model_answer(
        &root_proposal(&names, &non_cause_ids),
        &ledger_from_rows(&names, reordered_rows),
    )
    .expect("row order is not authority");
    assert_eq!(reordered.answer, non_cause.answer);

    let mut with_cause_rows = non_cause_rows.clone();
    with_cause_rows.push(HostEvidenceEntry {
        evidence_id: opaque(0x44, 99),
        candidate_id: names.candidates[0].clone(),
        source_label: names.sources[1].clone(),
        locator: names.locators[1].clone(),
        corpus_id: names.corpus.clone(),
        revision: names.revision,
        role: EvidenceRole::Cause,
        content: names.contents[1].clone(),
    });
    let cause_id = with_cause_rows
        .last()
        .expect("cause row")
        .evidence_id
        .clone();
    let mut with_cause_ids = non_cause_ids.clone();
    with_cause_ids.push(cause_id.clone());
    let established = validate_model_answer(
        &root_proposal(&names, &with_cause_ids),
        &ledger_from_rows(&names, with_cause_rows.clone()),
    )
    .expect("explicit cause row");
    assert!(established.answer.root_cause_established);
    assert_eq!(
        established.answer.candidates[0].claims[0].status,
        ClaimStatus::Supported
    );

    let without_cause = ledger_from_rows(&names, non_cause_rows);
    assert_eq!(
        validate_model_answer(&root_proposal(&names, &with_cause_ids), &without_cause),
        Err(ValidationError::UnknownEvidence)
    );

    let mut reversed_role_rows = with_cause_rows;
    reversed_role_rows
        .iter_mut()
        .find(|entry| entry.evidence_id == cause_id)
        .expect("cause row")
        .role = EvidenceRole::Neutral;
    let reversed = validate_model_answer(
        &root_proposal(&names, &with_cause_ids),
        &ledger_from_rows(&names, reversed_role_rows),
    )
    .expect("role reversal discloses a withheld claim");
    assert!(!reversed.answer.root_cause_established);
    assert_eq!(
        reversed.answer.candidates[0].claims[0].status,
        ClaimStatus::Withheld
    );
}

fn collect_files(root: &Path, suffix: &str, output: &mut Vec<PathBuf>) {
    if root.is_file() {
        if root.to_string_lossy().ends_with(suffix) {
            output.push(root.to_path_buf());
        }
        return;
    }
    for entry in fs::read_dir(root).expect("read source tree") {
        collect_files(&entry.expect("source entry").path(), suffix, output);
    }
}

fn runtime_leak_scan_source(source: &str) -> &str {
    // Scan the complete file. Test-only declarations can appear before later
    // production items (`search.rs` and `tool_host.rs` both do this), so
    // truncating at an arbitrary `#[cfg(test)]` creates a false-negative hole.
    // A conservative full-file scan may reject fixture vocabulary in tests,
    // but it can never silently omit reachable production ranking or prompts.
    source
}

#[test]
fn runtime_source_scan_does_not_stop_at_an_early_cfg_test_item() {
    let source = "before\n#[cfg(test)]\nuse crate::test_support;\nruntime_marker_after_cfg\n";
    let scanned = runtime_leak_scan_source(source);
    assert!(scanned.contains("runtime_marker_after_cfg"));
    assert_eq!(
        scanned, source,
        "the leak scan must cover the complete file"
    );
}

fn collect_oracle_strings(value: &Value, output: &mut BTreeSet<String>) {
    if let Some(groups) = value.get("evidence_groups").and_then(Value::as_array) {
        for group in groups {
            if let Some(token) = group.get("token").and_then(Value::as_str) {
                if token.chars().count() >= 12 {
                    output.insert(token.to_ascii_lowercase());
                }
            }
        }
    }
    for key in ["forbidden_claims", "required_disclosures"] {
        if let Some(values) = value.get(key).and_then(Value::as_array) {
            for text in values.iter().filter_map(Value::as_str) {
                if text.chars().count() >= 12 {
                    output.insert(text.to_ascii_lowercase());
                }
            }
        }
    }
}

#[test]
fn runtime_ranking_and_prompts_do_not_embed_or_import_answer_key_vocabulary() {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let runtime_paths = [
        manifest_dir.join("src/agent.rs"),
        manifest_dir.join("src/investigation_answer.rs"),
        manifest_dir.join("src/log_analysis/search.rs"),
        manifest_dir.join("src/log_analysis/linked_search_bound.rs"),
        manifest_dir.join("src/tool_host.rs"),
    ];
    let runtime = runtime_paths
        .iter()
        .map(|path| {
            let source = fs::read_to_string(path).expect("runtime source");
            (path, runtime_leak_scan_source(&source).to_ascii_lowercase())
        })
        .collect::<Vec<_>>();

    for (path, source) in &runtime {
        assert!(
            !source.contains("token_aliases"),
            "runtime token alias table is forbidden: {}",
            path.display()
        );
        for answer_key_path in ["truth/manifest", "retrieval-ablation/cases"] {
            assert!(
                !source.contains(answer_key_path),
                "runtime must not import benchmark answer keys: {} contains {answer_key_path}",
                path.display()
            );
        }
    }

    let truth_root = manifest_dir.join("../../fixtures/log-lab/scenarios/retrieval-ablation/cases");
    let mut manifests = Vec::new();
    collect_files(&truth_root, "/truth/manifest.json", &mut manifests);
    assert!(!manifests.is_empty(), "expected benchmark truth manifests");
    let mut oracle_strings = BTreeSet::new();
    for manifest in manifests {
        let value: Value =
            serde_json::from_str(&fs::read_to_string(&manifest).expect("read truth manifest"))
                .expect("truth manifest json");
        collect_oracle_strings(&value, &mut oracle_strings);
    }
    assert!(
        !oracle_strings.is_empty(),
        "expected derived oracle vocabulary"
    );

    let leaked = runtime
        .iter()
        .flat_map(|(path, source)| {
            oracle_strings
                .iter()
                .filter(move |phrase| source.contains(*phrase))
                .map(move |phrase| {
                    format!(
                        "{} contains derived oracle phrase {phrase:?}",
                        path.display()
                    )
                })
        })
        .collect::<Vec<_>>();
    assert!(
        leaked.is_empty(),
        "benchmark vocabulary leaked into runtime ranking/prompt sources:\n{}",
        leaked.join("\n")
    );
}
