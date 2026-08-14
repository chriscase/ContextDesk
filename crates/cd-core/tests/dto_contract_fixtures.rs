//! Wire-contract fixtures for the first governed `cd.v1` DTO family (design
//! handoff batch B2).
//!
//! Every fixture under `fixtures/contracts/` is the exact `serde_json` pretty
//! serialization of the *production* Rust type that crosses the Tauri IPC
//! boundary — never a parallel "equivalent" struct. The TypeScript mirror in
//! `packages/contracts` parses these same bytes with strict runtime
//! validators, so a silent rename, casing change, enum drift, or numeric-range
//! change on either side fails a test instead of failing only in the packaged
//! app.
//!
//! Regenerate after an intentional wire change:
//!
//! ```text
//! cargo test -p cd-core --test dto_contract_fixtures -- --ignored --nocapture
//! ```
//!
//! The normal (non-ignored) test regenerates in memory and byte-compares every
//! committed fixture, failing on drift, missing files, extra files, unstable
//! serialization, or an empty fixture set.

use std::collections::BTreeMap;
use std::path::PathBuf;

use cd_core::investigations::{
    assemble_investigation_report, EvidenceItem, EvidenceProvenance, EvidenceReferenceResolution,
    EvidenceReferenceStatus, FindingItem, FindingKind, FindingLifecycle, FindingViewFilters,
    FindingViewFind, FindingViewFindMatchMode, FindingViewLane, FindingViewRecipe,
    FindingViewTimeLinkMode, FindingViewViewportAnchor, HumanProposalAcceptance, HumanProvenance,
    InvestigationCorpusLink, InvestigationDocument, InvestigationNoiseLens,
    InvestigationPolicyBinding, InvestigationPolicyBindingResolution,
    InvestigationPolicyBindingStatus, InvestigationReport, InvestigationStatus, NoteItem,
    ProposalEvidenceCitation, ProposalEvidenceRole, ProposalProvenance, ProposalRankInputs,
    ProposalSourceKind, ProposedFindingItem, ProposedFindingStatus, ProposedReportSectionItem,
    ReportSectionItem, ReportSectionKind, ResolvedEvidenceItem, ResolvedFindingItem,
    ResolvedInvestigationDocument, PROPOSE_REPORT_SECTION_TOOL,
};
use cd_core::log_analysis::{ActiveTimestampBasis, TimestampProvenance};
use cd_core::log_analysis::{
    Bookmark, BookmarkEventRef, BookmarkEvidenceStatus, EventCount, EventPage, EventRowsPage,
    ExplorerEvent, LogFacets, NoiseCandidate, NoiseCandidateReasonCode, NoiseCandidateReport,
    NoiseCandidateRepresentative, NoiseCandidateShape, ResolvedBookmark, SharedTimelineAxisBucket,
    SharedTimelineLaneSummary, SharedTimelineSeverity, SharedTimelineSeveritySeries,
    SharedTimelineSummary, SuppressionAuditAction, SuppressionAuditEntry, SuppressionDocument,
    SuppressionLevelCount, SuppressionPreview, SuppressionRepresentativeEvent, SuppressionRule,
    SuppressionRuleOrigin, SuppressionRuleResolution, SuppressionRuleResolutionKind,
    SuppressionRuleState, SuppressionTemplatePredicate, SuppressionTimeSpan, TimeQuality,
};
use cd_core::model_curation::{model_selection_key, ModelAvailability, ModelOptionDto};
use cd_core::process_progress::{ProcessProgress, ProcessProgressKind, ProcessProgressPhase};
use cd_core::research::EventDto;
use serde_json::{json, Value};

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/contracts")
}

fn explorer_event_full() -> ExplorerEvent {
    ExplorerEvent {
        seq: 42,
        ts: 1_735_991_449,
        timestamp_provenance: TimestampProvenance::ExplicitWallClock,
        active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
        unresolved_local_timestamp: Some("2026-01-04 14:30:49".into()),
        time_quality: TimeQuality::Wall,
        level: "ERROR".into(),
        service: Some("checkout".into()),
        host: Some("api-7".into()),
        template_id: 41,
        trace_id: Some("req-9f1".into()),
        message: "connection refused to db-<*>".into(),
        source: "api.log".into(),
    }
}

fn explorer_event_sparse() -> ExplorerEvent {
    ExplorerEvent {
        seq: 43,
        ts: 17_123,
        timestamp_provenance: TimestampProvenance::OrderOnly,
        active_timestamp_basis: ActiveTimestampBasis::OrderOnly,
        unresolved_local_timestamp: None,
        time_quality: TimeQuality::OrderOnly,
        level: "INFO".into(),
        service: None,
        host: None,
        template_id: 7,
        trace_id: None,
        message: "GET /health <*>".into(),
        source: "worker.log".into(),
    }
}

fn event_ref(seq: u64) -> BookmarkEventRef {
    BookmarkEventRef {
        corpus_id: "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001".into(),
        seq,
        source: "api.log".into(),
        timestamp_hint: 1_735_991_449,
        time_quality_hint: TimeQuality::Wall,
    }
}

fn investigation_policy_binding() -> InvestigationPolicyBinding {
    InvestigationPolicyBinding {
        suppression_policy_revision: 7,
        resolved_template_revision: 11,
        effective_policy_sha256: "9f9af2c8459f74dc6f21ce3e0a9c7fd5a677d9cc7f60c5ee7f86a8c285e1732f"
            .into(),
        noise_lens: InvestigationNoiseLens::Active,
    }
}

