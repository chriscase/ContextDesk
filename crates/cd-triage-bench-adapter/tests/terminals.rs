//! Every SDK terminal produces a recorded run with a typed bench status, and
//! the real replay validator owns what counts as a well-formed stream.

mod common;

use cd_triage_bench::RunStatus;
use cd_triage_bench_adapter::{
    run_offline, AdapterError, AdapterRun, MockEnginePlan, MockSlotOutcome, MockSlotPlan,
    MockTerminalPlan, MockValidation,
};
use cd_triage_sdk::{
    parse_replay_v1, TriageContractError, TriageResultKind, TriageRunEventPayloadV2,
    TriageSlotKindV2, TriageValidationState,
};

fn run(plan: &MockEnginePlan) -> Result<AdapterRun, AdapterError> {
    let case = common::case();
    let snapshot = common::snapshot();
    let task = common::task(&snapshot);
    run_offline(
        &case,
        &snapshot,
        &task,
        common::policy(),
        Default::default(),
        common::CANCELLATION_ID,
        plan,
        &common::context(),
    )
}

fn ok(plan: &MockEnginePlan) -> AdapterRun {
    run(plan).expect("plan should produce a valid replay")
}

/// A terminal fixture: the replay golden plus the recorded bench status.
fn assert_terminal(name: &str, plan: &MockEnginePlan, expected: RunStatus) -> AdapterRun {
    let run = ok(plan);
    run.outcome.replay.validate().expect("real validator");
    assert_eq!(
        run.recorded.bench_run.status, expected,
        "{name}: bench status"
    );
    common::assert_golden(
        &format!("replay.{name}.json"),
        &common::golden_json(&run.outcome.replay),
    );
    // Every golden replay is re-parsed through the real public parser, so the
    // committed bytes are proven to satisfy the contract, not just the value
    // that produced them.
    let raw = std::fs::read_to_string(common::fixtures_dir().join(format!("replay.{name}.json")))
        .expect("golden replay");
    parse_replay_v1(&raw).expect("golden replay parses and validates");
    run
}

#[test]
fn completed_terminal_records_a_completed_run_with_a_grounded_final_answer() {
    let run = assert_terminal("complete", &common::plan_complete(), RunStatus::Completed);
    let result = run.outcome.result().expect("result");
    assert_eq!(result.kind, TriageResultKind::GroundedFinal);
    assert_eq!(result.validation_state, TriageValidationState::Passed);
    assert!(result.reconciliation.root_cause_established);
    assert!(result.answer.is_some());
    assert!(!run.recorded.bench_run.claims.is_empty());
}

#[test]
fn completed_partial_terminal_records_a_partial_run_without_an_answer() {
    let run = assert_terminal("partial", &common::plan_partial(), RunStatus::Partial);
    let result = run.outcome.result().expect("result");
    assert_eq!(result.kind, TriageResultKind::HonestPartial);
    assert!(!result.reconciliation.root_cause_established);
    assert!(
        result.answer.is_none(),
        "an honest partial must not fabricate an answer envelope"
    );
    assert!(run.recorded.bench_run.claims.is_empty());
}

#[test]
fn failed_terminal_stays_failed_even_though_it_carries_partial_output() {
    let run = assert_terminal("failed", &common::plan_failed(), RunStatus::Failed);
    let TriageRunEventPayloadV2::Failed {
        category,
        partial_result,
    } = run.outcome.terminal()
    else {
        panic!("expected a failed terminal");
    };
    assert_eq!(category, "provider_unavailable");
    let partial = partial_result.as_deref().expect("partial provenance");
    assert_eq!(partial.kind, TriageResultKind::HonestPartial);

    // The partial output is provenance. It does not upgrade the bench status.
    let terminal = &run.recorded.owner_only.terminal;
    assert_eq!(terminal.kind, "failed");
    assert!(terminal.partial_result_is_provenance_only);
    assert_eq!(terminal.bench_status, RunStatus::Failed);
    assert_ne!(terminal.bench_status, RunStatus::Partial);
}

#[test]
fn timed_out_terminal_records_a_timed_out_run() {
    let run = assert_terminal("timed-out", &common::plan_timed_out(), RunStatus::TimedOut);
    let TriageRunEventPayloadV2::TimedOut {
        category,
        partial_result,
    } = run.outcome.terminal()
    else {
        panic!("expected a timed-out terminal");
    };
    assert_eq!(category, "whole_turn_deadline");
    assert!(partial_result.is_some());
    assert!(
        run.recorded
            .owner_only
            .terminal
            .partial_result_is_provenance_only
    );
}

#[test]
fn cancelled_terminal_records_a_cancelled_run_without_a_validation_checkpoint() {
    let run = assert_terminal("cancelled", &common::plan_cancelled(), RunStatus::Cancelled);
    let TriageRunEventPayloadV2::Cancelled {
        cancellation_id,
        partial_result,
    } = run.outcome.terminal()
    else {
        panic!("expected a cancelled terminal");
    };
    assert_eq!(cancellation_id, common::CANCELLATION_ID);
    assert!(partial_result.is_none());
    // The contract lets cancellation precede validation; nothing else may.
    assert!(!run
        .outcome
        .replay
        .events
        .iter()
        .any(|event| matches!(event.event, TriageRunEventPayloadV2::Validation { .. })));
}

