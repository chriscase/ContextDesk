//! Headless source-neutral incident-triage evaluation bench.
//!
//! This crate is a **separate offline CLI/library**. It does not import
//! `cd-core` internals, does not talk to providers, and does not write
//! ContextDesk qualification, readiness, or routing state.
//!
//! ContextDesk remains a triage engine. Cases, evidence libraries, imported
//! runs, adjudication, and comparison reports live here.

#![forbid(unsafe_code)]

pub mod agreement;
pub mod canonical;
pub mod cli;
pub mod error;
pub mod gold;
pub mod import;
pub mod packet;
pub mod privacy;
pub mod report;
pub mod review;
pub mod store;
pub mod types;

pub use agreement::{
    build_agreement_views, project_agreement_share_safe, project_all_share_safe,
    render_agreement_json, render_agreement_markdown, render_agreement_share_safe_json,
    render_agreement_share_safe_markdown, AgreementRun, AgreementView, EvidenceAnchor, ExcludedRun,
    ExclusionReason, RoleBucket, RoleConflict, ShareSafeAgreementView, AGREEMENT_VIEW_SCHEMA_V1,
    AGREEMENT_VIEW_SHARE_SAFE_SCHEMA_V1,
};
pub use error::{BenchError, BenchResult};
pub use gold::{
    align_cited_evidence, align_run, latest_gold_for, ExpectedRelationship, GoldAlignment,
    GoldAlignmentStatus, GoldReference, GOLD_ALIGNMENT_NOT_CORRECTNESS, GOLD_IS_HUMAN_BENCHMARK,
    GOLD_REFERENCE_SCHEMA_V1,
};
pub use import::{import_run, ImportOutcome};
pub use packet::{materialize_task_packet, TaskPacket};
pub use report::{
    build_report_with_attribution, build_report_with_gold, extract_owner_model_attribution,
    render_report_json, render_report_jsonl, render_report_markdown, BacktestReport, GroupGold,
    HumanAcceptance, RunAttribution,
};
pub use review::{materialize_review_packet, merge_citation_assists, ReviewPacket, ReviewPhase};
pub use store::{BenchStore, VerifiedBlobCopy};
pub use types::*;