fn suppression_document_sample() -> SuppressionDocument {
    let predicate = SuppressionTemplatePredicate {
        template_id: 41,
        template_fingerprint: "fp-41-abcdef".into(),
    };
    SuppressionDocument {
        schema_version: 1,
        corpus_id: "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001".into(),
        revision: 7,
        rules: vec![
            SuppressionRule {
                id: "0199aaaa-0000-7000-8000-000000000001".into(),
                name: "health-check noise".into(),
                rationale: "Reviewed repetitive success traffic".into(),
                predicate: predicate.clone(),
                origin: SuppressionRuleOrigin::Human,
                state: SuppressionRuleState::Enabled,
                created_at: 1_735_990_000,
                updated_at: 1_735_990_100,
                resolution: Some(SuppressionRuleResolution {
                    kind: SuppressionRuleResolutionKind::MatchesCurrent,
                    matches_nothing: false,
                    explanation: "Enabled rule matches the current exact template.".into(),
                }),
            },
            SuppressionRule {
                id: "0199aaaa-0000-7000-8000-000000000002".into(),
                name: "retry chatter".into(),
                rationale: "Detector proposal retained for review".into(),
                predicate: SuppressionTemplatePredicate {
                    template_id: 77,
                    template_fingerprint: "fp-77-123456".into(),
                },
                origin: SuppressionRuleOrigin::DetectorProposal,
                state: SuppressionRuleState::Disabled,
                created_at: 1_735_990_200,
                updated_at: 1_735_990_300,
                resolution: Some(SuppressionRuleResolution {
                    kind: SuppressionRuleResolutionKind::Inactive,
                    matches_nothing: true,
                    explanation: "Disabled rules exclude nothing.".into(),
                }),
            },
            SuppressionRule {
                id: "0199aaaa-0000-7000-8000-000000000003".into(),
                name: "obsolete rule".into(),
                rationale: "Model proposal later removed".into(),
                predicate: SuppressionTemplatePredicate {
                    template_id: 99,
                    template_fingerprint: "fp-99-fedcba".into(),
                },
                origin: SuppressionRuleOrigin::ModelProposal,
                state: SuppressionRuleState::Removed,
                created_at: 1_735_990_400,
                updated_at: 1_735_990_500,
                resolution: Some(SuppressionRuleResolution {
                    kind: SuppressionRuleResolutionKind::StaleTargetMissing,
                    matches_nothing: true,
                    explanation: "The historical target no longer exists.".into(),
                }),
            },
        ],
        previews: vec![SuppressionPreview {
            token: "0199aaaa-1111-7000-8000-000000000001".into(),
            corpus_id: "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001".into(),
            event_revision: 3,
            rule_revision: 7,
            name: "health-check noise".into(),
            rationale: "Confirmed repetitive infrastructure traffic".into(),
            predicate,
            origin: SuppressionRuleOrigin::Human,
            matching_event_count: 10_300,
            incremental_event_count: 10_300,
            corpus_event_count: 25_000,
            level_counts: vec![
                SuppressionLevelCount {
                    level: "INFO".into(),
                    count: 10_299,
                },
                SuppressionLevelCount {
                    level: "WARN".into(),
                    count: 1,
                },
            ],
            source_count: 3,
            time_span: SuppressionTimeSpan {
                from: 1_735_400_000,
                to: 1_735_991_449,
            },
            representatives: vec![SuppressionRepresentativeEvent {
                seq: 42,
                source: "api.log".into(),
                timestamp: 1_735_991_449,
                time_quality: TimeQuality::Wall,
                level: "INFO".into(),
                redacted_excerpt: "GET /health 200 [REDACTED_TOKEN]".into(),
            }],
            created_at: 1_735_990_050,
        }],
        audit: vec![
            SuppressionAuditEntry {
                id: "0199aaaa-2222-7000-8000-000000000001".into(),
                revision: 3,
                action: SuppressionAuditAction::Previewed,
                rule_id: None,
                preview_token: Some("0199aaaa-1111-7000-8000-000000000001".into()),
                created_at: 1_735_990_050,
            },
            SuppressionAuditEntry {
                id: "0199aaaa-2222-7000-8000-000000000002".into(),
                revision: 4,
                action: SuppressionAuditAction::Activated,
                rule_id: Some("0199aaaa-0000-7000-8000-000000000001".into()),
                preview_token: Some("0199aaaa-1111-7000-8000-000000000001".into()),
                created_at: 1_735_990_100,
            },
            SuppressionAuditEntry {
                id: "0199aaaa-2222-7000-8000-000000000003".into(),
                revision: 5,
                action: SuppressionAuditAction::Disabled,
                rule_id: Some("0199aaaa-0000-7000-8000-000000000002".into()),
                preview_token: None,
                created_at: 1_735_990_300,
            },
            SuppressionAuditEntry {
                id: "0199aaaa-2222-7000-8000-000000000004".into(),
                revision: 6,
                action: SuppressionAuditAction::Reenabled,
                rule_id: Some("0199aaaa-0000-7000-8000-000000000002".into()),
                preview_token: None,
                created_at: 1_735_990_350,
            },
            SuppressionAuditEntry {
                id: "0199aaaa-2222-7000-8000-000000000005".into(),
                revision: 7,
                action: SuppressionAuditAction::Removed,
                rule_id: Some("0199aaaa-0000-7000-8000-000000000003".into()),
                preview_token: None,
                created_at: 1_735_990_500,
            },
        ],
        resolved_template_revision: Some(11),
    }
}

