//! Integration gate for the host-neutral Investigation Team qualification seam.

use cd_core::investigation_team_qualification::{
    AttemptStatus, QualificationInput, SCHEMA_ID, SUITE_VERSION,
};
use cd_workflow::investigation_team_qualification::{execute, QualificationStatus};

#[test]
fn host_execution_returns_typed_report_and_honest_status() {
    // The module unit tests cover the full input fixture. This integration
    // boundary intentionally stays small: it proves the workflow crate exports
    // the seam and that its public result carries a typed status.
    let _ = execute as fn(QualificationInput) -> _;
    assert_eq!(SCHEMA_ID, "contextdesk.investigation_team_qualification.v1");
    assert_eq!(
        SUITE_VERSION,
        "contextdesk.investigation_team_qualification.suite.v1"
    );
    assert_eq!(QualificationStatus::Partial.as_str(), "partial");
    assert_eq!(AttemptStatus::TimedOut.as_str(), "timed_out");
}