#[test]
fn every_terminal_produces_a_recorded_run_rather_than_a_discarded_attempt() {
    for (plan, expected) in [
        (common::plan_complete(), RunStatus::Completed),
        (common::plan_partial(), RunStatus::Partial),
        (common::plan_failed(), RunStatus::Failed),
        (common::plan_timed_out(), RunStatus::TimedOut),
        (common::plan_cancelled(), RunStatus::Cancelled),
    ] {
        let run = ok(&plan);
        assert_eq!(run.recorded.bench_run.status, expected);
        run.recorded
            .bench_run
            .validate()
            .expect("every terminal records a valid bench run");
        assert!(!run.recorded.raw_output.is_empty());
    }
}

#[test]
fn a_non_cancelled_terminal_may_not_skip_the_validation_checkpoint() {
    let mut plan = common::plan_failed();
    plan.validation = None;
    let error = run(&plan).unwrap_err();
    assert!(
        matches!(error, AdapterError::UnrealizablePlan(_)),
        "expected a refused plan, got {error:?}"
    );
}

#[test]
fn a_reviewer_without_a_contributor_is_rejected_by_the_real_phase_order() {
    // The reviewer phase requires a preliminary reconciliation, which in turn
    // requires a contributor attempt. The adapter does not restate that rule;
    // it surfaces the public validator's refusal.
    let plan = MockEnginePlan {
        slots: vec![
            MockSlotPlan {
                role_slot_id: "review".into(),
                role: TriageSlotKindV2::Reviewer,
                model: common::model("gateway-gamma", "model-review"),
                outcome: MockSlotOutcome::completed(),
            },
            MockSlotPlan {
                role_slot_id: "finalize".into(),
                role: TriageSlotKindV2::Finalizer,
                model: common::model("gateway-delta", "model-finalize"),
                outcome: MockSlotOutcome::completed(),
            },
        ],
        validation: Some(MockValidation {
            passed: true,
            reason_codes: vec![],
        }),
        correction: None,
        terminal: MockTerminalPlan::Completed,
    };
    let error = run(&plan).unwrap_err();
    assert_eq!(
        error,
        AdapterError::Contract(TriageContractError::InvalidPhaseOrder),
        "the real validator must be the authority on phase order"
    );
}

#[test]
fn two_finalizers_are_refused_before_a_stream_is_built() {
    let mut plan = common::plan_complete();
    plan.slots.push(MockSlotPlan {
        role_slot_id: "finalize-2".into(),
        role: TriageSlotKindV2::Finalizer,
        model: common::model("gateway-delta", "model-finalize"),
        outcome: MockSlotOutcome::completed(),
    });
    assert!(matches!(
        run(&plan).unwrap_err(),
        AdapterError::UnrealizablePlan(_)
    ));
}

#[test]
fn committed_invalid_replays_are_rejected_by_the_real_parser() {
    let run = ok(&common::plan_complete());

    // An extra event after the terminal.
    let mut after_terminal = run.outcome.replay.clone();
    let last = after_terminal.events.last().cloned().unwrap();
    let mut extra = after_terminal.events[1].clone();
    extra.sequence = last.sequence + 1;
    after_terminal.events.push(extra);
    common::assert_golden(
        "replay.after-terminal.invalid.json",
        &common::golden_json(&after_terminal),
    );

    // A non-contiguous sequence.
    let mut bad_sequence = run.outcome.replay.clone();
    bad_sequence.events[2].sequence = 99;
    common::assert_golden(
        "replay.bad-sequence.invalid.json",
        &common::golden_json(&bad_sequence),
    );

    let after =
        std::fs::read_to_string(common::fixtures_dir().join("replay.after-terminal.invalid.json"))
            .unwrap();
    let error = parse_replay_v1(&after).unwrap_err();
    assert!(
        matches!(
            error,
            TriageContractError::EventAfterTerminal | TriageContractError::TerminalCount(_)
        ),
        "{error:?}"
    );

    let bad =
        std::fs::read_to_string(common::fixtures_dir().join("replay.bad-sequence.invalid.json"))
            .unwrap();
    assert_eq!(
        parse_replay_v1(&bad).unwrap_err(),
        TriageContractError::NonContiguousSequence
    );
}

#[test]
fn golden_inputs_stay_stable() {
    let snapshot = common::snapshot();
    let task = common::task(&snapshot);
    let run = ok(&common::plan_complete());
    common::assert_golden("snapshot.json", &common::golden_json(&snapshot));
    common::assert_golden("task.json", &common::golden_json(&task));
    common::assert_golden("packet.json", &common::golden_json(&run.bounded.packet));
    common::assert_golden("request.json", &common::golden_json(&run.bound.request));
    common::assert_golden(
        "bench-run.complete.json",
        &common::golden_json(&run.recorded.bench_run),
    );
}

#[test]
fn a_preflight_rejection_is_a_recorded_failed_run_not_a_discarded_attempt() {
    let run = assert_terminal(
        "preflight-rejected",
        &common::plan_preflight_rejected(),
        RunStatus::Failed,
    );
    // Every configured slot is accounted for, none silently omitted.
    assert_eq!(run.outcome.attempts.len(), 4);
    assert!(run
        .outcome
        .attempts
        .iter()
        .all(|attempt| attempt.status == cd_triage_sdk::TriageAttemptStatus::NotAdmitted));
    // A not-admitted slot must report no provider work at all.
    assert!(run
        .outcome
        .attempts
        .iter()
        .all(|attempt| attempt.physical_provider_calls == Some(0)
            && attempt.semantic_corrections == Some(0)));
    assert_eq!(run.recorded.owner_only.terminal.kind, "failed");
    assert_eq!(run.recorded.bench_run.status, RunStatus::Failed);
    // The record still carries the exact model identity the policy named,
    // which is what makes a rejection auditable.
    assert_eq!(run.recorded.owner_only.slots.len(), 4);
}