fn noise_candidate_report_sample() -> NoiseCandidateReport {
    NoiseCandidateReport {
        corpus_id: "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001".into(),
        unsuppressed_event_count: 14_700,
        corpus_event_count: 25_000,
        suppression_revision: 7,
        event_revision: 3,
        template_analysis_revision: 2,
        already_suppressed_template_ids: vec![41],
        time_quality: TimeQuality::Wall,
        raw_time_quality: TimeQuality::Mixed,
        candidates: vec![
            NoiseCandidate {
                template_id: 7,
                template_fingerprint: "fp-7-001122".into(),
                pattern: "GET /health <*>".into(),
                score: 9_812,
                event_count: 6_058,
                corpus_share_bps: 4_120,
                source_count: 3,
                shape: NoiseCandidateShape::Steady,
                time_quality: TimeQuality::Wall,
                wall_time_span: Some(SuppressionTimeSpan {
                    from: 1_735_400_000,
                    to: 1_735_991_400,
                }),
                order_span: None,
                level_counts: vec![SuppressionLevelCount {
                    level: "INFO".into(),
                    count: 6_058,
                }],
                other_level_count: 0,
                level_counts_truncated: false,
                error_or_fatal_count: 0,
                warn_count: 0,
                info_count: 6_058,
                reason_codes: vec![
                    NoiseCandidateReasonCode::HighCorpusShare,
                    NoiseCandidateReasonCode::SteadyBackground,
                ],
                explanation: "41.2% of unsuppressed events across 3 sources at a steady rate."
                    .into(),
                already_suppressed: false,
                share_basis: "unsuppressed_events",
                proposal_kind: "candidate",
                representatives: vec![NoiseCandidateRepresentative {
                    seq: 43,
                    source: "worker.log".into(),
                    timestamp: 1_735_991_300,
                    time_quality: TimeQuality::Wall,
                    level: "INFO".into(),
                    redacted_excerpt: "GET /health 200".into(),
                }],
            },
            NoiseCandidate {
                template_id: 88,
                template_fingerprint: "fp-88-334455".into(),
                pattern: "retry attempt <*> failed".into(),
                score: 5_100,
                event_count: 900,
                corpus_share_bps: 612,
                source_count: 1,
                shape: NoiseCandidateShape::Bursty,
                time_quality: TimeQuality::OrderOnly,
                wall_time_span: None,
                order_span: Some(SuppressionTimeSpan {
                    from: 12_000,
                    to: 17_000,
                }),
                level_counts: vec![
                    SuppressionLevelCount {
                        level: "WARN".into(),
                        count: 700,
                    },
                    SuppressionLevelCount {
                        level: "ERROR".into(),
                        count: 200,
                    },
                ],
                other_level_count: 0,
                level_counts_truncated: false,
                error_or_fatal_count: 200,
                warn_count: 700,
                info_count: 0,
                reason_codes: vec![NoiseCandidateReasonCode::RepetitiveErrorRisky],
                explanation: "Repetitive but severity-bearing; marked risky, never auto-noise."
                    .into(),
                already_suppressed: false,
                share_basis: "unsuppressed_events",
                proposal_kind: "candidate",
                representatives: vec![],
            },
        ],
        eligible_candidate_count: 2,
        templates_scanned: 648,
        truncated: false,
        candidate_cap_truncated: false,
        template_scan_truncated: true,
        response_bytes_truncated: false,
        metadata_missing_template_ids: vec![],
        database_query_count: 4,
        disclaimer: NoiseCandidateReport::DISCLAIMER,
        cancelled: false,
    }
}

