//! Headless source-neutral incident-triage evaluation bench.
//!
//! This crate is a **separate offline CLI/library**. It does not import
//! `cd-core` internals, does not talk to providers, and does not write
//! ContextDesk qualification, readiness, or routing state.
//!
//! ContextDesk remains a triage engine. Cases, evidence libraries, imported
//! runs, adjudication, and comparison reports live here.

#![forbid(unsafe_code)]

pub mod canonical;
pub mod cli;
pub mod error;
pub mod import;
pub mod packet;
pub mod privacy;
pub mod report;
pub mod review;
pub mod store;
pub mod types;

pub use error::{BenchError, BenchResult};
pub use import::{import_run, ImportOutcome};
pub use packet::{materialize_task_packet, TaskPacket};
pub use report::{render_report_json, render_report_jsonl, render_report_markdown, BacktestReport};
pub use review::{materialize_review_packet, merge_citation_assists, ReviewPacket, ReviewPhase};
pub use store::{BenchStore, VerifiedBlobCopy};
pub use types::*;