fn investigation_document_sample() -> InvestigationDocument {
    let corpus_id = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001".to_string();
    let investigation_id = "0199bbbb-0000-7000-8000-000000000001".to_string();
    let policy_binding = investigation_policy_binding();
    InvestigationDocument {
        schema_version: 6,
        id: investigation_id.clone(),
        revision: 5,
        title: "checkout-cascade".into(),
        status: InvestigationStatus::Active,
        corpus_links: vec![InvestigationCorpusLink {
            corpus_id: corpus_id.clone(),
        }],
        evidence: vec![EvidenceItem {
            id: "0199bbbb-1111-7000-8000-000000000001".into(),
            title: "burst of connection refusals".into(),
            provenance: EvidenceProvenance::Human,
            corpus_id: corpus_id.clone(),
            event_refs: vec![event_ref(42), event_ref(44)],
            created_at: 1_735_991_500,
            updated_at: 1_735_991_500,
        }],
        findings: vec![
            FindingItem {
                id: "0199bbbb-2222-7000-8000-000000000001".into(),
                kind: FindingKind::Observation,
                lifecycle: FindingLifecycle::Accepted,
                title: "error burst at 14:02".into(),
                why_it_matters: "Marks the incident onset window.".into(),
                evidence_ids: vec!["0199bbbb-1111-7000-8000-000000000001".into()],
                view_recipe: Some(FindingViewRecipe {
                    filters: FindingViewFilters {
                        levels: vec!["ERROR".into()],
                        sources: vec!["api.log".into()],
                        services: vec![],
                        hosts: vec![],
                        time_from: Some(1_735_991_400),
                        time_to: Some(1_735_991_500),
                        seq_from: None,
                        seq_to: None,
                        template_id: Some(41),
                        trace_id: None,
                        keyword: Some("refused".into()),
                    },
                    lanes: vec![FindingViewLane {
                        id: "lane-1".into(),
                        label: "api".into(),
                        sources: vec!["api.log".into()],
                    }],
                    visible_lane_count: 1,
                    time_link_mode: FindingViewTimeLinkMode::FollowCursor,
                    focused_lane_id: Some("lane-1".into()),
                    focused_event: Some(event_ref(42)),
                    selection: vec![event_ref(42)],
                    highlights: vec![],
                    find: Some(FindingViewFind {
                        query: "refused".into(),
                        match_mode: FindingViewFindMatchMode::Literal,
                        case_sensitive: false,
                        semantic: false,
                    }),
                    viewport_anchors: vec![FindingViewViewportAnchor {
                        lane_id: "lane-1".into(),
                        event_ref: event_ref(42),
                    }],
                }),
                policy_binding: Some(policy_binding.clone()),
                provenance: HumanProvenance::Human,
                created_at: 1_735_991_600,
                updated_at: 1_735_991_600,
            },
            FindingItem {
                id: "0199bbbb-2222-7000-8000-000000000002".into(),
                kind: FindingKind::Inference,
                lifecycle: FindingLifecycle::Accepted,
                title: "pool exhaustion preceded the burst".into(),
                why_it_matters: "Connects the warning trail to the failures.".into(),
                evidence_ids: vec!["0199bbbb-1111-7000-8000-000000000001".into()],
                view_recipe: None,
                policy_binding: Some(policy_binding.clone()),
                provenance: HumanProvenance::Human,
                created_at: 1_735_991_700,
                updated_at: 1_735_991_700,
            },
            FindingItem {
                id: "0199bbbb-2222-7000-8000-000000000003".into(),
                kind: FindingKind::Hypothesis,
                lifecycle: FindingLifecycle::Resolved,
                title: "db-7 restart caused the cascade".into(),
                why_it_matters: "Testable root-cause explanation.".into(),
                evidence_ids: vec!["0199bbbb-1111-7000-8000-000000000001".into()],
                view_recipe: None,
                policy_binding: None,
                provenance: HumanProvenance::Human,
                created_at: 1_735_991_800,
                updated_at: 1_735_992_000,
            },
        ],
        notes: vec![NoteItem {
            id: "0199bbbb-3333-7000-8000-000000000001".into(),
            title: "timeline of operator actions".into(),
            body: "Restart at 14:01 per change ticket; burst begins 14:02:11.".into(),
            evidence_ids: vec!["0199bbbb-1111-7000-8000-000000000001".into()],
            finding_ids: Some(vec!["0199bbbb-2222-7000-8000-000000000003".into()]),
            provenance: HumanProvenance::Human,
            created_at: 1_735_992_100,
            updated_at: 1_735_992_100,
        }],
        proposed_findings: vec![ProposedFindingItem {
            id: "0199bbbb-4444-7000-8000-000000000001".into(),
            status: ProposedFindingStatus::Accepted,
            kind: FindingKind::Hypothesis,
            title: "connection pool exhaustion amplified the restart".into(),
            why_it_matters: "Human review can promote this bounded model proposal.".into(),
            caveats: Some("The cited events support correlation, not causation.".into()),
            evidence: vec![
                ProposalEvidenceCitation {
                    event_ref: event_ref(42),
                    role: ProposalEvidenceRole::Supporting,
                },
                ProposalEvidenceCitation {
                    event_ref: event_ref(44),
                    role: ProposalEvidenceRole::Contradicting,
                },
            ],
            view_recipe: None,
            corpus_id: corpus_id.clone(),
            investigation_id,
            policy_binding: Some(policy_binding),
            template_revision: Some(11),
            suppression_policy_revision: Some(7),
            rank_inputs: Some(ProposalRankInputs {
                supporting_count: 1,
                contradicting_count: 1,
                time_span_secs: Some(60),
                level_weight: Some(85),
            }),
            provenance: ProposalProvenance {
                source: ProposalSourceKind::Model,
                provider: Some("openai_compatible".into()),
                model_id: Some("local-investigator".into()),
                run_id: Some("run-contract-1".into()),
                tool_name: "propose_finding".into(),
                detector_id: None,
            },
            idempotency_key: "contract-proposal-1".into(),
            acceptance: Some(HumanProposalAcceptance {
                accepted_at: 1_735_992_200,
                edited: true,
            }),
            dismiss_reason: None,
            accepted_finding_id: Some("0199bbbb-2222-7000-8000-000000000003".into()),
            created_at: 1_735_992_150,
            updated_at: 1_735_992_200,
        }],
        // Schema v6 (#532): authored report sections — one with every optional
        // populated, one with all skipped-empty citation arrays absent.
        report_sections: vec![
            ReportSectionItem {
                id: "0199bbbb-5555-7000-8000-000000000001".into(),
                kind: ReportSectionKind::ExecutiveSummary,
                body: "Checkout cascade traced to the db-7 restart; mitigation verified.".into(),
                evidence_ids: vec!["0199bbbb-1111-7000-8000-000000000001".into()],
                finding_ids: vec!["0199bbbb-2222-7000-8000-000000000001".into()],
                note_ids: vec!["0199bbbb-3333-7000-8000-000000000001".into()],
                provenance: HumanProvenance::Human,
                accepted_from_proposal_id: Some("0199bbbb-6666-7000-8000-000000000002".into()),
                created_at: 1_735_992_300,
                updated_at: 1_735_992_360,
            },
            ReportSectionItem {
                id: "0199bbbb-5555-7000-8000-000000000002".into(),
                kind: ReportSectionKind::NextActions,
                body: "Add pool saturation alarms; document the restart runbook.".into(),
                evidence_ids: vec![],
                finding_ids: vec![],
                note_ids: vec![],
                provenance: HumanProvenance::Human,
                accepted_from_proposal_id: None,
                created_at: 1_735_992_400,
                updated_at: 1_735_992_400,
            },
        ],
        // Schema v6 (#532): proposed report sections in every terminal shape —
        // open Proposed (optionals absent), Accepted (acceptance + section
        // link), and Dismissed (required reason).
        proposed_report_sections: vec![
            ProposedReportSectionItem {
                id: "0199bbbb-6666-7000-8000-000000000001".into(),
                status: ProposedFindingStatus::Proposed,
                kind: ReportSectionKind::UnresolvedQuestions,
                body: "Why did the pool not recover after the restart completed?".into(),
                evidence_ids: vec![],
                finding_ids: vec![],
                note_ids: vec![],
                corpus_id: corpus_id.clone(),
                investigation_id: "0199bbbb-0000-7000-8000-000000000001".into(),
                provenance: ProposalProvenance {
                    source: ProposalSourceKind::Model,
                    provider: Some("openai_compatible".into()),
                    model_id: Some("local-investigator".into()),
                    run_id: Some("run-contract-2".into()),
                    tool_name: PROPOSE_REPORT_SECTION_TOOL.into(),
                    detector_id: None,
                },
                idempotency_key: "contract-report-proposal-1".into(),
                acceptance: None,
                dismiss_reason: None,
                accepted_section_id: None,
                created_at: 1_735_992_500,
                updated_at: 1_735_992_500,
            },
            ProposedReportSectionItem {
                id: "0199bbbb-6666-7000-8000-000000000002".into(),
                status: ProposedFindingStatus::Accepted,
                kind: ReportSectionKind::ExecutiveSummary,
                body: "Checkout cascade traced to the db-7 restart.".into(),
                evidence_ids: vec!["0199bbbb-1111-7000-8000-000000000001".into()],
                finding_ids: vec!["0199bbbb-2222-7000-8000-000000000002".into()],
                note_ids: vec!["0199bbbb-3333-7000-8000-000000000001".into()],
                corpus_id: corpus_id.clone(),
                investigation_id: "0199bbbb-0000-7000-8000-000000000001".into(),
                provenance: ProposalProvenance {
                    source: ProposalSourceKind::Detector,
                    provider: None,
                    model_id: None,
                    run_id: Some("run-contract-3".into()),
                    tool_name: PROPOSE_REPORT_SECTION_TOOL.into(),
                    detector_id: Some("report-detector-v1".into()),
                },
                idempotency_key: "contract-report-proposal-2".into(),
                acceptance: Some(HumanProposalAcceptance {
                    accepted_at: 1_735_992_360,
                    edited: true,
                }),
                dismiss_reason: None,
                accepted_section_id: Some("0199bbbb-5555-7000-8000-000000000001".into()),
                created_at: 1_735_992_310,
                updated_at: 1_735_992_360,
            },
            ProposedReportSectionItem {
                id: "0199bbbb-6666-7000-8000-000000000003".into(),
                status: ProposedFindingStatus::Dismissed,
                kind: ReportSectionKind::NextActions,
                body: "Restart db-7 weekly as a precaution.".into(),
                evidence_ids: vec![],
                finding_ids: vec![],
                note_ids: vec![],
                corpus_id,
                investigation_id: "0199bbbb-0000-7000-8000-000000000001".into(),
                provenance: ProposalProvenance {
                    source: ProposalSourceKind::Model,
                    provider: Some("openai_compatible".into()),
                    model_id: Some("local-investigator".into()),
                    run_id: Some("run-contract-4".into()),
                    tool_name: PROPOSE_REPORT_SECTION_TOOL.into(),
                    detector_id: None,
                },
                idempotency_key: "contract-report-proposal-3".into(),
                acceptance: None,
                dismiss_reason: Some(
                    "Scheduled restarts mask the defect instead of fixing it.".into(),
                ),
                accepted_section_id: None,
                created_at: 1_735_992_520,
                updated_at: 1_735_992_540,
            },
        ],
        created_at: 1_735_991_000,
        updated_at: 1_735_992_100,
    }
}

/// The versioned report projection, produced by the production assembly path.
///
/// Built by ACTUALLY calling [`assemble_investigation_report`] over a
/// hand-resolved document — never a parallel struct — so this fixture freezes
/// the real projection: deterministic finding/timeline ordering, per-reference
/// statuses, authored-vs-absent sections, and the policy-binding vocabulary.
fn investigation_report_sample() -> InvestigationReport {
    let document = investigation_document_sample();
    let current_policy = cd_core::log_analysis::SuppressionPolicyBindingSnapshot {
        suppression_policy_revision: 7,
        resolved_template_revision: 11,
        effective_policy_sha256: "9f9af2c8459f74dc6f21ce3e0a9c7fd5a677d9cc7f60c5ee7f86a8c285e1732f"
            .into(),
    };
    let evidence = vec![ResolvedEvidenceItem {
        item: document.evidence[0].clone(),
        references: vec![
            EvidenceReferenceResolution {
                event_ref: event_ref(42),
                status: EvidenceReferenceStatus::Verified,
                event: None,
            },
            EvidenceReferenceResolution {
                event_ref: event_ref(44),
                status: EvidenceReferenceStatus::Missing,
                event: None,
            },
        ],
    }];
    let statuses = [
        InvestigationPolicyBindingStatus::Current,
        InvestigationPolicyBindingStatus::MadeUnderDifferentPolicy,
        InvestigationPolicyBindingStatus::UnboundLegacy,
    ];
    let findings = document
        .findings
        .iter()
        .zip(statuses)
        .map(|(item, status)| ResolvedFindingItem {
            item: item.clone(),
            policy_binding: InvestigationPolicyBindingResolution {
                binding: item.policy_binding.clone(),
                current_suppression_policy_revision: current_policy.suppression_policy_revision,
                current_resolved_template_revision: current_policy.resolved_template_revision,
                current_effective_policy_sha256: current_policy.effective_policy_sha256.clone(),
                current_noise_lens: Some(InvestigationNoiseLens::Active),
                status,
            },
        })
        .collect();
    let resolved = ResolvedInvestigationDocument {
        document,
        evidence,
        findings,
        resolution_policy: Some(current_policy),
        resolution_noise_lens: Some(InvestigationNoiseLens::Active),
    };
    assemble_investigation_report(&resolved, 1_735_992_600)
}

fn resolved_bookmarks_sample() -> Vec<ResolvedBookmark> {
    vec![
        ResolvedBookmark {
            bookmark: Bookmark {
                id: "0199cccc-0000-7000-8000-000000000001".into(),
                label: "refusal burst".into(),
                seq_from: 42,
                seq_to: 44,
                ts_from: Some(1_735_991_400),
                ts_to: Some(1_735_991_500),
                event_refs: vec![event_ref(42), event_ref(44)],
                color: Some("amber".into()),
                note: Some("exact noncontiguous set".into()),
                created_at: 1_735_991_450,
                updated_at: 1_735_991_460,
            },
            evidence_status: BookmarkEvidenceStatus::Verified,
        },
        ResolvedBookmark {
            bookmark: Bookmark {
                id: "0199cccc-0000-7000-8000-000000000002".into(),
                label: "legacy range".into(),
                seq_from: 100,
                seq_to: 200,
                ts_from: None,
                ts_to: None,
                event_refs: vec![],
                color: None,
                note: None,
                created_at: 1_700_000_000,
                updated_at: 1_700_000_000,
            },
            evidence_status: BookmarkEvidenceStatus::LegacyRange,
        },
    ]
}

fn process_progress_sample() -> Vec<ProcessProgress> {
    let phases = [
        ProcessProgressPhase::Starting,
        ProcessProgressPhase::Scan,
        ProcessProgressPhase::Stream,
        ProcessProgressPhase::Parse,
        ProcessProgressPhase::Template,
        ProcessProgressPhase::Redact,
        ProcessProgressPhase::Store,
        ProcessProgressPhase::Embed,
        ProcessProgressPhase::Publish,
        ProcessProgressPhase::Read,
        ProcessProgressPhase::Validate,
        ProcessProgressPhase::Extract,
        ProcessProgressPhase::Write,
        ProcessProgressPhase::Completed,
        ProcessProgressPhase::Failed,
        ProcessProgressPhase::Cancelled,
    ];
    phases
        .iter()
        .enumerate()
        .map(|(i, phase)| ProcessProgress {
            kind: if i % 2 == 0 {
                ProcessProgressKind::LogIngest
            } else {
                ProcessProgressKind::SessionContextImport
            },
            phase: *phase,
            message: format!("phase {i}"),
            fraction: match i % 3 {
                0 => None,
                1 => Some(0.5),
                _ => Some(1.0),
            },
            lines_processed: if i % 2 == 0 {
                Some(i as u64 * 1000)
            } else {
                None
            },
            files_processed: Some(i as u64),
            bytes_processed: if i % 2 == 0 {
                None
            } else {
                Some(i as u64 * 4096)
            },
            templates: if i % 4 == 0 { Some(i as u64) } else { None },
            cancellable: i < 11,
            elapsed_ms: if i % 2 == 0 {
                Some(i as u64 * 1_000)
            } else {
                None
            },
            phase_elapsed_ms: if i % 3 == 0 {
                Some(i as u64 * 250)
            } else {
                None
            },
        })
        .collect()
}

fn event_dto_sample() -> Vec<EventDto> {
    vec![
        EventDto {
            kind: "turn_started".into(),
            payload: json!({ "session_id": "s-1" }),
        },
        EventDto {
            kind: "text_delta".into(),
            payload: json!({ "text": "Looking at the burst around 14:02…" }),
        },
        EventDto {
            kind: "tool".into(),
            payload: json!({
                "name": "search_logs",
                "phase": "completed",
                "detail": "41 hits",
            }),
        },
        EventDto {
            kind: "citation".into(),
            payload: json!({ "id": "log_template:41", "title": "connection refused to db-<*>" }),
        },
        EventDto {
            kind: "turn_completed".into(),
            payload: json!({ "ok": true }),
        },
    ]
}

/// Every committed fixture: `(file name, serialized value)`.
///
/// Names are stable and versioned; adding a family here without committing the
/// file (or vice versa) fails [`committed_fixtures_match_serialized_dtos`].
fn contract_fixtures() -> Vec<(&'static str, Value)> {
    let shared_timeline = SharedTimelineSummary {
        time_quality: TimeQuality::Wall,
        span_from: Some(1_735_991_400),
        span_to: Some(1_735_991_520),
        bucket_width: 60,
        bucket_count: 2,
        total_matched: 471,
        buckets: vec![
            SharedTimelineAxisBucket {
                index: 0,
                start: 1_735_991_400,
                end: 1_735_991_460,
            },
            SharedTimelineAxisBucket {
                index: 1,
                start: 1_735_991_460,
                end: 1_735_991_520,
            },
        ],
        counts: vec![420, 51],
        severity_series: SharedTimelineSeverity::ALL
            .iter()
            .map(|severity| SharedTimelineSeveritySeries {
                severity: *severity,
                counts: vec![10, 2],
            })
            .collect(),
        lanes: vec![SharedTimelineLaneSummary {
            lane_index: 0,
            source_count: 1,
            time_quality: TimeQuality::Wall,
            total_matched: 300,
            counts: vec![280, 20],
        }],
    };

    let event_page = EventPage {
        events: vec![explorer_event_full(), explorer_event_sparse()],
        next_cursor: Some(44),
        next_ts: Some(1_735_991_450),
        prev_cursor: Some(41),
        prev_ts: Some(1_735_991_440),
        total_matched: 471,
        time_quality: TimeQuality::Wall,
    };

    let event_rows_page = EventRowsPage {
        events: vec![explorer_event_sparse()],
        next_cursor: None,
        next_ts: None,
        prev_cursor: None,
        prev_ts: None,
        time_quality: TimeQuality::OrderOnly,
    };

    let facets = LogFacets {
        sources: BTreeMap::from([("api.log".to_string(), 300_u64), ("worker.log".into(), 171)]),
        levels: BTreeMap::from([("ERROR".to_string(), 471_u64), ("INFO".into(), 24_529)]),
        services: BTreeMap::from([("".to_string(), 171_u64), ("checkout".into(), 300)]),
        hosts: BTreeMap::from([("api-7".to_string(), 300_u64)]),
        time_quality: TimeQuality::Mixed,
        wall_event_count: 300,
        order_only_event_count: 171,
    };

    fn to<T: serde::Serialize>(value: &T) -> Value {
        serde_json::to_value(value).expect("fixture value serializes")
    }

    let model_options = vec![ModelOptionDto {
        id: "model::latest".into(),
        label: "Model latest".into(),
        selection_key: model_selection_key("account::west", "model::latest"),
        provider_id: "account::west".into(),
        provider_label: "Gateway west".into(),
        group: "Gateway west".into(),
        is_default: true,
        tools_enabled: true,
        tools_disabled_reason: None,
        availability: ModelAvailability::Discovered,
        availability_detail: None,
        readiness: cd_core::capability_qualification::ModelReadiness::unverified("model::latest"),
        hidden: false,
        hidden_by: None,
        pinned_rank: Some(0),
    }];

    vec![
        ("model_options.v1.json", to(&model_options)),
        ("event.v1.json", to(&event_dto_sample())),
        ("explorer_event.v1.json", to(&explorer_event_full())),
        ("event_page.v1.json", to(&event_page)),
        ("event_rows_page.v1.json", to(&event_rows_page)),
        (
            "event_count.v1.json",
            to(&EventCount { total_matched: 471 }),
        ),
        ("log_facets.v1.json", to(&facets)),
        ("shared_timeline_summary.v1.json", to(&shared_timeline)),
        (
            "suppression_document.v1.json",
            to(&suppression_document_sample()),
        ),
        (
            "noise_candidate_report.v1.json",
            to(&noise_candidate_report_sample()),
        ),
        (
            "investigation_document.v1.json",
            to(&investigation_document_sample()),
        ),
        (
            "investigation_report.v1.json",
            to(&investigation_report_sample()),
        ),
        (
            "resolved_bookmark.v1.json",
            to(&resolved_bookmarks_sample()),
        ),
        ("process_progress.v1.json", to(&process_progress_sample())),
        ("reviewed_format.v1.json", to(&reviewed_format_sample())),
        (
            "reviewed_format_preview.v1.json",
            to(&reviewed_format_preview_sample()),
        ),
        (
            "import_preview_report.v1.json",
            to(&import_preview_report_sample()),
        ),
        (
            "import_preview_plan.v1.json",
            to(&import_preview_plan_sample()),
        ),
        ("import_profile.v1.json", to(&import_profile_sample())),
        (
            "profile_match_report.v1.json",
            to(&profile_match_report_sample()),
        ),
    ]
}

/// The report wrapped into a runnable plan by the real binding fn, so the
/// committed token is the genuine production derivation over the committed
/// report — a wire consumer can trust the pair verbatim.
fn import_preview_plan_sample() -> cd_core::log_analysis::import_preview::ImportPreviewPlan {
    let report = import_preview_report_sample();
    let plan_token = cd_core::log_analysis::import_preview::import_plan_token(&report);
    cd_core::log_analysis::import_preview::ImportPreviewPlan {
        report,
        plan_token,
        plan_version: cd_core::log_analysis::import_preview::IMPORT_PLAN_VERSION,
    }
}

/// A preview report produced by the real preview pipeline.
///
/// Built by running `preview_import_path` over a controlled temporary
/// directory rather than by hand-assembling structs, so the fixture is the
/// genuine production serialization — including the classifier's own status,
/// reason, and grouping decisions. The tree is chosen to exercise a strong
/// match, a rolled pair that groups, a raw-fallback text file, and an
/// unsupported binary, so a wire consumer gets a sample of each.
///
/// Deterministic: fixed bytes, fixed names, and identity-sorted output. The
/// temporary path never appears in the report, which is what makes committing
/// this safe (and is separately asserted in `import_preview_adversarial.rs`).
fn import_preview_report_sample() -> cd_core::log_analysis::import_preview::ImportPreviewReport {
    let dir = tempfile::tempdir().expect("fixture tempdir");
    let json = b"{\"ts\":\"2026-01-01T00:00:00Z\",\"level\":\"info\",\"msg\":\"ready\"}\n";
    std::fs::create_dir_all(dir.path().join("logs")).expect("create logs dir");
    std::fs::write(dir.path().join("logs/app.jsonl.1"), json).expect("write");
    std::fs::write(dir.path().join("logs/app.jsonl.2"), json).expect("write");
    std::fs::write(
        dir.path().join("fallback.log"),
        b"plain event text, no structure\n",
    )
    .expect("write");
    std::fs::write(dir.path().join("image.log"), [0u8; 64]).expect("write");

    cd_core::log_analysis::import_preview::preview_import_path(dir.path(), None)
        .expect("fixture preview")
}

/// A import profile covering both a format-bound log group and a metrics group.
fn import_profile_sample() -> cd_core::log_analysis::import_profile::ImportProfile {
    use cd_core::log_analysis::import_preview::ImportItemRole;
    use cd_core::log_analysis::import_profile::{
        ImportProfile, ProfileRef, ProfileScope, SafePattern, SourceGroupRule,
        IMPORT_PROFILE_SCHEMA_ID,
    };

    ImportProfile {
        schema_id: IMPORT_PROFILE_SCHEMA_ID.to_string(),
        min_reader_version: 1,
        profile_id: "example.web-tier".to_string(),
        version: 1,
        scope: ProfileScope {
            label: "example/web".to_string(),
        },
        name: "Example web tier".to_string(),
        source_groups: vec![
            SourceGroupRule {
                group_id: "app-logs".to_string(),
                include: vec![SafePattern::new("logs/**")],
                exclude: vec![SafePattern::new("logs/**/debug-*")],
                role: ImportItemRole::Log,
                format_profile: Some(ProfileRef {
                    id: "json-object-line".to_string(),
                    version: 1,
                }),
                framing_profile: None,
                timestamp_policy: Some("reviewed.utc-explicit".to_string()),
            },
            SourceGroupRule {
                group_id: "metrics".to_string(),
                include: vec![SafePattern::new("metrics/*.json")],
                exclude: Vec::new(),
                role: ImportItemRole::OperationalMetrics,
                format_profile: None,
                framing_profile: None,
                timestamp_policy: None,
            },
        ],
    }
}

/// The match report for that import profile against that preview.
///
/// Freezing this pins the drift/conflict vocabulary a consumer must render —
/// including the `metrics` group matching nothing, which is drift rather than
/// silence.
fn profile_match_report_sample() -> cd_core::log_analysis::import_profile::ProfileMatchReport {
    cd_core::log_analysis::import_profile::match_profile(
        &import_profile_sample(),
        &import_preview_report_sample(),
    )
}

/// A reviewed format covering every slot kind the grammar supports.
fn reviewed_format_sample() -> cd_core::log_analysis::reviewed_format::ReviewedFormat {
    use cd_core::log_analysis::import_profile::SafePattern;
    use cd_core::log_analysis::reviewed_format::*;
    ReviewedFormat {
        schema_id: REVIEWED_FORMAT_SCHEMA_ID.to_string(),
        min_reader_version: 1,
        format_id: "example.app-log".to_string(),
        version: 1,
        name: "Example app log".to_string(),
        path_patterns: vec![SafePattern::new("**/app.log*")],
        timestamp: TimestampGrammar {
            tokens: vec![
                TimeToken::Year4,
                TimeToken::Literal('-'),
                TimeToken::Month2,
                TimeToken::Literal('-'),
                TimeToken::Day2,
                TimeToken::Literal(' '),
                TimeToken::Hour24,
                TimeToken::Literal(':'),
                TimeToken::Minute2,
                TimeToken::Literal(':'),
                TimeToken::Second2,
                TimeToken::Literal(','),
                TimeToken::Millis3,
            ],
        },
        layout: vec![
            FieldSlot::Whitespace,
            FieldSlot::Level,
            FieldSlot::Whitespace,
            FieldSlot::Thread {
                open: Some('['),
                close: Some(']'),
            },
            FieldSlot::Whitespace,
            FieldSlot::Logger {
                open: None,
                close: None,
            },
            FieldSlot::Whitespace,
            FieldSlot::Literal("- ".to_string()),
            FieldSlot::Message,
        ],
        multiline: MultilineRule::ContinuationUntilNextTimestamp,
        priority: 10,
        suggested_timezone: Some("America/Chicago".to_string()),
    }
}

/// A preview of that format over a synthetic sample, including a multiline
/// record so the continuation shape is pinned on the wire too.
fn reviewed_format_preview_sample() -> cd_core::log_analysis::reviewed_format::ReviewedFormatPreview
{
    cd_core::log_analysis::reviewed_format::preview_reviewed_format(
        &reviewed_format_sample(),
        "2024-05-03 12:24:22,729 ERROR [pool-1-thread-2] com.example.Svc - boom\n\
         java.lang.IllegalStateException: boom\n\
         \tat com.example.Svc.run(Svc.java:42)\n\
         2024-05-03 12:24:23,000 INFO [main] com.example.App - recovered\n",
    )
}

fn render(value: &Value) -> String {
    let mut text = serde_json::to_string_pretty(value).expect("fixture renders");
    text.push('\n');
    text
}

#[test]
fn committed_fixtures_match_serialized_dtos() {
    let dir = fixtures_dir();
    let fixtures = contract_fixtures();
    assert!(
        !fixtures.is_empty(),
        "contract fixture set must never be empty"
    );

    // Serialization must be deterministic call-over-call.
    for ((name_a, value_a), (_, value_b)) in contract_fixtures().iter().zip(fixtures.iter()) {
        assert_eq!(
            render(value_a),
            render(value_b),
            "non-deterministic serialization for {name_a}"
        );
    }

    // Exact committed file set: nothing missing, nothing extra.
    let expected: Vec<&str> = fixtures.iter().map(|(name, _)| *name).collect();
    let mut on_disk: Vec<String> = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("fixtures dir {} unreadable: {e}", dir.display()))
        .map(|entry| {
            entry
                .expect("dir entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    on_disk.sort();
    let mut expected_sorted: Vec<String> = expected.iter().map(|s| s.to_string()).collect();
    expected_sorted.sort();
    assert_eq!(
        on_disk, expected_sorted,
        "fixtures/contracts file set drifted (missing or extra files)"
    );

    // Byte-exact content per fixture.
    for (name, value) in &fixtures {
        let path = dir.join(name);
        let committed = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("missing committed fixture {name}: {e}"));
        assert_eq!(
            committed,
            render(value),
            "committed fixture {name} drifted from the production Rust serialization; \
             regenerate with: cargo test -p cd-core --test dto_contract_fixtures -- --ignored"
        );
    }
}

#[test]
fn fixtures_round_trip_through_deserialize() {
    // Deserialize the committed bytes back into the owning Rust type and
    // re-serialize, proving both wire directions for every family that
    // implements Deserialize. `NoiseCandidateReport` and `ResolvedBookmark`
    // are Serialize-only by design (&'static str fields / flatten projection)
    // and are covered by the byte-compare test alone.
    let dir = fixtures_dir();
    fn assert_round_trip<T: serde::de::DeserializeOwned + serde::Serialize>(
        dir: &std::path::Path,
        name: &str,
    ) {
        let committed =
            std::fs::read_to_string(dir.join(name)).unwrap_or_else(|e| panic!("{name}: {e}"));
        let value: T = serde_json::from_str(&committed)
            .unwrap_or_else(|e| panic!("{name} no longer deserializes into its Rust type: {e}"));
        assert_eq!(
            committed,
            render(&serde_json::to_value(&value).expect("re-serialize")),
            "{name} round-trip changed bytes"
        );
    }
    assert_round_trip::<Vec<EventDto>>(&dir, "event.v1.json");
    assert_round_trip::<ExplorerEvent>(&dir, "explorer_event.v1.json");
    assert_round_trip::<EventPage>(&dir, "event_page.v1.json");
    assert_round_trip::<EventRowsPage>(&dir, "event_rows_page.v1.json");
    assert_round_trip::<EventCount>(&dir, "event_count.v1.json");
    assert_round_trip::<LogFacets>(&dir, "log_facets.v1.json");
    assert_round_trip::<SharedTimelineSummary>(&dir, "shared_timeline_summary.v1.json");
    assert_round_trip::<SuppressionDocument>(&dir, "suppression_document.v1.json");
    assert_round_trip::<InvestigationDocument>(&dir, "investigation_document.v1.json");
    assert_round_trip::<InvestigationReport>(&dir, "investigation_report.v1.json");
    assert_round_trip::<Vec<ProcessProgress>>(&dir, "process_progress.v1.json");
    assert_round_trip::<Vec<ModelOptionDto>>(&dir, "model_options.v1.json");
}

/// Artifact writer; run explicitly after an intentional wire change.
#[test]
#[ignore = "fixture regenerator; run explicitly with --ignored"]
fn regenerate_contract_fixtures() {
    let dir = fixtures_dir();
    std::fs::create_dir_all(&dir).expect("create fixtures/contracts");
    for (name, value) in contract_fixtures() {
        std::fs::write(dir.join(name), render(&value)).expect("write fixture");
        println!("wrote {name}");
    }
}
